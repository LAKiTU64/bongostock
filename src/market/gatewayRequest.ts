import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'

import type { GatewayConnection, GatewayResponse } from './gatewayTransport'

import { decodeGatewayResponse, freezeGatewayConnection, gatewayRequestPayload } from './gatewayTransport'

export function captureGatewayConnection(): GatewayConnection {
  const settings = useMarketStore()
  return freezeGatewayConnection({
    baseUrl: settings.external.baseUrl,
    bearerToken: settings.bearerToken,
    timeoutMs: settings.external.timeoutMs,
  })
}

/** JSON uses the native transport. A playback request always passes its frozen connection. */
export async function requestGateway<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body: unknown = null,
  connection: GatewayConnection = captureGatewayConnection(),
): Promise<T> {
  const result = await invoke<GatewayResponse>(INVOKE_KEY.MARKET_REQUEST, {
    request: gatewayRequestPayload(connection, path, method, body),
  })
  return decodeGatewayResponse<T>(result)
}
