import { GraphQLClient, gql } from 'graphql-request'
import fetch from 'cross-fetch'
import { mkdirSync, createWriteStream, writeFileSync } from 'fs'
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
      _gte: domainStart,
    }
  }
  if (typeof domainEnd === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _lte: domainEnd,
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
      _gte: consensusStart,
    }
  }
  if (typeof consensusEnd === 'number') {
    where.block_height = {
      ...(where.block_height || {}),
      _lte: consensusEnd,
    }
  }
  return where
}

/**
 * Pulls pages concurrently while writing them in-order to preserve global sort order.
 * - Schedules N initial pages (concurrency) and advances a sliding window.
 * - Applies backpressure via the provided writer function.
 * Returns the total number of rows written.
 */
const writeRowsWithConcurrency = async (
  options: {
    fetchPage: (offset: number, limit: number) => Promise<TransferRow[]>
    pageSize: number
    concurrency: number
  },
  writer: (rows: TransferRow[]) => Promise<void>,
): Promise<number> => {
  const { fetchPage, pageSize, concurrency } = options
  let rowCount = 0

  const inFlight: Map<number, Promise<TransferRow[]>> = new Map()

  const seed = Math.max(1, concurrency)
  for (let i = 0; i < seed; i++) {
    inFlight.set(i, fetchPage(i * pageSize, pageSize))
  }
  let nextToSchedule = seed
  let noMore = false

  for (let page = 0; ; page++) {
    const p = inFlight.get(page)
    if (!p) break
    const rows = await p
    inFlight.delete(page)
    if (rows.length === 0) {
      noMore = true
    } else {
      await writer(rows)
      rowCount += rows.length
      if (rows.length < pageSize) {
        noMore = true
      }
    }
    if (!noMore) {
      inFlight.set(nextToSchedule, fetchPage(nextToSchedule * pageSize, pageSize))
      nextToSchedule++
    }
  }

  return rowCount
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
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const dir = join(config.outputDir, timestamp)
  mkdirSync(dir, { recursive: true })

  const whereD2C = toWhereD2C(config.domainStart, config.domainEnd)
  const whereC2D = toWhereC2D(config.consensusStart, config.consensusEnd)

  const d2cOut = createOutput(dir, 'd2c_transfers', config.exportFormat)
  const c2dOut = createOutput(dir, 'c2d_transfers', config.exportFormat)

  if (config.exportFormat === 'csv') {
    await d2cOut.write(FIELDS.join(',') + '\n')
    await c2dOut.write(FIELDS.join(',') + '\n')
  }

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

  const d2cCount = await writeRowsWithConcurrency(
    {
      fetchPage: fetchD2CPages(whereD2C),
      pageSize: config.pageSize,
      concurrency: config.concurrency,
    },
    async (rows) => writeRows(rows, d2cOut, config.exportFormat),
  )
  await d2cOut.end()

  const c2dCount = await writeRowsWithConcurrency(
    {
      fetchPage: fetchC2DPages(whereC2D),
      pageSize: config.pageSize,
      concurrency: config.concurrency,
    },
    async (rows) => writeRows(rows, c2dOut, config.exportFormat),
  )
  await c2dOut.end()

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
    rowCounts: { d2c: d2cCount, c2d: c2dCount },
    artifacts: {
      d2c: {
        path: relative(dir, d2cOut.filePath),
      },
      c2d: {
        path: relative(dir, c2dOut.filePath),
      },
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
