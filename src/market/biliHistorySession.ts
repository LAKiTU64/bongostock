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

  function publish(patch: Partial<BiliHistoryState>) {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
  }

  function reset() {
    deps.invalidatePlayback()
    historyRequests.next()
    pages = 0
    seenCursors.clear()
    publish({ context: undefined, status: undefined, loading: false, loaded: false, rows: [], hasMore: false, nextCursor: undefined, error: '' })
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

  return {
    invalidate() {
      if (disposed) return
      statusRequests.next()
      reset()
      publish({ checking: true })
    },
    refreshStatus,
    loadHistory,
    snapshot: () => state,
    dispose() {
      disposed = true
      statusRequests.next()
      historyRequests.next()
      // Normal view teardown lets the player's final bounded report drain.
      // Identity/connection changes use reset() instead and revoke that queue.
      state = { ...state, rows: [], context: undefined }
    },
  }
}
