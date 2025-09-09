import { upsertSourceInit, upsertDestinationSuccess, upsertSourceAck } from './sqlite'

export type ChainLabel = 'consensus' | 'domain'

export const asNumber = (v: any): number => {
  if (v?.toNumber) return v.toNumber()
  const s = v?.toString ? v.toString() : v
  const n = Number(s)
  return Number.isNaN(n) ? 0 : n
}

export const asString = (v: any): string => (v?.toString ? v.toString() : String(v))

export const extractAmountFromCall = (extrinsic: any): string | null => {
  try {
    const method = extrinsic?.method
    if (!method) return null
    const sec = method.section
    if (sec !== 'transporter') return null
    const metaArgs: any[] | undefined = (method as any).meta?.args as any
    if (Array.isArray(metaArgs)) {
      const idx = metaArgs.findIndex((a: any) => String(a?.name) === 'amount')
      if (idx >= 0) {
        const val = method.args?.[idx]
        return val != null ? asString(val) : null
      }
    }
    const last = method.args?.[method.args.length - 1]
    return last != null ? asString(last) : null
  } catch {
    return null
  }
}

export const processXdmEvents = (params: {
  db: any
  chain: ChainLabel
  events: any[]
  extrinsics: any[]
  blockHeight: number
  blockHash: string
  logPrefix: string
}): void => {
  const { db, chain, events, extrinsics, blockHeight, blockHash, logPrefix } = params

  for (const [, record] of events.entries()) {
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
        `${logPrefix} OutgoingTransferInitiated`,
        asNumber(dstChainId),
        asNumber(channelId),
        asString(nonce),
        amount,
        signer,
      )
      upsertSourceInit(db, {
        // Not used; kept for compatibility when directly importing sqlite in callers
        source_chain: chain,
        dst_chain_id: asNumber(dstChainId),
        channel_id: asNumber(channelId),
        nonce: asString(nonce),
        from_address: signer,
        amount,
        source_block_height: blockHeight,
        source_block_hash: blockHash,
        source_extrinsic_index: extrinsicIndex,
      } as any)
    }

    if (section === 'transporter' && method === 'IncomingTransferSuccessful') {
      const [srcChainId, messageId] = event.data as any
      const amountField = (event.data as any[])[2]
      const amount = amountField != null ? asString(amountField) : '0'
      const [channelId, nonce] = messageId as any
      console.log(
        `${logPrefix} IncomingTransferSuccessful`,
        asNumber(srcChainId),
        asNumber(channelId),
        asString(nonce),
        amount,
      )
      upsertDestinationSuccess(db, {
        destination_chain: chain,
        src_chain_id: asNumber(srcChainId),
        channel_id: asNumber(channelId),
        nonce: asString(nonce),
        amount,
        destination_block_height: blockHeight,
        destination_block_hash: blockHash,
      } as any)
    }

    if (section === 'messenger' && method === 'OutboxMessageResult') {
      const [dstChainId, channelId, nonce, result] = event.data as any
      const isOk = (result?.isOk ?? String(result) === 'Ok') ? 'Ok' : 'Err'
      upsertSourceAck(db, {
        source_chain: chain,
        dst_chain_id: asNumber(dstChainId),
        channel_id: asNumber(channelId),
        nonce: asString(nonce),
        result: isOk as 'Ok' | 'Err',
        source_block_height: blockHeight,
        source_block_hash: blockHash,
      } as any)
    }
  }
}
