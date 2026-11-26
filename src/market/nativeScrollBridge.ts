import type { NativeWheelSample } from './pageGesture'

export interface ScrollRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScrollRegion {
  region: ScrollRect
  exclusions: ScrollRect[]
}

export interface NativeScrollScope extends ScrollRegion {
  epoch: string
}

export interface NativeScrollPacket extends NativeWheelSample {
  // Normalized webview coordinates, independent of Retina backing scale.
  x: number
  y: number
}

interface Dependencies {
  // The platform adapter serializes these across component mounts as well.
  configure: (scope: NativeScrollScope | null) => Promise<void>
  listen: (receive: (packet: NativeScrollPacket) => void) => Promise<() => void>
  activate: (epoch?: string) => void
  receive: (packet: NativeScrollPacket) => void
  failed: (error: unknown) => void
}

/** Share one FIFO across mounts so old cleanup cannot overtake new activation. */
export function createNativeScrollConfigurator(configure: Dependencies['configure']): Dependencies['configure'] {
  let queue = Promise.resolve()
  return (scope) => {
    const result = queue.then(() => configure(scope))
    queue = result.catch(() => {})
    return result
  }
}

/** Own the subscription and revoke queued native deliveries synchronously. */
export function createNativeScrollBridge(deps: Dependencies) {
  let disposed = false
  let subscribed = false
  let unlisten: (() => void) | undefined
  let desired: ScrollRegion | null = null
  let current: NativeScrollScope | null = null
  let ready = false
  let revision = 0

  async function publish(): Promise<boolean> {
    const request = ++revision
    ready = false
    current = subscribed && desired ? { ...desired, epoch: crypto.randomUUID() } : null
    deps.activate(current?.epoch)
    if (!subscribed) return !desired
    const scope = current
    try {
      await deps.configure(scope)
      if (disposed || request !== revision) return false
      ready = Boolean(scope)
      return true
    } catch (error) {
      if (!disposed && request === revision) {
        current = null
        ready = false
        deps.activate()
        deps.failed(error)
        // A failed activation may have partially installed a monitor. Queue its
        // removal now, before a subsequent update can publish a replacement.
        if (scope) void deps.configure(null).catch(deps.failed)
      }
      return false
    }
  }

  return {
    get ready() {
      return ready
    },
    async start() {
      try {
        const stop = await deps.listen((packet) => {
          if (!disposed && current && packet.epoch === current.epoch) deps.receive(packet)
        })
        if (disposed) {
          stop()
          return
        }
        unlisten = stop
        subscribed = true
        await publish()
      } catch (error) {
        if (!disposed) deps.failed(error)
      }
    },
    update(region: ScrollRegion | null): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      desired = region
      return publish()
    },
    dispose() {
      if (disposed) return
      disposed = true
      desired = null
      current = null
      ready = false
      deps.activate()
      unlisten?.()
      // If listen is still pending, no native scope has been published yet.
      if (subscribed) void deps.configure(null).catch(deps.failed)
    },
  }
}
