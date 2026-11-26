import type { BiliIdentity } from './biliHistory'
import type { FeedItem } from './feedService'
import type { GatewayConnection } from './gatewayTransport'

import { freezeGatewayConnection, GatewayError } from './gatewayTransport'

export interface BiliFavoriteFolder {
  id: string
  title: string
  mediaCount: number
  isPrivate: boolean
}

export interface BiliFavoriteFolders {
  mid: string
  revision: string
  folders: BiliFavoriteFolder[]
}

export interface BiliFavoriteVideos {
  mid: string
  revision: string
  folderId: string
  page: number
  items: FeedItem[]
  hasMore: boolean
  notice?: string
}

function invalid(): never {
  throw new Error('收藏接口返回的数据不完整，请重试或更新网关。')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') return invalid()
  return value
}

function positiveId(value: unknown): string {
  const id = text(value)
  if (!/^[1-9]\d*$/.test(id)) return invalid()
  return id
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid()
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

function freezeIdentity(identity: BiliIdentity): BiliIdentity {
  const mid = positiveId(identity.mid)
  const revision = text(identity.revision)
  if (!revision) return invalid()
  return Object.freeze({ mid, revision })
}

function envelope(value: unknown, identity: BiliIdentity) {
  const data = record(value)
  if (text(data.mid) !== identity.mid || text(data.revision) !== identity.revision) {
    throw new GatewayError('账号已变化，请重新获取收藏。', 409)
  }
  return data
}

export function parseBiliFavoriteFolders(value: unknown, identity: BiliIdentity): BiliFavoriteFolders {
  const data = envelope(value, identity)
  if (!Array.isArray(data.folders)) return invalid()
  const ids = new Set<string>()
  const folders = data.folders.map((value) => {
    const folder = record(value)
    const id = positiveId(folder.id)
    if (ids.has(id)) return invalid()
    ids.add(id)
    return { id, title: text(folder.title), mediaCount: integer(folder.mediaCount, 0), isPrivate: boolean(folder.isPrivate) }
  })
  return { mid: identity.mid, revision: identity.revision, folders }
}

function parseItem(value: unknown): FeedItem {
  const item = record(value)
  const bvid = text(item.bvid)
  if (!/^BV[\dA-Za-z]{10}$/.test(bvid) || item.id !== `favorites:${bvid}` || item.source !== 'favorites') return invalid()
  const url = text(item.url)
  if (url !== `https://www.bilibili.com/video/${bvid}` && url !== `https://www.bilibili.com/video/${bvid}/`) return invalid()
  const result: FeedItem = { id: `favorites:${bvid}`, source: 'favorites', bvid, title: text(item.title), url }
  for (const key of ['author', 'stat', 'publishedAt'] as const) {
    if (item[key] !== undefined) result[key] = text(item[key])
  }
  if (item.cover !== undefined) {
    text(item.cover)
    // Never forward arbitrary image addresses or query parameters to the cover loader.
    result.cover = `/v1/media/cover?bvid=${bvid}`
  }
  if (item.durationSec !== undefined) {
    if (typeof item.durationSec !== 'number' || !Number.isFinite(item.durationSec) || item.durationSec < 0) return invalid()
    result.durationSec = item.durationSec
  }
  if (item.cid !== undefined) result.cid = integer(item.cid, 1)
  return result
}

export function parseBiliFavoriteVideos(value: unknown, identity: BiliIdentity, folderId: string, page: number): BiliFavoriteVideos {
  const data = envelope(value, identity)
  if (positiveId(data.folderId) !== folderId || integer(data.page, 1) !== page || !Array.isArray(data.items)) return invalid()
  return {
    mid: identity.mid,
    revision: identity.revision,
    folderId,
    page,
    items: data.items.map(parseItem),
    hasMore: boolean(data.hasMore),
    ...(data.notice === undefined ? {} : { notice: text(data.notice) }),
  }
}

/** Inject only the transport; production and tests share request capture and decoding. */
export function createBiliFavoritesClient(request: (path: string, connection: GatewayConnection) => Promise<unknown>) {
  return {
    async folders(identity: BiliIdentity, connection: GatewayConnection): Promise<BiliFavoriteFolders> {
      const frozenIdentity = freezeIdentity(identity)
      const frozenConnection = freezeGatewayConnection(connection)
      const query = new URLSearchParams({ ...frozenIdentity })
      return parseBiliFavoriteFolders(await request(`/v1/bili/favorites/folders?${query}`, frozenConnection), frozenIdentity)
    },
    async videos(identity: BiliIdentity, connection: GatewayConnection, folderId: string, page = 1): Promise<BiliFavoriteVideos> {
      const frozenIdentity = freezeIdentity(identity)
      const frozenConnection = freezeGatewayConnection(connection)
      const query = new URLSearchParams({ ...frozenIdentity, folderId: positiveId(folderId), page: String(integer(page, 1)) })
      return parseBiliFavoriteVideos(await request(`/v1/bili/favorites/videos?${query}`, frozenConnection), frozenIdentity, folderId, page)
    },
  }
}
