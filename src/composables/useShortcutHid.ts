import type { Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { onScopeDispose, watch } from 'vue'

import type { ShortcutHidKey } from '@/utils/shortcutHid'

import { WINDOW_LABEL } from '@/constants'
import { isMac } from '@/utils/platform'
import { isShortcutHidKey } from '@/utils/shortcutHid'

export const SHORTCUT_HID_RECORDED = 'settings-hid-shortcut-recorded'
export const SHORTCUT_HID_STATUS = 'settings-hid-shortcut-feedback'
export type HidStatus = 'ready' | 'noDevice' | 'permissionDenied' | 'disabled' | 'unavailable'

let pending = Promise.resolve()

// The main webview owns the monitor. Configure only the requested usages
// outside recording, and serialize IPC so a stale update cannot re-enable it.
export function useShortcutHid(
  bindings: () => string[],
  recording: Ref<boolean>,
  pressed: (key: ShortcutHidKey) => void,
) {
  if (!isMac) return
  let disposed = false
  let revision = 0
  function reportStatus(status: HidStatus) {
    if (!disposed && recording.value) return emitTo(WINDOW_LABEL.PREFERENCE, SHORTCUT_HID_STATUS, status)
  }
  const listeners = Promise.all([
    listen<string>('settings-hid-shortcut-pressed', ({ payload }) => {
      if (!disposed && isShortcutHidKey(payload)) pressed(payload)
    }, { target: WINDOW_LABEL.MAIN }),
    listen<HidStatus>('settings-hid-shortcut-status', ({ payload }) => reportStatus(payload), { target: WINDOW_LABEL.MAIN }),
  ])

  watch([() => bindings().filter(isShortcutHidKey).join(','), recording], ([names, record]) => {
    const current = ++revision
    pending = pending.then(async () => {
      await listeners
      if (disposed || current !== revision) return
      const status = await invoke<HidStatus>('set_shortcut_hid_keys', {
        keys: names ? names.split(',') : [],
        recording: record,
      })
      if (current === revision) await reportStatus(status)
    }).catch((error) => {
      console.warn('[bongostock] Could not configure extended keyboard shortcuts', error)
      if (current === revision) void reportStatus('unavailable')
    })
  }, { immediate: true })

  onScopeDispose(() => {
    disposed = true
    pending = pending.then(() => invoke<void>('set_shortcut_hid_keys', { keys: [], recording: false })).catch(console.warn)
    void listeners.then(offs => offs.forEach(off => off()))
  })
}
