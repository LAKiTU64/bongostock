import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'
import type { Ref } from 'vue'

import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { onScopeDispose, watch } from 'vue'

// Finish native changes in order, including cleanup of a previous component instance.
let pending = Promise.resolve()

export function useKeyPress(
  shortcut: Ref<string | undefined>,
  callback: ShortcutHandler,
  onFailure?: (value: string, fallback: string | undefined) => void,
) {
  const owned = new Set<string>()
  let disposed = false

  function schedule(value: string, previous?: string) {
    pending = pending.then(async () => {
      const wanted = disposed ? '' : shortcut.value || ''
      if (wanted !== value) return

      // Keep the last working binding until its replacement is registered.
      if (wanted && !owned.has(wanted)) {
        if (await isRegistered(wanted)) throw new Error('Shortcut is already registered')
        await register(wanted, (event) => {
          if (!disposed && shortcut.value === wanted && event.state === 'Pressed') callback(event)
        })
        owned.add(wanted)
      }
      for (const old of owned) {
        if (old === wanted) continue
        await unregister(old)
        owned.delete(old)
      }
    }).catch((error) => {
      if (disposed || shortcut.value !== value) return
      if (onFailure) onFailure(value, previous === undefined ? undefined : [...owned][0] ?? '')
      else console.warn('[bongostock] Unable to register shortcut', error)
    })
  }

  watch(shortcut, (value, previous) => schedule(value || '', previous), { immediate: true })
  onScopeDispose(() => {
    disposed = true
    schedule('')
  })
}
