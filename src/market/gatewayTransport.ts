export interface GatewayConnection {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly timeoutMs: number
}

export interface GatewayResponse {
  status: number
  body: string
}

export class GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

/** Canonical address for both requests and account scopes. Never retain URL credentials. */
export function normalizeGatewayUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是无账号、查询参数和片段的 HTTP(S) 地址。')
  }
  return url.toString().replace(/\/+$/, '')
}

export function freezeGatewayConnection(value: GatewayConnection): GatewayConnection {
  return Object.freeze({
    baseUrl: normalizeGatewayUrl(value.baseUrl),
    bearerToken: value.bearerToken.trim(),
    timeoutMs: Math.min(30_000, Math.max(1000, Number.isFinite(value.timeoutMs) ? value.timeoutMs : 8000)),
  })
}

export function gatewayRequestPayload(connection: GatewayConnection, path: string, method: 'GET' | 'POST' | 'DELETE', body: unknown = null) {
  return {
    baseUrl: connection.baseUrl,
    path,
    method,
    body,
    bearerToken: connection.bearerToken || null,
    timeoutMs: connection.timeoutMs,
  }
}

export function decodeGatewayResponse<T>(result: GatewayResponse): T {
  let payload: unknown
  try {
    payload = result.body ? JSON.parse(result.body) : {}
  } catch {
    throw new GatewayError(`网关返回的不是有效 JSON（HTTP ${result.status}）`, result.status)
  }
  if (result.status < 200 || result.status >= 300) {
    if (result.status === 401) throw new GatewayError('网关 Token 无效，请在设置中检查 Bearer Token。', 401)
    const error = (payload as { error?: unknown } | null)?.error
    throw new GatewayError(typeof error === 'string' ? error : `网关返回 HTTP ${result.status}`, result.status)
  }
  return payload as T
}

export function isBiliIdentityError(error: unknown): boolean {
  return error instanceof GatewayError && (error.status === 403 || error.status === 409)
}
