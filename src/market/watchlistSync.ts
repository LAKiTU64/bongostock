import { invoke } from '@tauri-apps/api/core'
import { watch } from 'vue'

import type { WatchlistGroup } from '@/stores/watchlist'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'
import { useWatchlistStore } from '@/stores/watchlist'

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

export interface CloudWatchlistResult {
  groups: WatchlistGroup[]
  updatedAt: number
}

export class WatchlistConflictError extends Error {
  constructor(readonly cloudState: CloudWatchlistResult) {
    super('云端已有更新，已拉取最新数据')
  }
}

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
  return diff.localOnlyGroups.length > 0
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

/** 检查云端是否有更新，有则覆盖本地（含 lastSyncedAt）。无更新返回 false。 */
export async function checkAndPull(): Promise<boolean> {
  const watchlist = useWatchlistStore()
  const cloud = await fetchCloudWatchlist(watchlist.lastSyncedAt)
  if (!cloud) return false

  // 保护：云端为空而本地有数据时，不拉取（避免清空本地），而是把本地推上去。
  // 覆盖"本地有数据、云端还没同步过"的首次迁移场景。
  if (cloud.groups.length === 0 && watchlist.groups.length > 0) {
    try {
      const updatedAt = await pushWatchlistToCloud(watchlist.groups, watchlist.lastSyncedAt)
      watchlist.markSynced(updatedAt)
    } catch (error) {
      if (error instanceof WatchlistConflictError && error.cloudState.groups.length > 0) {
        // 冲突且云端真有数据：以云端为准。
        watchlist.setGroups(error.cloudState.groups, true, false)
        watchlist.markSynced(error.cloudState.updatedAt)
      }
      // 冲突但云端仍为空：保留本地，等待下次推送（云端空状态允许覆盖）。
    }
    return false
  }

  watchlist.setGroups(cloud.groups, true, false)
  watchlist.markSynced(cloud.updatedAt)
  return true
}

/** 本地有待推送变更时推送到云端；成功清除 dirty，409 时自动拉取最新。 */
export async function pushPending(): Promise<boolean> {
  const watchlist = useWatchlistStore()
  if (!watchlist.dirty) return false

  try {
    const updatedAt = await pushWatchlistToCloud(watchlist.groups, watchlist.lastSyncedAt)
    watchlist.markSynced(updatedAt)
    return true
  } catch (error) {
    if (error instanceof WatchlistConflictError) {
      watchlist.setGroups(error.cloudState.groups, true, false)
      watchlist.markSynced(error.cloudState.updatedAt)
    }
    throw error
  }
}

const CHECK_INTERVAL_MS = 10_000
const PUSH_DEBOUNCE_MS = 2_000

let lastCheckedAt = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushInFlight: Promise<void> | null = null

/**
 * 行情请求成功后的"顺带检查"入口：节流调用 checkAndPull，发现云端更新则
 * 拉取覆盖本地。失败静默——不影响行情主流程，下次行情活动会再试。
 */
export function notifyMarketActivity() {
  const now = Date.now()
  if (now - lastCheckedAt < CHECK_INTERVAL_MS) return
  lastCheckedAt = now

  checkAndPull().catch(() => {
    // Cloud unreachable or unauthorized: keep local data, retry next activity.
  })
}

/**
 * 启动自动同步：本地自选变更（dirty）后防抖推送到云端；409 冲突时
 * 自动拉取最新云端数据。返回停止函数（组件卸载时调用，防抖清理）。
 */
export function startWatchlistSync() {
  const watchlist = useWatchlistStore()

  watch(
    () => watchlist.dirty,
    (value) => {
      if (!value) return
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = setTimeout(() => {
        pushTimer = null
        pushInFlight ??= pushPending()
          .then(() => undefined)
          .catch(() => {
            // Push failed (offline/401): dirty stays true, retried on next change or activity.
          })
          .finally(() => {
            pushInFlight = null
          })
      }, PUSH_DEBOUNCE_MS)
    },
  )
}
