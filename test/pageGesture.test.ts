import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import { createPageGesture, SCROLL_PHASE, TRACKPAD_PAGE_DISTANCE_PX, TRACKPAD_START_DISTANCE_PX, wheelDirection } from '../src/market/pageGesture'

function setup() {
  const turns: number[] = []
  const gesture = createPageGesture({ turn: direction => turns.push(direction) })
  const wheel = (deltaY: number, deltaX = 0) => gesture.wheel({ deltaX, deltaY, deltaMode: 0 })
  return { gesture, turns, wheel }
}

test('one wheel input turns exactly one page regardless of distance or acceleration', () => {
  const { wheel, turns } = setup()
  for (const distance of [1, 3, 40, 64, 120, 240, 100_000, Number.MAX_VALUE]) {
    wheel(distance)
    wheel(-distance)
  }
  assert.deepEqual(turns, Array.from({ length: 8 }, () => [1, -1]).flat())
})

test('pixel, line and page units never multiply the page count', () => {
  const { gesture, turns } = setup()
  for (const deltaMode of [0, 1, 2]) {
    gesture.wheel({ deltaX: 0, deltaY: 3, deltaMode })
    gesture.wheel({ deltaX: 0, deltaY: -3, deltaMode })
  }
  assert.deepEqual(turns, [1, -1, 1, -1, 1, -1])
})

test('successive wheel inputs are not delayed, accumulated or discarded by a cooldown', () => {
  const { wheel, turns } = setup()
  for (let index = 0; index < 10; index += 1) wheel(120)
  assert.deepEqual(turns, Array.from({ length: 10 }, () => 1))
  wheel(-120)
  assert.equal(turns.at(-1), -1)
})

test('small inputs do not need several events to reach a distance threshold', () => {
  const { wheel, turns } = setup()
  wheel(0.25)
  assert.deepEqual(turns, [1])
  wheel(-0.25)
  assert.deepEqual(turns, [1, -1])
})

test('horizontal scrolling uses the dominant axis and still turns one page', () => {
  const { wheel, turns } = setup()
  wheel(4, 800)
  wheel(4, -800)
  wheel(-800, 4)
  assert.deepEqual(turns, [1, -1, -1])
})

test('modifier zoom and zero or invalid input are not captured', () => {
  const { gesture, wheel, turns } = setup()
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(gesture.wheel({ deltaX: 0, deltaY: 120, deltaMode: 0, [modifier]: true }), false)
  }
  for (const invalid of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(wheel(invalid), false)
    assert.equal(wheel(120, invalid), false)
  }
  assert.equal(wheel(0), false)
  assert.equal(wheelDirection({ deltaX: 0, deltaY: 120, deltaMode: 3 }), 0)
  assert.deepEqual(turns, [])
})

test('dispose ignores later wheel events', () => {
  const { gesture, wheel, turns } = setup()
  wheel(120)
  gesture.dispose()
  assert.equal(wheel(120), false)
  assert.deepEqual(turns, [1])
})

function nativeSetup() {
  const state = setup()
  state.gesture.activate('a')
  const send = (deltaY: number, phase: number = SCROLL_PHASE.changed, overrides = {}) => state.gesture.nativeWheel({
    epoch: 'a',
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    phase,
    momentumPhase: 0,
    ...overrides,
  })
  return { ...state, send }
}
const distance = TRACKPAD_PAGE_DISTANCE_PX
const start = TRACKPAD_START_DISTANCE_PX

test('fragmented trackpad input turns at 20 pixels, then at 70 pixels', () => {
  const { send, turns } = nativeSetup()
  send(0, SCROLL_PHASE.began)
  for (let i = 0; i < 79; i += 1) send(0.25)
  assert.deepEqual(turns, [])
  send(0.25)
  assert.deepEqual(turns, [1])
  send(49)
  assert.deepEqual(turns, [1])
  send(1)
  assert.deepEqual(turns, [1, 1])
})

test('a single trackpad packet can cross several pages and carry the remainder', () => {
  const { send, turns } = nativeSetup()
  send(start + 3 * distance - 1, SCROLL_PHASE.began)
  assert.deepEqual(turns, [1, 1, 1])
  send(1)
  assert.deepEqual(turns, [1, 1, 1, 1])
})

test('a reversal starts at the first-page threshold with or without leftover distance', () => {
  for (const remainder of [0, 9]) {
    const { send, turns } = nativeSetup()
    send(start + remainder, SCROLL_PHASE.began)
    send(-(start - 1))
    assert.deepEqual(turns, [1])
    send(-1)
    assert.deepEqual(turns, [1, -1])
    send(-(distance - 1))
    assert.deepEqual(turns, [1, -1])
    send(-1)
    assert.deepEqual(turns, [1, -1, -1])
  }
})

test('horizontal trackpad uses dominant distance without summing both axes', () => {
  const { send, turns } = nativeSetup()
  send(start / 2, SCROLL_PHASE.began, { deltaX: start / 2 })
  assert.deepEqual(turns, [])
  send(1, SCROLL_PHASE.changed, { deltaX: start / 2 })
  assert.deepEqual(turns, [1])
})

test('momentum never contributes distance or cancels a new finger gesture', () => {
  const { send, turns } = nativeSetup()
  send(start / 2, SCROLL_PHASE.began)
  send(0, SCROLL_PHASE.ended)
  send(distance * 50, 0, { momentumPhase: SCROLL_PHASE.began })
  send(distance * 50, 0, { momentumPhase: SCROLL_PHASE.changed })
  assert.deepEqual(turns, [])
  send(start / 2, SCROLL_PHASE.began)
  send(0, 0, { momentumPhase: SCROLL_PHASE.ended })
  send(start / 2)
  assert.deepEqual(turns, [1])
})

test('ended and cancelled reset partial travel; mid-gesture entry does not page', () => {
  for (const end of [SCROLL_PHASE.ended, SCROLL_PHASE.cancelled]) {
    const { send, turns } = nativeSetup()
    send(distance * 5)
    send(start + distance - 1, SCROLL_PHASE.began)
    send(0, end)
    send(distance * 5)
    send(1, SCROLL_PHASE.began)
    assert.deepEqual(turns, [1])
    send(start - 1)
    assert.deepEqual(turns, [1, 1])
  }
})

test('scope changes revoke stale packets and require a fresh Began', () => {
  const { gesture, send, turns } = nativeSetup()
  send(start + distance - 1, SCROLL_PHASE.began)
  gesture.activate('b')
  assert.equal(send(distance * 5), false)
  send(distance * 5, SCROLL_PHASE.changed, { epoch: 'b' })
  send(1, SCROLL_PHASE.began, { epoch: 'b' })
  assert.deepEqual(turns, [1])
  send(start - 1, SCROLL_PHASE.changed, { epoch: 'b' })
  assert.deepEqual(turns, [1, 1])
  gesture.activate()
  assert.equal(send(distance, SCROLL_PHASE.began, { epoch: 'b' }), false)
})

test('invalid units, modifiers and non-finite native deltas never page', () => {
  const { gesture, send, turns } = nativeSetup()
  send(0, SCROLL_PHASE.began)
  for (const deltaMode of [1, 2, 3]) send(distance, SCROLL_PHASE.changed, { deltaMode })
  for (const delta of [Number.NaN, Infinity, -Infinity]) send(delta)
  for (const key of ['ctrlKey', 'metaKey', 'altKey']) send(distance, SCROLL_PHASE.began, { [key]: true })
  send(distance)
  assert.deepEqual(turns, [])
  assert.equal(send(distance, 0), false)
  gesture.dispose()
  assert.equal(send(distance, SCROLL_PHASE.began), false)
})

test('synchronous scope replacement stops remaining turns from a large packet', () => {
  const turns: number[] = []
  const gesture = createPageGesture({ turn: (direction) => {
    turns.push(direction)
    gesture.activate('b')
  } })
  gesture.activate('a')
  gesture.nativeWheel({ epoch: 'a', deltaX: 0, deltaY: distance * 3, deltaMode: 0, phase: SCROLL_PHASE.began, momentumPhase: 0 })
  assert.deepEqual(turns, [1])
})
