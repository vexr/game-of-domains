import { ApiPromise, WsProvider } from '@polkadot/api'

let apiInstance: ApiPromise | null = null
let providerInstance: WsProvider | null = null

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
  })

  provider.on('error', (err) => {
    console.error({ err }, 'chain provider error')
    // Do not tear down; allow WsProvider to auto-rotate/retry
  })

  return providerInstance
}

export const getApi = async (rpcEndpoints: string[]): Promise<ApiPromise> => {
  if (apiInstance && apiInstance.isConnected) {
    return apiInstance
  }

  const provider = getOrCreateProvider(rpcEndpoints)

  if (!apiInstance) {
    apiInstance = await ApiPromise.create({ provider })

    apiInstance.on('error', (err) => {
      console.error({ err }, 'chain api error')
      // Keep provider alive; ApiPromise will recover when provider reconnects
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

export const getFinalizedHeadAndHeader = async (api: ApiPromise) => {
  const head = await api.rpc.chain.getFinalizedHead()
  const header = await api.rpc.chain.getHeader(head)
  return { head, header }
}

export const getEventsAt = async (api: ApiPromise, hash: any, useSegments: boolean) => {
  if (useSegments && (api.query as any)?.system?.eventSegments) {
    const segments = await (api.query as any).system.eventSegments.at(hash)
    const flat = [] as any[]
    for (const seg of segments as any[]) {
      for (const e of (seg?.events || seg) as any[]) flat.push(e)
    }
    return flat
  }
  return api.query.system.events.at(hash)
}
