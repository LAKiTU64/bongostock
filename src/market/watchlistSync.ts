import { invoke } from '@tauri-apps/api/core'
import { ref, watch } from 'vue'

import type { WatchlistGroup } from '@/stores/watchlist'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'
import { useWatchlistStore } from '@/stores/watchlist'

import type { CloudWatchlistResult } from './watchlistSyncSession'

import { createWatchlistSyncSession, sameWatchlist, WatchlistConflictError } from './watchlistSyncSession'

interface ExternalMarketResponse {
  status: number
  body: string
}

interface CloudWatchlistPayload {
  groups?: unknown
  updatedAt?: number
  unchanged?: boolean
  error?: string
}

export { WatchlistConflictError } from './watchlistSyncSession'
export type { CloudWatchlistResult } from './watchlistSyncSession'

function extractGroups(payload: unknown): WatchlistGroup[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const groups = (payload as CloudWatchlistPayload).groups
  if (!Array.isArray(groups)) return []
  return groups.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const group = entry as Record<string, unknown>
    const id = typeof group.id === 'string' ? group.id : ''
    const name = typeof group.name === 'string' ? group.name : ''
    const codes = Array.isArray(group.codes) ? group.codes.filter((code): code is string => typeof code === 'string') : []
    return id && name ? [{ id, name, codes }] : []
  })
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

async function requestCloud(path: string, method: 'GET' | 'POST', body?: unknown) {
  const settings = useMarketStore()
  const result = await invoke<ExternalMarketResponse>(INVOKE_KEY.MARKET_REQUEST, {
    request: {
      baseUrl: settings.external.baseUrl,
      path,
      method,
      body: body ?? null,
      bearerToken: settings.bearerToken.trim() || null,
      timeoutMs: Math.max(settings.external.timeoutMs, 10_000),
    },
  })

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`云端返回 HTTP ${result.status}`)
  }

  try {
    return result.body ? JSON.parse(result.body) as unknown : {}
  } catch {
    throw new Error('云端返回的不是有效 JSON')
  }
}

export interface WatchlistDiff {
  structureChanged: boolean
  localGroups: number
  cloudGroups: number
  localCodes: number
  cloudCodes: number
  localOnlyGroups: string[]
  cloudOnlyGroups: string[]
  localOnlyCodes: string[]
  cloudOnlyCodes: string[]
}

/**
 * Compare local groups against cloud groups. Groups are aligned by id first,
 * then by name; codes are compared as plain sets. The result is used only to
 * inform the user what an overwrite would destroy — never merged.
 */
export function diffWatchlist(local: readonly WatchlistGroup[], cloud: readonly WatchlistGroup[]): WatchlistDiff {
  const localCodes = new Set(local.flatMap(group => group.codes))
  const cloudCodes = new Set(cloud.flatMap(group => group.codes))

  const localOnlyGroups = local
    .filter(group => !cloud.some(other => other.id === group.id || other.name === group.name))
    .map(group => group.name)
  const cloudOnlyGroups = cloud
    .filter(group => !local.some(other => other.id === group.id || other.name === group.name))
    .map(group => group.name)

  return {
    structureChanged: !sameWatchlist(local, cloud),
    localGroups: local.length,
    cloudGroups: cloud.length,
    localCodes: localCodes.size,
    cloudCodes: cloudCodes.size,
    localOnlyGroups,
    cloudOnlyGroups,
    localOnlyCodes: [...localCodes].filter(code => !cloudCodes.has(code)).sort(),
    cloudOnlyCodes: [...cloudCodes].filter(code => !localCodes.has(code)).sort(),
  }
}

export function hasWatchlistDifference(diff: WatchlistDiff) {
  return diff.structureChanged
    || diff.localOnlyGroups.length > 0
    || diff.cloudOnlyGroups.length > 0
    || diff.localOnlyCodes.length > 0
    || diff.cloudOnlyCodes.length > 0
}

/**
 * 拉取云端自选。带 `since` 做增量检查：云端未变化时返回 null，有变化时
 * 返回完整数据与云端 updatedAt。失败抛错（不影响调用方的行情流程）。
 */
export async function fetchCloudWatchlist(since = 0): Promise<CloudWatchlistResult | null> {
  const suffix = since > 0 ? `?since=${since}` : ''
  const payload = await requestCloud(`/v1/watchlist${suffix}`, 'GET') as CloudWatchlistPayload
  if (payload.unchanged === true) return null
  return { groups: extractGroups(payload), updatedAt: toNumber(payload.updatedAt) }
}

/**
 * 全量覆盖云端自选（本地→云端推送）。带 baseUpdatedAt 乐观锁：
 * 云端已被其他终端修改时抛 WatchlistConflictError（携带最新云端数据）。
 */
export async function pushWatchlistToCloud(groups: readonly WatchlistGroup[], baseUpdatedAt = 0): Promise<number> {
  try {
    const payload = await requestCloud('/v1/watchlist/replace', 'POST', { groups, baseUpdatedAt }) as CloudWatchlistPayload
    return toNumber(payload.updatedAt)
  } catch (error) {
    if (error instanceof Error && /HTTP 409/.test(error.message)) {
      const latest = await fetchCloudWatchlist()
      if (latest) throw new WatchlistConflictError(latest)
    }
    throw error
  }
}

export const watchlistSyncError = ref('')
const sessions = new WeakMap<ReturnType<typeof useWatchlistStore>, ReturnType<typeof createWatchlistSyncSession>>()

function syncSession() {
  const watchlist = useWatchlistStore()
  let session = sessions.get(watchlist)
  if (!session) {
    const settings = useMarketStore()
    session = createWatchlistSyncSession({
      read: () => ({
        groups: watchlist.groups,
        dirty: watchlist.dirty,
        lastSyncedAt: watchlist.lastSyncedAt,
        scope: JSON.stringify([settings.external.baseUrl, settings.bearerToken.trim()]),
      }),
      fetch: fetchCloudWatchlist,
      push: pushWatchlistToCloud,
      conflict: () => {
        watchlistSyncError.value = '云端自选已有更新，本地修改已保留。请通过“从云端拉取”或“推送到云端”确认使用哪一份。'
      },
      apply: (cloud) => {
        watchlist.setGroups(cloud.groups, true, false)
        watchlist.markSynced(cloud.updatedAt)
      },
      acknowledge: (updatedAt, clearDirty) => {
        if (clearDirty) watchlist.markSynced(updatedAt)
        else watchlist.lastSyncedAt = updatedAt
      },
    })
    sessions.set(watchlist, session)
  }
  return session
}

export async function confirmWatchlistPush(baseUpdatedAt: number) {
  await syncSession().confirmPush(baseUpdatedAt)
  watchlistSyncError.value = ''
}

export function resumeWatchlistSync() {
  watchlistSyncError.value = ''
  syncSession().resume()
}

export function checkAndPull(): Promise<boolean> {
  return syncSession().pull()
}

export function pushPending(): Promise<boolean> {
  return syncSession().push()
}

const CHECK_INTERVAL_MS = 10_000
const PUSH_DEBOUNCE_MS = 2_000

let lastCheckedAt = 0

/** Pending local edits take precedence over background cloud reads. */
export function notifyMarketActivity() {
  const now = Date.now()
  if (now - lastCheckedAt < CHECK_INTERVAL_MS) return
  lastCheckedAt = now
  const operation = useWatchlistStore().dirty ? pushPending() : checkAndPull()
  void operation.catch(() => {})
}

export function startWatchlistSync() {
  const watchlist = useWatchlistStore()
  const session = syncSession()
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  const unwatch = watch(
    () => [watchlist.dirty, JSON.stringify(watchlist.groups)],
    () => {
      clearTimeout(pushTimer)
      if (!watchlist.dirty) return
      pushTimer = setTimeout(() => {
        pushTimer = undefined
        void session.push().catch(() => {})
      }, PUSH_DEBOUNCE_MS)
    },
    { immediate: true },
  )
  return () => {
    unwatch()
    clearTimeout(pushTimer)
  }
}
