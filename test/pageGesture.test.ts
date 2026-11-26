import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import { createPageGesture, wheelDirection } from '../src/market/pageGesture'

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
