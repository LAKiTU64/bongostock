import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import { createBiliFavoritesClient, parseBiliFavoriteFolders, parseBiliFavoriteVideos } from '../src/market/biliFavorites'
import { GatewayError } from '../src/market/gatewayTransport'

const identity = { mid: '123', revision: 'revision-1' }
const connection = { baseUrl: 'https://gateway.example/', bearerToken: ' test-token ', timeoutMs: 8000 }
const folder = { id: '10', title: '稍后看', mediaCount: 2, isPrivate: true }
const item = {
  id: 'favorites:BV1234567890',
  bvid: 'BV1234567890',
  source: 'favorites',
  title: '视频',
  author: '作者',
  stat: '1.1w播放',
  durationSec: 120,
  url: 'https://www.bilibili.com/video/BV1234567890',
  cover: '/v1/media/cover?bvid=BV1234567890',
}
const folders = () => ({ ...identity, folders: [{ ...folder }] })
const videos = () => ({ ...identity, folderId: '10', page: 1, items: [{ ...item }], hasMore: true, notice: '仅显示前 50 页。' })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}

test('favorite DTOs accept empty lists, private folders and playable items without cid', () => {
  assert.deepEqual(parseBiliFavoriteFolders(folders(), identity), folders())
  assert.deepEqual(parseBiliFavoriteFolders({ ...identity, folders: [] }, identity).folders, [])
  const page = parseBiliFavoriteVideos(videos(), identity, '10', 1)
  assert.deepEqual(page, videos())
  assert.equal(page.items[0]!.cid, undefined)
  assert.equal(page.notice, '仅显示前 50 页。')
  assert.deepEqual(parseBiliFavoriteVideos({ ...videos(), items: [], hasMore: false }, identity, '10', 1).items, [])
})

test('folder and video envelopes reject another account or login revision with 409', () => {
  for (const changed of [{ mid: '456' }, { revision: 'new-login' }]) {
    assert.throws(() => parseBiliFavoriteFolders({ ...folders(), ...changed }, identity), (error: unknown) => error instanceof GatewayError && error.status === 409)
    assert.throws(() => parseBiliFavoriteVideos({ ...videos(), ...changed }, identity, '10', 1), (error: unknown) => error instanceof GatewayError && error.status === 409)
  }
})

test('folder decoder rejects malformed envelopes, identifiers, counts and flags', () => {
  const invalid: unknown[] = [null, [], {}, { ...folders(), folders: {} }, { ...folders(), mid: 123 }, { ...folders(), folders: [folder, folder] }]
  for (const patch of [{ id: 10 }, { id: '0' }, { title: null }, { mediaCount: -1 }, { mediaCount: 1.5 }, { isPrivate: 1 }]) {
    invalid.push({ ...folders(), folders: [{ ...folder, ...patch }] })
  }
  for (const value of invalid) assert.throws(() => parseBiliFavoriteFolders(value, identity))
})

test('video decoder validates request coordinates and critical structures rather than casting JSON', () => {
  const invalid: unknown[] = [null, [], {}, { ...videos(), folderId: '11' }, { ...videos(), page: 2 }, { ...videos(), page: '1' }, { ...videos(), items: {} }, { ...videos(), hasMore: 'false' }, { ...videos(), notice: {} }]
  for (const patch of [
    { id: 'rcmd:BV1234567890' },
    { source: 'history' },
    { bvid: 'bad' },
    { title: 123 },
    { author: {} },
    { stat: 1 },
    { url: 'https://other.example/video/BV1234567890' },
    { cover: {} },
    { durationSec: -1 },
    { durationSec: Infinity },
    { cid: 0 },
  ]) invalid.push({ ...videos(), items: [{ ...item, ...patch }] })
  invalid.push({ ...videos(), items: [null] })
  for (const value of invalid) assert.throws(() => parseBiliFavoriteVideos(value, identity, '10', 1))
})

test('cover metadata is rebuilt from the validated video identifier', () => {
  const page = parseBiliFavoriteVideos({ ...videos(), items: [{ ...item, cover: '/v1/media/cover?bvid=another&token=injected' }] }, identity, '10', 1)
  assert.equal(page.items[0]!.cover, '/v1/media/cover?bvid=BV1234567890')
})

test('client uses exact endpoints and query fields, freezing connection and identity before awaiting', async () => {
  const pending = deferred<unknown>()
  const mutableIdentity = { ...identity, revision: 'revision & + /' }
  const mutableConnection = { ...connection }
  const calls: Array<{ path: string, connection: typeof connection }> = []
  const client = createBiliFavoritesClient(async (path, captured) => {
    calls.push({ path, connection: captured })
    return pending.promise
  })
  const request = client.folders(mutableIdentity, mutableConnection)
  const url = new URL(calls[0]!.path, 'https://gateway.example')
  assert.equal(url.pathname, '/v1/bili/favorites/folders')
  assert.deepEqual([...url.searchParams], [['mid', '123'], ['revision', 'revision & + /']])
  assert.equal(Object.isFrozen(calls[0]!.connection), true)
  mutableConnection.baseUrl = 'https://changed.example'
  mutableConnection.bearerToken = 'changed'
  mutableIdentity.mid = '999'
  mutableIdentity.revision = 'changed'
  pending.resolve({ ...folders(), revision: 'revision & + /' })
  assert.equal((await request).mid, '123')
  assert.deepEqual(calls[0]!.connection, { baseUrl: 'https://gateway.example', bearerToken: 'test-token', timeoutMs: 8000 })
})

test('video client captures folder/page, validates its response and propagates transport status', async () => {
  let path = ''
  const client = createBiliFavoritesClient(async (requested) => {
    path = requested
    return { ...videos(), page: 3 }
  })
  const result = await client.videos(identity, connection, '10', 3)
  assert.equal(result.page, 3)
  const url = new URL(path, 'https://gateway.example')
  assert.equal(url.pathname, '/v1/bili/favorites/videos')
  assert.deepEqual([...url.searchParams], [['mid', '123'], ['revision', 'revision-1'], ['folderId', '10'], ['page', '3']])
  await assert.rejects(client.videos(identity, connection, '10', 2))
  await assert.rejects(client.videos(identity, connection, 'not-an-id', 1))
  await assert.rejects(client.videos(identity, connection, '10', 0))
  for (const status of [403, 409, 500]) {
    const failing = createBiliFavoritesClient(async () => {
      throw new GatewayError('failed', status)
    })
    await assert.rejects(failing.folders(identity, connection), (error: unknown) => error instanceof GatewayError && error.status === status)
  }
})
