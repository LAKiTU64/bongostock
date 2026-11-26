import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import { it } from 'node:test'

import type { Rect, SavedWindow, ScreenArea } from '../src/utils/windowGeometry'

import { clampRect, contains, createSerialQueue, fitToDesktop, moveAndVerify, normalizeMonitor, placePair, placePanel, restorePosition, selectScreen, visibleOnDesktop } from '../src/utils/windowGeometry'
import { recoverWindowPlacement } from '../src/utils/windowRecoveryFlow'

const primary = normalizeMonitor({
  name: 'retina',
  scaleFactor: 2,
  position: { x: 0, y: 0 },
  size: { width: 3024, height: 1964 },
  workArea: { position: { x: 0, y: 50 }, size: { width: 3024, height: 1800 } },
}, 'macos-logical')
const left = normalizeMonitor({
  name: 'external',
  scaleFactor: 1,
  position: { x: -1920, y: -98 },
  size: { width: 1920, height: 1080 },
  workArea: { position: { x: -1920, y: -73 }, size: { width: 1920, height: 1055 } },
}, 'macos-logical')
const screens = [left, primary] // primary intentionally not first
const pet = { width: 110, height: 75 }
const panel = { width: 296, height: 225 }

it('mixed-DPI macOS screens normalize to one global logical space', () => {
  assert.deepEqual(primary.bounds, { x: 0, y: 0, width: 1512, height: 982 })
  assert.deepEqual(left.bounds, { x: -1920, y: -98, width: 1920, height: 1080 })
  assert.equal(selectScreen(screens, primary.id, undefined, { x: -1332, y: 41 }).id, left.id)
  assert.equal(selectScreen(screens, primary.id, undefined, { x: 99999, y: 99999 }).id, primary.id)
})

it('windows retains physical monitor origins on mixed DPI', () => {
  const monitor = normalizeMonitor({ name: 'right', scaleFactor: 1.5, position: { x: 1920, y: 0 }, size: { width: 2560, height: 1440 } }, 'physical')
  assert.deepEqual(monitor.bounds, { x: 1920, y: 0, width: 2560, height: 1440 })
  assert.deepEqual(restorePosition({ x: 2100, y: 200 }, 'physical', pet, [monitor], monitor.id), { x: 2100, y: 200, ...pet })
})

it('legacy macOS physical records use a uniquely corroborated source scale', () => {
  const restored = restorePosition({ x: -1332, y: 41, width: 110, height: 75 }, 'macos-logical', pet, screens, primary.id)
  assert.deepEqual(restored, { ...pet, x: -1332, y: 41 })
  assert.deepEqual(restorePosition({ x: 2000, y: 500, width: 220, height: 150 }, 'macos-logical', pet, screens, primary.id), { ...pet, x: 1000, y: 250 })
  const saved: SavedWindow = { ...restored, version: 2, space: 'macos-logical', scale: 2 }
  for (let i = 0; i < 20; i++) assert.deepEqual(restorePosition(saved, 'macos-logical', pet, screens, primary.id), restored)
})

function screenAt(id: string, x: number, y: number, width: number, height: number, scale = 1): ScreenArea {
  const bounds = { x, y, width, height }
  return { id, bounds, work: bounds, scale }
}

it('legacy records with missing, inconsistent, or ambiguous scale evidence reset on the primary display', () => {
  const right = screenAt('right', 1512, 0, 2000, 1000)
  for (const record of [{ x: 2000, y: 500 }, { x: 2000, y: 500, width: 110, height: 150 }]) {
    assert.deepEqual(restorePosition(record, 'macos-logical', pet, [right, primary], primary.id), restorePosition(undefined, 'macos-logical', pet, [right, primary], primary.id))
  }
  // Both scales reproduce the integer physical size and place the window on
  // their respective screens. The input has no information to distinguish them.
  const tiny = { width: 1, height: 1 }
  const ambiguous = { x: 2000, y: 200, width: 2, height: 2 }
  assert.deepEqual(restorePosition(ambiguous, 'macos-logical', tiny, [right, primary], primary.id), restorePosition(undefined, 'macos-logical', tiny, [right, primary], primary.id))
})

it('preserves visible horizontal, vertical and four-way spans across mixed-DPI screens, including negative origins', async () => {
  const upperLeft = screenAt('ul', -1000, -600, 1000, 600, 2)
  const upperRight = screenAt('ur', 0, -600, 1000, 600, 1)
  const lowerLeft = screenAt('ll', -1000, 0, 1000, 700, 1)
  const lowerRight = screenAt('lr', 0, 0, 1000, 700, 2)
  const layout = [upperLeft, upperRight, lowerLeft, lowerRight]
  for (const rect of [{ x: -65, y: -300, ...panel }, { x: -800, y: -55, ...panel }, { x: -60, y: -40, ...panel }]) {
    assert.equal(layout.some(screen => contains(screen.work, rect)), false)
    assert.equal(visibleOnDesktop(rect, layout), true)
    assert.deepEqual(restorePosition({ ...rect, version: 2, space: 'macos-logical' }, 'macos-logical', panel, layout, lowerRight.id), rect)
    assert.deepEqual(await moveAndVerify(rect, layout, async () => rect, async point => assert.deepEqual(point, rect), async () => {}), rect)
  }
})

it('rejects internal gaps and dock insets even when all four window corners are visible', () => {
  const left = screenAt('left', -900, 0, 890, 600)
  const right = screenAt('right', 0, 0, 900, 600)
  const rect = { x: -60, y: 100, ...panel }
  assert.equal(visibleOnDesktop(rect, [left, right]), false)
  assert.deepEqual(fitToDesktop(rect, [left, right]), { ...rect, x: 0 })
  const insetLeft = { ...left, bounds: { ...left.bounds, width: 900 } }
  assert.equal(visibleOnDesktop(rect, [insetLeft, right]), false)
  const overlap = [screenAt('mirrored A', 0, 0, 500, 500), screenAt('mirrored B', 0, 0, 500, 500)]
  assert.equal(visibleOnDesktop({ x: 400, y: 30, ...panel }, overlap), false)
})

it('makes the smallest correction after a display shifts or changes resolution', () => {
  const left = screenAt('left', -1000, 0, 1000, 600)
  const right = screenAt('right', 0, 0, 1000, 600)
  const rect = { x: -150, y: 365, ...panel }
  assert.deepEqual(fitToDesktop(rect, [left, right]), rect)
  const shorterRight = screenAt('shorter', 0, 0, 1000, 575)
  // Moving up just 15 pixels keeps the existing horizontal span.
  assert.deepEqual(fitToDesktop(rect, [left, shorterRight]), { ...rect, y: 350 })
  assert.deepEqual(fitToDesktop(rect, [left]), { ...rect, x: -panel.width })
})

it('the window adapter saves a spanning window in logical points without moving it during a display change', async () => {
  const active = [left, primary]
  const monitors = active.map((screen) => {
    const physical = (r: Rect) => ({
      position: { x: r.x * screen.scale, y: r.y * screen.scale },
      size: { width: r.width * screen.scale, height: r.height * screen.scale },
    })
    return { name: screen.id, scaleFactor: screen.scale, ...physical(screen.bounds), workArea: physical(screen.work) }
  })
  let snapshots = 0
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'macos' },
      __TAURI_INTERNALS__: {
        invoke: async (name: string) => {
          if (name.endsWith('|available_monitors')) return monitors
          if (name.endsWith('|primary_monitor')) return monitors[1]
          if (name.endsWith('|display_work_areas')) return ++snapshots === 1 ? [primary] : active
          throw new Error(`Unexpected native command: ${name}`)
        },
      },
    },
  })
  try {
    const { ensureWindowOnScreen, saveWindowRect } = await import('../src/utils/windowPlacement')
    const window = {
      scaleFactor: async () => 2,
      outerPosition: async () => ({ x: -40, y: 160 }),
      outerSize: async () => ({ width: panel.width * 2, height: panel.height * 2 }),
      setPosition: async () => {
        throw new Error('Already-visible window should not move')
      },
    } as unknown as WebviewWindow
    const expected = { x: -20, y: 80, ...panel }
    assert.deepEqual(await ensureWindowOnScreen(window), expected)
    assert.equal(snapshots, 2)
    assert.deepEqual(await saveWindowRect(window), { ...expected, version: 2, space: 'macos-logical', scale: 2 })
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

it('v2 logical position remains on left display regardless of recorded/current scale', () => {
  for (const scale of [1, 2, 3]) {
    assert.deepEqual(restorePosition({ version: 2, space: 'macos-logical', scale, x: -1332, y: 41 }, 'macos-logical', pet, screens, primary.id), { x: -1332, y: 41, ...pet })
  }
})

it('removed display and known offscreen live frame fall back to primary', () => {
  const old = { version: 2, space: 'macos-logical', x: -1332, y: 41 } as const
  assert.ok(contains(primary.work, restorePosition(old, 'macos-logical', pet, [primary], primary.id)))
  const live = { x: 2596, y: 1558, ...pet }
  assert.equal(selectScreen(screens, primary.id, live).id, primary.id)
  assert.ok(contains(primary.work, clampRect(live, primary.work)))
})

it('invalid, missing and extreme saved coordinates cannot escape the work area', () => {
  const samples: (SavedWindow | undefined)[] = [undefined, {}, { x: Number.NaN, y: 1 }, { x: Infinity, y: 0 }, { x: 1e20, y: -1e20 }, { x: 1 }, { x: 0, y: 0, space: 'physical', version: 2 }]
  for (const saved of samples) assert.ok(contains(primary.work, restorePosition(saved, 'macos-logical', pet, screens, primary.id)))
  assert.throws(() => selectScreen([], primary.id), /No available display/)
})

it('clamp uses the entire rectangle and excludes menu bar/dock', () => {
  for (const screen of screens) {
    for (const size of [pet, panel, { width: 558, height: 414 }]) {
      for (const x of [-3000, -100, 0, 1511, 9999]) {
        for (const y of [-999, -98, 0, 981, 9999]) assert.ok(contains(screen.work, clampRect({ x, y, ...size }, screen.work)))
      }
    }
  }
})

it('panel placement ignores stale coordinates carried along with its size', () => {
  const stale = { ...panel, x: 99999, y: 99999 }
  const result = placePanel({ x: -1200, y: 100, ...pet }, stale, left.work)
  assert.equal(result.y, 187)
  assert.equal(result.x, -1293)
  assert.ok(contains(left.work, result))
})

it('pet and 296x225 panel are adjacent and entirely visible on either display', () => {
  for (const screen of screens) {
    for (const size of [pet, { width: 558, height: 414 }]) {
      const pair = placePair(size, panel, screen.work)
      assert.ok(contains(screen.work, pair.pet))
      assert.ok(contains(screen.work, pair.panel))
      assert.equal(pair.panel.y - pair.pet.y - pair.pet.height, 12)
    }
  }
})

it('short work area chooses horizontal pair; oversized windows anchor safely', () => {
  const area = { x: -1000, y: -50, width: 1000, height: 250 }
  const pair = placePair(pet, panel, area)
  assert.ok(contains(area, pair.pet))
  assert.ok(contains(area, pair.panel))
  assert.equal(pair.panel.x - pair.pet.x - pair.pet.width, 12)
  const oversized = clampRect({ x: 100, y: 100, width: 1200, height: 600 }, area)
  assert.equal(oversized.x, area.x)
  assert.equal(oversized.y, area.y)
  assert.equal(contains(area, oversized), false) // impossible without resizing; never claim success
})

it('readback retries a native missed move and corrects final resized dimensions', async () => {
  let live: Rect = { x: 2596, y: 1558, ...pet }
  let moves = 0
  const target = { x: 1390, y: 800, ...pet }
  const result = await moveAndVerify(target, primary.work, async () => live, async (point) => {
    moves++
    if (moves > 1) live = { ...point, width: 300, height: 225 }
  }, async () => {})
  assert.equal(moves, 3)
  assert.ok(contains(primary.work, result))
})

it('failed readback is bounded and surfaces an error instead of false success', async () => {
  let moves = 0
  await assert.rejects(moveAndVerify({ x: 100, y: 100, ...pet }, primary.work, async () => ({ x: 2596, y: 1558, ...pet }), async () => {
    moves++
  }, async () => {}), /could not be verified/)
  assert.equal(moves, 3)
})

it('hidden retained panel moves without showing or entering playback lifecycle', async () => {
  const events: string[] = []
  await recoverWindowPlacement({
    place: async () => {
      events.push('move')
    },
    show: async () => {
      events.push('show')
    },
    verify: async () => {
      events.push('verify')
    },
    persist: async () => {
      events.push('persist')
    },
  }, { x: 100, y: 100, ...panel }, primary.work, false)
  assert.deepEqual(events, ['move', 'verify', 'persist'])
})

it('visible window is positioned before reveal and verified after unminimizing', async () => {
  const events: string[] = []
  await recoverWindowPlacement({
    place: async () => {
      events.push('move')
    },
    show: async () => {
      events.push('show')
    },
    verify: async () => {
      events.push('verify')
    },
    persist: async () => {
      events.push('persist')
    },
  }, { x: 100, y: 100, ...pet }, primary.work, true)
  assert.deepEqual(events, ['move', 'show', 'verify', 'persist'])
})

it('failed placement never reveals a panel or persists an invalid position', async () => {
  const events: string[] = []
  await assert.rejects(recoverWindowPlacement({
    place: async () => {
      throw new Error('move failed')
    },
    show: async () => {
      events.push('show')
    },
    verify: async () => {
      events.push('verify')
    },
    persist: async () => {
      events.push('persist')
    },
  }, { x: 100, y: 100, ...panel }, primary.work, true), /move failed/)
  assert.deepEqual(events, [])
})

it('pending show/retained-position work completes before manual positioning; errors do not poison the queue', async () => {
  const queue = createSerialQueue()
  const events: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const showing = queue(async () => {
    await blocked
    events.push('old-show')
  })
  const recovery = queue(async () => {
    events.push('recovery')
    throw new Error('OS refused move')
  })
  const later = queue(async () => {
    events.push('retry')
  })
  release()
  await showing
  await assert.rejects(recovery, /OS refused/)
  await later
  assert.deepEqual(events, ['old-show', 'recovery', 'retry'])
})
