import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { BiliProgressReport } from '../src/market/biliHistory'

import { createPlaybackContext } from '../src/market/biliHistory'
import { GatewayError } from '../src/market/gatewayTransport'
import { createProgressReporter } from '../src/market/progressReporter'

const context = createPlaybackContext({ baseUrl: 'https://example.test', bearerToken: 'test-token', timeoutMs: 8000 }, { logged: true, mid: '123', revision: 'r1' })
const bvid = 'BV1rg1FzvEiP'

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function clock() {
  let time = 0
  let id = 0
  const timers = new Map<number, { at: number, callback: () => void }>()
  return {
    now: () => time,
    unixNow: () => 1_700_000_000_000 + time,
    schedule(callback: () => void, ms: number) {
      const next = ++id
      timers.set(next, { at: time + ms, callback })
      return next as unknown as ReturnType<typeof setTimeout>
    },
    unschedule(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number)
    },
    async advance(ms: number) {
      const target = time + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        time = due[1].at
        timers.delete(due[0])
        due[1].callback()
        await flush()
      }
      time = target
      await flush()
    },
    timerCount: () => timers.size,
  }
}

function setup(overrides: Partial<Parameters<typeof createProgressReporter>[0]> = {}) {
  const fakeClock = clock()
  const sent: BiliProgressReport[] = []
  let invalidations = 0
  const reporter = createProgressReporter({
    context,
    send: async (report) => {
      sent.push(report)
    },
    identityInvalid: () => invalidations += 1,
    ...fakeClock,
    ...overrides,
  })
  return { reporter, sent, clock: fakeClock, invalidations: () => invalidations }
}

test('never reports loaded metadata, restored progress or old records before actual playing', async () => {
  const { reporter, sent, clock } = setup()
  reporter.beginPart(bvid, 101)
  reporter.sample(80, false, true)
  reporter.finish(80)
  await clock.advance(30_000)
  assert.equal(sent.length, 0)
  reporter.playing()
  await clock.advance(15_000)
  reporter.sample(95)
  await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.startTs, 1_700_000_030)
  assert.equal(sent[0]?.realtimeSec, 15)
})

test('fifteen-second sampling tracks actual wall time independent of playback rate', async () => {
  const { reporter, sent, clock } = setup()
  reporter.beginPart(bvid, 101)
  reporter.playing()
  await clock.advance(14_000)
  reporter.sample(28)
  await flush()
  assert.equal(sent.length, 0)
  await clock.advance(1000)
  reporter.sample(30)
  await flush()
  assert.equal(sent[0]?.positionSec, 30)
  assert.equal(sent[0]?.realtimeSec, 15)
  assert.equal(sent[0]?.mid, '123')
  assert.equal(sent[0]?.revision, 'r1')
})

test('pause, buffering and seeking suspend realtime; repeated playing does not double count', async () => {
  const { reporter, sent, clock } = setup()
  reporter.beginPart(bvid, 101)
  reporter.playing()
  await clock.advance(5000)
  reporter.playing()
  reporter.finish(50)
  await flush()
  await clock.advance(30_000)
  reporter.sample(50)
  assert.equal(sent.length, 1)
  reporter.playing()
  await clock.advance(2000)
  reporter.suspend()
  await clock.advance(10_000)
  reporter.playing()
  await clock.advance(3000)
  reporter.suspend()
  await clock.advance(4000)
  reporter.playing()
  await clock.advance(1000)
  reporter.finish(8)
  await flush()
  assert.equal(sent.at(-1)?.positionSec, 8, 'seek-back progress must not be replaced by a max position')
  assert.equal(sent.at(-1)?.realtimeSec, 11)
})

test('switching P preserves its final report while the next P starts a new clock/session', async () => {
  const { reporter, sent, clock } = setup()
  reporter.beginPart(bvid, 101)
  reporter.playing()
  await clock.advance(4000)
  reporter.finish(80)
  reporter.beginPart(bvid, 102)
  await clock.advance(1000)
  reporter.playing()
  await clock.advance(2000)
  reporter.finish(5)
  await flush()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map(row => [row.cid, row.positionSec, row.realtimeSec, row.startTs]), [[101, 80, 4, 1_700_000_000], [102, 5, 2, 1_700_000_005]])
})

test('reports completed P explicitly and drains a final snapshot without waiting on unmount', async () => {
  const pending = deferred()
  const reports: BiliProgressReport[] = []
  const { reporter, clock } = setup({ send: async (report) => {
    reports.push(report)
    await pending.promise
  } })
  reporter.beginPart(bvid, 101)
  reporter.playing()
  await clock.advance(2000)
  reporter.finish(120, true)
  assert.equal(reporter.close(), undefined)
  await flush()
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.completed, true)
  assert.equal(reports[0]?.positionSec, 120)
  pending.resolve()
  await flush()
  assert.equal(clock.timerCount(), 0)
})

test('single-flight queue coalesces current part and enforces a minimum interval', async () => {
  const pending = deferred()
  const reports: BiliProgressReport[] = []
  const { reporter, clock } = setup({ send: async (report) => {
    reports.push(report)
    if (reports.length === 1) await pending.promise
  } })
  reporter.beginPart(bvid, 101)
  reporter.playing()
  reporter.sample(10, false, true)
  await flush()
  reporter.sample(20, false, true)
  reporter.sample(5, false, true)
  await flush()
  assert.equal(reports.length, 1)
  pending.resolve()
  await flush()
  await clock.advance(2999)
  assert.equal(reports.length, 1)
  await clock.advance(1)
  assert.equal(reports.length, 2)
  assert.equal(reports[1]?.positionSec, 5)
  reporter.finish(5)
  reporter.finish(5)
  await clock.advance(3000)
  assert.equal(reports.length, 3, 'new real playback time may update the final snapshot once')
  reporter.finish(5)
  await clock.advance(3000)
  assert.equal(reports.length, 3, 'identical paused snapshots are suppressed')
})

test('rapid part switches keep at most four pending final snapshots', async () => {
  const pending = deferred()
  const reports: BiliProgressReport[] = []
  const { reporter, clock } = setup({ send: async (report) => {
    reports.push(report)
    if (reports.length === 1) await pending.promise
  } })
  for (let cid = 101; cid <= 110; cid += 1) {
    reporter.beginPart(bvid, cid)
    reporter.playing()
    reporter.finish(cid)
    await flush()
  }
  assert.equal(reports.length, 1)
  reporter.close()
  pending.resolve()
  await flush()
  await clock.advance(15_000)
  assert.deepEqual(reports.map(row => row.cid), [101, 107, 108, 109, 110])
  assert.equal(clock.timerCount(), 0)
})

test('failed snapshots are not retried; only a new sample is sent after backoff', async () => {
  const reports: BiliProgressReport[] = []
  const { reporter, clock } = setup({ send: async (report) => {
    reports.push(report)
    if (reports.length === 1) throw new GatewayError('offline', 502)
  } })
  reporter.beginPart(bvid, 101)
  reporter.playing()
  reporter.sample(20, false, true)
  await flush()
  reporter.sample(20, false, true)
  await clock.advance(1000)
  reporter.sample(2, false, true)
  await clock.advance(3999)
  assert.equal(reports.length, 1)
  await clock.advance(1)
  assert.deepEqual(reports.map(row => row.positionSec), [20, 2])
  reporter.cancel()
})

test('identity failures cancel pending reports and request status revalidation', async () => {
  for (const status of [403, 409]) {
    let calls = 0
    const { reporter, clock, invalidations } = setup({ send: async () => {
      calls += 1
      throw new GatewayError('identity changed', status)
    } })
    reporter.beginPart(bvid, 101)
    reporter.playing()
    reporter.sample(20, false, true)
    await flush()
    reporter.finish(30)
    await clock.advance(60_000)
    assert.equal(invalidations(), 1)
    assert.equal(calls, 1)
  }
})

test('switching account cancels queued and not-yet-sent reports and ignores late failures', async () => {
  const signal = new AbortController()
  const pending = deferred()
  let calls = 0
  const { reporter, clock, invalidations } = setup({ signal: signal.signal, send: async () => {
    calls += 1
    await pending.promise
  } })
  reporter.beginPart(bvid, 101)
  reporter.playing()
  reporter.sample(10, false, true)
  await flush()
  reporter.finish(15)
  signal.abort()
  pending.reject(new GatewayError('old account', 409))
  await clock.advance(60_000)
  assert.equal(calls, 1)
  assert.equal(invalidations(), 0)
  assert.equal(clock.timerCount(), 0)

  const second = setup()
  second.reporter.beginPart(bvid, 101)
  second.reporter.playing()
  second.reporter.finish(10)
  second.reporter.cancel()
  await flush()
  assert.equal(second.sent.length, 0)
})

test('device-only playback never uploads even when old progress exists', async () => {
  const { reporter, sent, clock } = setup({ context: createPlaybackContext(context.connection, { logged: false }) })
  reporter.beginPart(bvid, 101)
  reporter.playing()
  await clock.advance(20_000)
  reporter.sample(100)
  reporter.finish(120, true)
  reporter.close()
  await flush()
  assert.deepEqual(sent, [])
})
