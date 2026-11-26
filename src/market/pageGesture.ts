export interface WheelSample {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/** AppKit NSEventPhase bit flags, not inferred from DOM wheel distances/units. */
export const SCROLL_PHASE = { began: 1, stationary: 2, changed: 4, ended: 8, cancelled: 16, mayBegin: 32 } as const

export interface NativeWheelSample extends WheelSample {
  epoch: string
  phase: number
  momentumPhase: number
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

/** Finger-driven AppKit distance in logical pixels (not Retina backing pixels). */
export const TRACKPAD_START_DISTANCE_PX = 20
export const TRACKPAD_PAGE_DISTANCE_PX = 50

/** Discrete wheels stay immediate; trackpads accumulate distance without a timer. */
export function createPageGesture(deps: Dependencies) {
  let disposed = false
  let epoch: string | undefined
  let tracking = false
  let lastDirection: -1 | 0 | 1 = 0
  let remaining = TRACKPAD_START_DISTANCE_PX
  return {
    activate(nextEpoch?: string) {
      epoch = nextEpoch
      tracking = false
    },
    nativeWheel(event: NativeWheelSample): boolean {
      if (disposed || !epoch || event.epoch !== epoch || (!event.phase && !event.momentumPhase)) return false
      // Momentum may arrive after the next Began. Never let it reset that gesture.
      if (event.momentumPhase) return true
      if (event.phase & (SCROLL_PHASE.ended | SCROLL_PHASE.cancelled)) {
        tracking = false
        return true
      }
      if (event.phase & SCROLL_PHASE.began) {
        tracking = true
        lastDirection = 0
      }
      // Changed without Began is the tail of a gesture from another scope.
      if (!tracking) return true
      if (event.ctrlKey || event.metaKey || event.altKey) {
        tracking = false
        return false
      }
      const direction = wheelDirection(event)
      if (!direction || event.deltaMode !== 0) return true
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      // Starting or reversing a swipe uses the shorter first-page distance.
      if (direction !== lastDirection) {
        lastDirection = direction
        remaining = TRACKPAD_START_DISTANCE_PX
      }
      remaining -= Math.abs(delta)
      while (remaining <= 0) {
        remaining += TRACKPAD_PAGE_DISTANCE_PX
        deps.turn(direction)
        // A turn can synchronously replace the source or dispose the component.
        if (disposed || event.epoch !== epoch || !tracking) break
      }
      return true
    },
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
