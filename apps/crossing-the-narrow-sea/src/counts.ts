import { createReadStream, createWriteStream, existsSync, writeFileSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { join, relative } from 'path'

interface CountsByWallet {
  [wallet: string]: number
}

type Direction = 'D2C' | 'C2D'

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'exports'
const INPUT_DIR = process.env.INPUT_DIR || join(OUTPUT_DIR, 'latest')

const CSV_DELIM = ','

const parseCsvLine = (line: string): string[] => {
  const values: string[] = []
  let cur = ''
  let i = 0
  const len = line.length
  let inQuotes = false
  while (i < len) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && line[i + 1] === '"') {
          cur += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      cur += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === CSV_DELIM) {
      values.push(cur)
      cur = ''
      i += 1
      continue
    }
    values.push
    cur += ch
    i += 1
  }
  values.push(cur)
  return values
}

const toBoolean = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v
  if (v === null || v === undefined) return false
  const s = String(v).toLowerCase().trim()
  return s === 'true' || s === '1' || s === 't' || s === 'yes'
}

const aggregateNdjson = async (filePath: string, direction: Direction, counts: CountsByWallet) => {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  for await (const line of rl) {
    const s = line.trim()
    if (!s) continue
    let row: any
    try {
      row = JSON.parse(s)
    } catch {
      continue
    }
    if (!toBoolean(row?.success)) continue
    const wallet = String(row?.from ?? '')
    if (!wallet) continue
    counts[wallet] = (counts[wallet] ?? 0) + 1
  }
}

const aggregateCsv = async (filePath: string, direction: Direction, counts: CountsByWallet) => {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  let header: string[] | null = null
  let idxFrom = -1
  let idxSuccess = -1
  for await (const line of rl) {
    const s = line.trim()
    if (!s) continue
    if (!header) {
      header = parseCsvLine(s)
      idxFrom = header.indexOf('from')
      idxSuccess = header.indexOf('success')
      continue
    }
    const cols = parseCsvLine(s)
    if (idxFrom < 0 || idxFrom >= cols.length) continue
    if (idxSuccess < 0 || idxSuccess >= cols.length) continue
    if (!toBoolean(cols[idxSuccess])) continue
    const wallet = cols[idxFrom]
    if (!wallet) continue
    counts[wallet] = (counts[wallet] ?? 0) + 1
  }
}

const aggregateFile = async (filePath: string, direction: Direction): Promise<CountsByWallet> => {
  const counts: CountsByWallet = Object.create(null)
  if (filePath.endsWith('.ndjson')) {
    await aggregateNdjson(filePath, direction, counts)
  } else if (filePath.endsWith('.csv')) {
    await aggregateCsv(filePath, direction, counts)
  } else {
    throw new Error(`Unsupported file format: ${filePath}`)
  }
  return counts
}

const writeCountsCsv = (path: string, d2c: CountsByWallet, c2d: CountsByWallet) => {
  const out = createWriteStream(path, { encoding: 'utf8' })
  out.write('direction,wallet,count\n')
  const writeMap = (dir: Direction, m: CountsByWallet) => {
    for (const wallet of Object.keys(m)) {
      out.write(`${dir},${wallet},${m[wallet]}\n`)
    }
  }
  writeMap('D2C', d2c)
  writeMap('C2D', c2d)
  out.end()
}

const main = async () => {
  const d2cNd = join(INPUT_DIR, 'd2c_transfers.ndjson')
  const d2cCsv = join(INPUT_DIR, 'd2c_transfers.csv')
  const c2dNd = join(INPUT_DIR, 'c2d_transfers.ndjson')
  const c2dCsv = join(INPUT_DIR, 'c2d_transfers.csv')

  const d2cPath = existsSync(d2cNd) ? d2cNd : existsSync(d2cCsv) ? d2cCsv : null
  const c2dPath = existsSync(c2dNd) ? c2dNd : existsSync(c2dCsv) ? c2dCsv : null
  if (!d2cPath || !c2dPath) {
    throw new Error(`Expected d2c and c2d artifacts under ${INPUT_DIR}`)
  }

  const [d2cCounts, c2dCounts] = await Promise.all([
    aggregateFile(d2cPath, 'D2C'),
    aggregateFile(c2dPath, 'C2D'),
  ])

  const totalD2C = Object.values(d2cCounts).reduce((a, b) => a + b, 0)
  const totalC2D = Object.values(c2dCounts).reduce((a, b) => a + b, 0)

  const jsonOutPath = join(INPUT_DIR, 'counts_per_wallet.json')
  const csvOutPath = join(INPUT_DIR, 'counts_per_wallet.csv')

  writeFileSync(
    jsonOutPath,
    JSON.stringify(
      {
        inputDir: INPUT_DIR,
        totals: { d2c: totalD2C, c2d: totalC2D },
        d2c: d2cCounts,
        c2d: c2dCounts,
      },
      null,
      2,
    ),
  )
  writeCountsCsv(csvOutPath, d2cCounts, c2dCounts)

  // Update manifest with counts artifacts if present
  try {
    const manifestPath = join(INPUT_DIR, 'manifest.json')
    const manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestRaw.artifacts = manifestRaw.artifacts || {}
    manifestRaw.artifacts.counts = {
      json: { path: relative(INPUT_DIR, jsonOutPath) },
      csv: { path: relative(INPUT_DIR, csvOutPath) },
    }
    writeFileSync(manifestPath, JSON.stringify(manifestRaw, null, 2))
  } catch {
    console.error('[counts] Failed to update manifest')
  }

  console.log(
    JSON.stringify(
      {
        message: '[counts] Done',
        inputDir: INPUT_DIR,
        artifacts: {
          json: relative(INPUT_DIR, jsonOutPath),
          csv: relative(INPUT_DIR, csvOutPath),
        },
        totals: { d2c: totalD2C, c2d: totalC2D },
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
