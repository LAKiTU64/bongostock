import type { FeedItem } from './feedService'

/** Only a stat explicitly labelled 播放 is a view count, never a history P/progress. */
export function playCountLabel(item: Pick<FeedItem, 'source' | 'stat'>): string | undefined {
  if (item.source === 'history' || typeof item.stat !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)(?:\s*([万亿w]))?\s*播放$/.exec(item.stat.trim())
  if (!match) return undefined
  const count = Number(match[1]) * (match[2] === '亿' ? 100_000_000 : match[2] ? 10_000 : 1)
  if (!Number.isFinite(count) || count < 0) return undefined
  return count < 10_000 ? String(Math.floor(count)) : `${Number((count / 10_000).toFixed(1))}w`
}
