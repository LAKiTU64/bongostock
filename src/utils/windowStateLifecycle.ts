import type { SavedWindow, Size } from './windowGeometry'

import { validNumber, validPoint, validSize } from './windowGeometry'

interface HydratedWindow extends SavedWindow {
  // Only set when reading an old nested record written by conflicting coordinate formats.
  legacyPhysicalScale?: number
}

export type WindowState = Record<string, HydratedWindow | undefined>

export function hasMixedWindowUnits(state: HydratedWindow | undefined): state is HydratedWindow & { legacyPhysicalScale: number } {
  return state?.version === undefined && state?.legacyPhysicalScale !== undefined
}

export function stateForWindowPosition(state: HydratedWindow | undefined, current: Size) {
  if (!hasMixedWindowUnits(state)) return state
  const scale = state.legacyPhysicalScale
  // Old native move and resize events updated separate fields. A current size
  // match substantiates the scale before restorePosition tests the source screen.
  if (!validSize(state) || Math.abs(state.width - current.width * scale) > 1
    || Math.abs(state.height - current.height * scale) > 1) {
    return undefined
  }
  return state
}

const prefix = 'window:'

export function windowPositionPatch(label: string, state: SavedWindow) {
  return { [prefix + label]: state }
}

/** The native store merges top-level keys. Each window writes only its own key. */
export function hydrateAppState(source: Record<string, unknown>) {
  const { name, version } = source
  const windowState: WindowState = { ...source.windowState as WindowState | undefined }
  for (const [label, state] of Object.entries(windowState)) {
    if (state?.version !== 2 || state.space !== 'macos-logical' || !('type' in state) || state.type !== 'Physical') continue
    // Pinia deep merges could leave the old native event type alongside the
    // v2 marker. Neither marker alone establishes the units of every field.
    windowState[label] = validPoint(state) && validSize(state) && validNumber(state.scale) && state.scale > 0
      ? { x: state.x, y: state.y, width: state.width, height: state.height, legacyPhysicalScale: state.scale }
      : undefined
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(prefix) && value && typeof value === 'object') windowState[key.slice(prefix.length)] = value as SavedWindow
  }
  return { ...(typeof name === 'string' && { name }), ...(typeof version === 'string' && { version }), windowState }
}

export function appMetadata({ name, version }: Record<string, unknown>) {
  return { name, version }
}

/** Ignore startup notifications. Sample immediately and coalesce events arriving during a native read. */
export function createWindowStateRecorder(capture: () => Promise<void>) {
  let phase: 'starting' | 'ready' | 'waiting-for-move' | 'disposed' = 'starting'
  let dirty = false
  let pending: Promise<void> | undefined
  let sizePending: (() => Promise<void>) | undefined
  const disposed = () => phase === 'disposed'

  async function sizeIfNeeded() {
    if (sizePending) {
      await sizePending()
      sizePending = undefined
    }
  }

  function record(moved = false) {
    if (phase === 'waiting-for-move' && moved) phase = 'ready'
    if (phase !== 'ready') return Promise.resolve()
    dirty = true
    pending ??= Promise.resolve().then(async () => {
      try {
        while (dirty && !disposed()) {
          dirty = false
          // Never record the default large window after failed startup sizing.
          await sizeIfNeeded()
          if (!disposed()) await capture()
        }
      } finally {
        pending = undefined
      }
    })
    return pending
  }

  return {
    get ready() {
      return phase === 'ready' && !sizePending
    },
    async restore(size: () => Promise<void>, place: () => Promise<void>) {
      sizePending = size
      // The native window or its display can still be settling at first use.
      for (let attempt = 0; !disposed(); attempt++) {
        try {
          await sizeIfNeeded()
          if (disposed()) return
          await place()
          if (!disposed()) phase = 'ready'
          return
        } catch (error) {
          if (disposed()) return
          if (attempt === 1) {
            phase = 'waiting-for-move'
            throw error
          }
          await new Promise(resolve => setTimeout(resolve, 80))
        }
      }
    },
    record,
    dispose() {
      phase = 'disposed'
      sizePending = undefined
      dirty = false
    },
  }
}
