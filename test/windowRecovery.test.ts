import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import { it } from 'node:test'

import type { Rect, SavedWindow } from '../src/utils/windowGeometry'

import { clampRect, contains, createSerialQueue, moveAndVerify, normalizeMonitor, placePair, placePanel, restorePosition, selectScreen } from '../src/utils/windowGeometry'
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

it('legacy macOS state resets once rather than guessing the source scale', () => {
  const restored = restorePosition({ x: -1332, y: 41, width: 110, height: 75 }, 'macos-logical', pet, screens, primary.id)
  assert.ok(contains(primary.work, restored))
  const saved: SavedWindow = { ...restored, version: 2, space: 'macos-logical', scale: 2 }
  for (let i = 0; i < 20; i++) assert.deepEqual(restorePosition(saved, 'macos-logical', pet, screens, primary.id), restored)
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
