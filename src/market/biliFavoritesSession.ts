import type { BiliFavoriteFolder, BiliFavoriteVideos } from './biliFavorites'
import type { BiliIdentity, PlaybackContext } from './biliHistory'
import type { GatewayConnection } from './gatewayTransport'

import { parseBiliFavoriteFolders, parseBiliFavoriteVideos } from './biliFavorites'
import { createPlaybackContext, samePlaybackContext } from './biliHistory'
import { isBiliIdentityError } from './gatewayTransport'

export interface BiliFavoritesState {
  folders: readonly BiliFavoriteFolder[]
  selectedId?: string
  loaded: boolean
  loading: boolean
  refreshing: boolean
  error: string
}

interface Dependencies {
  folders: (identity: BiliIdentity, connection: GatewayConnection) => Promise<unknown>
  videos: (identity: BiliIdentity, connection: GatewayConnection, folderId: string, page: number) => Promise<unknown>
  changed: (state: BiliFavoritesState) => void
  identityInvalid: () => void
}

function emptyState(): BiliFavoritesState {
  return { folders: [], loaded: false, loading: false, refreshing: false, error: '' }
}

/** Folder discovery is lazy; the visual pager owns each folder's video cache. */
export function createBiliFavoritesSession(deps: Dependencies) {
  let context: PlaybackContext | undefined
  let state = emptyState()
  let epoch = 0
  let disposed = false
  let flight: Promise<boolean> | undefined

  function publish(patch: Partial<BiliFavoritesState>) {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
  }

  function setContext(next: PlaybackContext | undefined) {
    if (disposed || samePlaybackContext(context, next)) return
    epoch += 1
    flight = undefined
    context = next ? createPlaybackContext(next.connection, { logged: Boolean(next.identity), ...next.identity }) : undefined
    state = emptyState()
    publish({})
  }

  function failure(error: unknown, requestEpoch: number) {
    if (disposed || requestEpoch !== epoch) return
    if (isBiliIdentityError(error)) {
      setContext(undefined)
      deps.identityInvalid()
    } else {
      publish({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  function loadFolders(refresh = false): Promise<boolean> {
    const captured = context
    if (disposed || !captured?.identity) return Promise.resolve(false)
    if (flight) return flight
    if (!refresh && (state.loaded || state.error)) return Promise.resolve(state.loaded)
    const requestEpoch = epoch
    publish({ loading: true, error: '' })
    flight = (async () => {
      // Register before invoking injected dependencies, including synchronous throws.
      await Promise.resolve()
      try {
        if (disposed || requestEpoch !== epoch) return false
        const result = await deps.folders(captured.identity!, captured.connection)
        if (disposed || requestEpoch !== epoch) return false
        const page = parseBiliFavoriteFolders(result, captured.identity!)
        publish({
          folders: page.folders,
          selectedId: page.folders.some(folder => folder.id === state.selectedId) ? state.selectedId : page.folders[0]?.id,
          loaded: true,
        })
        return true
      } catch (error) {
        failure(error, requestEpoch)
        return false
      } finally {
        if (!disposed && requestEpoch === epoch) {
          flight = undefined
          publish({ loading: false })
        }
      }
    })()
    return flight
  }

  async function readPage(folderId: string, page: number): Promise<BiliFavoriteVideos> {
    const captured = context
    const requestEpoch = epoch
    if (disposed || !captured?.identity) throw new Error('请先登录 B 站后查看收藏。')
    if (!state.folders.some(folder => folder.id === folderId)) throw new Error('收藏夹已变化，请刷新收藏夹列表。')
    try {
      const result = await deps.videos(captured.identity, captured.connection, folderId, page)
      if (disposed || requestEpoch !== epoch) throw new Error('账号已变化，请重试。')
      // A folder switch is not an identity change: late results may fill only its own pager key.
      return parseBiliFavoriteVideos(result, captured.identity, folderId, page)
    } catch (error) {
      if (!disposed && requestEpoch === epoch && isBiliIdentityError(error)) failure(error, requestEpoch)
      throw error
    }
  }

  return {
    snapshot: () => state,
    setContext,
    loadFolders,
    readPage,
    async refresh(refreshVideos: (folderId: string) => Promise<void>) {
      if (disposed || state.refreshing || !context?.identity) return
      const requestEpoch = epoch
      publish({ refreshing: true })
      try {
        if (!await loadFolders(true) || disposed || requestEpoch !== epoch || !state.selectedId) return
        await refreshVideos(state.selectedId)
      } finally {
        if (!disposed && requestEpoch === epoch) publish({ refreshing: false })
      }
    },
    selectFolder(id: string) {
      if (disposed || !state.folders.some(folder => folder.id === id)) return
      publish({ selectedId: id })
    },
    dispose() {
      disposed = true
      epoch += 1
      flight = undefined
      context = undefined
      state = emptyState()
    },
  }
}
