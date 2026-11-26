<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import type { BiliFavoritesState } from '@/market/biliFavoritesSession'
import type { BiliHistoryItem, PlaybackContext } from '@/market/biliHistory'
import type { BiliHistoryState } from '@/market/biliHistorySession'
import type { PageDirection, VideoSource } from '@/market/feedPager'
import type { FeedItem } from '@/market/feedService'
import type { ProgressReporter } from '@/market/progressReporter'

import { useNativePageScroll } from '@/composables/useNativePageScroll'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { createBiliFavoritesSession } from '@/market/biliFavoritesSession'
import { cloudHistoryItems, samePlaybackContext } from '@/market/biliHistory'
import { createBiliHistorySession } from '@/market/biliHistorySession'
import { fetchBiliFavoriteFolders, fetchBiliFavoriteVideos, fetchBiliHistory, fetchBiliStatus, reportBiliProgress } from '@/market/biliService'
import { createFeedPager, favoriteCacheKey, hasCachedNext, isFavoriteCacheKey, isWeeklyCacheKey, visibleVideoItems, weeklyCacheKey } from '@/market/feedPager'
import { playCountLabel } from '@/market/feedPresentation'
import { FEED_SOURCES, fetchFeeds, fetchWeeklyIssues } from '@/market/feedService'
import { captureGatewayConnection } from '@/market/gatewayRequest'
import { createPageGesture, wheelDirection } from '@/market/pageGesture'
import { createProgressReporter } from '@/market/progressReporter'
import { formatVideoTime } from '@/market/videoHistory'
import { createWeeklyIssuesSession } from '@/market/weeklyIssues'
import { openVideoPreferences } from '@/plugins/window'
import { useMarketStore } from '@/stores/market'

import FeedContextPicker from './FeedContextPicker.vue'
import VideoPlayer from './VideoPlayer.vue'

const props = defineProps<{ hiddenForPlayback: boolean }>()
const marketStore = useMarketStore()
const sources = [...FEED_SOURCES, { key: 'history', label: '历史' }, { key: 'favorites', label: '收藏' }] as const
const source = ref<VideoSource | 'favorites'>('rcmd')
const favoritesState = shallowRef<BiliFavoritesState>({ folders: [], loaded: false, loading: false, refreshing: false, error: '' })
const weekly = createWeeklyIssuesSession({
  fetch: fetchWeeklyIssues,
  changed: state => weeklyState.value = state,
})
const weeklyState = shallowRef(weekly.snapshot())
const weeklyOptions = computed(() => weeklyState.value.issues.map(issue => ({
  id: String(issue.number),
  title: issue.name.includes(`第${issue.number}期`) || issue.name === `第 ${issue.number} 期` ? issue.name : `第 ${issue.number} 期 · ${issue.name}`,
})))
const cacheKey = computed(() => source.value === 'favorites'
  ? favoriteCacheKey(favoritesState.value.selectedId ?? '')
  : source.value === 'weekly' && weeklyState.value.selectedNumber
    ? weeklyCacheKey(weeklyState.value.selectedNumber)
    : source.value)
const privateSource = computed(() => source.value === 'history' || source.value === 'favorites')
const refreshingFavorites = computed(() => favoritesState.value.refreshing)
const pagerVersion = ref(0)
const playing = ref<FeedItem | null>(null)
const playingContext = shallowRef<PlaybackContext>()
const playingHistory = shallowRef<readonly BiliHistoryItem[]>([])
const playingReporter = shallowRef<ProgressReporter>()
const syncMessage = ref('')
let accountReporter: ProgressReporter | undefined
const accountSignal = shallowRef(new AbortController())
const playerRef = ref<{ stop: () => void }>()
const accountState = shallowRef<BiliHistoryState>({ checking: true, loading: false, loaded: false, rows: [], hasMore: false, notice: '', error: '' })
let playRequest = 0
let refreshRequest = 0
let contentRefreshRequest = 0
let weeklyRefreshIntent: { context: PlaybackContext, number?: number } | undefined
let disposed = false
let statusTimer: ReturnType<typeof setInterval> | undefined

const pager = createFeedPager({
  changed: () => pagerVersion.value += 1,
  async fetch(selected, page, cursor, refresh) {
    const context = accountState.value.context
    if (!context) throw new Error('账号状态暂不可用，请重试。')
    if (isFavoriteCacheKey(selected)) return favorites.readPage(selected.slice('favorites:'.length), page)
    if (selected === 'history') {
      const result = await account.readPage(cursor)
      return { ...result, items: cloudHistoryItems(result.items), hasMore: result.hasMore && Boolean(result.nextCursor) }
    }
    if (isWeeklyCacheKey(selected)) return fetchFeeds('weekly', page, { refresh, weeklyNumber: Number(selected.slice('weekly:'.length)) }, context.connection)
    if (selected === 'weekly') throw new Error('请先选择每周必看期数。')
    return fetchFeeds(selected, page, { cursor, refresh }, context.connection)
  },
})
const favorites = createBiliFavoritesSession({
  folders: fetchBiliFavoriteFolders,
  videos: fetchBiliFavoriteVideos,
  changed: state => favoritesState.value = state,
  identityInvalid: () => {
    if (!disposed) void refreshIdentity(true)
  },
})
const account = createBiliHistorySession({
  connection: captureGatewayConnection,
  status: fetchBiliStatus,
  history: fetchBiliHistory,
  changed(state) {
    accountState.value = state
    favorites.setContext(state.context)
    weekly.setContext(state.context)
    pager.updateMetadata('history', cloudHistoryItems(state.rows))
  },
  invalidatePlayback() {
    favorites.setContext(undefined)
    weekly.setContext(undefined)
    weeklyRefreshIntent = undefined
    contentRefreshRequest += 1
    pager.invalidate()
    accountSignal.value.abort()
    accountReporter = undefined
    syncMessage.value = ''
    stop()
    accountSignal.value = new AbortController()
  },
})
const gesture = createPageGesture({
  turn: pages => void pager.move(pages),
})
const pageState = computed(() => {
  void pagerVersion.value
  return pager.snapshot(cacheKey.value)
})
const displayItems = computed(() => visibleVideoItems(pageState.value).map(item => ({ ...item, playCount: playCountLabel(item) })))
const needsLogin = computed(() => privateSource.value && !accountState.value.checking && accountState.value.status?.logged === false)
const loading = computed(() => !displayItems.value.length && (accountState.value.checking || pageState.value.loading || (source.value === 'favorites' && favoritesState.value.loading) || (source.value === 'weekly' && weeklyState.value.loading)))
const errorMessage = computed(() => (source.value === 'favorites' ? favoritesState.value.error : source.value === 'weekly' ? weeklyState.value.error : '') || pageState.value.error || (privateSource.value ? accountState.value.error : ''))
const canNext = computed(() => hasCachedNext(pageState.value) || pageState.value.hasMore)
const statusText = computed(() => errorMessage.value || accountState.value.recentError)
const footerLabel = computed(() => source.value === 'rank' && pageState.value.fallbackSource === 'bili' ? '热门' : '')
const hasFooterContext = computed(() => Boolean(footerLabel.value || (source.value === 'favorites' && favoritesState.value.folders.length) || (source.value === 'weekly' && weeklyState.value.issues.length)))
const emptyMessage = computed(() => {
  if (source.value === 'favorites') return favoritesState.value.folders.length ? '这个收藏夹暂无可显示的视频。' : '账号暂无自己创建的收藏夹。'
  if (source.value === 'history') return '云端账号暂无观看记录。'
  return source.value === 'dynamic' ? '关注的账号暂时没有可显示的视频。' : '暂时没有可显示的视频。'
})

const baseUrl = computed(() => marketStore.external.baseUrl.replace(/\/+$/, ''))
const token = computed(() => marketStore.bearerToken.trim())

function coverOf(item: FeedItem) {
  if (!item.cover?.startsWith('/v1/media/cover?')) return ''
  return `${baseUrl.value}${item.cover}&token=${encodeURIComponent(token.value)}`
}

async function ensureSource() {
  const context = accountState.value.context
  if (accountState.value.checking || !context || (source.value === 'favorites' && refreshingFavorites.value)) return
  if (privateSource.value && !context.identity) return
  if (source.value === 'favorites') {
    await favorites.loadFolders()
    if (disposed || source.value !== 'favorites' || refreshingFavorites.value || !samePlaybackContext(context, accountState.value.context) || !favoritesState.value.selectedId) return
  }
  if (source.value === 'weekly') {
    await weekly.load()
    if (disposed || source.value !== 'weekly' || !samePlaybackContext(context, accountState.value.context) || !weeklyState.value.selectedNumber) return
  }
  await pager.select(cacheKey.value)
}

function selectIssue(id: string) {
  stop()
  weekly.select(Number(id))
}

function selectFolder(id: string) {
  stop()
  favorites.selectFolder(id)
}

function turnPage(direction: PageDirection) {
  if (direction > 0 && pageState.value.failedRefresh && !hasCachedNext(pageState.value)) void pager.retry()
  else void pager.move(direction, true)
}

const pageViewport = ref<HTMLElement>()
const nativeScroll = useNativePageScroll({
  viewport: pageViewport,
  enabled: () => !playing.value && Boolean(displayItems.value.length) && !accountState.value.checking,
  // No page number or pagerVersion here: one long gesture may cross many pages.
  context: () => JSON.stringify([
    cacheKey.value,
    accountState.value.context?.scope,
    accountState.value.context?.identity?.revision,
    marketStore.external.baseUrl,
    marketStore.bearerToken,
    Boolean(playing.value),
  ]),
  activate: gesture.activate,
  wheel: gesture.nativeWheel,
})

function onWheel(event: WheelEvent) {
  if (!displayItems.value.length || !nativeScroll.acceptsDomWheel()) return
  const delta = wheelDirection(event)
  if (!delta) return
  if (pageState.value.pendingNext) {
    // Keep only the existing forward intent; reversing cancels it immediately.
    if (delta > 0) {
      event.preventDefault()
      return
    }
    pager.cancelNavigation()
  }
  if (gesture.wheel(event)) event.preventDefault()
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
  if (disposed || !item.bvid || !initial || accountState.value.checking) return
  pager.cancelNavigation()
  const request = ++playRequest
  // Join an in-progress return refresh before choosing a resume point. Background
  // pagination does not disable cards or replace the visual page.
  if (initial.identity && (!accountState.value.loaded || accountState.value.refreshingRecent)) await account.refreshRecent()
  if (disposed || request !== playRequest || !samePlaybackContext(initial, accountState.value.context)) return
  pager.cancelNavigation()
  playingContext.value = initial
  playingHistory.value = [...accountState.value.rows]
  playingReporter.value = progressReporter(initial)
  // A just-refreshed history row may point to a different, more recently viewed P.
  playing.value = item.source === 'history' ? pager.snapshot('history').items.find(row => row.id === item.id) ?? item : item
}

function stop() {
  playRequest += 1
  pager.cancelNavigation()
  playerRef.value?.stop()
  if (!playingContext.value?.identity) playingReporter.value?.close()
  playing.value = null
  playingContext.value = undefined
  playingHistory.value = []
  playingReporter.value = undefined
}

function returnToList() {
  stop()
  if (accountState.value.context?.identity) void account.refreshRecent()
}

async function refreshIdentity(invalidate = false) {
  const request = ++refreshRequest
  await account.refreshStatus(invalidate)
  if (!disposed && request === refreshRequest) await ensureSource()
}

async function refreshWeekly(context: PlaybackContext, number?: number) {
  const intent = { context, number }
  weeklyRefreshIntent = intent
  const loaded = await weekly.load(true)
  if (disposed || intent !== weeklyRefreshIntent || !samePlaybackContext(context, accountState.value.context)) return
  if (!loaded) return
  const selected = number ?? weeklyState.value.selectedNumber
  if (selected) await pager.refresh(weeklyCacheKey(selected))
  if (weeklyRefreshIntent === intent) weeklyRefreshIntent = undefined
}

async function refresh() {
  stop()
  const selected = source.value
  const selectedIssue = weeklyState.value.selectedNumber
  const initialWeeklyContext = accountState.value.context
  if (selected === 'favorites') {
    if (refreshingFavorites.value) return
    let refreshedFolderId = favoritesState.value.selectedId
    const initialContext = accountState.value.context
    try {
      if (!accountState.value.context?.identity) await account.refreshStatus()
      if (disposed || !accountState.value.context?.identity) return
      await favorites.refresh((folderId) => {
        refreshedFolderId = folderId
        // Capture the refreshed folder, never read a different selection inside fetch.
        return pager.refresh(favoriteCacheKey(folderId))
      })
    } finally {
      if (!disposed && source.value === 'favorites' && (favoritesState.value.selectedId !== refreshedFolderId || !samePlaybackContext(initialContext, accountState.value.context))) void ensureSource()
    }
    return
  }
  const request = ++contentRefreshRequest
  await account.refreshStatus()
  if (disposed || request !== contentRefreshRequest || !accountState.value.context) return
  if (selected === 'history' && !accountState.value.context.identity) return
  if (selected === 'weekly') {
    const context = accountState.value.context
    await refreshWeekly(context, samePlaybackContext(initialWeeklyContext, context) ? selectedIssue : undefined)
    return
  }
  await pager.refresh(selected)
}

function retry() {
  pager.cancelNavigation()
  if (!accountState.value.context || (privateSource.value && !accountState.value.context.identity)) {
    void refreshIdentity()
  } else if (source.value === 'weekly' && weeklyState.value.error) {
    const intent = weeklyRefreshIntent
    if (intent && samePlaybackContext(intent.context, accountState.value.context)) void refreshWeekly(intent.context, intent.number)
    else void weekly.load(true).then(() => ensureSource())
  } else if (source.value === 'favorites' && favoritesState.value.error) {
    void refresh()
  } else if (errorMessage.value) {
    void pager.retry()
  } else if (accountState.value.recentError) {
    void account.refreshRecent()
  }
}

useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) {
    if (!props.hiddenForPlayback) stop()
  } else {
    void refreshIdentity()
  }
})
watch(cacheKey, (selected) => {
  stop()
  void pager.select(selected, false)
  void ensureSource()
})
watch(() => [accountState.value.context, accountState.value.checking], () => void ensureSource())
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
    if ((!document.hidden || (props.hiddenForPlayback && playing.value)) && !accountState.value.checking) void refreshIdentity()
  }, 60_000)
})
onUnmounted(() => {
  disposed = true
  refreshRequest += 1
  clearInterval(statusTimer)
  stop()
  gesture.dispose()
  pager.dispose()
  favorites.dispose()
  weekly.dispose()
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

    <VideoPlayer
      v-if="playing && playingContext && playingReporter"
      :key="`${playing.bvid}:${playingContext.scope}`"
      ref="playerRef"
      :cloud-history="playingHistory"
      :context="playingContext"
      :hidden-for-playback="props.hiddenForPlayback"
      :item="playing"
      :reporter="playingReporter"
      :signal="accountSignal.signal"
      :sync-message="playingContext.identity ? syncMessage : ''"
      @back="returnToList"
    />

    <template v-else>
      <div class="list">
        <div
          ref="pageViewport"
          class="page-viewport"
          @wheel="onWheel"
        >
          <div
            v-if="displayItems.length"
            :key="`${cacheKey}:${pageState.page}`"
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
                :disabled="accountState.checking || !accountState.context"
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
                      v-if="source === 'history' && item.stat"
                      class="history-progress"
                    >{{ item.stat }}</span>
                    <span
                      v-else-if="item.playCount !== undefined"
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
                <span class="author">{{ item.author }}</span>
              </button>
            </div>
          </div>
          <p
            v-else-if="loading"
            class="hint"
            role="status"
          >
            加载中…
          </p>
          <div
            v-else-if="needsLogin"
            class="hint"
          >
            <button
              type="button"
              @click="openVideoPreferences"
            >
              登录 B 站
            </button>
          </div>
          <div
            v-else-if="errorMessage"
            class="hint err"
            role="alert"
          >
            <p :title="errorMessage">
              {{ errorMessage }}
            </p>
            <button
              v-if="source === 'dynamic'"
              type="button"
              @click="openVideoPreferences"
            >
              登录 B 站
            </button>
            <button
              type="button"
              @click="retry"
            >
              重试
            </button>
          </div>
          <p
            v-else
            class="hint"
          >
            {{ emptyMessage }}
          </p>
        </div>
        <footer class="page-footer">
          <div class="footer-context">
            <FeedContextPicker
              v-if="source === 'favorites' && favoritesState.folders.length"
              :key="`${accountState.context?.scope}:${accountState.context?.identity?.revision}`"
              :before-open="nativeScroll.suspend"
              :disabled="accountState.checking"
              :folders="favoritesState.folders"
              :selected-id="favoritesState.selectedId"
              @close="nativeScroll.resume"
              @select="selectFolder"
            />
            <FeedContextPicker
              v-else-if="source === 'weekly' && weeklyState.issues.length"
              :key="`weekly:${accountState.context?.scope}:${accountState.context?.identity?.revision}`"
              :before-open="nativeScroll.suspend"
              :disabled="accountState.checking"
              :folders="weeklyOptions"
              label="每周必看期数"
              :selected-id="String(weeklyState.selectedNumber)"
              :trigger-title="`第 ${weeklyState.selectedNumber} 期`"
              @close="nativeScroll.resume"
              @select="selectIssue"
            />
            <span
              v-else-if="footerLabel"
              class="footer-label"
            >{{ footerLabel }}</span>
            <div
              v-if="statusText && (displayItems.length || (source === 'favorites' && favoritesState.folders.length))"
              class="footer-error"
              :class="{ compact: hasFooterContext }"
            >
              <span
                class="status-message"
                :class="{ 'visually-hidden': hasFooterContext }"
                role="status"
                :title="statusText"
              >{{ statusText }}</span>
              <button
                :aria-label="`重试：${statusText}`"
                class="retry-button"
                :disabled="pageState.loading || accountState.refreshingRecent || favoritesState.loading || refreshingFavorites"
                :title="statusText"
                type="button"
                @click="retry"
              >
                重试
              </button>
            </div>
          </div>
          <nav
            aria-label="视频翻页"
            class="page-controls"
          >
            <button
              aria-label="上一页"
              class="page-previous"
              :disabled="pageState.refreshing || (pageState.page === 0 && !pageState.pendingNext)"
              type="button"
              @click="turnPage(-1)"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
              ><path d="m8 2-4 4 4 4" /></svg>
            </button>
            <span
              :aria-label="`第 ${pageState.page + 1} 页`"
              aria-live="polite"
              class="page-number"
            >{{ pageState.page + 1 }}</span>
            <button
              :aria-busy="pageState.pendingNext"
              :aria-label="pageState.pendingNext ? '正在加载下一页' : errorMessage && !hasCachedNext(pageState) ? '重试下一页' : '下一页'"
              class="page-following"
              :disabled="!displayItems.length || !canNext || pageState.pendingNext || pageState.refreshing"
              type="button"
              @click="turnPage(1)"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
              ><path d="m4 2 4 4-4 4" /></svg>
            </button>
          </nav>
        </footer>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fun-panel {
  display: flex;
  min-width: 0;
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
  grid-template-columns: 1fr 1.5fr 1fr 1fr 1fr 1fr;
  align-items: center;
  gap: var(--tab-gap);
  border-bottom: 1px solid rgb(68 61 62 / 9%);
}

button:focus-visible {
  outline: 2px solid #817576;
  outline-offset: -2px;
}

.list {
  --video-footer-height: 24px;

  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
  padding: 4px 4px 0;
}

.page-viewport {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  overscroll-behavior: contain;
}

.grid {
  display: grid;
  height: 100%;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  gap: 6px;
}

.card-wrap {
  min-width: 0;
  min-height: 0;
}

.card {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  gap: 3px;
  padding: 0 0 4px;
  border: none;
  border-radius: 6px;
  background: rgb(255 255 255 / 65%);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.card:hover:not(:disabled) {
  background: rgb(68 61 62 / 12%);
}

.card:disabled {
  cursor: default;
}

.thumb {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  flex: none;
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
.history-progress,
.duration {
  padding: 0 3px;
  border-radius: 3px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  white-space: nowrap;
}

.history-progress {
  overflow: hidden;
  text-overflow: ellipsis;
}

.duration {
  flex: none;
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
  height: 28px;
  flex: none;
  overflow: hidden;
  padding: 0 5px;
  font-size: 11px;
  line-height: 14px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.author {
  box-sizing: border-box;
  width: 100%;
  height: 12px;
  flex: none;
  overflow: hidden;
  margin-top: auto;
  padding: 0 5px;
  color: #817576;
  font-size: 10px;
  line-height: 12px;
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
  display: -webkit-box;
  overflow: hidden;
  margin: 0 0 6px;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.err {
  color: #a43930;
}

.hint button,
.retry-button,
.page-controls button {
  padding: 0 5px;
  border: 0;
  border-radius: 4px;
  background: rgb(68 61 62 / 8%);
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
}

.hint button {
  margin: 2px;
  padding: 4px 8px;
}

.page-footer {
  display: flex;
  box-sizing: border-box;
  height: var(--video-footer-height);
  flex: none;
  align-items: center;
  gap: 8px;
  border-top: 1px solid rgb(68 61 62 / 9%);
  color: #817576;
  font-size: 10px;
  line-height: 20px;
}

.footer-context {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
}

.footer-label {
  display: block;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  padding: 0 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-error {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
  color: #a43930;
}

.footer-error.compact {
  flex: none;
}

.status-message.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.status-message {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.retry-button {
  height: 20px;
  flex: none;
}

.page-controls {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  color: #443d3e;
}

.page-number {
  min-width: 22px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.page-controls button {
  display: grid;
  width: 22px;
  height: 20px;
  place-items: center;
  padding: 0;
  background: transparent;
}

.page-controls button:hover:not(:disabled) {
  background: rgb(68 61 62 / 8%);
}

.page-controls svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.page-controls button:disabled,
.retry-button:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
