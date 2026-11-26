import type { FeedItem } from './feedService'
import type { GatewayConnection } from './gatewayTransport'
import type { VideoProgress } from './videoHistory'

import { freezeGatewayConnection, GatewayError, normalizeGatewayUrl } from './gatewayTransport'
import { formatVideoTime } from './videoHistory'

export const DEVICE_HISTORY_SCOPE = 'device'

export interface BiliSessionStatus {
  logged: boolean
  nickname?: string
  mid?: string
  revision?: string
}

export interface BiliIdentity {
  readonly mid: string
  readonly revision: string
}

export interface PlaybackContext {
  readonly connection: GatewayConnection
  readonly identity?: BiliIdentity
  readonly scope: string
}

export interface BiliHistoryItem {
  bvid: string
  cid: number
  title: string
  author: string
  page: number
  partTitle: string
  positionSec: number
  completed: boolean
  watchedAtMs: number
  /** Display only: this can be the whole video's duration, not the selected P. */
  durationSec: number
  cover: string
}

export interface BiliHistoryPage {
  mid: string
  revision: string
  items: BiliHistoryItem[]
  hasMore: boolean
  nextCursor?: string
}

export interface BiliProgressReport {
  mid: string
  revision: string
  bvid: string
  cid: number
  positionSec: number
  realtimeSec: number
  completed: boolean
  startTs: number
}

export function biliIdentity(status: BiliSessionStatus): BiliIdentity | undefined {
  return status.logged && typeof status.mid === 'string' && /^[1-9]\d*$/.test(status.mid)
    && typeof status.revision === 'string' && status.revision.length > 0
    ? Object.freeze({ mid: status.mid, revision: status.revision })
    : undefined
}

export function accountHistoryScope(baseUrl: string, mid: string): string {
  return JSON.stringify([normalizeGatewayUrl(baseUrl), mid])
}

export function createPlaybackContext(connection: GatewayConnection, status: BiliSessionStatus, deviceOnly = false): PlaybackContext {
  const frozen = freezeGatewayConnection(connection)
  const identity = deviceOnly ? undefined : biliIdentity(status)
  return Object.freeze({
    connection: frozen,
    identity,
    scope: identity ? accountHistoryScope(frozen.baseUrl, identity.mid) : DEVICE_HISTORY_SCOPE,
  })
}

/** Invalidating an epoch makes all old status/history results inert, even if they finish later. */
export function createRequestEpoch() {
  let value = 0
  return {
    next: () => ++value,
    current: () => value,
    accepts: (request: number) => request === value,
  }
}

export function samePlaybackContext(a: PlaybackContext | undefined, b: PlaybackContext | undefined): boolean {
  return a?.connection.baseUrl === b?.connection.baseUrl
    && a?.connection.bearerToken === b?.connection.bearerToken
    && a?.identity?.mid === b?.identity?.mid
    && a?.identity?.revision === b?.identity?.revision
    && a?.scope === b?.scope
}

/** Do not put cloud rows in the persisted per-P store. */
export function mergeCloudHistory(previous: readonly BiliHistoryItem[], page: BiliHistoryPage, identity: BiliIdentity): BiliHistoryItem[] {
  if (page.mid !== identity.mid || page.revision !== identity.revision) {
    throw new GatewayError('账号已变化，请重新获取历史。', 409)
  }
  const byPart = new Map<string, BiliHistoryItem>()
  for (const item of [...previous, ...page.items]) {
    if (!/^BV[\dA-Za-z]{10}$/.test(item.bvid) || !Number.isSafeInteger(item.cid) || item.cid <= 0
      || !Number.isFinite(item.positionSec) || item.positionSec < 0
      || !Number.isFinite(item.watchedAtMs) || item.watchedAtMs <= 0) {
      continue
    }
    const key = `${item.bvid}:${item.cid}`
    const old = byPart.get(key)
    if (!old || item.watchedAtMs > old.watchedAtMs) byPart.set(key, { ...item, cover: `/v1/media/cover?bvid=${item.bvid}` })
  }
  return [...byPart.values()].sort((a, b) => b.watchedAtMs - a.watchedAtMs).slice(0, 1000)
}

export function cloudPartResume(cloud: BiliHistoryItem | undefined): Pick<VideoProgress, 'position' | 'completed'> | undefined {
  return cloud ? { position: cloud.positionSec, completed: cloud.completed } : undefined
}

export function cloudHistoryItems(cloud: readonly BiliHistoryItem[]): FeedItem[] {
  const byVideo = new Map<string, BiliHistoryItem>()
  for (const row of cloud) {
    const old = byVideo.get(row.bvid)
    if (!old || row.watchedAtMs > old.watchedAtMs) byVideo.set(row.bvid, row)
  }
  return [...byVideo.values()].sort((a, b) => b.watchedAtMs - a.watchedAtMs).map(row => ({
    id: `history:${row.bvid}`,
    source: 'history',
    bvid: row.bvid,
    cid: row.cid,
    title: row.title,
    author: row.author,
    url: `https://www.bilibili.com/video/${row.bvid}`,
    cover: row.cover,
    durationSec: row.durationSec,
    stat: row.completed ? `P${row.page} 已看完` : `P${row.page} · ${formatVideoTime(row.positionSec)}`,
  }))
}

export function preferredHistoryCid(item: FeedItem, latest?: { cid: number }): number | undefined {
  return item.source === 'history' ? item.cid : latest?.cid ?? item.cid
}
