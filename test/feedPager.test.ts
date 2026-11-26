import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { VideoBatch, VideoCacheKey } from '../src/market/feedPager'
import type { FeedItem } from '../src/market/feedService'

import { createFeedPager, hasCachedNext, visibleVideoItems } from '../src/market/feedPager'
import { createPageGesture } from '../src/market/pageGesture'

function items(start: number, count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(start + index), source: 'rcmd', title: `视频 ${start + index}`, url: '' }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 15; index += 1) await Promise.resolve()
}

function setup(fetch: Parameters<typeof createFeedPager>[0]['fetch']) {
  return createFeedPager({ fetch, changed: () => {} })
}

test('weekly issue metadata stays with cached cards and changes only after a successful refresh', async () => {
  let issue = 400
  let fail = false
  const pager = setup(async (_source, page) => {
    if (fail) throw new Error('刷新失败')
    return { items: items((page - 1) * 4 + 1, 4), hasMore: page < 2, weeklyNumber: issue }
  })
  await pager.select('weekly')
  await pager.prefetch()
  assert.equal(pager.snapshot().weeklyNumber, 400)
  assert.equal(pager.snapshot().items.length, 8)
  await pager.move(1)
  issue = 401
  fail = true
  await pager.refresh()
  assert.equal(pager.snapshot().weeklyNumber, 400)
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().items.length, 8)
  fail = false
  await pager.retry()
  assert.equal(pager.snapshot().weeklyNumber, 401)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().items.length, 4)
})

test('weekly issue changes reject an append atomically and explicit retry starts at the new first page', async () => {
  let issue = 400
  const calls: Array<{ page: number, refresh: boolean }> = []
  const pager = setup(async (_source, page, _cursor, refresh) => {
    calls.push({ page, refresh })
    return { items: items(issue * 100 + page * 4, 4), hasMore: true, weeklyNumber: issue }
  })
  await pager.select('weekly')
  const original = pager.snapshot().items
  issue = 401
  await pager.prefetch()
  assert.deepEqual(pager.snapshot().items, original)
  assert.equal(pager.snapshot().apiPage, 1)
  assert.equal(pager.snapshot().weeklyNumber, 400)
  assert.equal(pager.snapshot().failedRefresh, true)
  assert.match(pager.snapshot().error, /每周必看已更新/)
  const beforeWheel = calls.length
  await pager.move(1)
  await pager.move(1)
  assert.equal(calls.length, beforeWheel, 'wheel must not retry a changed collection')
  await pager.retry()
  assert.deepEqual(calls.at(-1), { page: 1, refresh: true })
  assert.equal(pager.snapshot().weeklyNumber, 401)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().error, '')
})

test('navigation during an issue-change refresh cannot restore the previous collection page', async () => {
  let issue = 400
  let pending: ReturnType<typeof deferred<VideoBatch>> | undefined
  const pager = setup(async () => pending ? pending.promise : { items: items(issue * 100, 20), hasMore: true, weeklyNumber: issue })
  await pager.select('weekly')
  issue = 401
  await pager.move(9)
  await flush()
  assert.equal(pager.snapshot().page, 9)
  assert.equal(pager.snapshot().failedRefresh, true)
  pending = deferred<VideoBatch>()
  const refresh = pager.retry()
  await flush()
  const extraForward = pager.move(1, true)
  pending.resolve({ items: items(40100, 20), hasMore: true, weeklyNumber: 401 })
  await Promise.all([refresh, extraForward])
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().weeklyNumber, 401)
  assert.equal(visibleVideoItems(pager.snapshot()).length, 2)
  assert.equal(await extraForward, false)
})

test('a refresh waiting for an append revokes navigation created during that wait', async () => {
  const append = deferred<VideoBatch>()
  const replacement = deferred<VideoBatch>()
  const pager = setup(async (_source, page, _cursor, refresh) => {
    if (refresh) return replacement.promise
    return page === 1 ? { items: items(1, 4), hasMore: true } : append.promise
  })
  await pager.ensure()
  const prefetch = pager.prefetch()
  await flush()
  const refresh = pager.refresh()
  await pager.move(1)
  const advance = pager.move(1)
  assert.equal(pager.snapshot().pendingNext, true)
  append.resolve({ items: items(5, 4), hasMore: true })
  await prefetch
  await flush()
  assert.equal(pager.snapshot().refreshing, true)
  assert.equal(pager.snapshot().pendingNext, false)
  assert.equal(await pager.move(-1), false)
  replacement.resolve({ items: items(100, 4), hasMore: false })
  await Promise.all([refresh, advance])
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().refreshing, false)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['100', '101'])
})

test('weekly issue metadata is optional, validated and never guessed for old gateways', async () => {
  for (const weeklyNumber of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '400' as unknown as number]) {
    const pager = setup(async (_source, page) => ({ items: items(page * 4, 4), hasMore: page < 2, weeklyNumber }))
    await pager.select('weekly')
    await pager.prefetch()
    assert.equal(pager.snapshot().weeklyNumber, undefined)
    assert.equal(pager.snapshot().items.length, 8)
    assert.equal(pager.snapshot().error, '')
  }
  for (const [first, second] of [[undefined, 400], [400, undefined]]) {
    let issue = first
    const pager = setup(async () => ({ items: items(1, 4), hasMore: true, weeklyNumber: issue }))
    await pager.select('weekly')
    issue = second
    await pager.prefetch()
    assert.equal(pager.snapshot().weeklyNumber, first)
    assert.equal(pager.snapshot().failedRefresh, true)
  }
})

test('rank fallback metadata is scoped to rank and does not mix popular and ranked pages', async () => {
  let fallbackSource: string | undefined = 'bili'
  const pager = setup(async (_source, page) => ({ items: items(page * 4, 4), hasMore: true, fallbackSource, weeklyNumber: 400 }))
  await pager.select('rank')
  assert.equal(pager.snapshot().fallbackSource, 'bili')
  assert.equal(pager.snapshot().weeklyNumber, undefined)
  fallbackSource = undefined
  await pager.prefetch()
  assert.equal(pager.snapshot().fallbackSource, 'bili')
  assert.equal(pager.snapshot().items.length, 4)
  assert.match(pager.snapshot().error, /榜单来源已更新/)
  await pager.retry()
  assert.equal(pager.snapshot().fallbackSource, undefined)
  assert.equal(pager.snapshot().error, '')
  fallbackSource = 'bili'
  await pager.select('rcmd')
  assert.equal(pager.snapshot().fallbackSource, undefined)
  assert.equal(pager.snapshot().weeklyNumber, undefined)
  await pager.select('rank', false)
  assert.equal(pager.snapshot().fallbackSource, undefined)
})

test('presentation pages contain two cards, clamp both ends and leave the last slot empty', async () => {
  const pager = setup(async () => ({ items: items(1, 5), hasMore: false }))
  await pager.ensure()
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['1', '2'])
  assert.equal(await pager.move(-1), false)
  assert.equal(await pager.move(1), true)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['3', '4'])
  assert.equal(await pager.move(1), true)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['5'])
  assert.equal(await pager.move(1), false)
  assert.equal(pager.snapshot().page, 2)
  assert.equal(hasCachedNext(pager.snapshot()), false)
  assert.equal(await pager.move(-1), true)
})

test('multi-page moves commit cached pages synchronously and clamp extreme distances at both ends', async () => {
  let changes = 0
  const pager = createFeedPager({
    fetch: async () => ({ items: items(1, 21), hasMore: false }),
    changed: () => changes += 1,
  })
  await pager.ensure()
  const before = changes
  const forward = pager.move(4)
  assert.equal(pager.snapshot().page, 4, 'cached movement must not await a promise')
  const next = pager.move(3)
  assert.equal(pager.snapshot().page, 7, 'a second event in the same task is not lost')
  assert.equal(await forward, true)
  assert.equal(await next, true)
  assert.equal(changes - before, 2, 'one update per event, not one per crossed page')
  const end = pager.move(Number.MAX_VALUE)
  assert.equal(pager.snapshot().page, 10)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['21'])
  assert.equal(await end, true)
  const start = pager.move(-Number.MAX_VALUE)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(await start, true)
  assert.equal(await pager.move(-Number.MAX_VALUE), false)
  for (const invalid of [Number.NaN, Infinity, -Infinity, 0, 0.5, -0.5]) {
    assert.equal(await pager.move(invalid), false)
    assert.equal(pager.snapshot().page, 0)
  }
})

test('each wheel input advances one cached page regardless of accelerated distance', async () => {
  const pager = setup(async () => ({ items: items(1, 40), hasMore: false }))
  const gesture = createPageGesture({ turn: direction => void pager.move(direction) })
  const wheel = (deltaY: number) => gesture.wheel({ deltaX: 0, deltaY, deltaMode: 0 })
  await pager.ensure()
  wheel(120)
  assert.equal(pager.snapshot().page, 1)
  wheel(240)
  assert.equal(pager.snapshot().page, 2)
  wheel(100_000)
  assert.equal(pager.snapshot().page, 3)
  wheel(-120)
  assert.equal(pager.snapshot().page, 2)
  await flush()
  assert.equal(pager.snapshot().page, 2, 'no deferred extra pages')
  wheel(1)
  assert.equal(pager.snapshot().page, 3, 'one input does not need distance accumulation')
})

test('a large move crosses the cache immediately and retains only one page beyond its tail', async () => {
  const pending = deferred<VideoBatch>()
  let calls = 0
  const pager = setup(async () => ++calls === 1 ? { items: items(1, 9), hasMore: true } : pending.promise)
  await pager.ensure()
  const turn = pager.move(Number.MAX_VALUE)
  assert.equal(pager.snapshot().page, 3, 'an unfinished half-page is not yet a cached next page')
  assert.equal(pager.snapshot().pendingNext, true)
  for (let index = 0; index < 20; index += 1) assert.equal(await pager.move(1000), false)
  assert.equal(calls, 2)
  pending.resolve({ items: items(10, 21), hasMore: false })
  assert.equal(await turn, true)
  assert.equal(pager.snapshot().page, 4, 'network completion fulfills exactly one next-page intent')
  assert.equal(pager.snapshot().pendingNext, false)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['9', '10'])
  await flush()
  assert.equal(pager.snapshot().page, 4, 'the remaining requested distance is not queued')
  assert.equal(await pager.move(2), true)
  assert.equal(pager.snapshot().page, 6)
})

test('multi-page reversal cancels pending navigation without racing its eventual success', async () => {
  const pending = deferred<VideoBatch>()
  const pager = setup(async (_source, page) => page === 1 ? { items: items(1, 8), hasMore: true } : pending.promise)
  await pager.ensure()
  const turn = pager.move(10)
  assert.equal(pager.snapshot().page, 3)
  const reverse = pager.move(-2)
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().pendingNext, false)
  pending.resolve({ items: items(9, 20), hasMore: false })
  assert.equal(await reverse, true)
  assert.equal(await turn, false)
  assert.equal(pager.snapshot().page, 1)
})

test('a failed large move leaves the cache browsable without wheel retries', async () => {
  let calls = 0
  const pager = setup(async () => {
    if (++calls === 1) return { items: items(1, 8), hasMore: true }
    throw new Error('offline')
  })
  await pager.ensure()
  assert.equal(await pager.move(100), true, 'cached pages moved even though the next batch failed')
  assert.equal(pager.snapshot().page, 3)
  assert.equal(pager.snapshot().pendingNext, false)
  assert.equal(pager.snapshot().error, 'offline')
  assert.equal(await pager.move(-100), true)
  assert.equal(await pager.move(100), true)
  assert.equal(await pager.move(100), false)
  assert.equal(pager.snapshot().page, 3)
  assert.equal(calls, 2)
})

test('each source restores its order, visual page and API cursor without requesting again', async () => {
  const calls: VideoCacheKey[] = []
  const pager = setup(async (source) => {
    calls.push(source)
    return { items: items(source === 'rcmd' ? 1 : 101, 20), hasMore: true, nextCursor: `${source}-next` }
  })
  await pager.ensure()
  await pager.move(1)
  await pager.move(1)
  await pager.select('history')
  await pager.move(1)
  await pager.select('rcmd')
  assert.equal(pager.snapshot().page, 2)
  assert.equal(pager.snapshot().apiPage, 1)
  assert.equal(pager.snapshot().nextCursor, 'rcmd-next')
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['5', '6'])
  await pager.select('history')
  assert.equal(pager.snapshot().page, 1)
  assert.deepEqual(calls, ['rcmd', 'history'])
})

test('playback return updates metadata without changing order, page or pagination', async () => {
  const pager = setup(async () => ({ items: items(1, 20), hasMore: true, nextCursor: 'tail' }))
  await pager.select('history')
  await pager.move(1)
  const before = pager.snapshot()
  pager.cancelNavigation()
  pager.updateMetadata('history', [{ ...items(3, 1)[0]!, cid: 999, stat: 'P2 · 12:34' }, ...items(100, 2)])
  const after = pager.snapshot()
  assert.equal(after.page, before.page)
  assert.equal(after.nextCursor, 'tail')
  assert.equal(after.apiPage, before.apiPage)
  assert.deepEqual(after.items.map(item => item.id), before.items.map(item => item.id))
  assert.equal(visibleVideoItems(after)[0]?.cid, 999)
  assert.equal(visibleVideoItems(after)[0]?.stat, 'P2 · 12:34')
})

test('metadata refreshed during a pending batch survives its commit, including duplicate cards', async () => {
  const pending = deferred<VideoBatch>()
  const pager = setup(async (_source, page) => page === 1 ? { items: items(1, 2), hasMore: true } : pending.promise)
  await pager.select('history')
  const next = pager.move(1)
  const update = { ...items(1, 1)[0]!, cid: 999, stat: 'P2 已看完' }
  pager.updateMetadata('history', [update])
  pending.resolve({ items: [...items(1, 1), ...items(3, 2)], hasMore: false })
  await next
  await pager.move(-1)
  assert.equal(visibleVideoItems(pager.snapshot())[0]?.cid, 999)
  assert.equal(visibleVideoItems(pager.snapshot())[0]?.stat, 'P2 已看完')
  assert.deepEqual(pager.snapshot().items.map(item => item.id), ['1', '2', '3', '4'])
})

test('near-tail prefetch is single flight and failure keeps cards, page and cursor retryable', async () => {
  const pending = deferred<VideoBatch>()
  const calls: Array<[number, string | undefined]> = []
  let fail = true
  const pager = setup(async (_source, page, cursor) => {
    calls.push([page, cursor])
    if (page === 1) return { items: items(1, 8), hasMore: true, nextCursor: 'next' }
    if (fail) return pending.promise
    return { items: items(9, 20), hasMore: false }
  })
  await pager.ensure()
  await pager.move(1)
  assert.equal(pager.snapshot().loading, true)
  assert.equal(pager.snapshot().pendingNext, false, 'background prefetch must not block card clicks')
  const extra = pager.prefetch()
  assert.equal(calls.length, 2)
  pending.reject(new Error('offline'))
  await extra
  await flush()
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().items.length, 8)
  assert.equal(pager.snapshot().nextCursor, 'next')
  assert.equal(pager.snapshot().apiPage, 1)
  assert.equal(pager.snapshot().error, 'offline')
  await pager.move(-1)
  assert.equal(pager.snapshot().page, 0)
  fail = false
  await pager.retry()
  assert.deepEqual(calls, [[1, undefined], [2, 'next'], [2, 'next']])
  assert.equal(pager.snapshot().items.length, 28)
  assert.equal(pager.snapshot().error, '')
})

test('a missing next page keeps the current page until ready; previous cancels the pending turn', async () => {
  const pending = deferred<VideoBatch>()
  const pager = setup(async (_source, page) => page === 1 ? { items: items(1, 4), hasMore: true } : pending.promise)
  await pager.ensure()
  await pager.move(1)
  const turn = pager.move(1)
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().pendingNext, true)
  await pager.move(-1)
  assert.equal(pager.snapshot().page, 0)
  pending.resolve({ items: items(5, 20), hasMore: false })
  assert.equal(await turn, false)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().pendingNext, false)
})

test('reversing at the first-page boundary cancels a pending turn without leaving cards blocked', async () => {
  const pending = deferred<VideoBatch>()
  const pager = setup(async (_source, page) => page === 1 ? { items: items(1, 2), hasMore: true } : pending.promise)
  await pager.ensure()
  const next = pager.move(1)
  await flush()
  assert.equal(pager.snapshot().pendingNext, true)
  assert.equal(await pager.move(-1), false)
  assert.equal(pager.snapshot().pendingNext, false)
  pending.resolve({ items: items(3, 20), hasMore: false })
  assert.equal(await next, false)
  assert.equal(pager.snapshot().page, 0)
})

test('a ready next page advances only once after an in-flight prefetch', async () => {
  const pending = deferred<VideoBatch>()
  let calls = 0
  const pager = setup(async () => ++calls === 1 ? { items: items(1, 2), hasMore: true } : pending.promise)
  await pager.ensure()
  const prefetch = pager.prefetch()
  const turn = pager.move(1)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().pendingNext, true)
  pending.resolve({ items: items(3, 20), hasMore: false })
  await prefetch
  assert.equal(await turn, true)
  assert.equal(calls, 2)
  assert.equal(pager.snapshot().page, 1)
})

test('repeated forward requests retain one pending intent and advance exactly once', async () => {
  const pending = deferred<VideoBatch>()
  let calls = 0
  const pager = setup(async () => ++calls === 1 ? { items: items(1, 2), hasMore: true } : pending.promise)
  await pager.ensure()
  const first = pager.move(1)
  for (let index = 0; index < 20; index += 1) assert.equal(await pager.move(1), false)
  assert.equal(pager.snapshot().pendingNext, true)
  assert.equal(pager.snapshot().page, 0)
  pending.resolve({ items: items(3, 20), hasMore: false })
  assert.equal(await first, true, 'later requests must not replace the original pending intent')
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().pendingNext, false)
  assert.equal(calls, 2)
})

test('failed loading keeps cards and stops automatic retries while cached pages remain browsable', async () => {
  let calls = 0
  let fail = true
  const pager = setup(async (_source, page) => {
    calls += 1
    if (page === 1) return { items: items(1, 4), hasMore: true, nextCursor: 'next' }
    if (fail) throw new Error('offline')
    return { items: items(5, 20), hasMore: false }
  })
  await pager.ensure()
  await pager.move(1)
  await flush()
  assert.equal(pager.snapshot().error, 'offline')
  const before = calls
  for (let index = 0; index < 20; index += 1) assert.equal(await pager.move(1), false)
  assert.equal(calls, before)
  assert.equal(pager.snapshot().pendingNext, false)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['3', '4'])
  assert.equal(await pager.move(-1), true)
  assert.equal(await pager.move(1), true)
  assert.equal(calls, before, 'cached browsing must not retry the failed prefetch')
  fail = false
  assert.equal(await pager.move(1, true), true, 'an explicit next button can retry')
  assert.equal(calls, before + 1)
  assert.equal(pager.snapshot().error, '')
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['5', '6'])
})

test('a failed pending turn releases cards without changing their page', async () => {
  const pending = deferred<VideoBatch>()
  const pager = setup(async (_source, page) => page === 1 ? { items: items(1, 2), hasMore: true } : pending.promise)
  await pager.ensure()
  const turn = pager.move(1)
  assert.equal(pager.snapshot().pendingNext, true)
  await flush()
  pending.reject(new Error('offline'))
  assert.equal(await turn, false)
  assert.equal(pager.snapshot().pendingNext, false)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().error, 'offline')
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['1', '2'])
})

test('refresh cancels the pending turn and replaces content only after its own success', async () => {
  const pending = deferred<VideoBatch>()
  let calls = 0
  const pager = setup(async () => {
    calls += 1
    if (calls === 1) return { items: items(1, 2), hasMore: true }
    if (calls === 2) return pending.promise
    return { items: items(100, 2), hasMore: false }
  })
  await pager.ensure()
  const turn = pager.move(1)
  await flush()
  const refresh = pager.refresh()
  assert.equal(pager.snapshot().pendingNext, false)
  pending.resolve({ items: items(3, 20), hasMore: false })
  assert.equal(await turn, false)
  await refresh
  assert.equal(pager.snapshot().page, 0)
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['100', '101'])
})

test('dispose prevents a pending turn from committing or publishing', async () => {
  const pending = deferred<VideoBatch>()
  let changes = 0
  const pager = createFeedPager({
    fetch: async (_source, page) => page === 1 ? { items: items(1, 2), hasMore: true } : pending.promise,
    changed: () => changes += 1,
  })
  await pager.ensure()
  const turn = pager.move(1)
  await flush()
  pager.dispose()
  const before = changes
  pending.resolve({ items: items(3, 20), hasMore: false })
  assert.equal(await turn, false)
  assert.equal(await pager.move(-1), false)
  assert.equal(changes, before)
})

test('empty and duplicate batches are skipped, repeated cursor ends paging without an empty visual page', async () => {
  const calls: number[] = []
  const pager = setup(async (_source, page) => {
    calls.push(page)
    if (page === 1) return { items: items(1, 2), hasMore: true, nextCursor: 'a' }
    if (page === 2) return { items: items(1, 2), hasMore: true, nextCursor: 'b' }
    return { items: [], hasMore: true, nextCursor: 'a' }
  })
  await pager.ensure()
  assert.equal(await pager.move(1), false)
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().hasMore, false)
  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(pager.snapshot().items.length, 2)
})

test('filtered pages fill two slots instead of showing a half-page before the end', async () => {
  const pager = setup(async (_source, page) => ({ items: page === 1 ? [] : items(page, 1), hasMore: page < 3, nextCursor: `cursor${page}` }))
  await pager.ensure()
  assert.deepEqual(visibleVideoItems(pager.snapshot()).map(item => item.id), ['2', '3'])
  assert.equal(pager.snapshot().apiPage, 3)
  assert.equal(pager.snapshot().hasMore, false)
})

test('empty batches have a per-action budget; a failed refresh preserves the original page and cursor', async () => {
  let empty = false
  let calls = 0
  const pager = setup(async (_source, page) => {
    calls += 1
    return { items: empty ? [] : items(1, 20), hasMore: true, nextCursor: `cursor${page}` }
  })
  await pager.ensure()
  await pager.move(1)
  const before = pager.snapshot()
  empty = true
  await pager.refresh()
  assert.equal(calls, 4)
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().nextCursor, before.nextCursor)
  assert.deepEqual(pager.snapshot().items, before.items)
  assert.match(pager.snapshot().error, /重试/)
  empty = false
  await pager.retry()
  assert.equal(pager.snapshot().page, 0)
  assert.equal(pager.snapshot().error, '')
})

test('API requests retain the fifty-page cap even with fresh cursors', async () => {
  let calls = 0
  const pager = setup(async (_source, page) => {
    calls += 1
    return { items: items(page * 2, 2), hasMore: true, nextCursor: String(page) }
  })
  await pager.ensure()
  for (let index = 0; index < 100; index += 1) {
    await pager.move(1)
    await flush()
  }
  assert.equal(calls, 50)
  assert.equal(pager.snapshot().hasMore, false)
  assert.equal(pager.snapshot().page, 49)
})

test('source switches isolate late failures and cancel pending visual turns', async () => {
  const late = deferred<VideoBatch>()
  const pager = setup(async (source, page) => {
    if (source === 'rcmd' && page > 1) return late.promise
    return { items: items(source === 'rcmd' ? 1 : 100, 2), hasMore: source === 'rcmd' }
  })
  await pager.ensure()
  const turn = pager.move(1)
  await pager.select('rank')
  late.reject(new Error('old source failure'))
  await turn
  assert.equal(pager.snapshot().error, '')
  assert.equal(pager.snapshot('rcmd').error, 'old source failure')
  assert.equal(pager.snapshot('rcmd').pendingNext, false)
  assert.equal(pager.snapshot().page, 0)
})

test('invalidation before dispatch sends nothing and synchronous dependency errors remain retryable', async () => {
  let calls = 0
  let fail = true
  const pager = setup(() => {
    calls += 1
    if (fail) throw new Error('synchronous failure')
    return Promise.resolve({ items: items(1, 2), hasMore: false })
  })
  const cancelled = pager.ensure()
  pager.invalidate()
  await cancelled
  assert.equal(calls, 0)
  await pager.ensure()
  assert.equal(pager.snapshot().loading, false)
  assert.equal(pager.snapshot().error, 'synchronous failure')
  fail = false
  await pager.retry()
  assert.equal(pager.snapshot().items.length, 2)
})

test('account invalidation clears every source and rejects late success/failure; dispose is inert', async () => {
  for (const reject of [false, true]) {
    const late = deferred<VideoBatch>()
    let old = false
    let changes = 0
    const pager = createFeedPager({
      fetch: async () => old ? late.promise : { items: items(1, 20), hasMore: false },
      changed: () => changes += 1,
    })
    await pager.select('history')
    await pager.select('rcmd')
    old = true
    const pending = pager.select('dynamic')
    await flush()
    pager.invalidate()
    assert.equal(pager.snapshot('history').items.length, 0)
    assert.equal(pager.snapshot('rcmd').items.length, 0)
    if (reject) late.reject(new Error('old account'))
    else late.resolve({ items: items(99, 20), hasMore: false })
    await pending
    assert.equal(pager.snapshot().items.length, 0)
    assert.equal(pager.snapshot().error, '')
    const before = changes
    pager.dispose()
    await pager.ensure()
    assert.equal(changes, before)
  }
})
