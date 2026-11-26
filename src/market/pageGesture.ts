export interface WheelSample {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

interface Dependencies {
  turn: (direction: -1 | 1) => void
}

export function wheelDirection(event: WheelSample): -1 | 0 | 1 {
  if (event.ctrlKey || event.metaKey || event.altKey) return 0
  if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return 0
  if (![0, 1, 2].includes(event.deltaMode)) return 0
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  return delta > 0 ? 1 : delta < 0 ? -1 : 0
}

/** Scroll acceleration changes distance, never the number of pages per input. */
export function createPageGesture(deps: Dependencies) {
  let disposed = false
  return {
    wheel(event: WheelSample): boolean {
      if (disposed) return false
      const direction = wheelDirection(event)
      if (!direction) return false
      deps.turn(direction)
      return true
    },
    dispose() {
      disposed = true
    },
  }
}
