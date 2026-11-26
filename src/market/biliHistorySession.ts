import type { BiliHistoryItem, BiliHistoryPage, BiliIdentity, BiliSessionStatus, PlaybackContext } from './biliHistory'
import type { GatewayConnection } from './gatewayTransport'

import { createPlaybackContext, createRequestEpoch, mergeCloudHistory, samePlaybackContext } from './biliHistory'
import { isBiliIdentityError } from './gatewayTransport'

export interface BiliHistoryState {
  context?: PlaybackContext
  status?: BiliSessionStatus
  checking: boolean
  loading: boolean
  loaded: boolean
  rows: BiliHistoryItem[]
  hasMore: boolean
  nextCursor?: string
  notice: string
  error: string
  refreshingRecent?: boolean
  recentError?: string
}

interface Dependencies {
  connection: () => GatewayConnection
  status: (connection: GatewayConnection) => Promise<BiliSessionStatus>
  history: (identity: BiliIdentity, connection: GatewayConnection, cursor?: string) => Promise<BiliHistoryPage>
  changed: (state: BiliHistoryState) => void
  invalidatePlayback: () => void
}

/** In-memory only. Requests are accepted only in the identity epoch that started them. */
export function createBiliHistorySession(deps: Dependencies) {
  let state: BiliHistoryState = { checking: false, loading: false, loaded: false, rows: [], hasMore: false, notice: '', error: '' }
  const statusRequests = createRequestEpoch()
  const historyRequests = createRequestEpoch()
  let disposed = false
  let pages = 0
  const seenCursors = new Set<string>()
  let accountEpoch = 0
  let progressRequest = 0
  const rowRequests = new Map<string, number>()
  let recentFlight: Promise<void> | undefined

  function publish(patch: Partial<BiliHistoryState>) {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
  }

  function reset() {
    accountEpoch += 1
    recentFlight = undefined
    rowRequests.clear()
    deps.invalidatePlayback()
    historyRequests.next()
    pages = 0
    seenCursors.clear()
    publish({ context: undefined, status: undefined, loading: false, loaded: false, rows: [], hasMore: false, nextCursor: undefined, error: '', notice: '', refreshingRecent: false, recentError: '' })
  }

  async function refreshStatus(invalidate = false) {
    if (disposed) return
    const request = statusRequests.next()
    if (invalidate) reset()
    publish({ checking: true })
    let connection: GatewayConnection | undefined
    try {
      connection = deps.connection()
      const status = await deps.status(connection)
      if (disposed || !statusRequests.accepts(request)) return
      const context = createPlaybackContext(connection, status)
      if (!samePlaybackContext(state.context, context)) reset()
      publish({
        context,
        status,
        notice: context.identity
          ? state.error ? state.notice : ''
          : status.logged ? '网关未提供账号身份，无法读取账号历史或上报进度。' : '',
        error: context.identity ? state.error : status.logged ? '当前网关不支持账号历史，请更新网关后重试。' : '',
      })
    } catch (error) {
      if (disposed || !statusRequests.accepts(request)) return
      // A failed status check cannot assign records to the previously seen (or a new) account.
      reset()
      publish({
        context: connection ? createPlaybackContext(connection, { logged: false }) : undefined,
        notice: '账号状态暂不可用，请重试。',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (!disposed && statusRequests.accepts(request)) publish({ checking: false })
    }
  }

  async function loadHistory(append = false) {
    const context = state.context
    if (disposed || !context?.identity || (append && (!state.hasMore || state.loading))) return
    const request = historyRequests.next()
    const cursor = append ? state.nextCursor : undefined
    publish({ loading: true, error: '' })
    try {
      const page = await deps.history(context.identity, context.connection, cursor)
      if (disposed || !historyRequests.accepts(request) || !samePlaybackContext(context, state.context)) return
      const rows = mergeCloudHistory(append ? state.rows : [], page, context.identity)
      if (!append) {
        pages = 0
        seenCursors.clear()
      }
      pages += 1
      const more = page.hasMore && Boolean(page.nextCursor) && page.nextCursor !== cursor
        && !seenCursors.has(page.nextCursor!) && pages < 50
      if (page.nextCursor) seenCursors.add(page.nextCursor)
      publish({ rows, loaded: true, hasMore: more, nextCursor: page.nextCursor, notice: '' })
    } catch (error) {
      if (disposed || !historyRequests.accepts(request)) return
      if (isBiliIdentityError(error)) {
        void refreshStatus(true)
      } else {
        publish({ error: error instanceof Error ? error.message : String(error), notice: state.loaded ? '账号历史加载失败，保留已加载的云端记录。' : '账号历史加载失败，请重试。' })
      }
    } finally {
      if (!disposed && historyRequests.accepts(request)) publish({ loading: false })
    }
  }

  function mergeProgress(page: BiliHistoryPage, identity: BiliIdentity, request: number, head: boolean) {
    const items = mergeCloudHistory([], page, identity)
    const existing = new Map(state.rows.map(row => [`${row.bvid}:${row.cid}`, row]))
    const accepted = items.filter((row) => {
      const key = `${row.bvid}:${row.cid}`
      const previous = existing.get(key)
      // Equal upstream timestamps still allow backwards seeks, but only from
      // a first-page request newer than the one that supplied the cached row.
      const accept = !previous || row.watchedAtMs > previous.watchedAtMs
        || (head && row.watchedAtMs === previous.watchedAtMs && request >= (rowRequests.get(key) ?? 0))
      if (accept) {
        existing.delete(key)
        rowRequests.set(key, request)
      }
      return accept
    })
    const rows = mergeCloudHistory([...existing.values()], { ...page, items: accepted }, identity)
    const retainedKeys = new Set(rows.map(row => `${row.bvid}:${row.cid}`))
    for (const key of rowRequests.keys()) {
      if (!retainedKeys.has(key)) rowRequests.delete(key)
    }
    publish({ rows, loaded: true })
    return items
  }

  /** The visual pager owns this cursor. Reading a batch only enriches resume data. */
  async function readPage(cursor?: string): Promise<BiliHistoryPage> {
    const context = state.context
    const epoch = accountEpoch
    if (disposed || !context?.identity) throw new Error('请先确认账号后重试。')
    const request = ++progressRequest
    try {
      const page = await deps.history(context.identity, context.connection, cursor)
      if (disposed || epoch !== accountEpoch || !samePlaybackContext(context, state.context)) throw new Error('账号已变化，请重试。')
      const items = mergeProgress(page, context.identity, request, !cursor)
      return { ...page, items }
    } catch (error) {
      if (!disposed && epoch === accountEpoch && isBiliIdentityError(error)) void refreshStatus(true)
      throw error
    }
  }

  /** Refresh recent cloud progress, never the list's order or pagination cursor. */
  function refreshRecent(): Promise<void> {
    if (recentFlight) return recentFlight
    const context = state.context
    if (disposed || !context?.identity) return Promise.resolve()
    const epoch = accountEpoch
    const request = ++progressRequest
    publish({ refreshingRecent: true, recentError: '' })
    recentFlight = (async () => {
      try {
        const page = await deps.history(context.identity!, context.connection)
        if (disposed || epoch !== accountEpoch || !samePlaybackContext(context, state.context)) return
        mergeProgress(page, context.identity!, request, true)
      } catch (error) {
        if (disposed || epoch !== accountEpoch) return
        if (isBiliIdentityError(error)) void refreshStatus(true)
        else publish({ recentError: '云端进度更新失败，暂用已读取的进度；可重试。' })
      } finally {
        if (!disposed && epoch === accountEpoch) {
          recentFlight = undefined
          publish({ refreshingRecent: false })
        }
      }
    })()
    return recentFlight
  }

  return {
    invalidate() {
      if (disposed) return
      statusRequests.next()
      reset()
      publish({ checking: true })
    },
    refreshStatus,
    loadHistory,
    readPage,
    refreshRecent,
    snapshot: () => state,
    dispose() {
      disposed = true
      accountEpoch += 1
      recentFlight = undefined
      statusRequests.next()
      historyRequests.next()
      // Normal view teardown lets the player's final bounded report drain.
      // Identity/connection changes use reset() instead and revoke that queue.
      state = { ...state, rows: [], context: undefined }
    },
  }
}
