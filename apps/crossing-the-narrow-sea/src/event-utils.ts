import {
  upsertSourceInit,
  upsertDestinationSuccess,
  upsertSourceAck,
  insertEventFailure,
} from './sqlite'

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
    try {
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
        // Guard: eventSegments may report an extrinsic index that is out of range of block.extrinsics
        if (
          extrinsicIndex != null &&
          (extrinsicIndex < 0 || extrinsicIndex >= (extrinsics?.length ?? 0))
        ) {
          insertEventFailure(db, {
            chain,
            block_height: blockHeight,
            block_hash: blockHash,
            extrinsic_index: extrinsicIndex,
            section,
            method,
            reason: 'extrinsic_index_out_of_range',
          } as any)
          console.warn(
            `${logPrefix} extrinsic index out of range for event method=${method} extrinsicId=${blockHeight}:${extrinsicIndex} extrinsics_count=${extrinsics?.length ?? 0}`,
          )
          continue
        }
        let signer = ''
        try {
          const anyExt = extrinsic as any
          const signedFlag =
            typeof anyExt?.isSigned === 'function' ? anyExt.isSigned() : !!anyExt?.isSigned
          if (signedFlag) {
            signer = anyExt?.signer?.toString?.() || ''
          }
        } catch (_e) {
          void _e
        }

        if (!signer) {
          insertEventFailure(db, {
            chain,
            block_height: blockHeight,
            block_hash: blockHash,
            extrinsic_index: extrinsicIndex,
            section,
            method,
            reason: 'unsigned_or_signer_unavailable',
          } as any)
          console.warn(
            `${logPrefix} unsigned or missing signer method=${method} extrinsicId=${blockHeight}:${extrinsicIndex}`,
          )
          continue
        }
        upsertSourceInit(db, {
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
    } catch (err) {
      const rec = record as any
      const evt = rec?.event
      const phase = rec?.phase
      const section = evt?.section || ''
      const method = evt?.method || ''
      const extrinsicIndex = phase?.isApplyExtrinsic
        ? (phase.asApplyExtrinsic.toNumber?.() ?? Number(phase.asApplyExtrinsic))
        : null
      insertEventFailure(db, {
        chain,
        block_height: blockHeight,
        block_hash: blockHash,
        extrinsic_index: extrinsicIndex,
        section,
        method,
        reason: 'unexpected_error',
        details: (err as Error)?.message || String(err),
      } as any)
      console.warn(
        `${logPrefix} unexpected error parsing event method=${method} extrinsicId=${blockHeight}:${extrinsicIndex}`,
        err,
      )
      continue
    }
  }
}
