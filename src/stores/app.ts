import { getName, getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import type { SavedWindow } from '@/utils/windowGeometry'
import type { WindowState } from '@/utils/windowStateLifecycle'

import { appMetadata, hydrateAppState, windowPositionPatch } from '@/utils/windowStateLifecycle'

export const useAppStore = defineStore('app', () => {
  const name = ref('')
  const version = ref('')
  const windowState = reactive<WindowState>({})

  async function saveWindowState(label: string, state: SavedWindow) {
    await invoke('plugin:pinia|patch', { id: 'app', state: windowPositionPatch(label, state) })
    windowState[label] = state
  }

  const init = async () => {
    name.value = await getName()
    version.value = await getVersion()
  }

  return {
    name,
    version,
    windowState,
    saveWindowState,
    init,
  }
}, {
  tauri: {
    hooks: {
      beforeBackendSync: appMetadata,
      beforeFrontendSync: hydrateAppState,
    },
  },
})
