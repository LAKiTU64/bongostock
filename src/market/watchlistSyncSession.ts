import type { WatchlistGroup } from '../stores/watchlist'

export interface CloudWatchlistResult {
  groups: WatchlistGroup[]
  updatedAt: number
}

export class WatchlistConflictError extends Error {
  constructor(readonly cloudState: CloudWatchlistResult) {
    super('云端已有更新，请重新确认自选列表')
  }
}

interface Snapshot {
  groups: WatchlistGroup[]
  lastSyncedAt: number
  dirty: boolean
  scope: string
}

interface Dependencies {
  read: () => Snapshot
  fetch: (since: number) => Promise<CloudWatchlistResult | null>
  push: (groups: WatchlistGroup[], baseUpdatedAt: number) => Promise<number>
  apply: (cloud: CloudWatchlistResult) => void
  acknowledge: (updatedAt: number, clearDirty: boolean) => void
  conflict?: (error: WatchlistConflictError) => void
}

export function sameWatchlist(left: readonly WatchlistGroup[], right: readonly WatchlistGroup[]) {
  return left.length === right.length && left.every((group, index) => {
    const other = right[index]!
    return group.id === other.id && group.name === other.name
      && group.codes.length === other.codes.length
      && group.codes.every((code, codeIndex) => code === other.codes[codeIndex])
  })
}

export function createWatchlistSyncSession(deps: Dependencies) {
  let pushFlight: Promise<boolean> | undefined
  let pullFlight: Promise<boolean> | undefined
  let conflict: { scope: string, error: WatchlistConflictError } | undefined

  function capture(): Snapshot {
    const state = deps.read()
    return { ...state, groups: state.groups.map(group => ({ ...group, codes: [...group.codes] })) }
  }

  function sameBase(snapshot: Snapshot) {
    const current = deps.read()
    return current.scope === snapshot.scope && current.lastSyncedAt === snapshot.lastSyncedAt
  }

  async function pushLoop(force: boolean, confirmedBase?: number) {
    if (conflict?.scope === deps.read().scope) throw conflict.error
    conflict = undefined
    let saved = false
    while (force || deps.read().dirty) {
      force = false
      const snapshot = capture()
      try {
        const updatedAt = await deps.push(snapshot.groups, confirmedBase ?? snapshot.lastSyncedAt)
        confirmedBase = undefined
        if (!sameBase(snapshot)) return saved
        const unchanged = sameWatchlist(snapshot.groups, deps.read().groups)
        deps.acknowledge(updatedAt, unchanged)
        saved = true
        if (unchanged) return saved
        // A successful response acknowledges only the submitted snapshot. The
        // next request uses that response's version and the latest local order.
      } catch (error) {
        if (error instanceof WatchlistConflictError && sameBase(snapshot)) {
          conflict = { scope: snapshot.scope, error }
          deps.conflict?.(error)
        }
        throw error
      }
    }
    return saved
  }

  function push(force = false): Promise<boolean> {
    if (pushFlight) return pushFlight
    pushFlight = Promise.resolve().then(() => pushLoop(force)).finally(() => {
      pushFlight = undefined
    })
    return pushFlight
  }

  async function pullOnce() {
    if (deps.read().dirty || pushFlight || conflict?.scope === deps.read().scope) return false
    const snapshot = capture()
    const cloud = await deps.fetch(snapshot.lastSyncedAt)
    if (!cloud || !sameBase(snapshot) || deps.read().dirty || pushFlight
      || !sameWatchlist(snapshot.groups, deps.read().groups)) {
      return false
    }
    if (!cloud.groups.length && snapshot.groups.length) {
      await push(true)
      return false
    }
    deps.apply(cloud)
    return true
  }

  function pull(): Promise<boolean> {
    if (pullFlight) return pullFlight
    pullFlight = Promise.resolve().then(pullOnce).finally(() => {
      pullFlight = undefined
    })
    return pullFlight
  }

  async function confirmPush(baseUpdatedAt: number) {
    const scope = deps.read().scope
    for (;;) {
      const pending = pushFlight
      if (!pending) break
      await pending.catch(() => {})
    }
    if (scope !== deps.read().scope) throw new Error('连接已变化，请重新确认同步')
    conflict = undefined
    pushFlight = Promise.resolve().then(() => pushLoop(true, baseUpdatedAt)).finally(() => {
      pushFlight = undefined
    })
    const saved = await pushFlight
    if (!saved) throw new Error('自选状态已变化，请重新确认同步')
    return saved
  }

  return { push, pull, confirmPush, resume: () => {
    conflict = undefined
  } }
}
