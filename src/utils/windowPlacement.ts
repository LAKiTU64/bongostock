import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, PhysicalPosition } from '@tauri-apps/api/dpi'
import { availableMonitors, cursorPosition, primaryMonitor } from '@tauri-apps/api/window'

import type { Point, Rect, SavedWindow, ScreenArea } from './windowGeometry'

import { isMac } from './platform'
import { createSerialQueue, fitToDesktop, moveAndVerify, normalizeMonitor, selectScreen, visibleOnDesktop } from './windowGeometry'

export const coordinateSpace = isMac ? 'macos-logical' : 'physical'
export const windowPositionQueue = createSerialQueue()
let positioning = 0
export const isPositioning = () => positioning > 0

export async function withPositioning<T>(task: () => Promise<T>): Promise<T> {
  positioning++
  try {
    return await task()
  } finally {
    positioning--
  }
}

function sameBounds(a: Rect, b: Rect) {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
    && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
}

export async function desktopGeometry() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [monitors, primary, native] = await Promise.all([
      availableMonitors(),
      primaryMonitor(),
      isMac ? invoke<{ bounds: Rect, work: Rect }[]>('plugin:custom-window|display_work_areas') : undefined,
    ])
    const screens = monitors.map(monitor => normalizeMonitor(monitor, coordinateSpace))
    const primaryId = primary ? normalizeMonitor(primary, coordinateSpace).id : undefined
    if (!screens.length || (primaryId && !screens.some(screen => screen.id === primaryId))) continue
    if (native) {
      // Tauri omits the vertical visibleFrame inset. Screen changes can fall
      // between the two APIs' snapshots; retry instead of applying mismatched areas.
      const matches = screens.map(screen => native.find(area => sameBounds(area.bounds, screen.bounds)))
      if (matches.some(match => !match) || native.some(area => !screens.some(screen => sameBounds(area.bounds, screen.bounds)))) continue
      screens.forEach((screen, index) => {
        screen.work = matches[index]!.work
      })
    }
    return { screens, primaryId, primaryScale: primary?.scaleFactor ?? 1 }
  }
  throw new Error('Could not read a consistent display layout')
}

export async function readWindowRect(window: WebviewWindow): Promise<Rect> {
  // Read scale on both sides: crossing between displays can change it while
  // the position/size IPC calls are in flight.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await window.scaleFactor()
    const [point, size] = await Promise.all([window.outerPosition(), window.outerSize()])
    const after = await window.scaleFactor()
    if (before !== after) continue
    const divisor = isMac ? after : 1
    return { x: point.x / divisor, y: point.y / divisor, width: size.width / divisor, height: size.height / divisor }
  }
  throw new Error('Display scale changed while reading window geometry')
}

export async function moveWindow(window: WebviewWindow, point: Point) {
  await window.setPosition(isMac ? new LogicalPosition(point.x, point.y) : new PhysicalPosition(Math.round(point.x), Math.round(point.y)))
}

export async function placeWindow(window: WebviewWindow, target: Rect, area: Rect | ScreenArea[]): Promise<Rect> {
  return withPositioning(() => moveAndVerify(target, area, () => readWindowRect(window), point => moveWindow(window, point), () => new Promise(resolve => setTimeout(resolve, 80))))
}

export async function ensureWindowOnScreen(window: WebviewWindow): Promise<Rect> {
  const rect = await readWindowRect(window)
  const { screens, primaryId } = await desktopGeometry()
  if (visibleOnDesktop(rect, screens)) return rect
  return placeWindow(window, fitToDesktop(rect, screens, primaryId), screens)
}

export async function saveWindowRect(window: WebviewWindow): Promise<SavedWindow | undefined> {
  const rect = await readWindowRect(window)
  const { screens } = await desktopGeometry()
  if (!visibleOnDesktop(rect, screens)) return undefined
  return { ...rect, version: 2, space: coordinateSpace, scale: await window.scaleFactor() }
}

export async function recoveryScreen(): Promise<ScreenArea> {
  const desktop = await desktopGeometry()
  // tao macOS cursor_position returns Quartz's global point multiplied by
  // the PRIMARY screen scale, not the screen under the cursor's scale.
  let point: Point | undefined
  try {
    const cursor = await cursorPosition()
    const divisor = isMac ? desktop.primaryScale : 1
    point = { x: cursor.x / divisor, y: cursor.y / divisor }
  } catch {
    // Cursor lookup may fail while a display is disconnected. Primary is the
    // explicit fallback; lack of any screen remains a visible error.
  }
  return selectScreen(desktop.screens, desktop.primaryId, undefined, point)
}
