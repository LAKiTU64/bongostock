import type { BiliHistoryPage, BiliIdentity, BiliProgressReport, BiliSessionStatus } from './biliHistory'
import type { GatewayConnection } from './gatewayTransport'

import { requestGateway } from './gatewayRequest'

export type { BiliSessionStatus } from './biliHistory'

export interface BiliQrcode {
  key: string
  url: string
}

export interface BiliPollResult {
  status: 'waiting' | 'scanned' | 'success' | 'expired'
  message?: string
}

export const fetchBiliStatus = (connection?: GatewayConnection) => requestGateway<BiliSessionStatus>('/v1/bili/status', 'GET', null, connection)
export const generateBiliQrcode = (connection?: GatewayConnection) => requestGateway<BiliQrcode>('/v1/bili/qrcode', 'GET', null, connection)
export const pollBiliQrcode = (key: string, connection?: GatewayConnection) => requestGateway<BiliPollResult>(`/v1/bili/qrcode/poll?key=${encodeURIComponent(key)}`, 'GET', null, connection)
export const logoutBili = (connection?: GatewayConnection) => requestGateway<{ ok: boolean }>('/v1/bili/session', 'DELETE', null, connection)

export function fetchBiliHistory(identity: BiliIdentity, connection: GatewayConnection, cursor?: string) {
  const query = new URLSearchParams({ mid: identity.mid, revision: identity.revision })
  if (cursor) query.set('cursor', cursor)
  return requestGateway<BiliHistoryPage>(`/v1/bili/history?${query}`, 'GET', null, connection)
}

export function reportBiliProgress(report: BiliProgressReport, connection: GatewayConnection) {
  return requestGateway<{ ok: true }>('/v1/bili/progress', 'POST', report, connection)
}
