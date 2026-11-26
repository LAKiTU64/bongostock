import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, PhysicalPosition } from '@tauri-apps/api/dpi'
import { availableMonitors, cursorPosition, primaryMonitor } from '@tauri-apps/api/window'

import type { Point, Rect, SavedWindow, ScreenArea } from './windowGeometry'

import { isMac } from './platform'
import { contains, createSerialQueue, moveAndVerify, normalizeMonitor, selectScreen } from './windowGeometry'

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

export async function desktopGeometry() {
  const [monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()])
  const screens = monitors.map(monitor => normalizeMonitor(monitor, coordinateSpace))
  if (isMac) {
    // The pinned Tauri runtime omits macOS's vertical visibleFrame inset.
    // Match native logical bounds rather than trusting monitor array order.
    const native = await invoke<{ bounds: Rect, work: Rect }[]>('plugin:custom-window|display_work_areas')
    for (const screen of screens) {
      const match = native.find(({ bounds }) => Math.abs(bounds.x - screen.bounds.x) <= 1 && Math.abs(bounds.y - screen.bounds.y) <= 1
        && Math.abs(bounds.width - screen.bounds.width) <= 1 && Math.abs(bounds.height - screen.bounds.height) <= 1)
      if (!match) throw new Error('Display layout changed while reading work areas; retry recovery')
      screen.work = match.work
    }
  }
  return {
    screens,
    primaryId: primary ? normalizeMonitor(primary, coordinateSpace).id : undefined,
    primaryScale: primary?.scaleFactor ?? 1,
  }
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

export async function placeWindow(window: WebviewWindow, target: Rect, area: Rect): Promise<Rect> {
  return withPositioning(() => moveAndVerify(target, area, () => readWindowRect(window), point => moveWindow(window, point), () => new Promise(resolve => setTimeout(resolve, 80))))
}

export async function ensureWindowOnScreen(window: WebviewWindow): Promise<Rect> {
  const rect = await readWindowRect(window)
  const { screens, primaryId } = await desktopGeometry()
  const screen = selectScreen(screens, primaryId, rect)
  if (contains(screen.work, rect)) return rect
  return placeWindow(window, rect, screen.work)
}

export async function saveWindowRect(window: WebviewWindow): Promise<SavedWindow | undefined> {
  const rect = await readWindowRect(window)
  const { screens } = await desktopGeometry()
  if (!screens.some(screen => contains(screen.work, rect))) return undefined
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
