import { invoke } from '@tauri-apps/api/core'

import type { WatchlistGroup } from '@/stores/watchlist'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'

interface ExternalMarketResponse {
  status: number
  body: string
}

interface CloudWatchlistPayload {
  groups?: unknown
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
 * then by name; codes are compared as plain sets per group. The result is used
 * only to inform the user what an overwrite would destroy — never merged.
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

/** Fetch the cloud watchlist and return its groups (does not touch local state). */
export async function fetchCloudWatchlist(): Promise<WatchlistGroup[]> {
  const payload = await requestCloud('/v1/watchlist', 'GET')
  return extractGroups(payload)
}

/** Overwrite the cloud watchlist with the given groups. */
export async function pushWatchlistToCloud(groups: readonly WatchlistGroup[]): Promise<void> {
  await requestCloud('/v1/watchlist/replace', 'POST', { groups })
}

/** Overwrite local groups from the cloud (caller decides direction). */
export async function pullWatchlistFromCloud(apply: (groups: WatchlistGroup[]) => void): Promise<WatchlistGroup[]> {
  const groups = await fetchCloudWatchlist()
  apply(groups)
  return groups
}
