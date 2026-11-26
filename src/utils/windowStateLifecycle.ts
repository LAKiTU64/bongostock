import type { SavedWindow } from './windowGeometry'

export type WindowState = Record<string, SavedWindow | undefined>

const prefix = 'window:'

export function windowPositionPatch(label: string, state: SavedWindow) {
  return { [prefix + label]: state }
}

/** The native store merges top-level keys. Each window writes only its own key. */
export function hydrateAppState(source: Record<string, unknown>) {
  const { name, version } = source
  const windowState: WindowState = { ...source.windowState as WindowState | undefined }
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
