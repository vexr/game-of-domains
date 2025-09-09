import 'dotenv/config'
import { getApi } from './chain'
import {
  openDb,
  upsertSourceInit,
  upsertDestinationSuccess,
  upsertSourceAck,
  getLastProcessedSourceInitHeight,
} from './sqlite'

const CONSENSUS_RPC_URL = process.env.CONSENSUS_RPC_URL as string
const rpcEndpoints = CONSENSUS_RPC_URL.split(',')
const START = Number(process.env.CONSENSUS_START_HEIGHT)
const END = Number(process.env.CONSENSUS_END_HEIGHT)
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'exports'
const DB_PATH = `${OUTPUT_DIR}/xdm.sqlite`
const LOG_EVERY = Number(process.env.LOG_EVERY || 1000)
const RETRY_BACKOFF_MS = Number(process.env.RPC_BACKOFF_MS || 1000)
const RETRY_MAX_BACKOFF_MS = Number(process.env.RPC_MAX_BACKOFF_MS || 10000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const asNumber = (v: any): number => {
  if (v?.toNumber) return v.toNumber()
  const s = v?.toString ? v.toString() : v
  const n = Number(s)
  return Number.isNaN(n) ? 0 : n
}

const asString = (v: any): string => (v?.toString ? v.toString() : String(v))

const extractAmountFromCall = (extrinsic: any): string | null => {
  try {
    const method = extrinsic?.method
    if (!method) return null
    const sec = method.section
    //const name = method.method
    if (sec !== 'transporter') return null
    const metaArgs: any[] | undefined = (method as any).meta?.args as any
    if (Array.isArray(metaArgs)) {
      const idx = metaArgs.findIndex((a: any) => String(a?.name) === 'amount')
      if (idx >= 0) {
        const val = method.args?.[idx]
        return val != null ? asString(val) : null
      }
    }
    // Fallback: common position is last arg
    const last = method.args?.[method.args.length - 1]
    return last != null ? asString(last) : null
  } catch {
    return null
  }
}

const main = async () => {
  if (!rpcEndpoints || !START || !END) {
    throw new Error('CONSENSUS_RPC_URL, CONSENSUS_START_HEIGHT, CONSENSUS_END_HEIGHT are required')
  }

  const api = await getApi(rpcEndpoints)
  const db = openDb(DB_PATH)
  const resumeFrom = getLastProcessedSourceInitHeight(db, 'consensus')
  const scanStart = Math.max(START, (resumeFrom ?? START) + 1)
  const total = END - scanStart + 1
  console.log(
    `[consensus] capture start: heights ${scanStart}..${END} (total ${Math.max(total, 0)})`,
  )

  let backoff = RETRY_BACKOFF_MS
  for (let h = scanStart; h <= END; ) {
    try {
      const hash = await api.rpc.chain.getBlockHash(h)
      const block = await api.rpc.chain.getBlock(hash)
      const events: any[] = (await api.query.system.events.at(hash)) as any
      const extrinsics = block.block.extrinsics
      if (h % 100 === 0) {
        console.log(`[consensus] processing #${h}`)
      }

      for (const [_, record] of events.entries()) {
        const { event, phase } = record as any
        const section = event.section
        const method = event.method

        const extrinsicIndex = phase.isApplyExtrinsic
          ? (phase.asApplyExtrinsic.toNumber?.() ?? Number(phase.asApplyExtrinsic))
          : null
        const extrinsic = extrinsicIndex != null ? extrinsics[extrinsicIndex] : undefined

        if (section === 'transporter' && method === 'OutgoingTransferInitiated') {
          const [dstChainId, messageId] = event.data as any
          const amountField = (event.data as any[])[2]
          const amount =
            amountField != null ? asString(amountField) : extractAmountFromCall(extrinsic) || '0'
          const [channelId, nonce] = messageId as any
          const signer = extrinsic?.signer?.toString?.() || ''
          console.log(
            'OutgoingTransferInitiated',
            asNumber(dstChainId),
            asNumber(channelId),
            asString(nonce),
            amount,
            signer,
          )
          upsertSourceInit(db, {
            source_chain: 'consensus',
            dst_chain_id: asNumber(dstChainId),
            channel_id: asNumber(channelId),
            nonce: asString(nonce),
            from_address: signer,
            amount,
            source_block_height: h,
            source_block_hash: hash.toString(),
            source_extrinsic_index: extrinsicIndex,
          })
        }

        if (section === 'transporter' && method === 'IncomingTransferSuccessful') {
          const [srcChainId, messageId] = event.data as any
          const amountField = (event.data as any[])[2]
          const amount = amountField != null ? asString(amountField) : '0'
          const [channelId, nonce] = messageId as any
          console.log(
            'IncomingTransferSuccessful',
            asNumber(srcChainId),
            asNumber(channelId),
            asString(nonce),
            amount,
          )
          upsertDestinationSuccess(db, {
            destination_chain: 'consensus',
            src_chain_id: asNumber(srcChainId),
            channel_id: asNumber(channelId),
            nonce: asString(nonce),
            amount,
            destination_block_height: h,
            destination_block_hash: hash.toString(),
          })
        }

        if (section === 'messenger' && method === 'OutboxMessageResult') {
          const [dstChainId, channelId, nonce, result] = event.data as any
          const isOk = (result?.isOk ?? String(result) === 'Ok') ? 'Ok' : 'Err'
          console.log(
            'OutboxMessageResult',
            asNumber(dstChainId),
            asNumber(channelId),
            asString(nonce),
            isOk,
          )
          upsertSourceAck(db, {
            source_chain: 'consensus',
            dst_chain_id: asNumber(dstChainId),
            channel_id: asNumber(channelId),
            nonce: asString(nonce),
            result: isOk as 'Ok' | 'Err',
            source_block_height: h,
            source_block_hash: hash.toString(),
          })
        }
      }

      const processed = h - scanStart + 1
      if (processed % LOG_EVERY === 0 || h === END) {
        const pct = Math.floor((processed * 100) / total)
        console.log(`[consensus] processed ${processed}/${total} (${pct}%) at #${h}`)
      }
      h += 1
      backoff = RETRY_BACKOFF_MS
    } catch (err) {
      const msg = (err as Error)?.message || String(err)
      console.warn(`[consensus] error at #${h}: ${msg}. retrying in ${backoff}ms`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, RETRY_MAX_BACKOFF_MS)
      // retry same height
    }
  }
  console.log('[consensus] capture complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
