import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { CloudWatchlistResult } from '../src/market/watchlistSyncSession'

import { createWatchlistSyncSession, sameWatchlist, WatchlistConflictError } from '../src/market/watchlistSyncSession'

const groups = (codes = ['SH600036', 'SZ000858']) => [{ id: 'first', name: '自选', codes: [...codes] }]
const reversed = () => groups(['SZ000858', 'SH600036'])
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
function setup() {
  const state = { groups: groups(), dirty: false, lastSyncedAt: 100, scope: 'connection-a' }
  const reads: ReturnType<typeof deferred<CloudWatchlistResult | null>>[] = []
  const writes: { groups: ReturnType<typeof groups>, base: number, response: ReturnType<typeof deferred<number>> }[] = []
  const applied: CloudWatchlistResult[] = []
  const session = createWatchlistSyncSession({
    read: () => state,
    fetch: async () => {
      const response = deferred<CloudWatchlistResult | null>()
      reads.push(response)
      return response.promise
    },
    push: async (value, base) => {
      const response = deferred<number>()
      writes.push({ groups: value, base, response })
      return response.promise
    },
    apply: (cloud) => {
      applied.push(cloud)
      state.groups = cloud.groups
      state.lastSyncedAt = cloud.updatedAt
      state.dirty = false
    },
    acknowledge: (version, clearDirty) => {
      state.lastSyncedAt = version
      if (clearDirty) state.dirty = false
    },
  })
  return { state, reads, writes, applied, session }
}

test('comparison includes group order, membership, names and stock order', () => {
  assert.equal(sameWatchlist(groups(), groups()), true)
  assert.equal(sameWatchlist(groups(), reversed()), false)
  assert.equal(sameWatchlist(groups(), [{ ...groups()[0]!, name: '改名' }]), false)
  const two = [...groups(), { id: 'second', name: '观察', codes: [] }]
  assert.equal(sameWatchlist(two, [...two].reverse()), false)
  assert.equal(sameWatchlist(two, [{ ...two[0]!, codes: [] }, { ...two[1]!, codes: groups()[0]!.codes }]), false)
})

test('dirty local order is never replaced by an automatic pull', async () => {
  const { state, reads, session } = setup()
  state.dirty = true
  assert.equal(await session.pull(), false)
  assert.equal(reads.length, 0)
})

test('a late pull cannot erase edits made while it was in flight', async () => {
  const { state, reads, session, applied } = setup()
  const operation = session.pull()
  await flush()
  state.groups = reversed()
  state.dirty = true
  reads[0]!.resolve({ groups: groups(), updatedAt: 200 })
  assert.equal(await operation, false)
  assert.deepEqual(state.groups, reversed())
  assert.equal(state.dirty, true)
  assert.equal(applied.length, 0)
})

test('one upload flight saves later edits with the acknowledged server version', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const first = session.push()
  assert.equal(session.push(), first)
  await flush()
  assert.equal(writes.length, 1)
  state.groups = reversed()
  writes[0]!.response.resolve(200)
  await flush()
  assert.equal(state.dirty, true)
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[0]!.groups, groups())
  assert.deepEqual(writes[1]!.groups, reversed())
  assert.equal(writes[1]!.base, 200)
  writes[1]!.response.resolve(201)
  assert.equal(await first, true)
  assert.equal(state.dirty, false)
  assert.equal(state.lastSyncedAt, 201)
})

test('pending upload suppresses pulls and a preceding pull cannot overwrite its acknowledgement', async () => {
  const { state, reads, writes, session } = setup()
  const pull = session.pull()
  await flush()
  state.dirty = true
  state.groups = reversed()
  const push = session.push()
  await flush()
  writes[0]!.response.resolve(201)
  await push
  reads[0]!.resolve({ groups: groups(), updatedAt: 200 })
  assert.equal(await pull, false)
  assert.deepEqual(state.groups, reversed())
  state.dirty = true
  const second = session.push()
  await flush()
  assert.equal(await session.pull(), false)
  assert.equal(reads.length, 1)
  writes[1]!.response.resolve(202)
  await second
})

test('failed save retains edits and can be explicitly retried without a request loop', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const operation = session.push()
  await flush()
  writes[0]!.response.reject(new Error('offline'))
  await assert.rejects(operation, /offline/)
  assert.equal(state.dirty, true)
  assert.equal(writes.length, 1)
  const retry = session.push()
  await flush()
  writes[1]!.response.resolve(200)
  await retry
  assert.equal(state.dirty, false)
})

test('a conflict retains edits made after the submitted snapshot', async () => {
  const { state, writes, applied, session } = setup()
  state.dirty = true
  const operation = session.push()
  await flush()
  state.groups = reversed()
  writes[0]!.response.reject(new WatchlistConflictError({ groups: groups(), updatedAt: 200 }))
  await assert.rejects(operation, WatchlistConflictError)
  assert.deepEqual(state.groups, reversed())
  assert.equal(state.dirty, true)
  assert.equal(applied.length, 0)
  await assert.rejects(session.push(), WatchlistConflictError)
  assert.equal(writes.length, 1)
  assert.deepEqual(state.groups, reversed())
  assert.equal(state.dirty, true)
})

test('an unresolved conflict never discards local edits on later automatic retries', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const operation = session.push()
  await flush()
  writes[0]!.response.reject(new WatchlistConflictError({ groups: reversed(), updatedAt: 200 }))
  await assert.rejects(operation, WatchlistConflictError)
  await assert.rejects(session.push(), WatchlistConflictError)
  assert.equal(writes.length, 1)
  assert.deepEqual(state.groups, groups())
  assert.equal(state.dirty, true)
  assert.equal(state.lastSyncedAt, 100)
  assert.equal(await session.pull(), false)
  state.lastSyncedAt = 200
  session.resume()
  const confirmed = session.push()
  await flush()
  assert.equal(writes[1]!.base, 200)
  writes[1]!.response.resolve(201)
  await confirmed
  assert.equal(state.dirty, false)
})

test('explicit push waits for automatic save and uses the confirmed cloud version', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const automatic = session.push()
  await flush()
  const manual = session.confirmPush(201)
  await flush()
  assert.equal(writes.length, 1)
  writes[0]!.response.resolve(200)
  await automatic
  await flush()
  assert.equal(writes.length, 2)
  assert.equal(writes[1]!.base, 201)
  state.groups = reversed()
  state.dirty = true
  writes[1]!.response.resolve(202)
  await flush()
  assert.equal(writes[2]!.base, 202)
  assert.deepEqual(writes[2]!.groups, reversed())
  writes[2]!.response.resolve(203)
  await manual
  assert.equal(state.dirty, false)
  assert.equal(state.lastSyncedAt, 203)
})

test('explicit push resolves a paused conflict without bypassing a second cloud change', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const automatic = session.push()
  await flush()
  writes[0]!.response.reject(new WatchlistConflictError({ groups: reversed(), updatedAt: 200 }))
  await assert.rejects(automatic)
  const manual = session.confirmPush(200)
  await flush()
  assert.equal(writes[1]!.base, 200)
  writes[1]!.response.reject(new WatchlistConflictError({ groups: reversed(), updatedAt: 201 }))
  await assert.rejects(manual, WatchlistConflictError)
  await assert.rejects(session.push(), WatchlistConflictError)
  assert.equal(writes.length, 2)
  assert.deepEqual(state.groups, groups())
  assert.equal(state.dirty, true)
})

test('migration conflicts with an empty cloud never erase local groups', async () => {
  const { state, reads, writes, session } = setup()
  const operation = session.pull()
  await flush()
  reads[0]!.resolve({ groups: [], updatedAt: 0 })
  await flush()
  writes[0]!.response.reject(new WatchlistConflictError({ groups: [], updatedAt: 200 }))
  await assert.rejects(operation, WatchlistConflictError)
  assert.deepEqual(state.groups, groups())
  assert.equal(state.lastSyncedAt, 100)
  await assert.rejects(session.push(), WatchlistConflictError)
  assert.equal(writes.length, 1)
})

test('replacement connection ignores old pull and upload results', async () => {
  for (const type of ['pull', 'push'] as const) {
    const { state, reads, writes, applied, session } = setup()
    state.dirty = type === 'push'
    const operation = session[type]()
    await flush()
    state.scope = 'connection-b'
    if (type === 'push') writes[0]!.response.resolve(200)
    else reads[0]!.resolve({ groups: reversed(), updatedAt: 200 })
    await operation
    assert.equal(state.lastSyncedAt, 100)
    assert.equal(applied.length, 0)
  }
})

test('another completed synchronization invalidates old responses', async () => {
  const { state, writes, session } = setup()
  state.dirty = true
  const operation = session.push()
  await flush()
  state.lastSyncedAt = 300
  state.groups = reversed()
  writes[0]!.response.resolve(200)
  assert.equal(await operation, false)
  assert.equal(state.lastSyncedAt, 300)
  assert.equal(state.dirty, true)
})

test('pulls are single flight and empty cloud migrates local data without clearing it', async () => {
  const { state, reads, writes, session } = setup()
  const operation = session.pull()
  assert.equal(session.pull(), operation)
  await flush()
  reads[0]!.resolve({ groups: [], updatedAt: 0 })
  await flush()
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0]!.groups, groups())
  writes[0]!.response.resolve(200)
  assert.equal(await operation, false)
  assert.deepEqual(state.groups, groups())
  assert.equal(state.lastSyncedAt, 200)
})
