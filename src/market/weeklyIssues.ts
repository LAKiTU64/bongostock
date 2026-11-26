import type { PlaybackContext } from './biliHistory'
import type { GatewayConnection } from './gatewayTransport'

import { samePlaybackContext } from './biliHistory'

export interface WeeklyIssue {
  number: number
  name: string
}

export interface WeeklyIssuesState {
  issues: readonly WeeklyIssue[]
  selectedNumber?: number
  loaded: boolean
  loading: boolean
  error: string
}

export function parseWeeklyIssues(value: unknown): WeeklyIssue[] {
  const rows = (value as { issues?: unknown } | null)?.issues
  if (!Array.isArray(rows)) throw new Error('每周必看期数响应无效，请重试。')
  const issues = new Map<number, WeeklyIssue>()
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.number) || row.number <= 0 || typeof row.name !== 'string') throw new Error('每周必看期数响应无效，请重试。')
    if (!issues.has(row.number)) issues.set(row.number, { number: row.number, name: row.name.trim() })
  }
  if (!issues.size) throw new Error('暂未取得每周必看期数，请重试。')
  return [...issues.values()].sort((a, b) => b.number - a.number)
}

interface Dependencies {
  fetch: (connection: GatewayConnection, refresh: boolean) => Promise<unknown>
  changed: (state: WeeklyIssuesState) => void
}

function emptyState(): WeeklyIssuesState {
  return { issues: [], loaded: false, loading: false, error: '' }
}

export function createWeeklyIssuesSession(deps: Dependencies) {
  let context: PlaybackContext | undefined
  let state = emptyState()
  let epoch = 0
  let disposed = false
  let flight: Promise<boolean> | undefined
  let flightRefresh = false

  function publish(patch: Partial<WeeklyIssuesState>) {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
  }

  return {
    snapshot: () => state,
    setContext(next: PlaybackContext | undefined) {
      if (disposed || samePlaybackContext(context, next)) return
      context = next
      epoch += 1
      flight = undefined
      state = emptyState()
      publish({})
    },
    load(refresh = false): Promise<boolean> {
      const captured = context
      if (disposed || !captured) return Promise.resolve(false)
      if (flight) {
        if (!refresh || flightRefresh) return flight
        const queuedEpoch = epoch
        return flight.then(() => disposed || queuedEpoch !== epoch ? false : this.load(true))
      }
      if (!refresh && (state.loaded || state.error)) return Promise.resolve(state.loaded)
      flightRefresh = refresh
      const requestEpoch = epoch
      publish({ loading: true, error: '' })
      flight = (async () => {
        await Promise.resolve()
        try {
          if (disposed || requestEpoch !== epoch) return false
          const result = await deps.fetch(captured.connection, refresh)
          if (disposed || requestEpoch !== epoch) return false
          const issues = parseWeeklyIssues(result)
          // A directory refresh must not silently change the issue being browsed.
          const selected = state.issues.find(issue => issue.number === state.selectedNumber)
          if (selected && !issues.some(issue => issue.number === selected.number)) issues.push(selected)
          issues.sort((a, b) => b.number - a.number)
          publish({ issues, selectedNumber: state.selectedNumber ?? issues[0].number, loaded: true })
          return true
        } catch (error) {
          if (!disposed && requestEpoch === epoch) publish({ error: error instanceof Error ? error.message : String(error) })
          return false
        } finally {
          if (!disposed && requestEpoch === epoch) {
            flight = undefined
            publish({ loading: false })
          }
        }
      })()
      return flight
    },
    select(number: number) {
      if (!disposed && state.issues.some(issue => issue.number === number)) publish({ selectedNumber: number })
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
