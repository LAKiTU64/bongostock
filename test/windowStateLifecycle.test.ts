/* eslint-disable test/no-import-node-test -- The project runs its regression suites with Node. */
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { createPlugin, saveNow } from '@tauri-store/pinia'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia } from 'pinia'
import { createApp, nextTick } from 'vue'

import { useAppStore } from '../src/stores/app'
import { compactPetLayout } from '../src/utils/petLayout'
import { restorePosition } from '../src/utils/windowGeometry'
import { createWindowStateRecorder } from '../src/utils/windowStateLifecycle'

const screen = { id: 'main', scale: 2, bounds: { x: 0, y: 0, width: 1440, height: 900 }, work: { x: 0, y: 25, width: 1440, height: 875 } }
const saved = { x: 1300, y: 790, width: 93, height: 69, version: 2 as const, space: 'macos-logical' as const }

test('restore sizes the pet before resolving an edge position and ignores startup resize events', async () => {
  const captures: unknown[] = []
  let rect = { x: 0, y: 40, width: 800, height: 600 }
  const recorder = createWindowStateRecorder(async () => {
    captures.push({ ...rect })
  })
  await recorder.record()
  await recorder.restore(async () => {
    const layout = compactPetLayout(true, 50, 1)
    rect = { ...rect, width: layout.windowWidth, height: layout.windowHeight }
    await recorder.record()
  }, async () => {
    rect = restorePosition(saved, 'macos-logical', rect, [screen], screen.id)
    await recorder.record()
  })
  assert.deepEqual(captures, [])
  assert.deepEqual(rect, { x: 1300, y: 790, width: 93, height: 69 })
  await recorder.record()
  assert.deepEqual(captures, [rect])
})

test('quick quit joins the in-flight capture and resamples the final drag location before returning', async () => {
  let release!: () => void
  let started!: () => void
  const firstRead = new Promise<void>((resolve) => {
    started = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const written: number[] = []
  let x = 35
  const recorder = createWindowStateRecorder(async () => {
    const snapshot = x
    started()
    await blocked
    written.push(snapshot)
  })
  await recorder.restore(async () => {}, async () => {})
  const moved = recorder.record()
  await firstRead
  x = 432
  void recorder.record()
  const quit = recorder.record()
  release()
  await Promise.all([moved, quit])
  assert.deepEqual(written, [35, 432])
})

test('a failed restore preserves the disk position until a new move and allows that move to be flushed', async () => {
  let x = 0
  let disk = 1300
  const recorder = createWindowStateRecorder(async () => {
    disk = x
  })
  await assert.rejects(recorder.restore(async () => {}, async () => {
    throw new Error('Display temporarily unavailable')
  }), /Display temporarily unavailable/)
  await recorder.record() // resize, scale and quit alone must not persist x=0
  assert.equal(recorder.ready, false)
  assert.equal(disk, 1300)
  x = 1142
  await recorder.record(true)
  assert.equal(disk, 1142)
  x = 1145
  await recorder.record()
  assert.equal(disk, 1145)
})

test('retries transient launch sizing before calculating the desktop position', async () => {
  let width = 800
  let attempts = 0
  const recorder = createWindowStateRecorder(async () => {})
  await recorder.restore(async () => {
    if (++attempts === 1) throw new Error('NSWindow unavailable')
    width = 110
  }, async () => {
    assert.equal(width, 110)
  })
  assert.equal(attempts, 2)
  assert.equal(recorder.ready, true)
})

test('a later drag retries a still-pending size before persisting any coordinates', async () => {
  let available = false
  let width = 800
  const widths: number[] = []
  const recorder = createWindowStateRecorder(async () => {
    widths.push(width)
  })
  await assert.rejects(recorder.restore(async () => {
    if (!available) throw new Error('Window unavailable')
    width = 110
  }, async () => {}), /Window unavailable/)
  await recorder.record()
  assert.deepEqual(widths, [])
  available = true
  await recorder.record(true)
  assert.deepEqual(widths, [110])
})

test('disposal during native sizing, positioning or a pending notification never reactivates recording', async () => {
  for (const during of ['sizing', 'positioning', 'notification']) {
    const captures: number[] = []
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold = async () => {
      started()
      await blocked
    }
    const recorder = createWindowStateRecorder(async () => {
      captures.push(1)
    })
    const placed: number[] = []
    const restore = recorder.restore(async () => {
      if (during === 'sizing') await hold()
    }, async () => {
      placed.push(1)
      if (during === 'positioning') await hold()
    })
    if (during === 'notification') {
      await restore
      void recorder.record(true)
    } else {
      await waiting
    }
    recorder.dispose()
    release()
    await restore
    await recorder.record(true)
    assert.equal(recorder.ready, false)
    assert.deepEqual(captures, [])
    assert.equal(placed.length, during === 'sizing' ? 0 : 1)
  }
})

test('real Pinia plugin loads legacy rectangles and keeps concurrent window patches independent through immediate disk flush', async () => {
  Object.assign(globalThis, { window: { crypto: globalThis.crypto } })
  const data: Record<string, unknown> = { windowState: { main: saved, preference: { x: 42, y: 80 } } }
  let disk: Record<string, any> = {}
  const keys: string[][] = []
  mockWindows('main')
  mockIPC((cmd, args) => {
    const input = args as { state: Record<string, unknown> }
    if (cmd === 'plugin:pinia|load') return structuredClone(data)
    if (cmd === 'plugin:pinia|patch') {
      keys.push(Object.keys(input.state))
      Object.assign(data, JSON.parse(JSON.stringify(input.state)))
    }
    if (cmd === 'plugin:pinia|save_some_now') disk = structuredClone(data)
  }, { shouldMockEvents: true })
  function createStore() {
    const pinia = createPinia().use(createPlugin({ saveOnChange: true, hooks: { error: (error) => {
      throw error
    } } }))
    createApp({}).use(pinia)
    return useAppStore(pinia)
  }
  try {
    const pet = createStore()
    const panel = createStore()
    await Promise.all([pet.$tauri.start(), panel.$tauri.start()])
    assert.deepEqual(pet.windowState.main, saved)
    const petRect = { ...saved, x: 1250 }
    const panelRect = { ...saved, x: 844, width: 296, height: 225 }
    await Promise.all([pet.saveWindowState('main', petRect), panel.saveWindowState('stock-panel', panelRect)])
    await nextTick()
    await saveNow('app')
    assert.ok(keys.every(patch => !patch.includes('windowState')))
    assert.deepEqual(disk['window:main'], petRect)
    assert.deepEqual(disk['window:stock-panel'], panelRect)
    const relaunched = createStore()
    await relaunched.$tauri.start()
    assert.deepEqual(relaunched.windowState.main, petRect)
    assert.deepEqual(relaunched.windowState['stock-panel'], panelRect)
    assert.deepEqual(relaunched.windowState.preference, { x: 42, y: 80 })
  } finally {
    clearMocks()
    Reflect.deleteProperty(globalThis, 'window')
  }
})
