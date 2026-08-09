import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { NewsDepth, NewsScope, NewsSort, NewsTimeRange } from '@/news/newsService'

const MAX_LOCAL_IDS = 500
function uniqueTail(values: readonly string[], limit: number) {
  return [...new Set(values.filter(Boolean))].slice(-limit)
}

export const useNewsStore = defineStore('news', () => {
  const scope = ref<NewsScope>('market')
  const marketPreset = ref('overview')
  const briefingPreset = ref('auto')
  const securityPreset = ref('latest')
  const timeRange = ref<NewsTimeRange>('1d')
  const sort = ref<NewsSort>('default')
  const depth = ref<NewsDepth>('standard')
  const readIds = ref<string[]>([])

  function init() {
    if (!['market', 'briefing', 'security'].includes(scope.value)) scope.value = 'market'
    timeRange.value = 'all'
    sort.value = 'newest'
    if (!['standard', 'extended'].includes(depth.value)) depth.value = 'standard'
    readIds.value = uniqueTail(readIds.value, MAX_LOCAL_IDS)
  }

  function markRead(id: string) {
    readIds.value = uniqueTail([...readIds.value, id], MAX_LOCAL_IDS)
  }

  return {
    scope,
    marketPreset,
    briefingPreset,
    securityPreset,
    timeRange,
    sort,
    depth,
    readIds,
    init,
    markRead,
  }
})
