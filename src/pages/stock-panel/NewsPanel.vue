<script setup lang="ts">
import { openUrl } from '@tauri-apps/plugin-opener'
import { computed, ref, watch } from 'vue'

import type { StockQuote } from '@/market/marketService'
import type {
  NewsItem,
  NewsScope,
  NewsSearchResult,
} from '@/news/newsService'

import { fetchNews } from '@/news/newsService'
import { useNewsStore } from '@/stores/news'
import { useWatchlistStore } from '@/stores/watchlist'

const props = defineProps<{
  activeGroupId: string
  quotes: StockQuote[]
  initialSecurityCode?: string
  refreshToken: number
}>()
const emit = defineEmits<{
  activity: []
  groupChange: [id: string]
  loading: [value: boolean]
}>()

const newsStore = useNewsStore()
const watchlistStore = useWatchlistStore()
const loading = ref(false)
const errorMessage = ref('')
const result = ref<NewsSearchResult>()
const query = ref('')
const lastQuery = ref('')
const showCustomQuery = ref(false)
const showSecurityContext = ref(newsStore.scope === 'security')
const securityCode = ref('')
const selectedItem = ref<NewsItem>()
const dirty = ref(true)
let requestId = 0
let listDrag: { pointerId: number, startY: number, scrollTop: number, moved: boolean } | undefined

const presetOptions = computed(() => {
  if (newsStore.scope === 'briefing') {
    return [
      ['auto', '自动'],
      ['morning', '早报'],
      ['noon', '午报'],
      ['evening', '晚报'],
      ['weekend', '周报'],
    ]
  }
  if (newsStore.scope === 'security') {
    return [
      ['latest', '动态'],
      ['announcement', '公告'],
      ['report', '研报'],
      ['earnings', '业绩'],
      ['risk', '风险'],
      ['industry', '行业'],
    ]
  }
  return [
    ['overview', '综合'],
    ['macro', '宏观'],
    ['market', '市场'],
    ['industry', '行业'],
    ['company', '公司'],
    ['announcement', '公告'],
    ['report', '研报'],
  ]
})
const activePreset = computed({
  get() {
    if (newsStore.scope === 'briefing') return newsStore.briefingPreset
    if (newsStore.scope === 'security') return newsStore.securityPreset
    return newsStore.marketPreset
  },
  set(value: string) {
    if (newsStore.scope === 'briefing') newsStore.briefingPreset = value
    else if (newsStore.scope === 'security') newsStore.securityPreset = value
    else newsStore.marketPreset = value
  },
})
const activeGroup = computed(() => watchlistStore.groups.find(group => group.id === props.activeGroupId)
  ?? watchlistStore.groups[0])
const quoteByCode = computed(() => new Map(props.quotes.map(item => [item.code.toUpperCase(), item])))
const securityOptions = computed(() => (activeGroup.value?.codes ?? []).map((code) => {
  const quote = quoteByCode.value.get(code.toUpperCase())
  return { code, name: quote?.name && quote.name !== '---' ? quote.name : code }
}))
const selectedSecurity = computed(() => securityOptions.value.find(item => item.code === securityCode.value))
const visibleItems = computed(() => [...(result.value?.items ?? []), ...(result.value?.outOfRangeItems ?? [])])
const outOfRangeIds = computed(() => new Set(result.value?.outOfRangeItems.map(item => item.id) ?? []))

watch(() => props.initialSecurityCode, (value) => {
  if (value && securityOptions.value.some(item => item.code === value)) securityCode.value = value
}, { immediate: true })
watch(securityOptions, (options) => {
  if (!options.some(item => item.code === securityCode.value)) securityCode.value = options[0]?.code ?? ''
}, { immediate: true })
watch(() => [
  newsStore.scope,
  activePreset.value,
  newsStore.timeRange,
  newsStore.depth,
  securityCode.value,
], () => {
  dirty.value = true
  selectedItem.value = undefined
})
watch(() => props.refreshToken, () => void search())

function setScope(scope: NewsScope) {
  newsStore.scope = scope
  showCustomQuery.value = false
  showSecurityContext.value = scope === 'security'
  selectedItem.value = undefined
  emit('activity')
}

function handleGroupChange(event: Event) {
  emit('groupChange', (event.target as HTMLSelectElement).value)
  emit('activity')
}

async function search() {
  selectedItem.value = undefined
  showCustomQuery.value = false
  showSecurityContext.value = false
  if (newsStore.scope === 'security' && !selectedSecurity.value) {
    result.value = undefined
    errorMessage.value = '当前分组没有可检索的股票'
    return
  }
  const currentRequest = ++requestId
  loading.value = true
  emit('loading', true)
  errorMessage.value = ''
  emit('activity')
  try {
    const customQuery = query.value.trim()
    const response = await fetchNews({
      scope: newsStore.scope,
      preset: activePreset.value,
      query: customQuery || undefined,
      security: newsStore.scope === 'security' ? selectedSecurity.value : undefined,
      timeRange: newsStore.timeRange,
      sort: 'newest',
      depth: newsStore.depth,
      types: ['news', 'announcement', 'report', 'external'],
    })
    if (currentRequest === requestId) {
      result.value = response
      lastQuery.value = customQuery
      query.value = ''
      dirty.value = false
    }
  } catch (error) {
    if (currentRequest === requestId) errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (currentRequest === requestId) {
      loading.value = false
      emit('loading', false)
    }
  }
}

function openCustomQuery() {
  showCustomQuery.value = !showCustomQuery.value
  if (showCustomQuery.value) showSecurityContext.value = false
  emit('activity')
}

function clearCustomQuery() {
  query.value = ''
  showCustomQuery.value = false
  dirty.value = true
  emit('activity')
}

function applyCustomQuery() {
  showCustomQuery.value = false
  dirty.value = true
  emit('activity')
}

function openItem(item: NewsItem) {
  newsStore.markRead(item.id)
  selectedItem.value = item
  emit('activity')
}

function closeItem() {
  selectedItem.value = undefined
  emit('activity')
}

function formatTime(value?: string) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace('/', '-').replace(',', '')
}

function handleListPointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button,a,input,select')) return
  const list = event.currentTarget as HTMLElement
  listDrag = { pointerId: event.pointerId, startY: event.clientY, scrollTop: list.scrollTop, moved: false }
  list.setPointerCapture(event.pointerId)
}

function handleListPointerMove(event: PointerEvent) {
  if (!listDrag || listDrag.pointerId !== event.pointerId) return
  const delta = event.clientY - listDrag.startY
  if (!listDrag.moved && Math.abs(delta) < 4) return
  listDrag.moved = true
  ;(event.currentTarget as HTMLElement).scrollTop = listDrag.scrollTop - delta
  event.preventDefault()
  emit('activity')
}

function handleListPointerEnd(event: PointerEvent) {
  if (!listDrag || listDrag.pointerId !== event.pointerId) return
  const list = event.currentTarget as HTMLElement
  listDrag = undefined
  if (list.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId)
}
</script>

<template>
  <section class="news-panel">
    <article
      v-if="selectedItem"
      class="news-detail"
      @pointercancel="handleListPointerEnd"
      @pointerdown="handleListPointerDown"
      @pointermove="handleListPointerMove"
      @pointerup="handleListPointerEnd"
      @wheel.passive="emit('activity')"
    >
      <header class="filter-row detail-toolbar">
        <button
          class="back-button"
          type="button"
          @click.stop="closeItem"
          @pointerdown.stop
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
          >
            <path d="m14.5 5-7 7 7 7" />
          </svg>
          返回
        </button>
        <span>{{ formatTime(selectedItem.publishedAt) }} · {{ selectedItem.source }}</span>
      </header>
      <h2>{{ selectedItem.title }}</h2>
      <p class="detail-content">
        {{ selectedItem.summary || '暂无正文' }}
      </p>
      <footer
        v-if="selectedItem.url"
        class="detail-actions"
      >
        <button
          type="button"
          @click.stop="openUrl(selectedItem.url)"
          @pointerdown.stop
        >
          打开原文
        </button>
      </footer>
    </article>

    <template v-else>
      <div class="filter-row">
        <nav
          aria-label="资讯范围"
          class="scope-tabs"
        >
          <button
            v-for="item in ([['market', '全市场'], ['briefing', '简报'], ['security', '个股']] as const)"
            :key="item[0]"
            :class="{ active: newsStore.scope === item[0] }"
            type="button"
            @click.stop="setScope(item[0])"
          >
            {{ item[1] }}
          </button>
        </nav>
        <select
          v-model="activePreset"
          class="preset-select"
          title="检索主题"
          @click.stop
        >
          <option
            v-for="item in presetOptions"
            :key="item[0]"
            :value="item[0]"
          >
            {{ item[1] }}
          </option>
        </select>
        <select
          v-model="newsStore.timeRange"
          class="time-range-select"
          title="时间范围"
          @click.stop
        >
          <option value="1d">
            1天
          </option>
          <option value="3d">
            3天
          </option>
          <option value="7d">
            7天
          </option>
          <option value="all">
            不限
          </option>
        </select>
        <select
          v-model="newsStore.depth"
          class="depth-select"
          title="召回深度"
          @click.stop
        >
          <option value="standard">
            10条
          </option><option value="extended">
            20条
          </option>
        </select>
        <button
          :aria-label="loading ? '正在搜索' : '搜索'"
          class="search-button"
          :class="{ 'has-query': query }"
          :disabled="loading"
          :title="query ? `搜索（自定义：${query}；右键修改）` : '搜索；右键输入完整搜索词'"
          type="button"
          @click.stop="search"
          @contextmenu.prevent.stop="openCustomQuery"
          @pointerdown.stop
        >
          <span v-if="loading">…</span>
          <svg
            v-else
            aria-hidden="true"
            viewBox="0 0 24 24"
          >
            <circle
              cx="10.5"
              cy="10.5"
              r="5.5"
            />
            <path d="m15 15 4.5 4.5" />
          </svg>
        </button>
      </div>

      <form
        v-if="showCustomQuery"
        class="context-popover custom-query-popover"
        @submit.prevent="applyCustomQuery"
      >
        <input
          v-model="query"
          autofocus
          placeholder="输入完整搜索词"
          @input="dirty = true"
          @pointerdown.stop
        >
        <button
          v-if="query"
          title="清除完整搜索词"
          type="button"
          @click.stop="clearCustomQuery"
        >
          ×
        </button>
        <button
          class="apply-button"
          type="submit"
        >
          使用
        </button>
      </form>

      <div
        v-else-if="newsStore.scope === 'security' && showSecurityContext"
        class="context-popover security-context"
      >
        <select
          class="group-select"
          title="股票分组"
          :value="activeGroup?.id"
          @change="handleGroupChange"
          @click.stop
        >
          <option
            v-for="group in watchlistStore.groups"
            :key="group.id"
            :value="group.id"
          >
            {{ group.name }}
          </option>
        </select>
        <select
          v-model="securityCode"
          class="security-select"
          title="自选股票"
          @click.stop
        >
          <option
            v-for="item in securityOptions"
            :key="item.code"
            :value="item.code"
          >
            {{ item.name }}
          </option>
        </select>
      </div>

      <div
        v-if="result"
        class="news-stats"
      >
        <span v-if="dirty">条件已变化，请点击搜索</span>
        <span
          v-else
          class="result-summary"
          :title="lastQuery ? `搜索词：${lastQuery}` : undefined"
        >显示 {{ visibleItems.length }} 条 · {{ result?.meta.cached ? '缓存' : '实时' }}<template v-if="lastQuery"> · 搜索词：{{ lastQuery }}</template></span>
        <span v-if="outOfRangeIds.size">{{ outOfRangeIds.size }} 条超出时间范围</span>
      </div>

      <div
        v-if="errorMessage"
        class="news-status error"
      >
        {{ errorMessage }}<button
          type="button"
          @click.stop="search"
        >
          重试
        </button>
      </div>
      <div
        v-else-if="loading && !result"
        class="news-status"
      >
        正在从服务端检索资讯…
      </div>
      <div
        v-else-if="!result"
        class="news-status"
      >
        选择条件后点击搜索
      </div>
      <div
        v-else-if="!visibleItems.length"
        class="news-status"
      >
        当前条件没有结果
      </div>
      <div
        v-else
        class="news-list"
        @pointercancel="handleListPointerEnd"
        @pointerdown="handleListPointerDown"
        @pointermove="handleListPointerMove"
        @pointerup="handleListPointerEnd"
        @wheel.passive="emit('activity')"
      >
        <article
          v-for="item in visibleItems"
          :key="item.id"
          class="news-item"
          :class="{ read: newsStore.readIds.includes(item.id), expired: outOfRangeIds.has(item.id) }"
        >
          <button
            class="news-title"
            type="button"
            @click.stop="openItem(item)"
          >
            <strong>{{ item.title }}</strong><span>{{ formatTime(item.publishedAt) }} · {{ item.source }}<em v-if="outOfRangeIds.has(item.id)"> · 超出范围</em></span>
          </button>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.news-panel {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  padding-top: 0;
  overflow: hidden;
  font-size: 9px;
}
.filter-row {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 26px;
  min-height: 26px;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: var(--tab-gap);
  border-bottom: 1px solid rgb(68 61 62 / 9%);
}
.scope-tabs {
  display: flex;
  flex: none;
  gap: var(--tab-gap);
}
.security-context {
  display: flex;
  gap: var(--tab-gap);
}
.security-context .group-select {
  flex: 0 0 82px;
}
.security-context .security-select {
  flex: 1;
}
.scope-tabs button,
.detail-toolbar .back-button,
.filter-row button,
.custom-query-popover button,
.news-status button,
.detail-actions button {
  padding: 3px 5px;
  border: 0;
  border-radius: 7px;
  background: rgb(68 61 62 / 8%);
  color: #655b5c;
  cursor: pointer;
  font: inherit;
}
.scope-tabs button.active {
  background: #443d3e;
  color: #fffaf3;
  font-weight: 650;
}
.scope-tabs button {
  box-sizing: border-box;
  height: 19px;
  flex: none;
  padding: 4px 7px;
  background: transparent;
  color: #817576;
  font-size: 10px;
  line-height: 1.1;
}
.detail-toolbar .back-button {
  display: flex;
  box-sizing: border-box;
  height: 19px;
  flex: none;
  align-items: center;
  gap: 1px;
  padding: 4px 7px;
  background: #443d3e;
  color: #fffaf3;
  font-size: 10px;
  font-weight: 650;
  line-height: 1.1;
}
.filter-row select,
.security-context select {
  box-sizing: border-box;
  min-width: 0;
  height: 19px;
  padding: 0 2px;
  border: 1px solid rgb(68 61 62 / 12%);
  border-radius: 7px;
  outline: none;
  background: rgb(255 255 255 / 65%);
  color: #655b5c;
  font: inherit;
  font-size: 8.5px;
}
.filter-row .preset-select {
  width: 0;
  min-width: 44px;
  flex: 1;
}
.filter-row .time-range-select {
  width: 44px;
  flex: none;
}
.filter-row .depth-select {
  width: 48px;
  flex: none;
}
.security-context select {
  padding: 0 2px;
  font-size: 8px;
}
.filter-row .search-button {
  position: relative;
  display: grid;
  box-sizing: border-box;
  width: 24px;
  height: 19px;
  flex: none;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: #443d3e;
  color: #fffaf3;
  font: inherit;
  font-size: 9px;
}
.filter-row .search-button svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-width: 2;
}
.filter-row .search-button.has-query::after {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #f4b7ae;
  content: '';
}
.filter-row .search-button:disabled {
  opacity: 0.4;
}
.custom-query-popover {
  display: flex;
  gap: var(--tab-gap);
}
.context-popover {
  position: absolute;
  z-index: 4;
  top: 29px;
  right: 0;
  left: 0;
  box-sizing: border-box;
  min-width: 0;
  padding: 4px;
  border: 1px solid rgb(68 61 62 / 12%);
  border-radius: 8px;
  background: rgb(255 250 243 / 98%);
  box-shadow: 0 3px 10px rgb(68 61 62 / 14%);
}
.custom-query-popover input {
  min-width: 0;
  height: 19px;
  flex: 1;
  box-sizing: border-box;
  padding: 2px 5px;
  border: 1px solid rgb(68 61 62 / 12%);
  border-radius: 7px;
  outline: none;
  background: rgb(255 255 255 / 65%);
  color: #443d3e;
  font: inherit;
}
.custom-query-popover button {
  min-width: 25px;
  height: 19px;
  flex: none;
  padding: 0 5px;
}
.custom-query-popover .apply-button {
  background: #443d3e;
  color: #fffaf3;
}
.news-stats {
  display: flex;
  min-height: 16px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  color: #938788;
  font-size: 8px;
}
.result-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.news-list {
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
  touch-action: pan-y;
}
.news-list::-webkit-scrollbar {
  display: none;
}
.news-item {
  padding: 3px 4px;
  border-bottom: 1px solid rgb(68 61 62 / 8%);
  background: rgb(255 255 255 / 30%);
}
.news-item.expired {
  border-left: 2px solid rgb(201 119 75 / 55%);
  background: rgb(255 244 232 / 42%);
}
.news-item:first-child {
  border-radius: 6px 6px 0 0;
}
.news-item.read {
  opacity: 0.62;
}
.news-title {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 1px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.news-title strong {
  overflow: hidden;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.news-title span {
  color: #938788;
  font-size: 7.5px;
  line-height: 1.2;
}
.news-title em {
  color: #c9774b;
  font-style: normal;
  font-weight: 600;
}
.news-detail {
  display: flex;
  min-height: 0;
  flex: 1;
  box-sizing: border-box;
  flex-direction: column;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: rgb(255 255 255 / 24%);
  scrollbar-width: none;
  touch-action: pan-y;
}
.news-detail::-webkit-scrollbar {
  display: none;
}
.detail-toolbar {
  justify-content: space-between;
  color: #938788;
  font-size: 7.5px;
}
.detail-toolbar span {
  min-width: 0;
  overflow: hidden;
  padding-right: 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back-button svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.news-detail h2 {
  margin: 6px 5px 3px;
  color: #443d3e;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.4;
}
.detail-content {
  margin: 2px 5px 6px;
  color: #655b5c;
  font-size: 9.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.detail-actions {
  display: flex;
  flex: none;
  justify-content: flex-end;
  padding: 3px 4px 5px;
}
.detail-actions button {
  background: #443d3e;
  color: #fffaf3;
  font-size: 8.5px;
}
.news-status {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #817576;
  text-align: center;
}
.news-status.error {
  color: #c94e47;
}
</style>
