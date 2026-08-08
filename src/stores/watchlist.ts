import { emit } from '@tauri-apps/api/event'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import { LISTEN_KEY } from '@/constants'
import { DEFAULT_WATCHLIST } from '@/market/defaults'

export interface WatchlistGroup {
  id: string
  name: string
  codes: string[]
}

export interface StockPanelSettings {
  fadeDelaySeconds: number
  dimmedOpacity: number
}

const CODE_PATTERN = /^(?:SH|SZ)\d{6}$/
const DEFAULT_GROUP_NAME = '自选股'
export const MAX_WATCHLIST_SIZE = 50
export const MAX_WATCHLIST_GROUPS = 8
export const MIN_FADE_DELAY_SECONDS = 1
export const MAX_FADE_DELAY_SECONDS = 300
export const MIN_DIMMED_OPACITY = 10
export const MAX_DIMMED_OPACITY = 100

function normalizeCode(value: string) {
  const code = value.trim().toUpperCase()

  if (!/^\d{6}$/.test(code)) return code
  if (/^[56]/.test(code)) return `SH${code}`
  if (/^[0-3]/.test(code)) return `SZ${code}`

  return code
}

function normalizeGroupName(value: string) {
  return value.trim().slice(0, 20)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sanitizePanelSettings(values: Partial<StockPanelSettings>) {
  return {
    fadeDelaySeconds: clamp(
      Number.isFinite(values.fadeDelaySeconds) ? Number(values.fadeDelaySeconds) : 2,
      MIN_FADE_DELAY_SECONDS,
      MAX_FADE_DELAY_SECONDS,
    ),
    dimmedOpacity: clamp(
      Number.isFinite(values.dimmedOpacity) ? Number(values.dimmedOpacity) : 28,
      MIN_DIMMED_OPACITY,
      MAX_DIMMED_OPACITY,
    ),
  }
}

function cloneGroups(values: readonly WatchlistGroup[]) {
  return values.map(group => ({ ...group, codes: [...group.codes] }))
}

function sanitizeGroups(values: readonly WatchlistGroup[]) {
  const seenCodes = new Set<string>()
  const seenIds = new Set<string>()
  const result: WatchlistGroup[] = []

  for (const value of values.slice(0, MAX_WATCHLIST_GROUPS)) {
    const id = value.id && !seenIds.has(value.id) ? value.id : nanoid(8)
    const name = normalizeGroupName(value.name) || DEFAULT_GROUP_NAME
    const codes: string[] = []

    seenIds.add(id)

    for (const rawCode of value.codes ?? []) {
      const code = normalizeCode(rawCode)

      if (!isValidCode(code) || seenCodes.has(code) || seenCodes.size >= MAX_WATCHLIST_SIZE) continue

      seenCodes.add(code)
      codes.push(code)
    }

    result.push({ id, name, codes })
  }

  return result
}

export function isValidCode(value: string) {
  return CODE_PATTERN.test(normalizeCode(value))
}

export const useWatchlistStore = defineStore('watchlist', () => {
  // Keep this field for migration from the original ungrouped persisted state.
  const codes = ref<string[]>([...DEFAULT_WATCHLIST])
  const groups = ref<WatchlistGroup[]>([])
  const panel = reactive<StockPanelSettings>({
    fadeDelaySeconds: 2,
    dimmedOpacity: 28,
  })
  const totalCodes = computed(() => codes.value.length)

  function syncCodes() {
    codes.value = groups.value.flatMap(group => group.codes)
  }

  function setGroups(values: readonly WatchlistGroup[], notify = true) {
    groups.value = sanitizeGroups(values)
    syncCodes()

    if (notify) void emit(LISTEN_KEY.WATCHLIST_CHANGED, cloneGroups(groups.value))
  }

  function init() {
    Object.assign(panel, sanitizePanelSettings(panel))
    const hydratedGroups = sanitizeGroups(groups.value)

    if (hydratedGroups.length > 0) {
      setGroups(hydratedGroups, false)
      return
    }

    const legacyCodes = [...new Set(codes.value.map(normalizeCode).filter(isValidCode))]
      .slice(0, MAX_WATCHLIST_SIZE)

    const initialCodes = legacyCodes.length > 0 ? legacyCodes : [...DEFAULT_WATCHLIST]

    setGroups([{ id: 'default', name: DEFAULT_GROUP_NAME, codes: initialCodes }], false)
  }

  function addGroup(value: string) {
    const name = normalizeGroupName(value)

    if (!name) return '请输入分组名称'
    if (groups.value.length >= MAX_WATCHLIST_GROUPS) return `最多创建 ${MAX_WATCHLIST_GROUPS} 个分组`
    if (groups.value.some(group => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return '已经有同名分组'
    }

    setGroups([...groups.value, { id: nanoid(8), name, codes: [] }])
    return ''
  }

  function renameGroup(id: string, value: string) {
    const name = normalizeGroupName(value)

    if (!name) return '分组名称不能为空'
    if (groups.value.some(group => group.id !== id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return '已经有同名分组'
    }

    setGroups(groups.value.map(group => group.id === id ? { ...group, name } : group))
    return ''
  }

  function removeGroup(id: string) {
    if (groups.value.length <= 1) return '至少保留一个分组'

    setGroups(groups.value.filter(group => group.id !== id))
    return ''
  }

  function addCode(value: string, groupId: string) {
    const code = normalizeCode(value)

    if (!isValidCode(code)) return '请输入 6 位代码，或 SH600036 / SZ000858'
    if (!groups.value.some(group => group.id === groupId)) return '请选择一个分组'
    if (codes.value.includes(code)) return '这个代码已经在其他分组中'
    if (codes.value.length >= MAX_WATCHLIST_SIZE) return `自选列表最多保存 ${MAX_WATCHLIST_SIZE} 只股票或基金`

    setGroups(groups.value.map(group => group.id === groupId
      ? { ...group, codes: [...group.codes, code] }
      : group))
    return ''
  }

  function removeCode(groupId: string, code: string) {
    const normalizedCode = normalizeCode(code)

    setGroups(groups.value.map(group => group.id === groupId
      ? { ...group, codes: group.codes.filter(item => item !== normalizedCode) }
      : group))
  }

  function replaceFromEvent(values: readonly WatchlistGroup[] | readonly string[]) {
    if (values.length > 0 && typeof values[0] === 'string') {
      setGroups([{
        id: 'default',
        name: DEFAULT_GROUP_NAME,
        codes: values as readonly string[] as string[],
      }], false)
      return
    }

    setGroups(values as readonly WatchlistGroup[], false)
  }

  function updatePanelSettings(values: Partial<StockPanelSettings>) {
    Object.assign(panel, sanitizePanelSettings({ ...panel, ...values }))
  }

  return {
    codes,
    groups,
    panel,
    totalCodes,
    init,
    addGroup,
    renameGroup,
    removeGroup,
    addCode,
    removeCode,
    replaceFromEvent,
    updatePanelSettings,
  }
})
