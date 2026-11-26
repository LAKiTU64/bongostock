import { LogicalSize, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useDebounceFn } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { SavedWindow } from '@/utils/windowGeometry'

import { WINDOW_LABEL } from '@/constants'
import { reportWindowRecoveryError } from '@/plugins/windowRecovery'
import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { restorePosition, selectScreen, validSize } from '@/utils/windowGeometry'
import { coordinateSpace, desktopGeometry, ensureWindowOnScreen, isPositioning, placeWindow, readWindowRect, saveWindowRect, windowPositionQueue } from '@/utils/windowPlacement'

export type WindowState = Record<string, SavedWindow | undefined>

export function useWindowState() {
  const appWindow = getCurrentWebviewWindow()
  const { label } = appWindow
  const appStore = useAppStore()
  const catStore = useCatStore()
  const isRestored = ref(false)
  const unlisteners: (() => void)[] = []
  let disposed = false

  const save = async () => {
    const state = await saveWindowRect(appWindow)
    if (state) appStore.windowState[label] = state
  }

  const onChange = useDebounceFn(() => {
    if (!isRestored.value || disposed || isPositioning()) return
    return windowPositionQueue(async () => {
      if (await appWindow.isMinimized()) return
      // Out-of-work-area moves are not persisted, but must still be corrected.
      if (label === WINDOW_LABEL.STOCK_PANEL || (label === WINDOW_LABEL.MAIN && catStore.window.keepInScreen)) {
        await ensureWindowOnScreen(appWindow)
      }
      await save()
    }).catch(reportWindowRecoveryError)
  }, 180)

  const handleChange = () => {
    // Ignore native notifications from our own bounded correction, including
    // failed moves, rather than scheduling another correction feedback loop.
    if (!isPositioning()) void onChange()
  }

  onMounted(async () => {
    const listeners = await Promise.all([
      appWindow.onMoved(handleChange),
      appWindow.onResized(handleChange),
      appWindow.onScaleChanged(handleChange),
    ])
    if (disposed) listeners.forEach(unlisten => unlisten())
    else unlisteners.push(...listeners)
  })
  onUnmounted(() => {
    disposed = true
    unlisteners.forEach(unlisten => unlisten())
  })
  watch(() => catStore.window.keepInScreen, onChange)

  const restoreState = async () => {
    try {
      await windowPositionQueue(async () => {
        const saved = appStore.windowState[label]
        // Pet/stock sizes belong to their pages, not an old display's pixels.
        if (label !== WINDOW_LABEL.MAIN && label !== WINDOW_LABEL.STOCK_PANEL && saved && validSize(saved) && saved.width <= 8192 && saved.height <= 8192) {
          await appWindow.setSize(saved.version === 2 && saved.space === 'macos-logical'
            ? new LogicalSize(saved.width, saved.height)
            : new PhysicalSize(saved.width, saved.height))
        }
        const current = await readWindowRect(appWindow)
        const { screens, primaryId } = await desktopGeometry()
        const target = restorePosition(saved, coordinateSpace, current, screens, primaryId)
        const screen = selectScreen(screens, primaryId, target)
        // Initial recovery is unconditional, independent of keepInScreen.
        await placeWindow(appWindow, target, screen.work)
        await save()
      })
    } catch (error) {
      await reportWindowRecoveryError(error)
    } finally {
      // Keep the menu reachable even if the OS refused a positioning request.
      isRestored.value = true
    }
  }

  return { isRestored, restoreState }
}
