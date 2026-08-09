import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'

export type NewsScope = 'market' | 'briefing' | 'security'
export type NewsSort = 'default' | 'newest' | 'oldest'
export type NewsTimeRange = '1d' | '3d' | '7d' | 'all'
export type NewsDepth = 'compact' | 'standard' | 'extended'
export type NewsType = 'news' | 'announcement' | 'report' | 'external'

export interface NewsSecurityContext {
  code: string
  name: string
}

export interface NewsSearchRequest {
  scope: NewsScope
  preset: string
  query?: string
  security?: NewsSecurityContext
  timeRange: NewsTimeRange
  sort: NewsSort
  depth: NewsDepth
  types: NewsType[]
}

export interface NewsItem {
  id: string
  title: string
  summary: string
  publishedAt?: string
  source: string
  type: NewsType
  url?: string
}

export interface NewsSearchResult {
  items: NewsItem[]
  outOfRangeItems: NewsItem[]
  stats: {
    upstreamCount: number
    duplicateCount: number
    outOfRangeCount: number
    filteredTypeCount: number
    returnedCount: number
  }
  meta: {
    provider: 'mx-news-search'
    sort: NewsSort
    timeRange: NewsTimeRange
    depth: NewsDepth
    retrievedAt: string
    cached: boolean
  }
}

interface GatewayResponse {
  status: number
  body: string
}

export async function fetchNews(request: NewsSearchRequest): Promise<NewsSearchResult> {
  const settings = useMarketStore()
  const response = await invoke<GatewayResponse>(INVOKE_KEY.MARKET_REQUEST, {
    request: {
      baseUrl: settings.external.baseUrl,
      path: '/v1/news/search',
      method: 'POST',
      body: request,
      bearerToken: settings.bearerToken.trim() || null,
      timeoutMs: Math.max(settings.external.timeoutMs, 20_000),
    },
  })

  let payload: unknown
  try {
    payload = response.body ? JSON.parse(response.body) as unknown : {}
  } catch {
    throw new Error('资讯服务返回的不是有效 JSON')
  }

  if (response.status < 200 || response.status >= 300) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `资讯服务返回 HTTP ${response.status}`
    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as NewsSearchResult).items)) {
    throw new Error('资讯服务返回格式无效')
  }
  return payload as NewsSearchResult
}
