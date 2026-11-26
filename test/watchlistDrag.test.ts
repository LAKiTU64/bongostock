// eslint-disable-next-line test/no-import-node-test
import type { TestContext } from 'node:test'

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { effectScope, ref, shallowRef } from 'vue'

import type { WatchlistDragSource } from '../src/pages/preference/components/market/watchlistDrag'

import { resolveWatchlistDrop, useWatchlistDrag, watchlistScrollSpeed } from '../src/pages/preference/components/market/watchlistDrag'

function initialGroups() {
  return [
    { id: 'a', name: '甲', codes: ['SH600001', 'SH600002', 'SH600003'] },
    { id: 'b', name: '乙', codes: ['SH600001', 'SZ000001'] },
    { id: 'c', name: '丙', codes: [] },
  ]
}

const groupSource: WatchlistDragSource = { kind: 'group', groupId: 'a' }
const codeSource: WatchlistDragSource = { kind: 'code', groupId: 'a', code: 'SH600001' }

test('group insertion slots use post-removal indices for before, after and end', () => {
  const groups = initialGroups()
  assert.deepEqual(resolveWatchlistDrop(groups, groupSource, { kind: 'group', before: 'c' }), { kind: 'group', groupId: 'a', from: 0, to: 1 })
  assert.deepEqual(resolveWatchlistDrop(groups, groupSource, { kind: 'group', before: null }), { kind: 'group', groupId: 'a', from: 0, to: 2 })
  assert.deepEqual(resolveWatchlistDrop(groups, { kind: 'group', groupId: 'c' }, { kind: 'group', before: 'a' }), { kind: 'group', groupId: 'c', from: 2, to: 0 })
  assert.deepEqual(resolveWatchlistDrop(groups, { kind: 'group', groupId: 'c' }, { kind: 'group', before: 'b' }), { kind: 'group', groupId: 'c', from: 2, to: 1 })
})

test('stock insertion never transfers across groups, including a duplicated stock', () => {
  const groups = initialGroups()
  assert.deepEqual(resolveWatchlistDrop(groups, codeSource, { kind: 'code', groupId: 'a', before: 'SH600003' }), { kind: 'code', groupId: 'a', from: 0, to: 1 })
  assert.deepEqual(resolveWatchlistDrop(groups, codeSource, { kind: 'code', groupId: 'a', before: null }), { kind: 'code', groupId: 'a', from: 0, to: 2 })
  assert.deepEqual(resolveWatchlistDrop(groups, { kind: 'code', groupId: 'a', code: 'SH600003' }, { kind: 'code', groupId: 'a', before: 'SH600001' }), { kind: 'code', groupId: 'a', from: 2, to: 0 })
  assert.equal(resolveWatchlistDrop(groups, codeSource, { kind: 'code', groupId: 'b', before: 'SH600001' }), null)
  assert.equal(resolveWatchlistDrop(groups, codeSource, { kind: 'code', groupId: 'c', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, codeSource, { kind: 'group', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, groupSource, { kind: 'code', groupId: 'a', before: null }), null)
})

test('self, adjacent, missing source/target and unchanged end slots are no-ops', () => {
  const groups = initialGroups()
  for (const before of ['a', 'b', 'missing']) assert.equal(resolveWatchlistDrop(groups, groupSource, { kind: 'group', before }), null)
  for (const before of ['SH600001', 'SH600002', 'missing']) assert.equal(resolveWatchlistDrop(groups, codeSource, { kind: 'code', groupId: 'a', before }), null)
  assert.equal(resolveWatchlistDrop(groups, { kind: 'group', groupId: 'c' }, { kind: 'group', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, { kind: 'group', groupId: 'missing' }, { kind: 'group', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, { kind: 'code', groupId: 'a', code: 'missing' }, { kind: 'code', groupId: 'a', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, { kind: 'code', groupId: 'a', code: 'SH600003' }, { kind: 'code', groupId: 'a', before: null }), null)
  assert.equal(resolveWatchlistDrop(groups, codeSource, null), null)
})

test('every legal insertion produces a permutation with the source at the store target index', () => {
  for (let size = 1; size <= 12; size += 1) {
    const groups = Array.from({ length: size }, (_, index) => ({ id: String(index), name: String(index), codes: [] }))
    for (let from = 0; from < size; from += 1) {
      for (let slot = 0; slot <= size; slot += 1) {
        const before = groups[slot]?.id ?? null
        const source: WatchlistDragSource = { kind: 'group', groupId: String(from) }
        const move = resolveWatchlistDrop(groups, source, { kind: 'group', before })
        if (slot === from || slot === from + 1) {
          assert.equal(move, null)
          continue
        }
        assert.ok(move)
        const order = groups.map(group => group.id)
        const [item] = order.splice(move.from, 1)
        order.splice(move.to, 0, item!)
        const expected = groups.map(group => group.id)
        expected.splice(slot, 0, 'moved')
        expected.splice(expected.indexOf(String(from)), 1)
        assert.deepEqual(order, expected.map(item => item === 'moved' ? String(from) : item))
      }
    }
  }
})

test('auto-scroll is bounded, supports short lists and stops outside the edge region', () => {
  assert.equal(watchlistScrollSpeed(100, 100, 500), -720)
  assert.equal(watchlistScrollSpeed(500, 100, 500), 720)
  assert.equal(watchlistScrollSpeed(300, 100, 500), 0)
  assert.equal(watchlistScrollSpeed(50, 100, 500), 0)
  assert.equal(watchlistScrollSpeed(550, 100, 500), 0)
  assert.equal(watchlistScrollSpeed(105, 100, 100), 0)
  assert.equal(watchlistScrollSpeed(115, 100, 130), 0)
  assert.ok(watchlistScrollSpeed(125, 100, 130) > 0)
  assert.ok(watchlistScrollSpeed(110, 100, 500) > -720)
})

// Minimal DOM fixture: exercise the actual pointer listeners, capture, hit-testing and RAF
// lifecycle without a browser, Tauri, or adding a DOM package to the application.
class TrackedTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(listener)
    }
    super.addEventListener(type, listener, options)
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, options)
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

class ElementFixture extends TrackedTarget {
  children: ElementFixture[] = []
  parentElement: ElementFixture | null = null
  dataset: Record<string, string> = {}
  overflowY = 'visible'
  captured: number | null = null
  focused = false
  visible = true
  maxScroll = 0
  private position = 0

  constructor(public top: number, public bottom: number) {
    super()
  }

  get scrollTop() {
    return this.position
  }

  set scrollTop(value: number) {
    this.position = Math.max(0, Math.min(this.maxScroll, value))
  }

  append(child: ElementFixture) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  contains(element: ElementFixture): boolean {
    return element === this || this.children.some(child => child.contains(element))
  }

  matches(selector: string) {
    const key = selector.slice(1, -1).replace(/^data-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    return key in this.dataset
  }

  closest(selector: string): ElementFixture | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null
  }

  querySelectorAll(selector: string): ElementFixture[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }

  getBoundingClientRect() {
    let offset = 0
    for (let parent = this.parentElement; parent; parent = parent.parentElement) offset += parent.scrollTop
    return { top: this.top - offset, bottom: this.bottom - offset, left: 0, right: 500 }
  }

  getClientRects() {
    return this.visible ? [this.getBoundingClientRect()] : []
  }

  focus() {
    this.focused = true
  }

  setPointerCapture(id: number) {
    this.captured = id
  }

  hasPointerCapture(id: number) {
    return this.captured === id
  }

  releasePointerCapture() {
    this.captured = null
  }
}

function inputEvent(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values)
}

function setup(t: TestContext, geometryHitTesting = false) {
  const windowTarget = Object.assign(new TrackedTarget(), { innerWidth: 800, innerHeight: 600 })
  const pane = new ElementFixture(0, 600)
  pane.overflowY = 'auto'
  pane.maxScroll = 500
  const root = pane.append(new ElementFixture(20, 500))
  const groupA = root.append(new ElementFixture(20, 240))
  groupA.dataset.watchlistGroup = 'a'
  const groupHandle = groupA.append(new ElementFixture(20, 60))
  const list = groupA.append(new ElementFixture(80, 240))
  list.dataset.watchlistCodes = 'a'
  list.overflowY = 'auto'
  for (let index = 0; index < 3; index += 1) {
    const row = list.append(new ElementFixture(80 + index * 40, 120 + index * 40))
    row.dataset.watchlistCode = `SH60000${index + 1}`
  }
  const codeHandle = list.children[0]!.append(new ElementFixture(80, 120))
  const groupB = root.append(new ElementFixture(260, 360))
  groupB.dataset.watchlistGroup = 'b'
  const otherList = groupB.append(new ElementFixture(280, 360))
  otherList.dataset.watchlistCodes = 'b'
  const groupC = root.append(new ElementFixture(380, 480))
  groupC.dataset.watchlistGroup = 'c'
  let hit: ElementFixture | null = list
  function elementAtPoint(element: ElementFixture, x: number, y: number): ElementFixture | null {
    const bounds = element.getBoundingClientRect()
    const inside = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
    if (!element.visible || (!inside && /auto|scroll|hidden|clip/.test(element.overflowY))) return null
    for (const child of [...element.children].reverse()) {
      const result = elementAtPoint(child, x, y)
      if (result) return result
    }
    return inside ? element : null
  }
  const documentTarget = Object.assign(new TrackedTarget(), {
    hidden: false,
    scrollingElement: null,
    elementFromPoint: (x: number, y: number) => geometryHitTesting ? elementAtPoint(pane, x, y) : hit,
  })
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  const globals: Record<string, unknown> = {
    window: windowTarget,
    document: documentTarget,
    getComputedStyle: (element: ElementFixture) => ({ overflowY: element.overflowY }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  const groups = ref(initialGroups())
  const calls: unknown[][] = []
  function move<T>(items: T[], from: number, to: number) {
    const [item] = items.splice(from, 1)
    items.splice(to, 0, item!)
  }
  const scope = effectScope()
  const drag = scope.run(() => useWatchlistDrag({
    root: shallowRef(root as unknown as HTMLElement),
    groups: () => groups.value,
    moveGroup: (from, to) => {
      calls.push(['group', from, to])
      const next = structuredClone(groups.value.map(group => ({ ...group, codes: [...group.codes] })))
      move(next, from, to)
      groups.value = next
    },
    moveCode: (groupId, from, to) => {
      calls.push(['code', groupId, from, to])
      const next = groups.value.map(group => ({ ...group, codes: [...group.codes] }))
      move(next.find(group => group.id === groupId)!.codes, from, to)
      groups.value = next
    },
  }))!
  t.after(() => {
    scope.stop()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const dispatch = (type: string, values: Record<string, unknown> = {}) => {
    const event = inputEvent(type, { pointerId: 1, buttons: 1, clientX: 20, clientY: 230, ...values })
    windowTarget.dispatchEvent(event)
    return event
  }
  function start(source = codeSource, values: Record<string, unknown> = {}) {
    const event = inputEvent('pointerdown', { isPrimary: true, button: 0, pointerId: 1, clientX: 20, clientY: source.kind === 'code' ? 90 : 30, ...values })
    Object.defineProperty(event, 'currentTarget', { value: source.kind === 'code' ? codeHandle : groupHandle })
    drag.start(event as unknown as PointerEvent, source)
    return event
  }
  function clean() {
    assert.equal(drag.active.value, null)
    assert.equal(frames.size, 0)
    assert.equal(windowTarget.listenerCount(), 0)
    assert.equal(documentTarget.listenerCount(), 0)
    assert.equal(groupHandle.listenerCount(), 0)
    assert.equal(codeHandle.listenerCount(), 0)
    assert.equal(codeHandle.captured, null)
    assert.equal(groupHandle.captured, null)
  }
  function tick(time: number) {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(time)
  }
  return { drag, groups, calls, start, dispatch, clean, scope, list, otherList, groupB, groupC, pane, codeHandle, documentTarget, tick, hit: (element: ElementFixture | null) => {
    hit = element
  } }
}

test('pointer drag starts only on a primary handle after a threshold; click is inert', (t) => {
  const f = setup(t)
  f.start(codeSource, { button: 2 })
  f.clean()
  f.start(codeSource, { isPrimary: false })
  f.clean()
  f.start()
  assert.equal(f.codeHandle.focused, true)
  f.dispatch('pointermove', { clientY: 93 })
  assert.equal(f.drag.active.value, null)
  f.dispatch('pointerup', { clientY: 93 })
  assert.deepEqual(f.calls, [])
  f.clean()
})

test('pointer stock drop uses an end cue and commits once, leaving other groups unchanged', (t) => {
  const f = setup(t)
  f.start()
  f.dispatch('pointermove')
  assert.deepEqual(f.drag.active.value, codeSource)
  assert.equal(f.drag.codeCue('a', 'SH600003', 2), 'drop-after')
  assert.equal(f.drag.codeCue('b', 'SH600001', 0), '')
  f.dispatch('pointerup')
  f.dispatch('pointerup')
  assert.deepEqual(f.calls, [['code', 'a', 0, 2]])
  assert.deepEqual(f.groups.value[0]!.codes, ['SH600002', 'SH600003', 'SH600001'])
  assert.deepEqual(f.groups.value[1]!.codes, initialGroups()[1]!.codes)
  assert.match(f.drag.announcement.value, /第 3 项/)
  f.clean()
})

test('group drag supports before and after/end without stock cues', (t) => {
  const f = setup(t)
  f.hit(f.groupC)
  f.start(groupSource)
  f.dispatch('pointermove', { clientY: 390 })
  assert.equal(f.drag.groupCue('c', 2), 'drop-before')
  assert.equal(f.drag.codeCue('a', 'SH600003', 2), '')
  f.dispatch('pointermove', { clientY: 470 })
  assert.equal(f.drag.groupCue('c', 2), 'drop-after')
  f.dispatch('pointerup', { clientY: 470 })
  assert.deepEqual(f.calls, [['group', 0, 2]])
  assert.deepEqual(f.groups.value.map(group => group.id), ['b', 'c', 'a'])
  f.clean()
})

test('cross-group, outside and no-op stock drops do not call the store', (t) => {
  const f = setup(t)
  for (const hit of [f.otherList, null, f.list]) {
    f.start()
    f.hit(hit)
    f.dispatch('pointermove', { clientY: 110 })
    assert.equal(f.drag.codeCue('a', 'SH600001', 0), '')
    f.dispatch('pointerup', { clientY: 110 })
    f.clean()
  }
  assert.deepEqual(f.calls, [])
})

test('release hit-test rejects an outside drop even after a valid insertion cue', (t) => {
  const f = setup(t)
  f.start()
  f.dispatch('pointermove')
  assert.equal(f.drag.codeCue('a', 'SH600003', 2), 'drop-after')
  f.hit(null)
  f.dispatch('pointerup')
  assert.deepEqual(f.calls, [])
  f.clean()
})

test('Escape, pointercancel, lost capture, blur, hidden page, lost button and unmount clean up', (t) => {
  const f = setup(t)
  const cancelActions = [
    () => f.dispatch('keydown', { key: 'Escape' }),
    () => f.dispatch('pointercancel'),
    () => f.codeHandle.dispatchEvent(new Event('lostpointercapture')),
    () => f.dispatch('blur'),
    () => {
      f.documentTarget.hidden = true
      f.documentTarget.dispatchEvent(new Event('visibilitychange'))
      f.documentTarget.hidden = false
    },
    () => f.dispatch('pointermove', { buttons: 0 }),
    () => f.scope.stop(),
  ]
  for (const cancel of cancelActions) {
    f.start()
    f.dispatch('pointermove')
    cancel()
    f.dispatch('pointerup')
    f.clean()
    assert.deepEqual(f.calls, [])
  }
})

test('foreign pointers cannot finish/cancel the active drag; Escape cancels pending gestures too', (t) => {
  const f = setup(t)
  f.start()
  f.dispatch('pointermove')
  f.dispatch('pointerup', { pointerId: 2 })
  f.dispatch('pointercancel', { pointerId: 2 })
  assert.deepEqual(f.drag.active.value, codeSource)
  f.drag.cancel()
  f.start()
  f.dispatch('keydown', { key: 'Escape' })
  f.dispatch('pointermove')
  f.dispatch('pointerup')
  f.clean()
  assert.deepEqual(f.calls, [])
})

test('replacement, rename, stock edit and group removal invalidate a drag synchronously', (t) => {
  const f = setup(t)
  const changes = [
    () => {
      f.groups.value = initialGroups()
    },
    () => {
      f.groups.value[0]!.name = '更名'
    },
    () => {
      f.groups.value[0]!.codes.reverse()
    },
    () => {
      f.groups.value.splice(0, 1)
    },
  ]
  for (const change of changes) {
    f.groups.value = initialGroups()
    f.start()
    f.dispatch('pointermove')
    change()
    f.clean()
    f.dispatch('pointerup')
    assert.deepEqual(f.calls, [])
  }
})

test('handle keyboard sorting supports arrows and Home/End with boundary no-ops', (t) => {
  const f = setup(t)
  const key = (key: string, source: WatchlistDragSource) => {
    const event = inputEvent('keydown', { key })
    f.drag.keyboard(event as unknown as KeyboardEvent, source)
    return event
  }
  assert.equal(key('Tab', codeSource).defaultPrevented, false)
  key('ArrowUp', codeSource)
  assert.deepEqual(f.calls, [])
  key('ArrowDown', codeSource)
  key('End', codeSource)
  key('End', codeSource)
  key('Home', codeSource)
  assert.deepEqual(f.calls, [['code', 'a', 0, 1], ['code', 'a', 1, 2], ['code', 'a', 2, 0]])
  key('End', groupSource)
  key('ArrowUp', groupSource)
  key('Home', groupSource)
  assert.deepEqual(f.calls.slice(3), [['group', 0, 2], ['group', 2, 1], ['group', 1, 0]])
  f.clean()
})

test('auto-scroll keeps running without pointermove, reaches long-list ends and updates hit-testing', (t) => {
  const f = setup(t, true)
  const codes = Array.from({ length: 100 }, (_, index) => `SH${String(index).padStart(6, '0')}`)
  f.groups.value[0]!.codes = codes
  f.list.children = []
  for (let index = 0; index < codes.length; index += 1) {
    const row = f.list.append(new ElementFixture(80 + index * 40, 120 + index * 40))
    row.dataset.watchlistCode = codes[index]!
  }
  f.list.children[0]!.append(f.codeHandle)
  f.list.maxScroll = codes.length * 40 - 160
  const source: WatchlistDragSource = { kind: 'code', groupId: 'a', code: codes[0]! }
  f.start(source)
  f.dispatch('pointermove', { clientY: 239 })
  for (let time = 16; time < 7000; time += 16) f.tick(time)
  assert.equal(f.list.scrollTop, f.list.maxScroll)
  assert.equal(f.drag.codeCue('a', codes.at(-1)!, codes.length - 1), 'drop-after')
  f.dispatch('pointerup', { clientY: 239 })
  assert.deepEqual(f.calls, [['code', 'a', 0, 99]])
  f.clean()
})

for (const edge of ['top', 'bottom'] as const) {
  test(`stock auto-scroll reveals the clipped ${edge} edge without scrolling the source list away`, (t) => {
    const f = setup(t, true)
    const codes = Array.from({ length: 100 }, (_, index) => `SH${String(index).padStart(6, '0')}`)
    f.groups.value[0]!.codes = codes
    f.list.children = []
    for (let index = 0; index < codes.length; index += 1) {
      const row = f.list.append(new ElementFixture(80 + index * 40, 120 + index * 40))
      row.dataset.watchlistCode = codes[index]!
    }
    f.list.maxScroll = codes.length * 40 - 160
    // Both outer directions have room to scroll beyond the source list. Fractional
    // clipping distances require the final frame to be smaller than its normal step.
    f.pane.bottom = 179.5
    f.pane.scrollTop = edge === 'top' ? 103.5 : 0
    f.list.scrollTop = edge === 'top' ? 0 : f.list.maxScroll
    const from = edge === 'top' ? 2 : 96
    const to = edge === 'top' ? 0 : 99
    const row = f.list.children[from]!
    row.append(f.codeHandle)
    f.codeHandle.top = row.top
    f.codeHandle.bottom = row.bottom
    const startY = f.codeHandle.getBoundingClientRect().top + 10
    const y = edge === 'top' ? 1 : 178.5
    const expectedScroll = edge === 'top' ? 80 : 60.5
    assert.equal(f.documentTarget.elementFromPoint(20, startY), f.codeHandle)
    f.start({ kind: 'code', groupId: 'a', code: codes[from]! }, { clientY: startY })
    f.dispatch('pointermove', { clientY: y })
    for (let time = 16; time < 4000; time += 40) {
      f.tick(time)
      assert.ok(edge === 'top' ? f.pane.scrollTop >= expectedScroll : f.pane.scrollTop <= expectedScroll, 'no frame overshoots the revealed edge')
      assert.equal(f.documentTarget.elementFromPoint(20, y)?.closest('[data-watchlist-codes]'), f.list)
    }
    assert.ok(Math.abs(f.pane.scrollTop - expectedScroll) < 1e-9)
    const stoppedAt = f.pane.scrollTop
    f.tick(5000)
    assert.equal(f.pane.scrollTop, stoppedAt)
    assert.equal(f.list.scrollTop, edge === 'top' ? 0 : f.list.maxScroll)
    assert.equal(f.drag.codeCue('a', codes[to]!, to), edge === 'top' ? 'drop-before' : 'drop-after')
    f.dispatch('pointerup', { clientY: y })
    assert.deepEqual(f.calls, [['code', 'a', from, to]])
    f.clean()
  })
}

test('auto-scroll reaches both outer pane edges for group dragging', (t) => {
  const f = setup(t)
  f.start(groupSource)
  f.dispatch('pointermove', { clientY: 599 })
  for (let time = 16; time < 1000; time += 16) f.tick(time)
  assert.equal(f.pane.scrollTop, f.pane.maxScroll)
  f.dispatch('pointermove', { clientY: 1 })
  for (let time = 1000; time < 2000; time += 16) f.tick(time)
  assert.equal(f.pane.scrollTop, 0)
  f.drag.cancel()
  f.clean()
  assert.deepEqual(f.calls, [])
})

test('failed pointer capture leaves no pending gesture or listeners', (t) => {
  const f = setup(t)
  f.codeHandle.setPointerCapture = () => {
    throw new Error('pointer is no longer active')
  }
  f.start()
  f.dispatch('pointermove')
  f.dispatch('pointerup')
  f.clean()
  assert.deepEqual(f.calls, [])
})

test('partly clipped stock list scrolls at the visible pane edge; hiding the handle cancels', (t) => {
  const f = setup(t)
  f.pane.bottom = 180
  f.list.maxScroll = 500
  f.start()
  f.dispatch('pointermove', { clientY: 179 })
  f.tick(16)
  f.tick(32)
  assert.ok(f.list.scrollTop > 0)
  f.codeHandle.visible = false
  f.tick(48)
  f.clean()
  assert.deepEqual(f.calls, [])
})
