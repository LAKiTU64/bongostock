import { LogicalSize, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { saveNow } from '@tauri-store/pinia'
import { useDebounceFn } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { reportWindowRecoveryError } from '@/plugins/windowRecovery'
import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { useSkinStore } from '@/stores/skin'
import { compactPetLayout } from '@/utils/petLayout'
import { isMac } from '@/utils/platform'
import { restorePosition, validSize } from '@/utils/windowGeometry'
import { coordinateSpace, desktopGeometry, ensureWindowOnScreen, isPositioning, placeWindow, readWindowRect, saveWindowRect, windowPositionQueue } from '@/utils/windowPlacement'
import { createWindowStateRecorder } from '@/utils/windowStateLifecycle'

// Exit and restart menu actions are both owned by the main webview.
let flushMainWindow: (() => Promise<void>) | undefined

export async function flushWindowStateBeforeExit() {
  await flushMainWindow?.()
  await saveNow('app')
}

export function useWindowState() {
  const appWindow = getCurrentWebviewWindow()
  const { label } = appWindow
  const appStore = useAppStore()
  const catStore = useCatStore()
  const skinStore = useSkinStore()
  const isRestored = ref(false)
  const unlisteners: (() => void)[] = []
  let disposed = false

  const save = async () => {
    const state = await saveWindowRect(appWindow)
    if (!disposed && state) await appStore.saveWindowState(label, state)
  }

  const recorder = createWindowStateRecorder(() => windowPositionQueue(async () => {
    if (!disposed && !await appWindow.isMinimized()) await save()
  }))
  if (label === WINDOW_LABEL.MAIN) flushMainWindow = recorder.record

  // Keep the window inside the desktop after the drag settles. Persist valid
  // movement immediately, including when the user quits during this delay.
  const correctAfterDrag = useDebounceFn(() => {
    if (!recorder.ready || disposed || isPositioning()) return
    if (label !== WINDOW_LABEL.STOCK_PANEL && (label !== WINDOW_LABEL.MAIN || !catStore.window.keepInScreen)) return
    return windowPositionQueue(async () => {
      if (disposed || await appWindow.isMinimized()) return
      await ensureWindowOnScreen(appWindow)
      await save()
    }).catch(reportWindowRecoveryError)
  }, 180)

  const handleChange = (moved: boolean) => {
    if (!isRestored.value || disposed || isPositioning()) return
    void recorder.record(moved).catch(reportWindowRecoveryError)
    void correctAfterDrag()
  }

  onMounted(() => {
    for (const registration of [
      appWindow.onMoved(() => handleChange(true)),
      appWindow.onResized(() => handleChange(false)),
      appWindow.onScaleChanged(() => handleChange(false)),
    ]) {
      void registration.then((unlisten) => {
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      }).catch((error) => {
        if (!disposed) void reportWindowRecoveryError(error)
      })
    }
  })
  onUnmounted(() => {
    disposed = true
    recorder.dispose()
    if (flushMainWindow === recorder.record) flushMainWindow = undefined
    unlisteners.forEach(unlisten => unlisten())
  })
  watch(() => catStore.window.keepInScreen, correctAfterDrag)

  const restoreState = async () => {
    try {
      const saved = appStore.windowState[label]
      await windowPositionQueue(() => recorder.restore(async () => {
        if (label === WINDOW_LABEL.MAIN) {
          const builtin = skinStore.findBuiltin(skinStore.resolveId(catStore.skin))
          const layout = compactPetLayout(Boolean(builtin), catStore.window.scale, isMac ? 1 : globalThis.devicePixelRatio)
          await appWindow.setSize(new LogicalSize(layout.windowWidth, layout.windowHeight))
        } else if (label !== WINDOW_LABEL.STOCK_PANEL && saved && validSize(saved) && saved.width <= 8192 && saved.height <= 8192) {
          await appWindow.setSize(saved.version === 2 && saved.space === 'macos-logical'
            ? new LogicalSize(saved.width, saved.height)
            : new PhysicalSize(saved.width, saved.height))
        }
      }, async () => {
        const current = await readWindowRect(appWindow)
        const { screens, primaryId } = await desktopGeometry()
        const target = restorePosition(saved, coordinateSpace, current, screens, primaryId)
        if (disposed) return
        await placeWindow(appWindow, target, screens)
        if (!disposed) await save()
      }))
    } catch (error) {
      if (!disposed) await reportWindowRecoveryError(error)
    } finally {
      // Keep the menu reachable even if the OS refused a positioning request.
      if (!disposed) isRestored.value = true
    }
  }

  return { isRestored, restoreState }
}
