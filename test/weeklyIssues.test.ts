import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { VideoBatch } from '../src/market/feedPager'

import { createPlaybackContext } from '../src/market/biliHistory'
import { createFeedPager, weeklyCacheKey } from '../src/market/feedPager'
import { createWeeklyIssuesSession, parseWeeklyIssues } from '../src/market/weeklyIssues'

const connection = { baseUrl: 'https://gateway.example', bearerToken: 'test-token', timeoutMs: 8000 }
const context = (mid = '123') => createPlaybackContext(connection, { logged: true, mid, revision: `login-${mid}` })
const directory = (numbers = [400, 399, 3]) => ({ issues: numbers.map(number => ({ number, name: `第 ${number} 期` })) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => resolve = yes)
  return { promise, resolve }
}
function batch(number: number): VideoBatch {
  return { weeklyNumber: number, hasMore: false, items: Array.from({ length: 6 }, (_, index) => ({ id: `${number}:${index}`, source: 'weekly', title: `期数 ${number}`, url: '' })) }
}

test('weekly directory validates, sorts newest first and deduplicates', () => {
  assert.deepEqual(parseWeeklyIssues(directory([3, 400, 399, 400])).map(row => row.number), [400, 399, 3])
  for (const value of [null, {}, { issues: null }, directory([]), directory([0]), directory([-1]), directory([1.5]), directory([Infinity]), directory([Number.MAX_SAFE_INTEGER + 1]), { issues: [{ number: '400', name: 'x' }] }, { issues: [{ number: 400 }] }]) {
    assert.throws(() => parseWeeklyIssues(value))
  }
})

test('directory is lazy, defaults to latest, preserves explicit selection across refreshes', async () => {
  let calls = 0
  let numbers = [400, 399, 3]
  const session = createWeeklyIssuesSession({ fetch: async () => {
    calls += 1
    return directory(numbers)
  }, changed: () => {} })
  session.setContext(context())
  assert.equal(calls, 0)
  await session.load()
  assert.equal(session.snapshot().selectedNumber, 400)
  session.select(399)
  session.select(999)
  await session.load()
  assert.equal(calls, 1)
  numbers = [401, 400, 3]
  await session.load(true)
  assert.equal(session.snapshot().selectedNumber, 399)
  assert.deepEqual(session.snapshot().issues.map(row => row.number), [401, 400, 399, 3])
})

test('failed directory refresh preserves selection and explicit retry recovers', async () => {
  let fail = false
  let calls = 0
  const session = createWeeklyIssuesSession({ fetch: async () => {
    calls += 1
    if (fail) throw new Error('目录失败')
    return directory()
  }, changed: () => {} })
  session.setContext(context())
  await session.load()
  session.select(3)
  fail = true
  assert.equal(await session.load(true), false)
  assert.equal(session.snapshot().selectedNumber, 3)
  assert.equal(session.snapshot().issues.length, 3)
  assert.match(session.snapshot().error, /目录失败/)
  await session.load()
  assert.equal(calls, 2)
  fail = false
  await session.load(true)
  assert.equal(session.snapshot().error, '')
  assert.equal(session.snapshot().selectedNumber, 3)
})

test('first-load failure is not automatically retried and never fabricates a selected issue', async () => {
  let calls = 0
  const session = createWeeklyIssuesSession({ fetch: async () => {
    calls += 1
    throw new Error('目录失败')
  }, changed: () => {} })
  session.setContext(context())
  await session.load()
  await session.load()
  assert.equal(calls, 1)
  assert.equal(session.snapshot().selectedNumber, undefined)
  assert.equal(session.snapshot().loading, false)
})

test('old account directory completion cannot overwrite a new account or its flight', async () => {
  const old = deferred<unknown>()
  const current = deferred<unknown>()
  let calls = 0
  const session = createWeeklyIssuesSession({ fetch: () => ++calls === 1 ? old.promise : current.promise, changed: () => {} })
  session.setContext(context())
  const first = session.load()
  await Promise.resolve()
  session.setContext(context('456'))
  const second = session.load()
  await Promise.resolve()
  old.resolve(directory([400]))
  await first
  assert.equal(session.snapshot().loading, true)
  assert.equal(session.snapshot().selectedNumber, undefined)
  current.resolve(directory([401]))
  await second
  assert.equal(session.snapshot().selectedNumber, 401)
})

test('changing gateway or disposing rejects pending directory results', async () => {
  for (const dispose of [false, true]) {
    const pending = deferred<unknown>()
    const session = createWeeklyIssuesSession({ fetch: () => pending.promise, changed: () => {} })
    session.setContext(context())
    const flight = session.load()
    await Promise.resolve()
    if (dispose) session.dispose()
    else session.setContext(createPlaybackContext({ ...connection, baseUrl: 'https://another.example' }, { logged: false }))
    pending.resolve(directory())
    assert.equal(await flight, false)
    assert.equal(session.snapshot().selectedNumber, undefined)
  }
})

test('per-issue caches keep independent pages and late responses stay in their own issue', async () => {
  const pending = deferred<VideoBatch>()
  const pager = createFeedPager({ fetch: async key => key === 'weekly:400' ? pending.promise : batch(399), changed: () => {} })
  const first = pager.select(weeklyCacheKey(400))
  await Promise.resolve()
  await pager.select(weeklyCacheKey(399))
  await pager.move(1)
  pending.resolve(batch(400))
  await first
  assert.equal(pager.snapshot().weeklyNumber, 399)
  assert.equal(pager.snapshot().page, 1)
  await pager.select(weeklyCacheKey(400))
  assert.equal(pager.snapshot().page, 0)
  await pager.move(2)
  await pager.select(weeklyCacheKey(399))
  assert.equal(pager.snapshot().page, 1)
  await pager.select(weeklyCacheKey(400))
  assert.equal(pager.snapshot().page, 2)
})

test('wrong or missing selected issue metadata is rejected without replacing cached cards', async () => {
  for (const wrong of [399, undefined]) {
    let value = batch(400)
    const pager = createFeedPager({ fetch: async () => value, changed: () => {} })
    await pager.select(weeklyCacheKey(400))
    await pager.move(1)
    value = { ...batch(399), weeklyNumber: wrong }
    await pager.refresh()
    assert.equal(pager.snapshot().weeklyNumber, 400)
    assert.equal(pager.snapshot().page, 1)
    assert.match(pager.snapshot().error, /期号不匹配/)
    value = batch(400)
    await pager.retry()
    assert.equal(pager.snapshot().page, 0)
    assert.equal(pager.snapshot().error, '')
  }
})

test('invalid cache numbers cannot be requested and invalidation clears per-issue state', async () => {
  for (const number of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => weeklyCacheKey(number))
  const pending = deferred<VideoBatch>()
  const pager = createFeedPager({ fetch: () => pending.promise, changed: () => {} })
  const flight = pager.select(weeklyCacheKey(400))
  await Promise.resolve()
  pager.invalidate()
  pending.resolve(batch(400))
  await flight
  assert.equal(pager.snapshot(weeklyCacheKey(400)).loaded, false)
})

test('forced directory refresh waits for ordinary flight then refreshes once for all callers', async () => {
  const pending = deferred<unknown>()
  const calls: boolean[] = []
  const session = createWeeklyIssuesSession({ fetch: async (_connection, refresh) => {
    calls.push(refresh)
    return refresh ? directory([401, 400]) : pending.promise
  }, changed: () => {} })
  session.setContext(context())
  const ordinary = session.load()
  await Promise.resolve()
  const firstRefresh = session.load(true)
  const secondRefresh = session.load(true)
  pending.resolve(directory([400]))
  await Promise.all([ordinary, firstRefresh, secondRefresh])
  assert.deepEqual(calls, [false, true])
  assert.deepEqual(session.snapshot().issues.map(row => row.number), [401, 400])
  assert.equal(session.snapshot().selectedNumber, 400)
})

test('queued forced directory refresh does not execute for a replacement account', async () => {
  const pending = deferred<unknown>()
  let calls = 0
  const session = createWeeklyIssuesSession({ fetch: async () => {
    calls += 1
    return pending.promise
  }, changed: () => {} })
  session.setContext(context())
  const ordinary = session.load()
  await Promise.resolve()
  const refresh = session.load(true)
  session.setContext(context('456'))
  pending.resolve(directory())
  await Promise.all([ordinary, refresh])
  assert.equal(calls, 1)
  assert.equal(session.snapshot().selectedNumber, undefined)
})
