import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { VideoProgress } from '@/market/videoHistory'

import { DEVICE_HISTORY_SCOPE } from '@/market/biliHistory'
import { latestVideos, sanitizeVideoHistory } from '@/market/videoHistory'

const storageError = ref('')

export const useVideoHistoryStore = defineStore('videoHistory', () => {
  // Keep the same persisted key so pre-account device records survive the upgrade.
  const entries = ref<VideoProgress[]>([])
  const videos = computed(() => latestVideos(forScope(DEVICE_HISTORY_SCOPE)))

  function init() {
    entries.value = sanitizeVideoHistory(entries.value)
  }

  function forScope(scope: string) {
    return entries.value.filter(row => (row.scope ?? DEVICE_HISTORY_SCOPE) === scope)
  }

  function record(progress: VideoProgress, scope = DEVICE_HISTORY_SCOPE) {
    entries.value = sanitizeVideoHistory([
      { ...progress, scope },
      ...entries.value.filter(row => (row.scope ?? DEVICE_HISTORY_SCOPE) !== scope || row.bvid !== progress.bvid || row.cid !== progress.cid),
    ])
  }

  function findPart(bvid: string, cid: number, scope = DEVICE_HISTORY_SCOPE) {
    return forScope(scope).find(row => row.bvid === bvid && row.cid === cid)
  }

  function latest(bvid: string, scope = DEVICE_HISTORY_SCOPE) {
    return latestVideos(forScope(scope)).find(row => row.bvid === bvid)
  }

  function remove(bvid: string, scope = DEVICE_HISTORY_SCOPE) {
    entries.value = entries.value.filter(row => (row.scope ?? DEVICE_HISTORY_SCOPE) !== scope || row.bvid !== bvid)
  }

  function clear(scope = DEVICE_HISTORY_SCOPE) {
    entries.value = entries.value.filter(row => (row.scope ?? DEVICE_HISTORY_SCOPE) !== scope)
  }

  return { entries, videos, storageError, init, forScope, record, findPart, latest, remove, clear }
}, {
  tauri: {
    filterKeys: ['storageError'],
    saveStrategy: 'immediate',
    syncStrategy: 'immediate',
    hooks: {
      error: () => {
        storageError.value = '观看记录读写失败，最近进度可能无法保留。'
      },
    },
  },
})
