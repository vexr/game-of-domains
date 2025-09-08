import { GraphQLClient, gql } from 'graphql-request'
import fetch from 'cross-fetch'
import { mkdirSync, createWriteStream, writeFileSync, existsSync, renameSync } from 'fs'
import { join, relative } from 'path'

/**
 * Runtime configuration for the export job.
 * Values are derived from environment variables with safe defaults.
 */
interface ExportConfig {
  endpoint: string
  pageSize: number
  concurrency: number
  outputDir: string
  exportFormat: 'ndjson' | 'csv'
  logEveryPages: number
  consensusStart?: number
  consensusEnd?: number
  domainStart?: number
  domainEnd?: number
}

/** GraphQL endpoint to query (SubQL). Can be overridden via SUBQL_ENDPOINT. */
const endpoint =
  process.env.SUBQL_ENDPOINT || 'https://subql.blue.taurus.subspace.network/v1/graphql'

/** Effective configuration assembled from env + defaults. */
const config: ExportConfig = {
  endpoint,
  pageSize: Number(process.env.PAGE_SIZE || 1000),
  concurrency: Number(process.env.CONCURRENCY || 6),
  outputDir: process.env.OUTPUT_DIR || 'exports',
  exportFormat: (process.env.EXPORT_FORMAT || 'ndjson') as 'ndjson' | 'csv',
  logEveryPages: Number(process.env.LOG_EVERY_PAGES || 25),
  consensusStart: process.env.CONSENSUS_START_HEIGHT
    ? Number(process.env.CONSENSUS_START_HEIGHT)
    : undefined,
  consensusEnd: process.env.CONSENSUS_END_HEIGHT
    ? Number(process.env.CONSENSUS_END_HEIGHT)
    : undefined,
  domainStart: process.env.DOMAIN_START_HEIGHT
    ? Number(process.env.DOMAIN_START_HEIGHT)
    : undefined,
  domainEnd: process.env.DOMAIN_END_HEIGHT ? Number(process.env.DOMAIN_END_HEIGHT) : undefined,
}

/** Shared GraphQL client instance. */
const client = new GraphQLClient(endpoint, { fetch })

/**
 * Domain → Consensus transfers query.
 * Ordered by block_height to enable deterministic, page-aligned exports.
 */
const EXPORT_D2C = gql`
  query ExportD2C($limit: Int!, $offset: Int!, $where: domain_auto_evm_transfers_bool_exp) {
    domain_auto_evm_transfers(
      where: $where
      order_by: { block_height: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      from
      to
      from_chain
      to_chain
      value
      fee
      success
      block_height
      block_hash
      event_id
      extrinsic_id
      timestamp
    }
  }
`

/**
 * Consensus → Domain transfers query.
 * Ordered by block_height to enable deterministic, page-aligned exports.
 */
const EXPORT_C2D = gql`
  query ExportC2D($limit: Int!, $offset: Int!, $where: consensus_transfers_bool_exp) {
    consensus_transfers(
      where: $where
      order_by: { block_height: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      from
      to
      from_chain
      to_chain
      value
      fee
      success
      block_height
      block_hash
      event_id
      extrinsic_id
      timestamp
    }
  }
`

/** Generic row shape returned by GraphQL for transfer records. */
interface TransferRow {
  [key: string]: unknown
}

/**
 * Build where clause for Domain→Consensus export window.
 */
const toWhereD2C = (domainStart?: number, domainEnd?: number) => {
  const where: any = {
    from_chain: { _eq: 'domain:0' },
    to_chain: { _eq: 'consensus:null' },
  }
  if (typeof domainStart === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _gte: String(domainStart),
    }
  }
  if (typeof domainEnd === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _lte: String(domainEnd),
    }
  }
  return where
}

/**
 * Build where clause for Consensus→Domain export window.
 */
const toWhereC2D = (consensusStart?: number, consensusEnd?: number) => {
  const where: any = {
    from_chain: { _eq: 'consensus:null' },
    to_chain: { _eq: 'domain:0' },
  }
  if (typeof consensusStart === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _gte: String(consensusStart),
    }
  }
  if (typeof consensusEnd === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _lte: String(consensusEnd),
    }
  }
  return where
}

/**
 * Sequential pagination that advances by the actual number of rows returned.
 * This avoids skipping data when the server enforces a lower per-page max than requested.
 * Returns the total number of rows written.
 */
const writeRowsSequential = async (
  options: {
    fetchPage: (offset: number, limit: number) => Promise<TransferRow[]>
    pageSize: number
  },
  writer: (rows: TransferRow[]) => Promise<void>,
  onProgress?: (info: { pageIndex: number; rowsInPage: number; totalRows: number }) => void,
): Promise<number> => {
  const { fetchPage, pageSize } = options
  let offset = 0
  let rowCount = 0
  let pageIndex = 0
  for (;;) {
    const rows = await fetchPage(offset, pageSize)
    if (rows.length === 0) break
    await writer(rows)
    rowCount += rows.length
    offset += rows.length
    if (onProgress) onProgress({ pageIndex, rowsInPage: rows.length, totalRows: rowCount })
    pageIndex += 1
  }
  return rowCount
}

/**
 * Concurrent pagination with deterministic ordering.
 * Detects effective stride from the first page and fetches next pages in parallel.
 */
const writeRowsConcurrent = async (
  options: {
    fetchPage: (offset: number, limit: number) => Promise<TransferRow[]>
    pageSize: number
    concurrency: number
  },
  writer: (rows: TransferRow[]) => Promise<void>,
): Promise<number> => {
  const { fetchPage, pageSize } = options
  const concurrency = Math.max(1, options.concurrency)

  // Page 0 determines effective stride (may be less than requested pageSize)
  const first = await fetchPage(0, pageSize)
  if (first.length === 0) return 0
  await writer(first)
  let totalRows = first.length
  const stride = first.length
  if (stride <= 0) return totalRows

  const inFlight: Map<number, Promise<TransferRow[]>> = new Map()
  const startFetch = (pageIdx: number) => {
    const offset = pageIdx * stride
    inFlight.set(pageIdx, fetchPage(offset, pageSize))
  }
  const seed = Math.max(0, concurrency - 1)
  for (let i = 1; i <= seed; i++) startFetch(i)

  let nextToSchedule = seed + 1
  let done = false
  for (let page = 1; !done; page++) {
    const p = inFlight.get(page)
    if (!p) break
    const rows = await p
    inFlight.delete(page)
    if (rows.length === 0) {
      done = true
    } else {
      await writer(rows)
      totalRows += rows.length
      if (rows.length < stride) {
        done = true
      }
    }
    if (!done) {
      startFetch(nextToSchedule)
      nextToSchedule += 1
    }
  }

  return totalRows
}

/**
 * Create a backpressure-aware file writer for the given output artifact.
 */
const createOutput = (dir: string, baseName: string, format: 'ndjson' | 'csv') => {
  const ext = format === 'ndjson' ? '.ndjson' : '.csv'
  const filePath = join(dir, `${baseName}${ext}`)
  const fileStream = createWriteStream(filePath, { encoding: 'utf8' })
  const write = (data: string): Promise<void> =>
    new Promise((resolve) => {
      const ok = (fileStream as any).write(data)
      if (ok) return resolve()
      ;(fileStream as any).once('drain', () => resolve())
    })
  const end = (): Promise<void> => new Promise((resolve) => (fileStream as any).end(resolve))
  return { filePath, write, end }
}

/** Stable field ordering for CSV output. */
const FIELDS = [
  'id',
  'from',
  'to',
  'from_chain',
  'to_chain',
  'value',
  'fee',
  'success',
  'block_height',
  'block_hash',
  'event_id',
  'extrinsic_id',
  'timestamp',
] as const

/** Minimal CSV escaping for values. */
const escapeCsv = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** Page fetcher factory for D2C query. */
const fetchD2CPages =
  (where: any) =>
  async (offset: number, limit: number): Promise<TransferRow[]> => {
    const res = await client.request<{
      domain_auto_evm_transfers: TransferRow[]
    }>(EXPORT_D2C, { where, offset, limit })
    return res.domain_auto_evm_transfers
  }

/** Page fetcher factory for C2D query. */
const fetchC2DPages =
  (where: any) =>
  async (offset: number, limit: number): Promise<TransferRow[]> => {
    const res = await client.request<{ consensus_transfers: TransferRow[] }>(EXPORT_C2D, {
      where,
      offset,
      limit,
    })
    return res.consensus_transfers
  }

/** Entry point: orchestrates export, writing artifacts and manifest. */
const main = async (): Promise<void> => {
  const formatStamp = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 14)
  const baseDir = config.outputDir
  mkdirSync(baseDir, { recursive: true })

  // Archive existing latest → timestamped folder before starting new export
  const latestDir = join(baseDir, 'latest')
  if (existsSync(latestDir)) {
    let dest = join(baseDir, formatStamp(new Date()))
    if (existsSync(dest)) {
      let i = 1
      while (existsSync(`${dest}-${i}`)) i++
      dest = `${dest}-${i}`
    }
    renameSync(latestDir, dest)
  }

  const dir = latestDir
  mkdirSync(dir, { recursive: true })

  const whereD2C = toWhereD2C(config.domainStart, config.domainEnd)
  const whereC2D = toWhereC2D(config.consensusStart, config.consensusEnd)

  // Outputs are created per direction within exportOneDirection

  const writeRows = async (
    rows: TransferRow[],
    out: { write: (s: string) => Promise<void> },
    format: 'ndjson' | 'csv',
  ) => {
    if (format === 'ndjson') {
      let chunk = ''
      for (const row of rows) chunk += JSON.stringify(row) + '\n'
      await out.write(chunk)
    } else {
      let chunk = ''
      for (const row of rows) {
        const values = FIELDS.map((f) => escapeCsv((row as any)[f]))
        chunk += values.join(',') + '\n'
      }
      await out.write(chunk)
    }
  }

  const exportOneDirection = async (
    label: 'D2C' | 'C2D',
    where: any,
    baseName: string,
    fetchFactory: (w: any) => (offset: number, limit: number) => Promise<TransferRow[]>,
  ): Promise<{ count: number; artifactPath: string }> => {
    console.log(
      JSON.stringify(
        { message: `[export] ${label} start`, where, pageSize: config.pageSize },
        null,
        2,
      ),
    )
    const out = createOutput(dir, baseName, config.exportFormat)
    if (config.exportFormat === 'csv') {
      await out.write(FIELDS.join(',') + '\n')
    }
    const fetchPage = fetchFactory(where)
    const count = await (config.concurrency > 1
      ? writeRowsConcurrent(
          { fetchPage, pageSize: config.pageSize, concurrency: config.concurrency },
          async (rows) => writeRows(rows, out, config.exportFormat),
        )
      : writeRowsSequential({ fetchPage, pageSize: config.pageSize }, async (rows) =>
          writeRows(rows, out, config.exportFormat),
        ))
    await out.end()
    console.log(JSON.stringify({ message: `[export] ${label} done`, rows: count }, null, 2))
    return { count, artifactPath: relative(dir, out.filePath) }
  }

  const [d2c, c2d] = await Promise.all([
    exportOneDirection('D2C', whereD2C, 'd2c_transfers', fetchD2CPages),
    exportOneDirection('C2D', whereC2D, 'c2d_transfers', fetchC2DPages),
  ])

  const manifest = {
    exportedAt: new Date().toISOString(),
    endpoint: config.endpoint,
    filters: {
      from_chain_d2c: 'domain:0',
      to_chain_d2c: 'consensus:null',
      from_chain_c2d: 'consensus:null',
      to_chain_c2d: 'domain:0',
      startHeight: config.consensusStart ?? null,
      endHeight: config.consensusEnd ?? null,
      domainStartHeight: config.domainStart ?? null,
      domainEndHeight: config.domainEnd ?? null,
    },
    pageSize: config.pageSize,
    rowCounts: { d2c: d2c.count, c2d: c2d.count },
    artifacts: {
      d2c: { path: d2c.artifactPath },
      c2d: { path: c2d.artifactPath },
    },
  }

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(
    JSON.stringify(
      {
        message: '[export] Done',
        outputDir: dir,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
