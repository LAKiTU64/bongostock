import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { NativeScrollPacket, NativeScrollScope } from '../src/market/nativeScrollBridge'

import { createNativeScrollBridge, createNativeScrollConfigurator } from '../src/market/nativeScrollBridge'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const region = { region: { x: 0.1, y: 0.1, width: 0.8, height: 0.6 }, exclusions: [] }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function packet(epoch: string): NativeScrollPacket {
  return { epoch, x: 0.5, y: 0.5, deltaX: 0, deltaY: 120, deltaMode: 0, phase: 1, momentumPhase: 0 }
}
function setup(options: { pendingListen?: boolean, configure?: (scope: NativeScrollScope | null) => Promise<void> } = {}) {
  const scopes: (NativeScrollScope | null)[] = []
  const active: (string | undefined)[] = []
  const received: NativeScrollPacket[] = []
  const failures: unknown[] = []
  const listener = deferred<() => void>()
  let receive!: (packet: NativeScrollPacket) => void
  let stopped = 0
  const stop = () => {
    stopped += 1
  }
  const bridge = createNativeScrollBridge({
    configure: (scope) => {
      scopes.push(scope)
      return options.configure?.(scope) ?? Promise.resolve()
    },
    listen: (handler) => {
      receive = handler
      return options.pendingListen ? listener.promise : Promise.resolve(stop)
    },
    activate: epoch => active.push(epoch),
    receive: sample => received.push(sample),
    failed: error => failures.push(error),
  })
  return { bridge, scopes, active, received, failures, listener, stop, receive: (sample: NativeScrollPacket) => receive(sample), stopped: () => stopped }
}

test('subscribe before publishing; updates pending subscription use the latest scope', async () => {
  const state = setup({ pendingListen: true })
  const started = state.bridge.start()
  assert.equal(await state.bridge.update(region), false)
  assert.deepEqual(state.scopes, [])
  const replacement = { ...region, region: { ...region.region, y: 0.2 } }
  await state.bridge.update(replacement)
  state.listener.resolve(state.stop)
  await started
  assert.equal(state.scopes.length, 1)
  assert.equal(state.scopes[0]?.region.y, 0.2)
  assert.equal(state.bridge.ready, true)
})

test('revocation rejects already queued packets before native acknowledgement', async () => {
  const removal = deferred<void>()
  const state = setup({ configure: scope => scope ? Promise.resolve() : removal.promise })
  await state.bridge.update(region)
  await state.bridge.start()
  const epoch = state.scopes[0]!.epoch
  state.receive(packet(epoch))
  assert.equal(state.received.length, 1)
  let acknowledged = false
  const paused = state.bridge.update(null).then((result) => {
    acknowledged = result
  })
  assert.equal(state.bridge.ready, false)
  state.receive(packet(epoch))
  assert.equal(state.received.length, 1)
  await tick()
  assert.equal(acknowledged, false)
  removal.resolve()
  await paused
  assert.equal(acknowledged, true)
  assert.equal(state.active.at(-1), undefined)
})

test('stale activation acknowledgement cannot rearm or complete a newer request', async () => {
  const requests: ReturnType<typeof deferred<void>>[] = []
  const state = setup({ configure: () => {
    const request = deferred<void>()
    requests.push(request)
    return request.promise
  } })
  await state.bridge.update(region)
  const started = state.bridge.start()
  await tick()
  const oldEpoch = state.scopes[0]!.epoch
  const newer = state.bridge.update(region)
  const newEpoch = state.scopes[1]!.epoch
  assert.notEqual(oldEpoch, newEpoch)
  requests[0].resolve()
  await started
  assert.equal(state.bridge.ready, false)
  state.receive(packet(oldEpoch))
  assert.equal(state.received.length, 0)
  requests[1].resolve()
  assert.equal(await newer, true)
  state.receive(packet(newEpoch))
  assert.equal(state.received.length, 1)
})

test('dispose during listen stops the eventual subscription without installing a region', async () => {
  const state = setup({ pendingListen: true })
  await state.bridge.update(region)
  const started = state.bridge.start()
  state.bridge.dispose()
  state.listener.resolve(state.stop)
  await started
  assert.equal(state.stopped(), 1)
  assert.deepEqual(state.scopes, [])
  assert.equal(await state.bridge.update(region), false)
})

test('dispose removes capture, is idempotent and rejects in-flight deliveries', async () => {
  const state = setup()
  await state.bridge.update(region)
  await state.bridge.start()
  const epoch = state.scopes[0]!.epoch
  state.bridge.dispose()
  state.bridge.dispose()
  state.receive(packet(epoch))
  assert.equal(state.stopped(), 1)
  assert.equal(state.scopes.at(-1), null)
  assert.equal(state.scopes.length, 2)
  assert.deepEqual(state.received, [])
  assert.equal(state.bridge.ready, false)
})

test('failed activation revokes its epoch and removes a potentially installed monitor', async () => {
  const failure = new Error('configure failed')
  const state = setup({ configure: scope => scope ? Promise.reject(failure) : Promise.resolve() })
  await state.bridge.update(region)
  await state.bridge.start()
  state.receive(packet(state.scopes[0]!.epoch))
  assert.equal(state.bridge.ready, false)
  assert.deepEqual(state.received, [])
  assert.deepEqual(state.failures, [failure])
  assert.equal(state.scopes.at(-1), null)
  assert.equal(state.active.at(-1), undefined)
})

test('removal failure reports false rather than opening a menu over a live monitor', async () => {
  const failure = new Error('remove failed')
  const state = setup({ configure: scope => scope ? Promise.resolve() : Promise.reject(failure) })
  await state.bridge.update(region)
  await state.bridge.start()
  assert.equal(await state.bridge.update(null), false)
  assert.deepEqual(state.failures, [failure])
  assert.equal(state.bridge.ready, false)
})

test('subscription failure never publishes native capture', async () => {
  const state = setup({ pendingListen: true })
  await state.bridge.update(region)
  const started = state.bridge.start()
  const failure = new Error('listen failed')
  state.listener.reject(failure)
  await started
  assert.deepEqual(state.scopes, [])
  assert.deepEqual(state.failures, [failure])
})

test('shared configuration FIFO preserves old-mount cleanup before new activation after failure', async () => {
  const calls: (NativeScrollScope | null)[] = []
  const first = deferred<void>()
  const configure = createNativeScrollConfigurator((scope) => {
    calls.push(scope)
    return calls.length === 1 ? first.promise : Promise.resolve()
  })
  const oldScope = { ...region, epoch: 'old' }
  const newScope = { ...region, epoch: 'new' }
  const firstCall = configure(oldScope)
  const cleanup = configure(null)
  const replacement = configure(newScope)
  await tick()
  assert.deepEqual(calls, [oldScope])
  first.reject(new Error('old activation failed'))
  await assert.rejects(firstCall)
  await Promise.all([cleanup, replacement])
  assert.deepEqual(calls, [oldScope, null, newScope])
})
