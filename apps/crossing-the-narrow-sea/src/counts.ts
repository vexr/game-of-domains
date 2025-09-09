import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

interface TransferRow {
  direction: 'd2c' | 'c2d'
  from: string
}

interface CountsResult {
  d2c: Record<string, number>
  c2d: Record<string, number>
  totals: { d2c: number; c2d: number; overall: number }
  files: { d2c_transfers: string; c2d_transfers: string }
  output_dir: string
  generated_at: string
}

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'exports'

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

const readNdjsonCounts = async (
  filePath: string,
  expectedDirection: 'd2c' | 'c2d',
): Promise<{ counts: Record<string, number>; total: number }> => {
  const counts: Record<string, number> = {}
  let total = 0

  if (!fs.existsSync(filePath)) {
    return { counts, total }
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed) as Partial<TransferRow>
      if (!row || row.direction !== expectedDirection) continue
      const from = String(row.from || '')
      if (!from) continue
      counts[from] = (counts[from] ?? 0) + 1
      total += 1
    } catch {
      // skip malformed line
    }
  }

  return { counts, total }
}

const writeJsonFile = (filePath: string, data: unknown): void => {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

const main = async () => {
  const outDirAbs = path.resolve(OUTPUT_DIR)
  const d2cPath = path.resolve(outDirAbs, 'd2c_transfers.ndjson')
  const c2dPath = path.resolve(outDirAbs, 'c2d_transfers.ndjson')

  const [{ counts: d2cCounts, total: d2cTotal }, { counts: c2dCounts, total: c2dTotal }] =
    await Promise.all([readNdjsonCounts(d2cPath, 'd2c'), readNdjsonCounts(c2dPath, 'c2d')])

  const result: CountsResult = {
    d2c: d2cCounts,
    c2d: c2dCounts,
    totals: { d2c: d2cTotal, c2d: c2dTotal, overall: d2cTotal + c2dTotal },
    files: { d2c_transfers: d2cPath, c2d_transfers: c2dPath },
    output_dir: outDirAbs,
    generated_at: new Date().toISOString(),
  }

  const countsFile = path.resolve(outDirAbs, 'counts_per_wallet.json')
  writeJsonFile(countsFile, result)

  console.log(JSON.stringify({ counts_file: countsFile, ...result }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
