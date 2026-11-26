import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { BiliHistoryItem, BiliHistoryPage, BiliSessionStatus } from '../src/market/biliHistory'
import type { BiliHistoryState } from '../src/market/biliHistorySession'

import { cloudHistoryItems } from '../src/market/biliHistory'
import { createBiliHistorySession } from '../src/market/biliHistorySession'
import { createFeedPager, visibleVideoItems } from '../src/market/feedPager'
import { GatewayError } from '../src/market/gatewayTransport'

const connection = { baseUrl: 'https://example.test', bearerToken: 'test-token', timeoutMs: 8000 }
const status = { logged: true, mid: '123', revision: 'r1' }
const row: BiliHistoryItem = { bvid: 'BV1rg1FzvEiP', cid: 101, title: '视频', author: '', page: 1, partTitle: '', positionSec: 20, completed: false, watchedAtMs: 1000, durationSec: 600, cover: '' }
const page: BiliHistoryPage = { mid: '123', revision: 'r1', items: [row], hasMore: true, nextCursor: 'cursor1' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function setup(overrides: Partial<Parameters<typeof createBiliHistorySession>[0]> = {}) {
  let last: BiliHistoryState | undefined
  let invalidations = 0
  const session = createBiliHistorySession({
    connection: () => connection,
    status: async () => status,
    history: async () => page,
    changed: value => last = value,
    invalidatePlayback: () => invalidations += 1,
    ...overrides,
  })
  return { session, state: () => last!, invalidations: () => invalidations }
}

test('pagination merges partial and empty filtered pages and ends on repeated cursor without discarding rows', async () => {
  const cursors: (string | undefined)[] = []
  const { session, state } = setup({
    history: async (_identity, _connection, cursor) => {
      cursors.push(cursor)
      if (!cursor) return page
      if (cursor === 'cursor1') return { ...page, items: [], nextCursor: 'cursor2' }
      return { ...page, items: [{ ...row, cid: 102, watchedAtMs: 2000 }], nextCursor: 'cursor2' }
    },
  })
  await session.refreshStatus()
  await session.loadHistory()
  await session.loadHistory(true)
  assert.equal(state().hasMore, true)
  assert.equal(state().rows.length, 1)
  await session.loadHistory(true)
  assert.equal(state().hasMore, false)
  assert.equal(state().rows.length, 2)
  assert.deepEqual(cursors, [undefined, 'cursor1', 'cursor2'])
})

test('pagination failure retains loaded rows and cursor for a manual retry', async () => {
  let fails = true
  const { session, state } = setup({ history: async (_identity, _connection, cursor) => {
    if (!cursor) return page
    if (fails) throw new GatewayError('upstream unavailable', 502)
    return { ...page, items: [{ ...row, cid: 102 }], hasMore: false }
  } })
  await session.refreshStatus()
  await session.loadHistory()
  await session.loadHistory(true)
  assert.equal(state().rows.length, 1)
  assert.equal(state().nextCursor, 'cursor1')
  assert.equal(state().loaded, true)
  assert.equal(state().loading, false)
  assert.match(state().notice, /保留/)
  fails = false
  await session.loadHistory(true)
  assert.equal(state().rows.length, 2)
  assert.equal(state().error, '')
})

test('history failure remains an error without local fallback; failed status clears cloud identity', async () => {
  let failStatus = false
  const { session, state } = setup({
    status: async () => {
      if (failStatus) throw new Error('offline')
      return status
    },
    history: async () => {
      throw new GatewayError('not enabled', 501)
    },
  })
  await session.refreshStatus()
  const scope = state().context!.scope
  await session.loadHistory()
  assert.notEqual(scope, 'device')
  assert.equal(state().context?.scope, scope)
  assert.match(state().notice, /加载失败/)
  assert.doesNotMatch(state().notice, /本地|设备/)
  assert.equal(state().rows.length, 0)
  assert.equal(state().loaded, false)
  assert.equal(state().error, 'not enabled')
  failStatus = true
  await session.refreshStatus()
  assert.equal(state().context?.scope, 'device')
  assert.equal(state().context?.identity, undefined)
  assert.equal(state().rows.length, 0)
})

test('logged-out history makes no history request and offers no local fallback', async () => {
  let calls = 0
  const { session, state } = setup({
    status: async () => ({ logged: false }),
    history: async () => {
      calls += 1
      return page
    },
  })
  await session.refreshStatus()
  await session.loadHistory()
  assert.equal(calls, 0)
  assert.equal(state().status?.logged, false)
  assert.equal(state().rows.length, 0)
  assert.equal(state().loaded, false)
  assert.doesNotMatch(state().notice, /本地|设备/)
})

test('refresh replaces cached cloud progress with the latest upstream value', async () => {
  let positionSec = 80
  const { session, state } = setup({ history: async () => ({ ...page, items: [{ ...row, positionSec }] }) })
  await session.refreshStatus()
  await session.loadHistory()
  positionSec = 5
  await session.loadHistory()
  assert.equal(state().rows[0]?.positionSec, 5)
  assert.equal(state().notice, '')
})

test('an older status response cannot replace a new connection/account context', async () => {
  const first = deferred<BiliSessionStatus>()
  let count = 0
  let currentConnection = { ...connection }
  const { session, state } = setup({
    connection: () => ({ ...currentConnection }),
    status: async () => ++count === 1 ? first.promise : { logged: true, mid: '456', revision: 'r2' },
  })
  const pending = session.refreshStatus()
  currentConnection = { ...connection, baseUrl: 'https://other.test', bearerToken: 'new-token' }
  await session.refreshStatus(true)
  first.resolve(status)
  await pending
  assert.equal(state().context?.identity?.mid, '456')
  assert.equal(state().context?.connection.baseUrl, 'https://other.test')
  assert.equal(state().context?.connection.bearerToken, 'new-token')
})

test('history and failures arriving after account change cannot refill or alter the new account cache', async () => {
  for (const reject of [false, true]) {
    const oldPage = deferred<BiliHistoryPage>()
    let currentStatus = status
    const { session, state, invalidations } = setup({ status: async () => currentStatus, history: () => oldPage.promise })
    await session.refreshStatus()
    const loading = session.loadHistory()
    currentStatus = { logged: true, mid: '456', revision: 'r2' }
    await session.refreshStatus(true)
    if (reject) oldPage.reject(new GatewayError('old session', 409))
    else oldPage.resolve(page)
    await loading
    assert.equal(state().context?.identity?.mid, '456')
    assert.equal(state().rows.length, 0)
    assert.equal(state().error, '')
    assert.equal(state().loading, false)
    assert.ok(invalidations() >= 2)
  }
})

test('403/409 history errors revoke playback and recheck identity; 401 only reports Bearer failure', async () => {
  for (const code of [401, 403, 409]) {
    let statusCalls = 0
    const { session, state, invalidations } = setup({
      status: async () => {
        statusCalls += 1
        return statusCalls > 1 ? { logged: false } : status
      },
      history: async () => {
        throw new GatewayError('test failure', code)
      },
    })
    await session.refreshStatus()
    await session.loadHistory()
    await flush()
    assert.equal(statusCalls, code === 401 ? 1 : 2)
    assert.equal(state().context?.scope === 'device', code !== 401)
    assert.equal(invalidations() > 1, code !== 401)
  }
})

test('same-account relogin invalidates revision and cache but retains the stable local scope', async () => {
  let currentStatus = status
  const { session, state } = setup({ status: async () => currentStatus })
  await session.refreshStatus()
  const scope = state().context!.scope
  await session.loadHistory()
  currentStatus = { ...status, revision: 'r2' }
  await session.refreshStatus()
  assert.equal(state().context?.scope, scope)
  assert.equal(state().context?.identity?.revision, 'r2')
  assert.equal(state().rows.length, 0)
  assert.equal(state().loaded, false)
})

test('connection invalidation is synchronous and sends nothing until the replacement snapshot is ready', async () => {
  const pending = deferred<BiliSessionStatus>()
  let calls = 0
  const { session, state } = setup({ status: async () => {
    calls += 1
    return pending.promise
  } })
  const oldRequest = session.refreshStatus()
  session.invalidate()
  assert.equal(state().context, undefined)
  assert.equal(state().checking, true)
  assert.equal(calls, 1)
  pending.resolve(status)
  await oldRequest
  assert.equal(state().context, undefined)
  assert.equal(state().checking, true)
  session.dispose()
})

test('duplicate load-more is single flight and disposed sessions ignore pending results', async () => {
  const pending = deferred<BiliHistoryPage>()
  let calls = 0
  const { session } = setup({ history: async () => ++calls === 1 ? page : pending.promise })
  await session.refreshStatus()
  await session.loadHistory()
  const more = session.loadHistory(true)
  await session.loadHistory(true)
  assert.equal(calls, 2)
  session.dispose()
  pending.resolve({ ...page, items: [{ ...row, cid: 102 }] })
  await more
  assert.equal(session.snapshot().rows.length, 0)
})

test('recent cloud refresh replaces backwards-seek progress without resetting the pagination cursor', async () => {
  let recent = false
  const cursors: (string | undefined)[] = []
  const { session, state } = setup({ history: async (_identity, _connection, cursor) => {
    cursors.push(cursor)
    if (recent && !cursor) return { ...page, items: [{ ...row, positionSec: 5 }], nextCursor: 'new-first-page-cursor' }
    if (cursor) return { ...page, items: [{ ...row, cid: 102, page: 2, watchedAtMs: 500 }], nextCursor: 'cursor2' }
    return page
  } })
  await session.refreshStatus()
  await session.loadHistory()
  await session.loadHistory(true)
  recent = true
  await session.refreshRecent()
  assert.equal(state().rows.find(item => item.cid === 101)?.positionSec, 5)
  assert.equal(state().rows.length, 2)
  assert.equal(state().nextCursor, 'cursor2')
  assert.equal(state().hasMore, true)
  await session.loadHistory(true)
  assert.deepEqual(cursors, [undefined, 'cursor1', undefined, 'cursor2'])
})

test('recent progress and page fetches use independent error/loading state and never splice cursors', async () => {
  const pending = deferred<BiliHistoryPage>()
  let failRecent = false
  const { session, state } = setup({ history: async (_identity, _connection, cursor) => {
    if (cursor === 'external-tail') return pending.promise
    if (failRecent) throw new Error('recent offline')
    return page
  } })
  await session.refreshStatus()
  await session.loadHistory()
  const next = session.readPage('external-tail')
  failRecent = true
  await session.refreshRecent()
  assert.equal(state().error, '')
  assert.equal(state().loading, false)
  assert.match(state().recentError!, /更新失败/)
  pending.resolve({ ...page, items: [{ ...row, cid: 102 }], nextCursor: 'external-next' })
  const result = await next
  assert.equal(result.nextCursor, 'external-next')
  assert.equal(state().nextCursor, 'cursor1', 'a visual page request cannot overwrite another cursor')
  assert.match(state().recentError!, /更新失败/, 'pagination must not erase a progress-refresh failure')
})

test('tail history batches retain the newest P and first-page refresh accepts a same-timestamp backwards seek', async () => {
  let backwards = false
  const newer = { ...row, cid: 102, page: 2, positionSec: 80, watchedAtMs: 2000 }
  const { session, state } = setup({ history: async (_identity, _connection, cursor) => ({
    ...page,
    items: cursor ? [row] : [{ ...newer, positionSec: backwards ? 5 : 80 }],
  }) })
  await session.refreshStatus()
  await session.readPage()
  await session.readPage('tail')
  assert.equal(cloudHistoryItems(state().rows)[0]?.cid, 102)
  assert.equal(state().rows.find(item => item.cid === 102)?.positionSec, 80)
  backwards = true
  await session.readPage()
  assert.equal(state().rows.find(item => item.cid === 102)?.positionSec, 5)
})

test('late first-page responses cannot overwrite newer recent progress at the same timestamp', async () => {
  for (const positionSec of [5, 40]) {
    const late = deferred<BiliHistoryPage>()
    let calls = 0
    const { session, state } = setup({ history: async () => {
      calls += 1
      if (calls === 1) return late.promise
      return { ...page, items: [{ ...row, positionSec }] }
    } })
    await session.refreshStatus()
    const first = session.readPage()
    await session.refreshRecent()
    late.resolve(page)
    await first
    assert.equal(state().rows[0]?.positionSec, positionSec)
    session.dispose()
  }
})

test('late recent responses cannot overwrite a newer first-page seek at the same timestamp', async () => {
  const late = deferred<BiliHistoryPage>()
  let calls = 0
  const { session, state } = setup({ history: async () => {
    calls += 1
    if (calls === 1) return late.promise
    return { ...page, items: [{ ...row, positionSec: 5 }] }
  } })
  await session.refreshStatus()
  const recent = session.refreshRecent()
  await session.readPage()
  late.resolve(page)
  await recent
  assert.equal(state().rows[0]?.positionSec, 5)
  session.dispose()
})

test('return refresh is single flight; account invalidation and disposal reject late progress and pages', async () => {
  for (const mode of ['invalidate', 'dispose']) {
    const late = deferred<BiliHistoryPage>()
    let calls = 0
    const { session, state } = setup({ history: async () => {
      calls += 1
      return late.promise
    } })
    await session.refreshStatus()
    const recent = session.refreshRecent()
    const sameRecent = session.refreshRecent()
    assert.equal(recent, sameRecent)
    const next = session.readPage('tail')
    assert.equal(calls, 2)
    if (mode === 'invalidate') session.invalidate()
    else session.dispose()
    late.resolve(page)
    await recent
    await assert.rejects(next, /账号已变化/)
    assert.equal(session.snapshot().rows.length, 0)
    if (mode === 'invalidate') assert.equal(state().refreshingRecent, false)
  }
})

test('a history pager retains visual order through return refresh and clears while viewing another source', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...row, bvid: `BV${String(index).padStart(10, '0')}`, watchedAtMs: 20_000 - index }))
  let recent = false
  let currentStatus = status
  const pager = createFeedPager({
    changed: () => {},
    fetch: async (source, _page, cursor) => {
      if (source !== 'history') return { items: [{ id: 'feed', source, title: 'feed', url: '' }], hasMore: false }
      const batch = await session.readPage(cursor)
      return { ...batch, items: cloudHistoryItems(batch.items) }
    },
  })
  const session = createBiliHistorySession({
    connection: () => connection,
    status: async () => currentStatus,
    history: async () => ({ ...page, items: recent ? [{ ...rows[2]!, cid: 999, page: 2, positionSec: 754, watchedAtMs: 30_000 }] : rows, nextCursor: recent ? 'recent-cursor' : 'tail-cursor' }),
    changed: state => pager.updateMetadata('history', cloudHistoryItems(state.rows)),
    invalidatePlayback: () => pager.invalidate(),
  })
  await session.refreshStatus()
  await pager.select('history')
  await pager.move(1)
  const order = pager.snapshot().items.map(item => item.id)
  recent = true
  await session.refreshRecent()
  assert.deepEqual(pager.snapshot().items.map(item => item.id), order)
  assert.equal(pager.snapshot().page, 1)
  assert.equal(pager.snapshot().nextCursor, 'tail-cursor')
  assert.equal(visibleVideoItems(pager.snapshot())[0]?.cid, 999)
  assert.equal(visibleVideoItems(pager.snapshot())[0]?.stat, 'P2 · 12:34')
  assert.equal(session.snapshot().rows.find(item => item.cid === 999)?.positionSec, 754)
  await pager.select('rcmd')
  currentStatus = { ...status, mid: '456', revision: 'new' }
  await session.refreshStatus()
  assert.equal(pager.snapshot('history').items.length, 0)
  assert.equal(pager.snapshot('history').nextCursor, undefined)
  assert.equal(session.snapshot().rows.length, 0)
})
