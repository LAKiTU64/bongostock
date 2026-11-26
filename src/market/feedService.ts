import type { GatewayConnection } from './gatewayTransport'

import { requestGateway } from './gatewayRequest'

export const FEED_SOURCES = [
  { key: 'rcmd', label: '推荐' },
  { key: 'weekly', label: '每周必看' },
  { key: 'rank', label: '排行' },
  { key: 'dynamic', label: '关注' },
] as const

export type FeedSource = typeof FEED_SOURCES[number]['key']

export interface FeedItem {
  id: string
  source: string
  title: string
  url: string
  cover?: string
  author?: string
  stat?: string
  durationSec?: number
  publishedAt?: string
  bvid?: string
  cid?: number
}

export interface VideoPart {
  cid: number
  page: number
  title: string
  durationSec: number
}

export interface VideoParts {
  bvid: string
  parts: VideoPart[]
}

export async function fetchVideoParts(bvid: string, connection?: GatewayConnection): Promise<VideoParts> {
  return requestGateway<VideoParts>(`/v1/bili/parts?${new URLSearchParams({ bvid })}`, 'GET', null, connection)
}

export interface FeedPage {
  items: FeedItem[]
  source: string
  page: number
  size: number
  hasMore: boolean
  nextCursor?: string
  notice?: string
  fallbackSource?: string
  cached: boolean
  retrievedAt: string
}

export async function fetchFeeds(source: FeedSource, page = 1, options: { cursor?: string, refresh?: boolean } = {}): Promise<FeedPage> {
  const query = new URLSearchParams({ source, page: String(page), size: '20' })
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.refresh) query.set('refresh', '1')
  return requestGateway<FeedPage>(`/v1/feeds?${query}`)
}
