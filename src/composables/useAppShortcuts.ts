import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onScopeDispose, toRef } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { hideWindow, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useShortcutStore } from '@/stores/shortcut'

import { useKeyPress } from './useKeyPress'
import { closeStockPanel } from './useStockPanel'

export const appShortcutKeys = ['visibleCat', 'visiblePreference', 'penetrable', 'alwaysOnTop', 'bossKey'] as const
export type AppShortcutKey = typeof appShortcutKeys[number]

export const SHORTCUT_RECORDING = 'settings-shortcut-recording'
export const SHORTCUT_CAPTURED = 'settings-shortcut-captured'
export const SHORTCUT_FAILED = 'settings-shortcut-failed'

export function useAppShortcuts() {
  const shortcuts = useShortcutStore()
  const cat = useCatStore()
  let recording = false
  const listening = listen<boolean>(SHORTCUT_RECORDING, ({ payload }) => {
    recording = payload
  })
  onScopeDispose(() => {
    void listening.then(off => off())
  })

  async function toggleSettings() {
    const window = await WebviewWindow.getByLabel(WINDOW_LABEL.PREFERENCE)
    if (window && await window.isVisible()) await hideWindow(WINDOW_LABEL.PREFERENCE)
    else await showWindow(WINDOW_LABEL.PREFERENCE)
  }
  const actions = {
    visibleCat: () => {
      cat.window.visible = !cat.window.visible
    },
    visiblePreference: toggleSettings,
    bossKey: () => closeStockPanel('discard'),
    penetrable: () => {
      cat.window.passThrough = !cat.window.passThrough
    },
    alwaysOnTop: () => {
      cat.window.alwaysOnTop = !cat.window.alwaysOnTop
    },
  }
  for (const key of appShortcutKeys) {
    useKeyPress(toRef(shortcuts, key), async () => {
      // A registered combination can be consumed by the OS before the recorder sees a keydown.
      if (recording) {
        const window = await WebviewWindow.getByLabel(WINDOW_LABEL.PREFERENCE)
        if (window && await window.isFocused()) {
          await emitTo(WINDOW_LABEL.PREFERENCE, SHORTCUT_CAPTURED, shortcuts[key])
          return
        }
        recording = false
      }
      await actions[key]()
    }, (_value, previous) => {
      // Keep an existing setting on cold-start failures. Roll back unsuccessful edits.
      if (previous !== undefined) shortcuts[key] = previous
      void emitTo(WINDOW_LABEL.PREFERENCE, SHORTCUT_FAILED, key)
    })
  }
}
