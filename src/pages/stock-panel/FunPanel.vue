<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import type { BiliHistoryItem, PlaybackContext } from '@/market/biliHistory'
import type { BiliHistoryState } from '@/market/biliHistorySession'
import type { FeedItem, FeedSource } from '@/market/feedService'
import type { ProgressReporter } from '@/market/progressReporter'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { cloudHistoryItems, samePlaybackContext } from '@/market/biliHistory'
import { createBiliHistorySession } from '@/market/biliHistorySession'
import { fetchBiliHistory, fetchBiliStatus, reportBiliProgress } from '@/market/biliService'
import { playCountLabel } from '@/market/feedPresentation'
import { FEED_SOURCES, fetchFeeds } from '@/market/feedService'
import { captureGatewayConnection } from '@/market/gatewayRequest'
import { createProgressReporter } from '@/market/progressReporter'
import { formatVideoTime } from '@/market/videoHistory'
import { showWindow } from '@/plugins/window'
import { useMarketStore } from '@/stores/market'

import VideoPlayer from './VideoPlayer.vue'

const marketStore = useMarketStore()
const sources = [...FEED_SOURCES, { key: 'history', label: '历史' }] as const
const source = ref<FeedSource | 'history'>('rcmd')
const items = ref<FeedItem[]>([])
const feedLoading = ref(false)
const feedLoadingMore = ref(false)
const feedError = ref('')
const feedNotice = ref('')
const feedHasMore = ref(false)
const pageNumber = ref(0)
const nextCursor = ref<string>()
const playing = ref<FeedItem | null>(null)
const playingContext = shallowRef<PlaybackContext>()
const playingHistory = shallowRef<readonly BiliHistoryItem[]>([])
const playingReporter = shallowRef<ProgressReporter>()
const syncMessage = ref('')
let accountReporter: ProgressReporter | undefined
const accountSignal = shallowRef(new AbortController())
const playerRef = ref<{ stop: () => void }>()
const listEl = ref<HTMLElement>()
const accountState = shallowRef<BiliHistoryState>({ checking: true, loading: false, loaded: false, rows: [], hasMore: false, notice: '', error: '' })
let requestId = 0
let playRequest = 0
let refreshRequest = 0
let disposed = false
let statusTimer: ReturnType<typeof setInterval> | undefined

const account = createBiliHistorySession({
  connection: captureGatewayConnection,
  status: fetchBiliStatus,
  history: fetchBiliHistory,
  changed: state => accountState.value = state,
  invalidatePlayback() {
    requestId += 1
    items.value = []
    feedLoading.value = false
    feedLoadingMore.value = false
    feedHasMore.value = false
    accountSignal.value.abort()
    accountReporter = undefined
    syncMessage.value = ''
    stop()
    accountSignal.value = new AbortController()
  },
})
const displayItems = computed(() => (source.value === 'history'
  ? cloudHistoryItems(accountState.value.rows)
  : items.value).map(item => ({ ...item, playCount: playCountLabel(item) })))
const loading = computed(() => source.value === 'history' ? accountState.value.checking || (accountState.value.loading && !accountState.value.loaded) : feedLoading.value)
const loadingMore = computed(() => source.value === 'history' ? accountState.value.loading : feedLoadingMore.value)
const errorMessage = computed(() => source.value === 'history' ? accountState.value.error : feedError.value)
const needsLogin = computed(() => source.value === 'history' && !accountState.value.checking && accountState.value.status?.logged === false)
const notice = computed(() => source.value === 'history'
  ? accountState.value.notice
  : accountState.value.loading && !accountState.value.loaded ? '正在读取账号历史…' : feedNotice.value)
const hasMore = computed(() => source.value === 'history' ? accountState.value.hasMore : feedHasMore.value)

const baseUrl = computed(() => marketStore.external.baseUrl.replace(/\/+$/, ''))
const token = computed(() => marketStore.bearerToken.trim())

function coverOf(item: FeedItem) {
  if (!item.cover?.startsWith('/v1/media/cover?')) return ''
  return `${baseUrl.value}${item.cover}&token=${encodeURIComponent(token.value)}`
}

async function load(append = false, force = false) {
  if (source.value === 'history') {
    requestId += 1
    if (!append) stop()
    feedLoading.value = false
    feedLoadingMore.value = false
    if (accountState.value.context?.identity
      && (append || force || !accountState.value.loaded) && !accountState.value.loading) {
      await account.loadHistory(append)
    }
    return
  }
  if (append && (feedLoading.value || feedLoadingMore.value || !feedHasMore.value)) return
  const current = ++requestId
  const page = append ? pageNumber.value + 1 : 1
  const cursor = append ? nextCursor.value : undefined
  feedLoading.value = !append
  feedLoadingMore.value = append
  feedError.value = ''
  if (!append) {
    stop()
    items.value = []
    feedNotice.value = ''
    feedHasMore.value = false
    nextCursor.value = undefined
    listEl.value?.scrollTo({ top: 0 })
  }
  try {
    const result = await fetchFeeds(source.value, page, { cursor, refresh: force })
    if (disposed || current !== requestId) return
    const existing = new Set(append ? items.value.map(item => item.id) : [])
    const added = result.items.filter((item) => {
      if (existing.has(item.id)) return false
      existing.add(item.id)
      return true
    })
    items.value = append ? [...items.value, ...added] : added
    pageNumber.value = page
    nextCursor.value = result.nextCursor
    feedHasMore.value = result.hasMore && page < 50
      && (!append || added.length > 0 || Boolean(result.nextCursor && result.nextCursor !== cursor))
    feedNotice.value = result.notice ?? ''
  } catch (error) {
    if (!disposed && current === requestId) feedError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (!disposed && current === requestId) {
      feedLoading.value = false
      feedLoadingMore.value = false
    }
  }
}

function progressReporter(context: PlaybackContext) {
  if (context.identity && accountReporter) return accountReporter
  const reporter = createProgressReporter({
    context,
    signal: accountSignal.value.signal,
    send: report => reportBiliProgress(report, context.connection),
    identityInvalid: () => {
      if (!disposed) void refreshIdentity(true)
    },
    failed: () => {
      if (!disposed) syncMessage.value = '账号进度暂未同步，请检查网络后继续播放。'
    },
    succeeded: () => {
      if (!disposed) syncMessage.value = ''
    },
  })
  // One queue for the whole account epoch, including rapid switches between videos.
  if (context.identity) accountReporter = reporter
  return reporter
}

async function play(item: FeedItem) {
  const initial = accountState.value.context
  if (!item.bvid || !initial || accountState.value.checking || accountState.value.loading) return
  const request = ++playRequest
  // Fetch at most the first page on a feed click; never fall back to device history.
  if (initial.identity && !accountState.value.loaded && !accountState.value.loading) await account.loadHistory()
  if (disposed || request !== playRequest || !samePlaybackContext(initial, accountState.value.context)) return
  playingContext.value = initial
  playingHistory.value = [...accountState.value.rows]
  playingReporter.value = progressReporter(playingContext.value)
  playing.value = item
}

function stop() {
  playRequest += 1
  playerRef.value?.stop()
  if (!playingContext.value?.identity) playingReporter.value?.close()
  playing.value = null
}

function returnToList() {
  stop()
  if (accountState.value.context?.identity) void account.loadHistory()
}

async function refreshIdentity(invalidate = false) {
  const request = ++refreshRequest
  requestId += 1
  stop()
  await account.refreshStatus(invalidate)
  if (!disposed && request === refreshRequest && (source.value === 'history' || !feedLoading.value)) await load(false, true)
}

function refresh() {
  void refreshIdentity()
}

function loadMore() {
  void load(true)
}

function retryHistory() {
  if (source.value === 'history' && accountState.value.context?.identity) void account.loadHistory(accountState.value.loaded && accountState.value.hasMore)
  else if (items.value.length && source.value !== 'history') loadMore()
  else refresh()
}

function onScroll() {
  const list = listEl.value
  if (list && !errorMessage.value && list.scrollHeight - list.scrollTop - list.clientHeight < 40) loadMore()
}

function openSettings() {
  void showWindow(WINDOW_LABEL.PREFERENCE)
}

useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) stop()
  else void account.refreshStatus()
})
watch(source, () => {
  void load(false, source.value === 'history')
})
watch(() => [accountState.value.context, accountState.value.checking], () => {
  if (accountState.value.checking) return
  if (source.value !== 'history' && accountState.value.context && !feedLoading.value && !items.value.length) void load()
  if (source.value === 'history' && accountState.value.context?.identity
    && !accountState.value.loaded && !accountState.value.loading) {
    void account.loadHistory()
  }
})
// Revoke synchronously, but capture the replacement connection after Vue batches
// settings updates, never halfway between changing the address and its token.
watch(() => [marketStore.external.baseUrl, marketStore.bearerToken], () => {
  refreshRequest += 1
  account.invalidate()
}, { flush: 'sync' })
watch(() => [marketStore.external.baseUrl, marketStore.bearerToken], () => void refreshIdentity())
useTauriListen(LISTEN_KEY.BILI_SESSION_CHANGED, () => void refreshIdentity(true))
onMounted(() => {
  void refreshIdentity(true)
  statusTimer = setInterval(() => {
    if (!document.hidden && !accountState.value.checking) void account.refreshStatus()
  }, 60_000)
})
onUnmounted(() => {
  disposed = true
  requestId += 1
  refreshRequest += 1
  clearInterval(statusTimer)
  stop()
  accountReporter?.close()
  account.dispose()
})

defineExpose({ refresh, pause: stop })
</script>

<template>
  <div class="fun-panel">
    <div
      v-if="!playing"
      aria-label="视频来源"
      class="sources"
      role="group"
    >
      <button
        v-for="option in sources"
        :key="option.key"
        :aria-pressed="source === option.key"
        class="group-tab"
        :class="{ active: source === option.key }"
        type="button"
        @click="source = option.key"
      >
        {{ option.label }}
      </button>
    </div>

    <p
      v-if="notice && !playing"
      class="notice"
      role="status"
    >
      {{ notice }}
    </p>

    <VideoPlayer
      v-if="playing && playingContext && playingReporter"
      :key="`${playing.bvid}:${playingContext.scope}`"
      ref="playerRef"
      :cloud-history="playingHistory"
      :context="playingContext"
      :item="playing"
      :reporter="playingReporter"
      :signal="accountSignal.signal"
      :sync-message="playingContext.identity ? syncMessage : ''"
      @back="returnToList"
    />

    <div
      v-else
      ref="listEl"
      class="list"
      @scroll.passive="onScroll"
    >
      <p
        v-if="loading"
        class="hint"
        role="status"
      >
        加载中…
      </p>
      <div
        v-else-if="needsLogin"
        class="hint"
      >
        <p>请在设置的「行情」页登录 B 站。</p>
        <button
          type="button"
          @click="openSettings"
        >
          打开设置
        </button>
      </div>
      <p
        v-else-if="!errorMessage && displayItems.length === 0 && (source !== 'history' || accountState.loaded)"
        class="hint"
      >
        {{ source === 'history' ? '云端账号暂无观看记录。' : source === 'dynamic' ? '关注的账号暂时没有可显示的视频。' : '暂时没有可显示的视频。' }}
      </p>

      <div
        v-if="displayItems.length"
        class="grid"
      >
        <div
          v-for="item in displayItems"
          :key="item.id"
          class="card-wrap"
        >
          <button
            :aria-label="`播放：${item.title}`"
            class="card"
            :disabled="accountState.checking || !accountState.context || accountState.loading"
            type="button"
            @click="play(item)"
          >
            <span class="thumb">
              <img
                v-if="coverOf(item)"
                alt=""
                loading="lazy"
                :src="coverOf(item)"
              >
              <span class="thumb-labels">
                <span
                  v-if="item.playCount !== undefined"
                  :aria-label="`播放量 ${item.playCount}`"
                  class="play-count"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 12 12"
                  ><path d="m3 2 7 4-7 4Z" /></svg>
                  {{ item.playCount }}
                </span>
                <span
                  v-if="item.durationSec"
                  class="duration"
                >{{ formatVideoTime(item.durationSec) }}</span>
              </span>
            </span>
            <span class="title">{{ item.title }}</span>
            <span
              v-if="item.author"
              class="author"
            >{{ item.author }}</span>
            <span
              v-if="item.stat && item.playCount === undefined"
              class="stat"
            >{{ item.stat }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="errorMessage"
        class="hint err"
        role="alert"
      >
        <p>{{ errorMessage }}</p>
        <p v-if="source === 'dynamic'">
          登录入口在设置的「行情」页。
        </p>
        <button
          v-if="source === 'dynamic'"
          type="button"
          @click="openSettings"
        >
          打开设置
        </button>
        <button
          type="button"
          @click="retryHistory"
        >
          重试
        </button>
      </div>
      <button
        v-else-if="hasMore"
        class="load-more"
        :disabled="loadingMore"
        type="button"
        @click="loadMore"
      >
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
      <p
        v-else-if="source !== 'history' && items.length && !loading"
        class="end"
      >
        暂时没有更多视频，可点上方刷新。
      </p>
    </div>
  </div>
</template>

<style scoped>
.fun-panel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  color: #443d3e;
}

.sources {
  display: grid;
  box-sizing: border-box;
  height: 26px;
  min-height: 26px;
  flex-shrink: 0;
  grid-template-columns: 1fr 1.5fr 1fr 1fr 1fr;
  align-items: center;
  gap: var(--tab-gap);
  border-bottom: 1px solid rgb(68 61 62 / 9%);
}

button:focus-visible {
  outline: 2px solid #817576;
  outline-offset: -2px;
}

.notice {
  flex-shrink: 0;
  margin: 0;
  padding: 0 5px 4px;
  color: #817576;
  font-size: 10px;
  line-height: 1.4;
}

.list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.list::-webkit-scrollbar {
  width: 4px;
}

.list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgb(68 61 62 / 18%);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}

.card-wrap {
  position: relative;
  min-width: 0;
}

.card {
  width: 100%;
  display: flex;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  gap: 2px;
  padding: 0 0 4px;
  border: none;
  border-radius: 6px;
  background: rgb(255 255 255 / 65%);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.card:hover {
  background: rgb(68 61 62 / 12%);
}

.thumb {
  position: relative;
  display: block;
  aspect-ratio: 16 / 9;
  background: rgb(68 61 62 / 8%);
}

.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-labels {
  position: absolute;
  right: 3px;
  bottom: 3px;
  left: 3px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  pointer-events: none;
}

.play-count,
.duration {
  padding: 0 3px;
  border-radius: 3px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  white-space: nowrap;
}

.duration {
  margin-left: auto;
}

.play-count {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.play-count svg {
  width: 9px;
  height: 9px;
  fill: none;
  stroke: currentColor;
  stroke-linejoin: round;
}

.title {
  display: -webkit-box;
  overflow: hidden;
  padding: 0 4px;
  font-size: 11px;
  line-height: 14px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.author,
.stat {
  overflow: hidden;
  padding: 0 4px;
  color: #817576;
  font-size: 10px;
  line-height: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 0;
  padding: 12px 8px;
  color: #817576;
  font-size: 11px;
  text-align: center;
}

.hint p {
  margin: 0 0 6px;
}

.hint.err {
  color: #a43930;
}

.hint button,
.load-more {
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  margin: 2px;
  background: rgb(68 61 62 / 8%);
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.load-more {
  display: block;
  width: calc(100% - 4px);
  margin-top: 6px;
}

.load-more:disabled {
  cursor: wait;
}

.end {
  margin: 7px 0 3px;
  color: #817576;
  font-size: 10px;
  text-align: center;
}
</style>
