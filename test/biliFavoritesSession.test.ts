import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { BiliFavoriteFolders, BiliFavoriteVideos } from '../src/market/biliFavorites'
import type { PlaybackContext } from '../src/market/biliHistory'

import { createBiliFavoritesSession } from '../src/market/biliFavoritesSession'
import { createPlaybackContext } from '../src/market/biliHistory'
import { createFeedPager, favoriteCacheKey, isFavoriteCacheKey, visibleVideoItems } from '../src/market/feedPager'
import { GatewayError } from '../src/market/gatewayTransport'

const identity = { mid: '123', revision: 'login-1' }
const connection = { baseUrl: 'https://gateway.example', bearerToken: 'test-token', timeoutMs: 8000 }
const context = () => createPlaybackContext(connection, { logged: true, ...identity })
function folders(ids = ['10', '20']): BiliFavoriteFolders {
  return { ...identity, folders: ids.map(id => ({ id, title: `收藏夹 ${id}`, mediaCount: 20, isPrivate: id === '20' })) }
}
function videos(folderId = '10', page = 1, count = 20): BiliFavoriteVideos {
  return {
    ...identity,
    folderId,
    page,
    hasMore: false,
    items: Array.from({ length: count }, (_, index) => {
      const bvid = `BV${String(Number(folderId) * 1000 + page * 100 + index).padStart(10, '0')}`
      return { id: `favorites:${bvid}`, source: 'favorites', bvid, title: bvid, url: `https://www.bilibili.com/video/${bvid}` }
    }),
  }
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
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

type Dependencies = Parameters<typeof createBiliFavoritesSession>[0]
function setup(overrides: Partial<Dependencies> = {}) {
  let folderCalls = 0
  let revoked = 0
  const videoCalls: Array<[string, number]> = []
  const session = createBiliFavoritesSession({
    folders: async () => {
      folderCalls += 1
      return folders()
    },
    videos: async (_identity, _connection, folderId, page) => {
      videoCalls.push([folderId, page])
      return videos(folderId, page)
    },
    changed: () => {},
    identityInvalid: () => {
      revoked += 1
      pager.invalidate()
    },
    ...overrides,
  })
  const pager = createFeedPager({
    fetch: async (key, page) => isFavoriteCacheKey(key)
      ? session.readPage(key.slice('favorites:'.length), page)
      : { items: videos('99').items, hasMore: false },
    changed: () => {},
  })
  session.setContext(context())
  async function select(id = session.snapshot().selectedId!) {
    session.selectFolder(id)
    await pager.select(favoriteCacheKey(id))
  }
  return { session, pager, select, videoCalls, counts: () => ({ folderCalls, revoked }) }
}

test('folders are lazy, single-flight and reused across source switches; first folder is selected', async () => {
  const fixture = setup()
  await fixture.pager.select('rcmd')
  await fixture.pager.select('history')
  assert.equal(fixture.counts().folderCalls, 0)
  const first = fixture.session.loadFolders()
  assert.equal(first, fixture.session.loadFolders())
  await first
  assert.equal(fixture.session.snapshot().selectedId, '10')
  await fixture.select()
  await fixture.pager.select('rcmd')
  await fixture.session.loadFolders()
  await fixture.select()
  assert.equal(fixture.counts().folderCalls, 1)
  assert.deepEqual(fixture.videoCalls, [['10', 1]])
})

test('login and identity support gate every favorite request, including manual refresh', async () => {
  for (const status of [{ logged: false }, { logged: true }]) {
    const fixture = setup()
    fixture.session.setContext(createPlaybackContext(connection, status))
    assert.equal(await fixture.session.loadFolders(), false)
    await fixture.session.refresh(async () => {
      assert.fail('must not refresh videos')
    })
    await assert.rejects(fixture.session.readPage('10', 1), /登录/)
    assert.equal(fixture.counts().folderCalls, 0)
    assert.deepEqual(fixture.videoCalls, [])
    assert.deepEqual(fixture.session.snapshot().folders, [])
  }
})

test('no folders and an empty folder are separate successful states', async () => {
  const none = setup({ folders: async () => folders([]) })
  await none.session.loadFolders()
  assert.equal(none.session.snapshot().loaded, true)
  assert.equal(none.session.snapshot().selectedId, undefined)
  await none.session.refresh(async () => {
    assert.fail('no folder to request')
  })
  assert.equal(none.session.snapshot().error, '')
  const empty = setup({ videos: async (_identity, _connection, id, page) => videos(id, page, 0) })
  await empty.session.loadFolders()
  await empty.select()
  assert.equal(empty.session.snapshot().selectedId, '10')
  assert.equal(empty.pager.snapshot().loaded, true)
  assert.equal(empty.pager.snapshot().hasMore, false)
  assert.equal(empty.pager.snapshot().error, '')
  assert.deepEqual(visibleVideoItems(empty.pager.snapshot()), [])
})

test('folder switching keeps independent pages and never resets recommendations or history', async () => {
  const fixture = setup()
  await fixture.pager.select('rcmd')
  await fixture.pager.move(3)
  await fixture.pager.select('history')
  await fixture.pager.move(2)
  await fixture.session.loadFolders()
  await fixture.select('10')
  await fixture.pager.move(4)
  const first = fixture.pager.snapshot()
  await fixture.select('20')
  await fixture.pager.move(1)
  const second = fixture.pager.snapshot()
  await fixture.select('10')
  assert.deepEqual(fixture.pager.snapshot(), first)
  await fixture.select('20')
  assert.deepEqual(fixture.pager.snapshot(), second)
  assert.equal(fixture.pager.snapshot('rcmd').page, 3)
  assert.equal(fixture.pager.snapshot('history').page, 2)
  assert.deepEqual(fixture.videoCalls, [['10', 1], ['20', 1]])
  fixture.pager.cancelNavigation() // Playback/return never changes the selected folder or page.
  assert.equal(fixture.session.snapshot().selectedId, '20')
  assert.deepEqual(fixture.pager.snapshot(), second)
})

test('late results and failures populate only the captured old folder key', async () => {
  for (const reject of [false, true]) {
    const pending = deferred<unknown>()
    const fixture = setup({ videos: async (_identity, _connection, id, page) => id === '10' ? pending.promise : videos(id, page) })
    await fixture.session.loadFolders()
    const first = fixture.select('10')
    await flush()
    await fixture.select('20')
    const current = fixture.pager.snapshot()
    if (reject) pending.reject(new Error('old folder offline'))
    else pending.resolve(videos('10'))
    await first
    assert.deepEqual(fixture.pager.snapshot(), current)
    assert.equal(fixture.session.snapshot().selectedId, '20')
    assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).error, reject ? 'old folder offline' : '')
    assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).items.length, reject ? 0 : 20)
  }
})

test('refresh first updates folders, preserves selection and replaces only its video page on success', async () => {
  let listing = folders()
  let failFolders = false
  let failVideos = false
  let videoCalls = 0
  const fixture = setup({
    folders: async () => {
      if (failFolders) throw new Error('folders offline')
      return listing
    },
    videos: async (_identity, _connection, id, page) => {
      videoCalls += 1
      if (failVideos) throw new Error('videos offline')
      return videos(id, page)
    },
  })
  const refresh = () => fixture.session.refresh(id => fixture.pager.refresh(favoriteCacheKey(id)))
  await fixture.pager.select('rcmd')
  await fixture.pager.move(2)
  await fixture.session.loadFolders()
  await fixture.select('20')
  await fixture.pager.move(3)
  const before = fixture.pager.snapshot()
  failFolders = true
  await refresh()
  assert.equal(videoCalls, 1)
  assert.equal(fixture.session.snapshot().error, 'folders offline')
  assert.equal(fixture.session.snapshot().selectedId, '20')
  assert.deepEqual(fixture.pager.snapshot(), before)
  failFolders = false
  failVideos = true
  listing = folders(['30', '20'])
  await refresh()
  assert.equal(fixture.session.snapshot().selectedId, '20')
  assert.equal(fixture.pager.snapshot().page, 3)
  assert.deepEqual(fixture.pager.snapshot().items, before.items)
  assert.equal(fixture.pager.snapshot().failedRefresh, true)
  failVideos = false
  await fixture.pager.retry()
  assert.equal(fixture.pager.snapshot().page, 0)
  assert.equal(fixture.pager.snapshot().error, '')
  listing = folders(['30'])
  await refresh()
  assert.equal(fixture.session.snapshot().selectedId, '30')
  assert.equal(fixture.pager.snapshot(favoriteCacheKey('30')).loaded, true)
  assert.equal(fixture.pager.snapshot('rcmd').page, 2)
  listing = folders([])
  const calls = videoCalls
  await refresh()
  assert.equal(fixture.session.snapshot().selectedId, undefined)
  assert.equal(videoCalls, calls)
})

test('switching folders during a video refresh does not reset the newly selected folder', async () => {
  const pending = deferred<unknown>()
  let refreshing = false
  const fixture = setup({ videos: async (_identity, _connection, id, page) => refreshing && id === '10' ? pending.promise : videos(id, page) })
  await fixture.session.loadFolders()
  await fixture.select('20')
  await fixture.pager.move(2)
  const second = fixture.pager.snapshot()
  await fixture.select('10')
  await fixture.pager.move(3)
  refreshing = true
  const refresh = fixture.session.refresh(id => fixture.pager.refresh(favoriteCacheKey(id)))
  await flush()
  await fixture.select('20')
  pending.resolve(videos('10'))
  await refresh
  assert.equal(fixture.session.snapshot().selectedId, '20')
  assert.deepEqual(fixture.pager.snapshot(), second)
  assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).page, 0)
})

test('a pending refresh never blocks a replacement account or clears its refresh state', async () => {
  const oldVideos = deferred<void>()
  const newVideos = deferred<void>()
  const fixture = setup({ folders: async current => ({ ...folders(), ...current }) })
  await fixture.session.loadFolders()
  const oldRefresh = fixture.session.refresh(() => oldVideos.promise)
  await flush()
  assert.equal(fixture.session.snapshot().refreshing, true)
  fixture.session.setContext(createPlaybackContext(connection, { logged: true, ...identity, revision: 'login-2' }))
  assert.equal(fixture.session.snapshot().refreshing, false)
  const newRefresh = fixture.session.refresh(() => newVideos.promise)
  await flush()
  assert.equal(fixture.session.snapshot().loaded, true)
  assert.equal(fixture.session.snapshot().refreshing, true)
  oldVideos.resolve()
  await oldRefresh
  assert.equal(fixture.session.snapshot().refreshing, true)
  newVideos.resolve()
  await newRefresh
  assert.equal(fixture.session.snapshot().refreshing, false)
})

test('a stale directory refresh cannot request video data under a replacement identity', async () => {
  const pending = deferred<unknown>()
  let refreshing = false
  const fixture = setup({ folders: async () => refreshing ? pending.promise : folders() })
  await fixture.session.loadFolders()
  await fixture.select()
  refreshing = true
  const refresh = fixture.session.refresh(async () => {
    assert.fail('old directory refresh must not continue under a replacement identity')
  })
  await flush()
  fixture.session.setContext(createPlaybackContext(connection, { logged: true, ...identity, revision: 'login-2' }))
  fixture.pager.invalidate()
  pending.resolve(folders())
  await refresh
  assert.equal(fixture.session.snapshot().loaded, false)
  assert.deepEqual(fixture.videoCalls, [['10', 1]])
})

test('a directory failure is not automatically retried by ensure, but explicit refresh retries it', async () => {
  let calls = 0
  const fixture = setup({ folders: async () => {
    if (++calls === 1) throw new Error('offline')
    return folders()
  } })
  assert.equal(await fixture.session.loadFolders(), false)
  assert.equal(fixture.session.snapshot().loading, false)
  assert.equal(fixture.session.snapshot().error, 'offline')
  assert.equal(await fixture.session.loadFolders(), false)
  assert.equal(calls, 1)
  await fixture.session.refresh(id => fixture.pager.refresh(favoriteCacheKey(id)))
  assert.equal(calls, 2)
  assert.equal(fixture.session.snapshot().error, '')
  assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).loaded, true)
})

test('video failures are retryable without wheel-driven request loops, keeping cached pages', async () => {
  let fail = true
  let calls = 0
  const fixture = setup({ videos: async (_identity, _connection, id, page) => {
    calls += 1
    if (page === 1) return { ...videos(id, page, 8), hasMore: true }
    if (fail) throw new Error('offline')
    return videos(id, page)
  } })
  await fixture.session.loadFolders()
  await fixture.select()
  await fixture.pager.move(3)
  await flush()
  const before = fixture.pager.snapshot()
  assert.equal(before.error, 'offline')
  for (let count = 0; count < 20; count += 1) await fixture.pager.move(1)
  assert.equal(calls, 2)
  assert.equal(fixture.pager.snapshot().page, 3)
  assert.deepEqual(fixture.pager.snapshot().items, before.items)
  fail = false
  await fixture.pager.move(1, true)
  assert.equal(fixture.pager.snapshot().page, 4)
  assert.equal(calls, 3)
})

test('403 and 409 on either endpoint revoke folder/video caches and request identity refresh', async () => {
  for (const status of [403, 409]) {
    for (const endpoint of ['folders', 'videos']) {
      let fail = false
      const fixture = setup({
        folders: async () => {
          if (fail && endpoint === 'folders') throw new GatewayError('expired', status)
          return folders()
        },
        videos: async (_identity, _connection, id, page) => {
          if (fail && endpoint === 'videos') throw new GatewayError('expired', status)
          return videos(id, page)
        },
      })
      await fixture.session.loadFolders()
      await fixture.select()
      fail = true
      await fixture.session.refresh(id => fixture.pager.refresh(favoriteCacheKey(id)))
      assert.equal(fixture.counts().revoked, 1)
      assert.equal(fixture.session.snapshot().loaded, false)
      assert.equal(fixture.session.snapshot().selectedId, undefined)
      assert.deepEqual(fixture.session.snapshot().folders, [])
      assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).items.length, 0)
      assert.equal(fixture.pager.snapshot(favoriteCacheKey('10')).error, '')
      assert.equal(await fixture.session.loadFolders(), false, 'old identity stays revoked until status refresh')
    }
  }
})

test('malformed successful responses never replace cached data or page coordinates', async () => {
  let bad = false
  const fixture = setup({ videos: async (_identity, _connection, id, page) => bad ? { ...videos(id, page), folderId: '999' } : videos(id, page) })
  await fixture.session.loadFolders()
  await fixture.select()
  await fixture.pager.move(2)
  const before = fixture.pager.snapshot()
  bad = true
  await fixture.pager.refresh()
  assert.equal(fixture.pager.snapshot().page, 2)
  assert.deepEqual(fixture.pager.snapshot().items, before.items)
  assert.match(fixture.pager.snapshot().error, /数据不完整/)
})

test('mismatched successful account envelopes revoke identity rather than retaining private data', async () => {
  const fixture = setup({ folders: async () => ({ ...folders(), revision: 'different' }) })
  await fixture.session.loadFolders()
  assert.equal(fixture.counts().revoked, 1)
  assert.deepEqual(fixture.session.snapshot().folders, [])
})

test('account, revision, address and token changes discard late directory responses and failures', async () => {
  const replacements: PlaybackContext[] = [
    createPlaybackContext(connection, { logged: true, ...identity, mid: '456' }),
    createPlaybackContext(connection, { logged: true, ...identity, revision: 'login-2' }),
    createPlaybackContext({ ...connection, baseUrl: 'https://new.example' }, { logged: true, ...identity }),
    createPlaybackContext({ ...connection, bearerToken: 'new-token' }, { logged: true, ...identity }),
  ]
  for (const replacement of replacements) {
    for (const reject of [false, true]) {
      const pending = deferred<unknown>()
      const fixture = setup({ folders: async () => pending.promise })
      const loading = fixture.session.loadFolders()
      await flush()
      fixture.session.setContext(replacement)
      fixture.pager.invalidate() // Same account invalidation hook used by the component.
      if (reject) pending.reject(new GatewayError('old login expired', 403))
      else pending.resolve(folders())
      assert.equal(await loading, false)
      assert.equal(fixture.session.snapshot().loading, false)
      assert.equal(fixture.session.snapshot().loaded, false)
      assert.equal(fixture.session.snapshot().error, '')
      assert.equal(fixture.counts().revoked, 0, 'an old 403 must not revoke the replacement identity')
    }
  }
})

test('identity invalidation isolates late video success and failure from the replacement cache', async () => {
  for (const reject of [false, true]) {
    const pending = deferred<unknown>()
    const fixture = setup({ videos: async () => pending.promise })
    await fixture.session.loadFolders()
    const loading = fixture.select()
    await flush()
    fixture.session.setContext(undefined)
    fixture.pager.invalidate()
    fixture.session.setContext(context())
    if (reject) pending.reject(new GatewayError('old identity', 409))
    else pending.resolve(videos())
    await loading
    assert.equal(fixture.counts().revoked, 0)
    assert.equal(fixture.pager.snapshot().loaded, false)
    assert.equal(fixture.pager.snapshot().error, '')
    assert.deepEqual(fixture.session.snapshot().folders, [])
  }
})

test('captured session context is frozen, while same-identity status updates retain folder selection', async () => {
  let captured: PlaybackContext['connection'] | undefined
  const mutable = { connection: { ...connection }, identity: { ...identity }, scope: context().scope }
  const fixture = setup({ folders: async (_identity, connection) => {
    captured = connection
    assert.equal(Object.isFrozen(_identity), true)
    return folders()
  } })
  fixture.session.setContext(undefined)
  fixture.session.setContext(mutable)
  mutable.connection.baseUrl = 'https://mutated.example'
  mutable.identity.mid = '999'
  await fixture.session.loadFolders()
  assert.equal(captured?.baseUrl, connection.baseUrl)
  assert.equal(Object.isFrozen(captured), true)
  fixture.session.selectFolder('20')
  fixture.session.setContext(context())
  assert.equal(fixture.session.snapshot().selectedId, '20')
})

test('server notice is retained, and favorites do not silently stop at the generic feed cap', async () => {
  const fixture = setup({ videos: async (_identity, _connection, id, page) => ({
    ...videos(id, page, 2),
    hasMore: page < 51,
    ...(page === 51 ? { notice: '收藏仅显示前 51 页。' } : {}),
  }) })
  await fixture.session.loadFolders()
  await fixture.select()
  for (let count = 0; count < 60; count += 1) {
    await fixture.pager.move(1)
    await flush()
  }
  assert.equal(fixture.pager.snapshot().apiPage, 51)
  assert.equal(fixture.pager.snapshot().notice, '收藏仅显示前 51 页。')
  assert.equal(fixture.pager.snapshot().hasMore, false)
})

test('disposal and pre-dispatch context changes make pending work inert', async () => {
  let calls = 0
  let changes = 0
  const pending = deferred<unknown>()
  const fixture = setup({ folders: async () => {
    calls += 1
    return pending.promise
  }, changed: () => changes += 1 })
  const cancelled = fixture.session.loadFolders()
  fixture.session.setContext(undefined)
  await cancelled
  assert.equal(calls, 0)
  fixture.session.setContext(context())
  const loading = fixture.session.loadFolders()
  await flush()
  fixture.session.dispose()
  const before = changes
  pending.resolve(folders())
  assert.equal(await loading, false)
  assert.equal(changes, before)
  assert.equal(await fixture.session.loadFolders(), false)
})
