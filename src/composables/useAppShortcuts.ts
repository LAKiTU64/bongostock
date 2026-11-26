import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onScopeDispose, ref, toRef } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { closeForBossKey, hideWindow, toggleAuxiliaryWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useShortcutStore } from '@/stores/shortcut'
import { isMac } from '@/utils/platform'
import { isPcFunctionAlias, isShortcutHidKey, shortcutAlias } from '@/utils/shortcutHid'

import { useKeyPress } from './useKeyPress'
import { useShortcutHid } from './useShortcutHid'

export const appShortcutKeys = ['visibleCat', 'visiblePreference', 'penetrable', 'alwaysOnTop', 'bossKey'] as const
export type AppShortcutKey = typeof appShortcutKeys[number]

export const SHORTCUT_RECORDING = 'settings-shortcut-recording'
export const SHORTCUT_CAPTURED = 'settings-shortcut-captured'
export const SHORTCUT_FAILED = 'settings-shortcut-failed'

export function useAppShortcuts() {
  const shortcuts = useShortcutStore()
  const cat = useCatStore()
  const recording = ref(false)
  let lastCapture: { alias: string, time: number } | undefined
  const listening = listen<boolean | { captured: string }>(SHORTCUT_RECORDING, ({ payload }) => {
    recording.value = payload === true
    if (typeof payload === 'object') lastCapture = { alias: shortcutAlias(payload.captured), time: performance.now() }
  })
  onScopeDispose(() => {
    void listening.then(off => off())
  })

  const actions = {
    visibleCat: () => {
      cat.window.visible = !cat.window.visible
    },
    visiblePreference: () => toggleAuxiliaryWindow(WINDOW_LABEL.PREFERENCE, () => hideWindow(WINDOW_LABEL.PREFERENCE)),
    bossKey: () => {
      const closing = closeForBossKey()
      cat.window.visible = false
      return closing
    },
    penetrable: () => {
      cat.window.passThrough = !cat.window.passThrough
    },
    alwaysOnTop: () => {
      cat.window.alwaysOnTop = !cat.window.alwaysOnTop
    },
  }
  async function runShortcut(key: AppShortcutKey) {
    const value = shortcuts[key]
    if (recording.value) {
      const window = await WebviewWindow.getByLabel(WINDOW_LABEL.PREFERENCE)
      if (window && await window.isFocused()) {
        await emitTo(WINDOW_LABEL.PREFERENCE, SHORTCUT_CAPTURED, value)
        return
      }
      recording.value = false
    }
    const alias = shortcutAlias(value)
    if (isMac && isPcFunctionAlias(alias) && lastCapture?.alias === alias
      && performance.now() - lastCapture.time < 200) {
      return
    }
    await actions[key]()
  }
  useShortcutHid(() => appShortcutKeys.map(key => shortcuts[key]), recording, (value) => {
    const key = appShortcutKeys.find(key => shortcuts[key] === value)
    if (key) void runShortcut(key)
  })
  for (const key of appShortcutKeys) {
    useKeyPress(toRef(shortcuts, key), () => runShortcut(key), (_value, previous) => {
      // Keep an existing setting on cold-start failures. Roll back unsuccessful edits.
      if (previous !== undefined) shortcuts[key] = previous
      void emitTo(WINDOW_LABEL.PREFERENCE, SHORTCUT_FAILED, key)
    }, value => isMac && isShortcutHidKey(value))
  }
}
