import type { Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { nextTick, onMounted, onUnmounted, watch } from 'vue'

import type { NativeScrollPacket, ScrollRect, ScrollRegion } from '@/market/nativeScrollBridge'
import type { NativeWheelSample } from '@/market/pageGesture'

import { createNativeScrollBridge, createNativeScrollConfigurator } from '@/market/nativeScrollBridge'
import { isMac } from '@/utils/platform'

const configure = createNativeScrollConfigurator(scope => invoke<void>('plugin:custom-window|set_page_gesture', { region: scope }))
const excludedTargets = '[role="menu"], [role="dialog"], input, textarea, select, video'

interface Options {
  viewport: Ref<HTMLElement | undefined>
  enabled: () => boolean
  context: () => unknown
  activate: (epoch?: string) => void
  wheel: (sample: NativeWheelSample) => void
}

/** Opt in only the visible video list; popups retain their native scrolling. */
export function useNativePageScroll(options: Options) {
  let mounted = false
  let failed = false
  let suspended = false
  let signature = ''
  let resize: ResizeObserver | undefined
  let mutations: MutationObserver | undefined

  function rect(element: Element): ScrollRect {
    const box = element.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, box.left / innerWidth))
    const y = Math.max(0, Math.min(1, box.top / innerHeight))
    return { x, y, width: Math.max(0, Math.min(1, box.right / innerWidth) - x), height: Math.max(0, Math.min(1, box.bottom / innerHeight) - y) }
  }

  function receive(packet: NativeScrollPacket) {
    const viewport = options.viewport.value
    if (!mounted || suspended || document.hidden || !options.enabled() || !viewport) return
    // Check current DOM, not geometry from before a menu/player was opened.
    const target = document.elementFromPoint(packet.x * innerWidth, packet.y * innerHeight)
    if (!target || !viewport.contains(target) || target.closest(excludedTargets)) {
      invalidate()
      return
    }
    options.wheel(packet)
  }

  const bridge = createNativeScrollBridge({
    configure,
    listen: receive => getCurrentWebviewWindow().listen<NativeScrollPacket>('stock-panel-page-gesture', event => receive(event.payload)),
    activate: options.activate,
    receive,
    failed(error) {
      failed = true
      signature = ''
      console.warn('Native video gesture paging unavailable; using DOM wheel paging.', error)
    },
  })

  function syncRegion() {
    if (!isMac || !mounted) return
    const viewport = options.viewport.value
    let region: ScrollRegion | null = null
    if (!failed && !suspended && !document.hidden && options.enabled() && viewport && innerWidth > 0 && innerHeight > 0) {
      const bounds = rect(viewport)
      if (bounds.width > 0 && bounds.height > 0) {
        const exclusions = Array.from(document.querySelectorAll(excludedTargets))
          .map(rect)
          .filter(box => box.width > 0 && box.height > 0
            && box.x < bounds.x + bounds.width && box.x + box.width > bounds.x
            && box.y < bounds.y + bounds.height && box.y + box.height > bounds.y)
        if (exclusions.length <= 64) region = { region: bounds, exclusions }
      }
    }
    const next = JSON.stringify(region)
    if (signature === next) return
    signature = next
    void bridge.update(region)
  }

  function invalidate() {
    if (!isMac || !mounted) return
    signature = ''
    void bridge.update(null)
    void nextTick(syncRegion)
  }

  // Revocation is synchronous in JS; callers opening a native-scrollable menu
  // also await the AppKit removal acknowledgement before rendering that menu.
  async function suspend() {
    suspended = true
    signature = 'null'
    if (!isMac || !mounted) return true
    return bridge.update(null)
  }

  function resume() {
    suspended = false
    signature = ''
    void nextTick(syncRegion)
  }

  watch(options.context, invalidate, { flush: 'sync' })
  watch(options.enabled, invalidate, { flush: 'sync' })
  watch(options.viewport, (viewport, previous) => {
    if (previous) resize?.unobserve(previous)
    if (viewport) resize?.observe(viewport)
    invalidate()
  }, { flush: 'post' })
  useEventListener(document, 'visibilitychange', invalidate)
  // A visible panel can receive scroll events while another window has focus.
  useEventListener(window, 'blur', invalidate)
  useEventListener(window, 'focus', invalidate)
  useEventListener(window, 'resize', syncRegion)
  useEventListener(document, 'scroll', syncRegion, { capture: true })

  onMounted(() => {
    if (!isMac) return
    mounted = true
    resize = new ResizeObserver(syncRegion)
    if (options.viewport.value) resize.observe(options.viewport.value)
    mutations = new MutationObserver(syncRegion)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'style', 'class', 'hidden'] })
    syncRegion()
    void bridge.start()
  })
  onUnmounted(() => {
    mounted = false
    resize?.disconnect()
    mutations?.disconnect()
    if (isMac) bridge.dispose()
  })

  return {
    invalidate,
    suspend,
    resume,
    // During handshakes reject DOM tails from the previous scope. The native
    // monitor leaves ordinary mouse wheel events untouched once armed.
    acceptsDomWheel: () => !suspended && (!isMac || failed || bridge.ready),
  }
}
