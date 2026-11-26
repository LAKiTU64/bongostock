// macOS uses global logical desktop coordinates. Windows/Linux retain native
// physical desktop coordinates; dividing their monitor origins by DPI is wrong.
export type CoordinateSpace = 'macos-logical' | 'physical'
export interface Point { x: number, y: number }
export interface Size { width: number, height: number }
export interface Rect extends Point, Size {}
export interface ScreenArea { id: string, bounds: Rect, work: Rect, scale: number }
export interface MonitorGeometry {
  name: string | null
  position: Point
  size: Size
  scaleFactor: number
  workArea?: { position: Point, size: Size }
}
export interface SavedWindow extends Partial<Rect> {
  version?: 2
  space?: CoordinateSpace
  scale?: number
}

export const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 10_000_000
export const validSize = <T extends Partial<Size>>(value: T): value is T & Size => validNumber(value.width) && validNumber(value.height) && value.width > 0 && value.height > 0
export const validPoint = <T extends Partial<Point>>(value: T): value is T & Point => validNumber(value.x) && validNumber(value.y)

export function normalizeMonitor(monitor: MonitorGeometry, space: CoordinateSpace): ScreenArea {
  const scale = monitor.scaleFactor > 0 && Number.isFinite(monitor.scaleFactor) ? monitor.scaleFactor : 1
  const divisor = space === 'macos-logical' ? scale : 1
  const rect = (area: { position: Point, size: Size }): Rect => ({
    x: area.position.x / divisor,
    y: area.position.y / divisor,
    width: area.size.width / divisor,
    height: area.size.height / divisor,
  })
  const bounds = rect(monitor)
  const work = monitor.workArea ? rect(monitor.workArea) : bounds
  return { id: `${monitor.name}:${bounds.x}:${bounds.y}`, bounds, work, scale }
}

export function contains(area: Rect, rect: Rect, tolerance = 1): boolean {
  return validPoint(rect) && validSize(rect)
    && rect.x >= area.x - tolerance && rect.y >= area.y - tolerance
    && rect.x + rect.width <= area.x + area.width + tolerance
    && rect.y + rect.height <= area.y + area.height + tolerance
}

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

/** Test the union of work areas, including holes between staggered displays. */
export function visibleOnDesktop(rect: Rect, screens: ScreenArea[]): boolean {
  if (!validPoint(rect) || !validSize(rect)) return false
  if (screens.some(screen => contains(screen.work, rect))) return true
  const areas = screens.map(screen => screen.work).filter(area => overlap(area, rect) > 0).sort((a, b) => a.y - b.y)
  if (!areas.length) return false
  // Between consecutive vertical edges, the set of covering displays is constant.
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const cuts = new Set([rect.x, right])
  for (const area of areas) {
    cuts.add(Math.max(rect.x, area.x))
    cuts.add(Math.min(right, area.x + area.width))
  }
  const edges = [...cuts].sort((a, b) => a - b)
  for (let i = 1; i < edges.length; i++) {
    let coveredTo = rect.y
    for (const area of areas) {
      if (area.x > edges[i - 1]! || area.x + area.width < edges[i]!) continue
      if (area.y > coveredTo) break
      coveredTo = Math.max(coveredTo, area.y + area.height)
      if (coveredTo >= bottom) break
    }
    if (coveredTo < bottom) return false
  }
  return true
}

export function selectScreen(screens: ScreenArea[], primaryId?: string, rect?: Rect, point?: Point): ScreenArea {
  if (!screens.length) throw new Error('No available display work area')
  const underPointer = point && screens.find(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height)
  if (underPointer) return underPointer
  if (rect && validPoint(rect) && validSize(rect)) {
    const best = screens.reduce((a, b) => overlap(a.bounds, rect) >= overlap(b.bounds, rect) ? a : b)
    if (overlap(best.bounds, rect) > 0) return best
  }
  // The monitor array is not ordered by primary status.
  return screens.find(screen => screen.id === primaryId)
    ?? screens.find(({ bounds }) => bounds.x === 0 && bounds.y === 0)
    ?? screens[0]!
}

export function clampRect(rect: Rect, area: Rect): Rect {
  if (!validSize(rect) || !validPoint(area) || !validSize(area)) throw new Error('Invalid window geometry')
  return {
    ...rect,
    x: Math.max(area.x, Math.min(validNumber(rect.x) ? rect.x : area.x, area.x + Math.max(0, area.width - rect.width))),
    y: Math.max(area.y, Math.min(validNumber(rect.y) ? rect.y : area.y, area.y + Math.max(0, area.height - rect.height))),
  }
}

/** Keep a valid position; otherwise move only as far as the usable desktop requires. */
export function fitToDesktop(rect: Rect, screens: ScreenArea[], primaryId?: string): Rect {
  if (visibleOnDesktop(rect, screens)) return rect
  const screen = selectScreen(screens, primaryId, rect)
  let best = clampRect(rect, screen.work)
  if (screens.length === 1 || !validPoint(rect)) return best
  let distance = visibleOnDesktop(best, screens) ? Math.hypot(best.x - rect.x, best.y - rect.y) : Infinity
  // A closest valid rectangle keeps each axis or touches a work-area edge.
  // Include both sides of every edge to handle L-shaped and staggered layouts.
  const xs = new Set([rect.x])
  const ys = new Set([rect.y])
  for (const { work } of screens) {
    for (const edge of [work.x, work.x + work.width]) {
      xs.add(edge)
      xs.add(edge - rect.width)
    }
    for (const edge of [work.y, work.y + work.height]) {
      ys.add(edge)
      ys.add(edge - rect.height)
    }
  }
  for (const x of xs) {
    for (const y of ys) {
      const d = Math.hypot(x - rect.x, y - rect.y)
      if (d >= distance) continue
      const candidate = { ...rect, x, y }
      if (visibleOnDesktop(candidate, screens)) {
        best = candidate
        distance = d
      }
    }
  }
  return best
}

export function placePanel(pet: Rect, size: Size, area: Rect, gap = 12): Rect {
  let y = pet.y + pet.height + gap
  if (y + size.height > area.y + area.height) y = pet.y - size.height - gap
  return clampRect({ x: pet.x + (pet.width - size.width) / 2, y, width: size.width, height: size.height }, area)
}

export function placePair(petSize: Size, panelSize: Size, area: Rect, gap = 12): { pet: Rect, panel: Rect } {
  // Center the pair as a unit when it fits vertically, otherwise try side by side.
  const vertical = petSize.height + panelSize.height + gap <= area.height
  const pet = clampRect({
    ...petSize,
    x: area.x + (area.width - (vertical ? petSize.width : petSize.width + panelSize.width + gap)) / 2,
    y: area.y + (area.height - (vertical ? petSize.height + panelSize.height + gap : petSize.height)) / 2,
  }, area)
  const panel = vertical
    ? placePanel(pet, panelSize, area, gap)
    : clampRect({
        ...panelSize,
        x: pet.x + pet.width + gap,
        y: pet.y + (pet.height - panelSize.height) / 2,
      }, area)
  return { pet, panel }
}

export function restorePosition(saved: SavedWindow | undefined, space: CoordinateSpace, size: Size, screens: ScreenArea[], primaryId?: string): Rect {
  if (saved && validPoint(saved)) {
    if ((saved.version === 2 && saved.space === space) || (saved.version === undefined && space === 'physical')) {
      return fitToDesktop({ ...size, x: saved.x, y: saved.y }, screens, primaryId)
    }
    // Legacy macOS move/resize events recorded physical pixels separately.
    // Both dimensions and the candidate display must agree on the old scale.
    if (saved.version === undefined && space === 'macos-logical' && validSize(saved)) {
      const candidates = []
      for (const scale of new Set(screens.map(screen => screen.scale))) {
        if (Math.abs(saved.width - size.width * scale) > 1 || Math.abs(saved.height - size.height * scale) > 1) continue
        const rect = { ...size, x: saved.x / scale, y: saved.y / scale }
        if (visibleOnDesktop(rect, screens) && screens.some(screen => screen.scale === scale && overlap(screen.bounds, rect) > 0)) candidates.push(rect)
      }
      if (candidates.length === 1) return candidates[0]!
    }
  }
  const screen = selectScreen(screens, primaryId)
  return clampRect({
    ...size,
    x: screen.work.x + (screen.work.width - size.width) / 2,
    y: screen.work.y + (screen.work.height - size.height) / 2,
  }, screen.work)
}

/** A rejected task does not poison later positioning operations. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task)
    tail = result.catch(() => {})
    return result
  }
}

export async function moveAndVerify(
  target: Rect,
  area: Rect | ScreenArea[],
  read: () => Promise<Rect>,
  move: (point: Point) => Promise<void>,
  settle: () => Promise<void>,
): Promise<Rect> {
  const fit = (rect: Rect) => Array.isArray(area) ? fitToDesktop(rect, area) : clampRect(rect, area)
  let desired = fit(target)
  for (let attempt = 0; attempt < 3; attempt++) {
    await move(desired)
    await settle()
    const actual = await read()
    const visible = Array.isArray(area) ? visibleOnDesktop(actual, area) : contains(area, actual)
    if (visible && Math.abs(actual.x - desired.x) <= 1 && Math.abs(actual.y - desired.y) <= 1) return actual
    // DPI/skin sizing may finish after the move; use the actual final size.
    desired = fit({ ...actual, x: target.x, y: target.y })
  }
  throw new Error('Window position could not be verified inside the display work area')
}
