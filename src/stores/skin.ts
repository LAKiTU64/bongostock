import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { ImportedSkin } from '@/skins/skinService'

import { listImportedSkins } from '@/skins/skinService'

export const BUILTIN_SKIN_ID = 'builtin:mmmmmoko'
export const BUILTIN_KEYBOARD_SKIN_ID = 'builtin:mmmmmoko-keyboard'
export const LEGACY_GITHUB_SKIN_ID = 'github'
export const LEGACY_STEAM_SKIN_ID = 'steam'

export interface BuiltinSkin {
  id: string
  name: string
  author: string
  description: string
  modelPath: string
  previewPath: string
  mode: 'standard' | 'keyboard'
  keyResources: {
    left: string[]
    right: string[]
  }
}

export const BUILTIN_SKINS: BuiltinSkin[] = [
  {
    id: BUILTIN_SKIN_ID,
    name: '经典小键盘 · 标准模式',
    author: 'MMmmmoko',
    description: 'BongoCat 原生 Live2D 标准模型',
    modelPath: 'assets/models/standard',
    previewPath: 'assets/models/standard/resources/cover.png',
    mode: 'standard',
    keyResources: {
      left: ['KeyA', 'KeyD', 'KeyE', 'KeyQ', 'KeyR', 'KeyS', 'KeyW', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Space'],
      right: [],
    },
  },
  {
    id: BUILTIN_KEYBOARD_SKIN_ID,
    name: '经典小键盘 · 键盘模式',
    author: 'MMmmmoko',
    description: 'BongoCat 原生 Live2D 键盘模型',
    modelPath: 'assets/models/keyboard',
    previewPath: 'assets/models/keyboard/resources/cover.png',
    mode: 'keyboard',
    keyResources: {
      left: ['Control', 'KeyR', 'Shift'],
      right: ['DownArrow', 'LeftArrow', 'RightArrow', 'UpArrow'],
    },
  },
]

export function getBuiltinSkin(id: string) {
  return BUILTIN_SKINS.find(item => item.id === id)
}

export const useSkinStore = defineStore('skin', () => {
  const imported = ref<ImportedSkin[]>([])
  const ready = ref(false)
  const importedById = computed(() => new Map(imported.value.map(item => [item.id, item])))

  async function init() {
    try {
      imported.value = await listImportedSkins()
    } catch {
      imported.value = []
    } finally {
      ready.value = true
    }
  }

  async function refresh() {
    imported.value = await listImportedSkins()
  }

  function find(id: string) {
    return importedById.value.get(id)
  }

  function findBuiltin(id: string) {
    return getBuiltinSkin(id)
  }

  function resolveId(id: string) {
    if (getBuiltinSkin(id)) return id
    if (id === LEGACY_GITHUB_SKIN_ID) return BUILTIN_SKIN_ID
    if (id === LEGACY_STEAM_SKIN_ID) return find('strayrogue-local') ? 'strayrogue-local' : BUILTIN_SKIN_ID
    return find(id) ? id : BUILTIN_SKIN_ID
  }

  return {
    imported,
    ready,
    init,
    refresh,
    find,
    findBuiltin,
    resolveId,
  }
})
