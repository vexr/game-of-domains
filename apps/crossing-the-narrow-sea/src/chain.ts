import { ApiPromise, WsProvider } from '@polkadot/api'
import type { EventRecord, Header, Hash } from '@polkadot/types/interfaces'

interface VecLike<T = unknown> {
  toArray: () => T[]
}
interface OptionLike<T = unknown> {
  isSome?: boolean
  isNone?: boolean
  unwrap: () => T
}

interface SystemModuleExtended {
  events: { at: (hash: Hash | string) => Promise<unknown> }
  eventSegments?: {
    at: (hash: Hash | string, index: number) => Promise<unknown>
  }
  eventCount?: { at: (hash: Hash | string) => Promise<unknown> }
}

let apiInstance: ApiPromise | null = null
let providerInstance: WsProvider | null = null
let isReconnecting = false

const getOrCreateProvider = (rpcEndpoints: string[]): WsProvider => {
  if (providerInstance) return providerInstance

  const provider = new WsProvider(rpcEndpoints)
  providerInstance = provider

  provider.on('connected', () => {
    console.info({ endpoints: rpcEndpoints }, 'chain connected')
    console.info({ connectedEndpoint: provider.endpoint }, 'connected endpoint')
  })

  provider.on('disconnected', () => {
    console.warn('chain disconnected')
    // Do not tear down; allow WsProvider to auto-rotate/retry
    void triggerReconnect()
  })

  provider.on('error', (err) => {
    console.error({ err }, 'chain provider error')
    // Do not tear down; allow WsProvider to auto-rotate/retry
    void triggerReconnect()
  })

  return providerInstance
}

const triggerReconnect = async (): Promise<void> => {
  if (!apiInstance || isReconnecting) return
  if (apiInstance.isConnected) return
  isReconnecting = true
  try {
    console.warn('chain api disconnected; attempting reconnect')
    await apiInstance.connect()
    await apiInstance.isReadyOrError
    console.info('chain api reconnected')
  } catch (err) {
    console.warn({ err }, 'chain api reconnect attempt failed; provider will keep retrying')
  } finally {
    isReconnecting = false
  }
}

export const getApi = async (rpcEndpoints: string[]): Promise<ApiPromise> => {
  if (apiInstance) {
    if (apiInstance.isConnected) return apiInstance
    await triggerReconnect()
    await apiInstance.isReadyOrError
    return apiInstance
  }

  const provider = getOrCreateProvider(rpcEndpoints)

  if (!apiInstance) {
    apiInstance = await ApiPromise.create({ provider })

    apiInstance.on('error', (err) => {
      console.error({ err }, 'chain api error')
      // Keep provider alive; ApiPromise will recover when provider reconnects
    })

    apiInstance.on('connected', () => {
      console.info('chain api connected')
    })

    apiInstance.on('disconnected', () => {
      console.warn('chain api disconnected')
      void triggerReconnect()
    })

    await apiInstance.isReadyOrError
    console.info('chain api ready')
  }

  return apiInstance
}

export const disconnectApi = async (): Promise<void> => {
  if (apiInstance) {
    try {
      await apiInstance.disconnect()
    } catch (e) {
      console.warn({ err: e }, 'error disconnecting ApiPromise')
    } finally {
      apiInstance = null
    }
  }

  if (providerInstance) {
    try {
      await providerInstance.disconnect()
    } catch (e) {
      console.warn({ err: e }, 'error disconnecting WsProvider')
    } finally {
      providerInstance = null
    }
  }
}

export const getFinalizedHeadAndHeader = async (
  api: ApiPromise,
): Promise<{ head: Hash; header: Header }> => {
  const head = await api.rpc.chain.getFinalizedHead()
  const header = await api.rpc.chain.getHeader(head)
  return { head, header }
}

export const getEventsAt = async (
  api: ApiPromise,
  hash: Hash | string,
  useSegments: boolean,
): Promise<EventRecord[]> => {
  const system = api.query.system as unknown as SystemModuleExtended
  if (useSegments && system?.eventSegments) {
    try {
      const SEGMENT_SIZE = 100
      // Use storage at block to get precise count (prefer eventCount, fallback to eventsCount)
      const countAny = system?.eventCount?.at ? await system.eventCount.at(hash) : null
      const count = countAny ? Number(countAny) : 0
      const lastIndex = Math.floor((count - 1) / SEGMENT_SIZE)
      const flattened: EventRecord[] = []
      const unwrapSegment = (seg: unknown): EventRecord[] => {
        // Option<Vec<EventRecord>> or Vec<EventRecord>
        const maybeOpt = seg as OptionLike<unknown>
        if (typeof maybeOpt?.unwrap === 'function') {
          // if Option, drop None
          if ((maybeOpt as OptionLike<unknown>).isNone === true) return []
          const unwrapped = maybeOpt.unwrap() as unknown
          const vec = unwrapped as VecLike<EventRecord>
          return typeof vec?.toArray === 'function' ? (vec.toArray() as EventRecord[]) : []
        }
        const vec = seg as VecLike<EventRecord>
        if (typeof vec?.toArray === 'function') return vec.toArray() as EventRecord[]
        return []
      }

      // Fetch indexed segments 0..lastIndex explicitly at this block hash
      for (let i = 0; i <= lastIndex; i++) {
        const segVal = await system.eventSegments.at(hash, i)
        const unwrapped = unwrapSegment(segVal)
        for (const e of unwrapped) flattened.push(e)
      }
      // Return all events from 0..lastIndex without deduplication
      return flattened
    } catch (err) {
      console.warn({ err }, 'getEventsAt: eventSegments fetch failed')
      // Do not fall back to system.events when eventSegments are present
      throw new Error('Failed to fetch eventSegments for block')
    }
  }
  // Use legacy system.events for chains without eventSegments
  const legacy: unknown = await (
    api.query.system.events as unknown as {
      at: (h: Hash | string) => Promise<unknown>
    }
  ).at(hash)
  // Convert Vec<EventRecord> to EventRecord[] if possible
  const unwrapLegacy = (val: unknown): EventRecord[] => {
    const vec = val as VecLike<EventRecord>
    return typeof vec?.toArray === 'function' ? (vec.toArray() as EventRecord[]) : []
  }
  return unwrapLegacy(legacy)
}
