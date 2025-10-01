import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { openDb } from './sqlite'

interface MatchedTransferRow {
  direction: 'd2c' | 'c2d'
  from: string
  channel_id: number
  nonce: string
  amount: string
  source_block_height: number
  source_block_hash: string
  source_extrinsic_index: number | null
  dest_block_height: number | null
  dest_block_hash: string | null
}

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'exports'
const DB_PATH = `${OUTPUT_DIR}/xdm.sqlite`

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

const writeNdjson = (filePath: string, rows: Iterable<MatchedTransferRow>): number => {
  ensureDir(path.dirname(filePath))
  const fd = fs.openSync(filePath, 'w')
  let count = 0
  for (const row of rows) {
    fs.writeSync(fd, JSON.stringify(row) + '\n')
    count += 1
  }
  fs.closeSync(fd)
  return count
}

const asBoolean = (v: any): boolean => v != null && v !== 0 && String(v) !== ''

const buildIterator = (
  sql: string,
  params: any[],
  direction: 'd2c' | 'c2d',
): Iterable<MatchedTransferRow> => {
  const db = openDb(DB_PATH)
  const stmt = db.prepare(sql)
  const iter = stmt.iterate(...params) as Iterable<any>

  const mapped: Iterable<MatchedTransferRow> = {
    [Symbol.iterator]: function* () {
      try {
        for (const r of iter as any) {
          const destOk = asBoolean(r.dest_present)

          // Only include transfers with destination success
          if (!destOk) continue

          yield {
            direction,
            from: r.from_address || '',
            channel_id: Number(r.channel_id),
            nonce: String(r.nonce),
            amount: String(r.dest_amount ?? r.amount ?? '0'),
            source_block_height: Number(r.source_block_height),
            source_block_hash: String(r.source_block_hash || ''),
            source_extrinsic_index:
              r.source_extrinsic_index != null ? Number(r.source_extrinsic_index) : null,
            dest_block_height:
              r.destination_block_height != null ? Number(r.destination_block_height) : null,
            dest_block_hash:
              r.destination_block_hash != null ? String(r.destination_block_hash) : null,
          }
        }
      } finally {
        try {
          // Close DB when iteration completes or is interrupted
          // @ts-ignore better-sqlite3 Database has close method
          ;(db as any).close?.()
        } catch {
          // ignore close errors
        }
      }
    },
  }

  return mapped
}

const main = async () => {
  const d2cSql = `
    SELECT
      i.from_address,
      i.channel_id,
      i.nonce,
      i.amount,
      i.source_block_height,
      i.source_block_hash,
      i.source_extrinsic_index,
      ds.amount AS dest_amount,
      ds.destination_block_height,
      ds.destination_block_hash,
      CASE WHEN ds.destination_chain IS NOT NULL THEN 1 ELSE NULL END AS dest_present
    FROM source_inits i
    LEFT JOIN destination_successes ds
      ON ds.channel_id = i.channel_id AND ds.nonce = i.nonce AND ds.destination_chain = 'consensus'
    WHERE i.source_chain = 'domain'
  `

  const c2dSql = `
    SELECT
      i.from_address,
      i.channel_id,
      i.nonce,
      i.amount,
      i.source_block_height,
      i.source_block_hash,
      i.source_extrinsic_index,
      ds.amount AS dest_amount,
      ds.destination_block_height,
      ds.destination_block_hash,
      CASE WHEN ds.destination_chain IS NOT NULL THEN 1 ELSE NULL END AS dest_present
    FROM source_inits i
    LEFT JOIN destination_successes ds
      ON ds.channel_id = i.channel_id AND ds.nonce = i.nonce AND ds.destination_chain = 'domain'
    WHERE i.source_chain = 'consensus'
  `

  const d2cRows = buildIterator(d2cSql, [], 'd2c')
  const c2dRows = buildIterator(c2dSql, [], 'c2d')

  const d2cPath = path.resolve(OUTPUT_DIR, 'd2c_transfers.ndjson')
  const c2dPath = path.resolve(OUTPUT_DIR, 'c2d_transfers.ndjson')

  const d2cCount = writeNdjson(d2cPath, d2cRows)
  const c2dCount = writeNdjson(c2dPath, c2dRows)

  console.log(
    JSON.stringify(
      {
        output_dir: OUTPUT_DIR,
        db_path: DB_PATH,
        files: {
          d2c_transfers: d2cPath,
          c2d_transfers: c2dPath,
        },
        counts: {
          d2c: d2cCount,
          c2d: c2dCount,
          total: d2cCount + c2dCount,
        },
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
