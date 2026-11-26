import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import type { BiliHistoryItem, BiliHistoryPage } from '../src/market/biliHistory'
import type { VideoProgress } from '../src/market/videoHistory'

import { accountHistoryScope, biliIdentity, cloudHistoryItems, cloudPartResume, createPlaybackContext, DEVICE_HISTORY_SCOPE, mergeCloudHistory, preferredHistoryCid, samePlaybackContext } from '../src/market/biliHistory'
import { decodeGatewayResponse, freezeGatewayConnection, GatewayError, gatewayRequestPayload, isBiliIdentityError } from '../src/market/gatewayTransport'
import { MAX_HISTORY_PARTS, MAX_HISTORY_VIDEOS, resumePosition, sanitizeHistoryScope, sanitizeVideoHistory } from '../src/market/videoHistory'
import { useVideoHistoryStore } from '../src/stores/videoHistory'

const connection = { baseUrl: 'https://example.test', bearerToken: 'test-only-token', timeoutMs: 8000 }
const identity = { mid: '123', revision: 'test-revision' }
const local: VideoProgress = { bvid: 'BV1rg1FzvEiP', cid: 101, title: '视频', author: 'UP', page: 1, partTitle: '第一 P', position: 30, duration: 120, watchedAt: 10_000, completed: false }
const cloud: BiliHistoryItem = { bvid: local.bvid, cid: local.cid, title: local.title, author: local.author, page: 1, partTitle: '', positionSec: 80, completed: false, watchedAtMs: 9000, durationSec: 3000, cover: `/v1/media/cover?bvid=${local.bvid}` }
const page: BiliHistoryPage = { ...identity, items: [cloud], hasMore: false }

test('captures an immutable normalized connection and identity without retaining mutable settings', () => {
  const settings = { ...connection, baseUrl: 'HTTPS://EXAMPLE.TEST:443/api///', bearerToken: ' test-only-token ' }
  const context = createPlaybackContext(settings, { logged: true, ...identity })
  settings.baseUrl = 'https://other.test'
  settings.bearerToken = 'replacement'
  assert.equal(context.connection.baseUrl, 'https://example.test/api')
  assert.equal(context.connection.bearerToken, connection.bearerToken)
  assert.equal(context.scope, accountHistoryScope('https://example.test/api/', identity.mid))
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.identity) && Object.isFrozen(context.connection))
  assert.equal(samePlaybackContext(context, createPlaybackContext(context.connection, { logged: true, ...identity })), true)
  assert.equal(samePlaybackContext(context, createPlaybackContext(context.connection, { logged: true, ...identity, revision: 'new' })), false)
  assert.equal(samePlaybackContext(context, createPlaybackContext({ ...context.connection, bearerToken: 'other' }, { logged: true, ...identity })), false)
})

test('old gateways and missing or invalid identities stay in the independent device scope', () => {
  for (const status of [{ logged: true }, { logged: false, ...identity }, { logged: true, mid: '0', revision: 'r' }, { logged: true, mid: '1', revision: '' }]) {
    assert.equal(biliIdentity(status), undefined)
    assert.equal(createPlaybackContext(connection, status).scope, DEVICE_HISTORY_SCOPE)
  }
  assert.equal(createPlaybackContext(connection, { logged: true, ...identity }, true).identity, undefined)
})

test('POST bodies and captured Bearer are forwarded; only 403 and 409 mean Bili identity invalid', () => {
  const frozen = freezeGatewayConnection(connection)
  const report = { ...identity, bvid: local.bvid, cid: local.cid, positionSec: 25, realtimeSec: 10, completed: false, startTs: 100 }
  const payload = gatewayRequestPayload(frozen, '/v1/bili/progress', 'POST', report)
  assert.deepEqual(payload.body, report)
  assert.equal(payload.bearerToken, connection.bearerToken)
  for (const status of [400, 401, 403, 409, 501, 502]) {
    assert.throws(() => decodeGatewayResponse({ status, body: '{"error":"test"}' }), (error: unknown) => {
      assert.ok(error instanceof GatewayError)
      assert.equal(error.status, status)
      assert.equal(isBiliIdentityError(error), [403, 409].includes(status))
      return true
    })
  }
  assert.throws(() => decodeGatewayResponse({ status: 409, body: 'bad json' }), (error: unknown) => isBiliIdentityError(error))
  assert.deepEqual(decodeGatewayResponse({ status: 200, body: '{"ok":true}' }), { ok: true })
})

test('scope validation never persists credentials or silently transfers invalid scopes to an account', () => {
  assert.equal(sanitizeHistoryScope(undefined), 'device')
  assert.equal(sanitizeHistoryScope(JSON.stringify(['https://example.test:443/', '123'])), accountHistoryScope(connection.baseUrl, '123'))
  for (const scope of ['bad', JSON.stringify(['https://user:secret@example.test', '123']), JSON.stringify(['https://example.test?token=secret', '123']), JSON.stringify(['https://example.test', '0'])]) {
    assert.equal(sanitizeHistoryScope(scope), undefined)
    assert.deepEqual(sanitizeVideoHistory([{ ...local, scope }]), [])
  }
})

test('the existing storage key keeps device records and isolates accounts and gateways for lookup and deletion', () => {
  setActivePinia(createPinia())
  const store = useVideoHistoryStore()
  store.entries = [local]
  store.init()
  const a = accountHistoryScope(connection.baseUrl, '123')
  const b = accountHistoryScope(connection.baseUrl, '456')
  const otherGateway = accountHistoryScope('https://other.test', '123')
  store.record({ ...local, position: 50, watchedAt: 11_000 }, a)
  store.record({ ...local, position: 60, watchedAt: 12_000 }, b)
  store.record({ ...local, position: 70, watchedAt: 13_000 }, otherGateway)
  assert.equal(store.findPart(local.bvid, local.cid)?.position, 30)
  assert.equal(store.findPart(local.bvid, local.cid, a)?.position, 50)
  assert.equal(store.latest(local.bvid, b)?.position, 60)
  assert.equal(store.latest(local.bvid, otherGateway)?.position, 70)
  store.remove(local.bvid, a)
  assert.equal(store.findPart(local.bvid, local.cid, a), undefined)
  assert.equal(store.entries.length, 3)
  store.clear(b)
  assert.equal(store.entries.length, 2)
  assert.equal(store.forScope('device').length, 1)
})

test('global history capacity spans every account rather than multiplying per account', () => {
  const rows = Array.from({ length: 220 }, (_, index) => ({ ...local, watchedAt: index + 1, scope: accountHistoryScope(connection.baseUrl, String(index + 1)) }))
  assert.equal(sanitizeVideoHistory(rows).length, MAX_HISTORY_VIDEOS)
  const parts = Array.from({ length: 1100 }, (_, index) => ({ ...local, cid: index + 1, watchedAt: index + 1, scope: accountHistoryScope(connection.baseUrl, index % 2 ? '1' : '2') }))
  assert.equal(sanitizeVideoHistory(parts).length, MAX_HISTORY_PARTS)
})

test('resume uses only the cloud P position and the actual media duration', () => {
  assert.deepEqual(cloudPartResume(cloud), { position: 80, completed: false })
  assert.deepEqual(cloudPartResume({ ...cloud, positionSec: 5 }), { position: 5, completed: false })
  assert.equal(cloudPartResume(undefined), undefined)
  assert.equal(resumePosition(cloudPartResume({ ...cloud, positionSec: 500 }), 120), 0)
  assert.equal(resumePosition(cloudPartResume({ ...cloud, completed: true }), 120), 0)
  assert.equal(resumePosition(cloudPartResume(cloud), 120), 80)
  assert.equal(sanitizeVideoHistory([cloud]).length, 0, 'cloud total duration is never stored as a P breakpoint')
})

test('cloud history lists one latest P per video and preserves the clicked history cid', () => {
  const secondP = { ...cloud, cid: 102, page: 2, watchedAtMs: 11_000 }
  const merged = cloudHistoryItems([cloud, secondP])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.cid, 102)
  assert.deepEqual(cloudHistoryItems([]), [])
  assert.equal(preferredHistoryCid(merged[0]!, { cid: 999 }), 102)
  assert.equal(preferredHistoryCid({ ...merged[0]!, source: 'rcmd' }, { cid: 999 }), 999)
})

test('cloud merge validates identity, preserves per-P records, deduplicates by time and sanitizes covers', () => {
  const rows = mergeCloudHistory([cloud], { ...page, items: [{ ...cloud, positionSec: 2, watchedAtMs: 12_000, cover: 'https://external.test/private' }, { ...cloud, cid: 102 }, { ...cloud, cid: -1 }] }, identity)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.positionSec, 2)
  assert.equal(rows[0]?.cover, cloud.cover)
  assert.throws(() => mergeCloudHistory([], { ...page, revision: 'old' }, identity), (error: unknown) => isBiliIdentityError(error))
})
