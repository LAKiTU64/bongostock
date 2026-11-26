import type { BiliProgressReport, PlaybackContext } from './biliHistory'

import { isBiliIdentityError } from './gatewayTransport'

interface ReporterOptions {
  context: PlaybackContext
  send: (report: BiliProgressReport) => Promise<unknown>
  identityInvalid: () => void
  signal?: AbortSignal
  failed?: (error: unknown) => void
  succeeded?: () => void
  now?: () => number
  unixNow?: () => number
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void
}

interface PartSession {
  id: number
  bvid: string
  cid: number
  started: boolean
  startTs: number
  realtimeMs: number
  runningSince?: number
}

interface PendingReport {
  id: number
  report: BiliProgressReport
  signature: string
}

export type ProgressReporter = ReturnType<typeof createProgressReporter>

/** Single-flight, bounded, latest-snapshot delivery. Never retries a failed payload. */
export function createProgressReporter(options: ReporterOptions) {
  const now = options.now ?? (() => performance.now())
  const unixNow = options.unixNow ?? (() => Date.now())
  const schedule = options.schedule ?? setTimeout
  const unschedule = options.unschedule ?? clearTimeout
  const identity = options.context.identity
  let part: PartSession | undefined
  let sequence = 0
  let cancelled = false
  let closed = false
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextSendAt = 0
  let lastPeriodic = -Infinity
  let failures = 0
  let lastAttempt = ''
  const queue: PendingReport[] = []

  function elapsed(session: PartSession) {
    return session.realtimeMs + (session.runningSince === undefined ? 0 : Math.max(0, now() - session.runningSince))
  }

  function suspendClock() {
    if (!part || part.runningSince === undefined) return
    part.realtimeMs = elapsed(part)
    part.runningSince = undefined
  }

  function cancel() {
    cancelled = true
    queue.length = 0
    suspendClock()
    if (timer !== undefined) unschedule(timer)
    timer = undefined
    options.signal?.removeEventListener('abort', cancel)
  }

  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()

  function pump() {
    if (closed && !busy && !queue.length) options.signal?.removeEventListener('abort', cancel)
    if (cancelled || busy || timer !== undefined || !queue.length) return
    const delay = nextSendAt - now()
    if (delay > 0) {
      timer = schedule(() => {
        timer = undefined
        pump()
      }, delay)
      return
    }
    const pending = queue.shift()!
    if (pending.signature === lastAttempt) {
      pump()
      return
    }
    busy = true
    lastAttempt = pending.signature
    nextSendAt = now() + 3000
    void Promise.resolve().then(() => {
      if (!cancelled) return options.send(pending.report)
    }).then(() => {
      if (cancelled) return
      failures = 0
      options.succeeded?.()
    }).catch((error: unknown) => {
      if (cancelled) return
      if (isBiliIdentityError(error)) {
        cancel()
        options.identityInvalid()
        return
      }
      // Do not replay old snapshots after a network failure. A future real sample
      // can be sent after the backoff, without blocking playback or local saves.
      queue.length = 0
      failures += 1
      nextSendAt = now() + Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4))
      options.failed?.(error)
    }).finally(() => {
      busy = false
      pump()
    })
  }

  function sample(positionSec: number, completed = false, force = false) {
    if (cancelled || closed || !identity || !part?.started || !Number.isFinite(positionSec) || positionSec < 0) return
    if (!force && (part.runningSince === undefined || now() - lastPeriodic < 15_000)) return
    lastPeriodic = now()
    const report: BiliProgressReport = {
      ...identity,
      bvid: part.bvid,
      cid: part.cid,
      positionSec,
      realtimeSec: elapsed(part) / 1000,
      completed,
      startTs: part.startTs,
    }
    const signature = `${part.id}:${Math.floor(positionSec)}:${Math.floor(report.realtimeSec)}:${completed}`
    if (signature === lastAttempt && !queue.some(entry => entry.id === part!.id)) return
    const index = queue.findIndex(entry => entry.id === part!.id)
    const pending = { id: part.id, report, signature }
    if (index >= 0) queue[index] = pending
    else queue.push(pending)
    // A rapid series of part switches must not accumulate an unbounded backlog.
    if (queue.length > 4) queue.shift()
    pump()
  }

  return {
    beginPart(bvid: string, cid: number) {
      if (closed || cancelled) return
      suspendClock()
      part = { id: ++sequence, bvid, cid, started: false, startTs: 0, realtimeMs: 0 }
      lastPeriodic = now()
    },
    playing() {
      if (closed || cancelled || !part) return
      if (!part.started) {
        part.started = true
        part.startTs = Math.floor(unixNow() / 1000)
        lastPeriodic = now()
      }
      if (part.runningSince === undefined) part.runningSince = now()
    },
    suspend: suspendClock,
    sample,
    finish(positionSec: number, completed = false) {
      suspendClock()
      sample(positionSec, completed, true)
    },
    /** Drain a final bounded queue without keeping the component mounted. */
    close() {
      suspendClock()
      closed = true
      pump()
    },
    cancel,
  }
}
