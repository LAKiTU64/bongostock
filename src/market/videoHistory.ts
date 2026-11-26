import type { FeedItem } from './feedService'

import { normalizeGatewayUrl } from './gatewayTransport'

export interface VideoProgress {
  /** Missing scopes in old files belong only to this device, never to the next login. */
  scope?: string
  bvid: string
  cid: number
  title: string
  author: string
  page: number
  partTitle: string
  position: number
  duration: number
  watchedAt: number
  completed: boolean
}

export const MAX_HISTORY_VIDEOS = 200
export const MAX_HISTORY_PARTS = 1000
const BVID_PATTERN = /^BV[\dA-Za-z]{10}$/

/** Only canonical gateway + account IDs may be persisted; tokens/revisions never are. */
export function sanitizeHistoryScope(value: unknown): string | undefined {
  if (value === undefined || value === 'device') return 'device'
  if (typeof value !== 'string') return undefined
  try {
    const pair: unknown = JSON.parse(value)
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
      || typeof pair[1] !== 'string' || !/^[1-9]\d*$/.test(pair[1])) {
      return undefined
    }
    return JSON.stringify([normalizeGatewayUrl(pair[0]), pair[1]])
  } catch {
    return undefined
  }
}

/** Persist only identifiers and display metadata, never media URLs or credentials. */
export function sanitizeVideoHistory(value: unknown): VideoProgress[] {
  if (!Array.isArray(value)) return []
  const valid: VideoProgress[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    if (typeof row.bvid !== 'string' || !BVID_PATTERN.test(row.bvid)) continue
    if (!Number.isSafeInteger(row.cid) || Number(row.cid) <= 0) continue
    if (typeof row.position !== 'number' || !Number.isFinite(row.position) || row.position < 0) continue
    if (typeof row.duration !== 'number' || !Number.isFinite(row.duration) || row.duration <= 0) continue
    if (typeof row.watchedAt !== 'number' || !Number.isFinite(row.watchedAt) || row.watchedAt <= 0) continue
    const scope = sanitizeHistoryScope(row.scope)
    if (!scope) continue
    valid.push({
      scope,
      bvid: row.bvid,
      cid: Number(row.cid),
      title: typeof row.title === 'string' ? row.title.slice(0, 200) : row.bvid,
      author: typeof row.author === 'string' ? row.author.slice(0, 100) : '',
      page: Number.isSafeInteger(row.page) && Number(row.page) > 0 ? Number(row.page) : 1,
      partTitle: typeof row.partTitle === 'string' ? row.partTitle.slice(0, 200) : '',
      position: Math.min(row.position, row.duration),
      duration: row.duration,
      watchedAt: row.watchedAt,
      completed: row.completed === true,
    })
  }
  valid.sort((a, b) => b.watchedAt - a.watchedAt)
  const videos = new Set<string>()
  const parts = new Set<string>()
  return valid.filter((entry) => {
    const videoKey = `${entry.scope}:${entry.bvid}`
    const key = `${videoKey}:${entry.cid}`
    if (parts.has(key) || parts.size >= MAX_HISTORY_PARTS) return false
    if (!videos.has(videoKey) && videos.size >= MAX_HISTORY_VIDEOS) return false
    videos.add(videoKey)
    parts.add(key)
    return true
  })
}

export function latestVideos(entries: readonly VideoProgress[]): VideoProgress[] {
  const seen = new Set<string>()
  return [...entries].sort((a, b) => b.watchedAt - a.watchedAt).filter((entry) => {
    if (seen.has(entry.bvid)) return false
    seen.add(entry.bvid)
    return true
  })
}

export function resumePosition(entry: Pick<VideoProgress, 'position' | 'completed'> | undefined, duration: number): number {
  if (!entry || entry.completed || !Number.isFinite(duration) || duration <= 0) return 0
  // A nearly finished part restarts rather than opening on its final frame.
  if (entry.position >= duration - Math.min(5, duration * 0.05)) return 0
  return Math.max(0, Math.min(entry.position, duration))
}

export function historyFeedItem(entry: VideoProgress): FeedItem {
  return {
    id: `history:${entry.bvid}`,
    source: 'history',
    bvid: entry.bvid,
    cid: entry.cid,
    title: entry.title,
    author: entry.author,
    url: `https://www.bilibili.com/video/${entry.bvid}`,
    cover: `/v1/media/cover?bvid=${entry.bvid}`,
    durationSec: entry.duration,
    stat: entry.completed ? `P${entry.page} 已看完` : `P${entry.page} 看到 ${formatVideoTime(entry.position)}`,
  }
}

export function formatVideoTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const rest = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}
