<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { AudioOutputState } from '@/market/audioSafety'
import type { BiliHistoryItem, PlaybackContext } from '@/market/biliHistory'
import type { FeedItem, VideoPart } from '@/market/feedService'
import type { ProgressReporter } from '@/market/progressReporter'

import { INVOKE_KEY, LISTEN_KEY } from '@/constants'
import { createAudioSafety } from '@/market/audioSafety'
import { cloudHistoryItems, cloudPartResume, preferredHistoryCid } from '@/market/biliHistory'
import { fetchVideoParts } from '@/market/feedService'
import { formatVideoTime, resumePosition } from '@/market/videoHistory'

const props = defineProps<{ item: FeedItem, context: PlaybackContext, cloudHistory: readonly BiliHistoryItem[], signal: AbortSignal, reporter: ProgressReporter, syncMessage: string }>()
const emit = defineEmits<{ back: [] }>()
// Never resolve connection or identity from mutable settings while a video is open.
const context = props.context
const parts = ref<VideoPart[]>([])
const selected = ref<VideoPart>()
const videoEl = ref<HTMLVideoElement>()
const showParts = ref(false)
const loading = ref(true)
const error = ref('')
const paused = ref(true)
const muted = ref(true)
const playbackRate = ref(1)
const playbackRates = [1, 1.5, 2, 0.75]
const position = ref(0)
const duration = ref(0)
const seekPreview = ref<number>()
const ready = ref(false)
const message = ref('')
let generation = 0
let loadGeneration = 0
const restoring = ref(false)
let disposed = false
let progressTimer: ReturnType<typeof setInterval> | undefined
const reporter = props.reporter
const audioSafety = createAudioSafety({
  queryOutput: () => invoke<AudioOutputState>(INVOKE_KEY.GET_AUDIO_OUTPUT_STATE),
  getMedia: () => videoEl.value,
  onMuted: value => muted.value = value,
  onInterrupt: () => {
    finishReport()
    paused.value = true
    message.value = '音频输出已变化，已静音并暂停。请手动播放或开启声音。'
  },
})

const streamUrl = computed(() => {
  if (!props.item.bvid || !selected.value) return ''
  const query = new URLSearchParams({
    bvid: props.item.bvid,
    cid: String(selected.value.cid),
    qn: '16',
    token: context.connection.bearerToken,
  })
  return `${context.connection.baseUrl}/v1/media/stream?${query}`
})

function mountVideo(element: unknown) {
  if (!(element instanceof HTMLVideoElement) || element === videoEl.value || disposed) return
  // Never bind the previous part's muted=false onto a fresh element. Set source
  // only after silencing it, even if a route event arrived before this mount.
  element.muted = true
  element.defaultMuted = true
  element.pause()
  videoEl.value = element
  muted.value = true
  element.src = streamUrl.value
}

function currentVideo(event: Event): HTMLVideoElement | undefined {
  const video = event.currentTarget as HTMLVideoElement
  return !disposed && video === videoEl.value ? video : undefined
}

function finishReport(completed = false) {
  const video = videoEl.value
  if (video) reporter.finish(video.currentTime, completed || video.ended)
  else reporter.suspend()
}

function stop() {
  finishReport()
  audioSafety.stop()
  paused.value = true
}

function selectPart(part: VideoPart, userInitiated = false) {
  finishReport()
  audioSafety.beginPart(userInitiated)
  // Old media events must not be counted or saved as the newly selected P.
  videoEl.value = undefined
  reporter.beginPart(props.item.bvid!, part.cid)
  generation += 1
  restoring.value = false
  ready.value = false
  paused.value = true
  error.value = ''
  message.value = ''
  position.value = 0
  duration.value = 0
  seekPreview.value = undefined
  selected.value = part
  showParts.value = false
}

async function loadParts(userInitiated = false) {
  if (userInitiated) audioSafety.allowPlayback()
  const request = ++loadGeneration
  loading.value = true
  error.value = ''
  try {
    const result = await fetchVideoParts(props.item.bvid!, context.connection)
    if (disposed || props.signal.aborted || request !== loadGeneration) return
    if (result.bvid !== props.item.bvid || !Array.isArray(result.parts) || result.parts.length === 0) {
      throw new Error('未获取到可播放的选集')
    }
    parts.value = result.parts
    const previous = cloudHistoryItems(props.cloudHistory).find(row => row.bvid === props.item.bvid)
    const preferredCid = preferredHistoryCid(props.item, previous?.cid ? { cid: previous.cid } : undefined)
    const part = parts.value.find(row => row.cid === preferredCid) ?? parts.value[0]!
    selectPart(part)
    if (preferredCid && preferredCid !== part.cid) message.value = '上次观看的分 P 已不可用，已打开第一 P。'
  } catch (reason) {
    if (!disposed && request === loadGeneration) error.value = reason instanceof Error ? reason.message : '选集加载失败'
  } finally {
    if (!disposed && request === loadGeneration) loading.value = false
  }
}

async function startVideo(video: HTMLVideoElement, userInitiated = false) {
  if (disposed || props.signal.aborted || video !== videoEl.value) return
  const current = generation
  const playing = await audioSafety.play(video, userInitiated)
  if (!playing && !disposed && current === generation && video === videoEl.value) {
    paused.value = video.paused
    if (!message.value) message.value = '点击播放继续。'
  }
}

function onMetadata(event: Event) {
  const video = currentVideo(event)
  if (!video || !selected.value || !Number.isFinite(video.duration) || video.duration <= 0) return
  duration.value = video.duration
  video.playbackRate = playbackRate.value
  const previous = cloudPartResume(
    props.cloudHistory.find(row => row.bvid === props.item.bvid && row.cid === selected.value!.cid),
  )
  const resume = resumePosition(previous, video.duration)
  ready.value = true
  if (resume > 0) {
    restoring.value = true
    position.value = resume
    try {
      video.currentTime = resume
    } catch {
      restoring.value = false
      message.value = '未能恢复进度，可拖动进度条。'
      void startVideo(video)
    }
  } else {
    void startVideo(video)
  }
}

function onSeeked(event: Event) {
  const video = currentVideo(event)
  if (!video) return
  position.value = video.currentTime
  if (restoring.value) {
    restoring.value = false
    void startVideo(video)
  } else if (!video.paused && video.readyState >= 3) {
    reporter.playing()
  }
}

function onSuspended(event: Event) {
  if (currentVideo(event)) reporter.suspend()
}

function onPlaying(event: Event) {
  const video = currentVideo(event)
  if (!video || !audioSafety.acceptPlaying(video)) return
  paused.value = false
  reporter.playing()
}

function onPause(event: Event) {
  if (!currentVideo(event)) return
  finishReport()
  paused.value = true
}

function onTimeUpdate(event: Event) {
  const video = currentVideo(event)
  if (!video || restoring.value) return
  position.value = video.currentTime
}

function onEnded(event: Event) {
  if (!currentVideo(event)) return
  finishReport(true)
  audioSafety.stop()
  paused.value = true
  message.value = ''
}

function onError(event: Event) {
  if (!currentVideo(event)) return
  finishReport()
  audioSafety.stop()
  paused.value = true
  error.value = '视频暂时无法播放，可重试或返回列表。'
}

function togglePlay() {
  const video = videoEl.value
  if (!video || !ready.value) return
  if (video.paused) {
    if (video.ended) video.currentTime = 0
    message.value = ''
    void startVideo(video, true)
  } else {
    stop()
  }
}

async function toggleMute() {
  const video = videoEl.value
  if (!video) return
  if (!video.muted) {
    audioSafety.mute()
  } else if (!await audioSafety.unmute() && !disposed && video === videoEl.value) {
    message.value = '未能确认当前音频输出，保持静音。请再次点击开启声音。'
  }
}

function onVolumeChange(event: Event) {
  const video = currentVideo(event)
  if (video) muted.value = video.muted
}

function cyclePlaybackRate() {
  const index = playbackRates.indexOf(playbackRate.value)
  playbackRate.value = playbackRates[(index + 1) % playbackRates.length]!
  if (videoEl.value) videoEl.value.playbackRate = playbackRate.value
}

function previewSeek(event: Event) {
  seekPreview.value = Number((event.target as HTMLInputElement).value)
}

function commitSeek(event: Event) {
  const video = videoEl.value
  const target = Number((event.target as HTMLInputElement).value)
  seekPreview.value = undefined
  if (!video || !ready.value || !Number.isFinite(target)) return
  video.currentTime = Math.min(Math.max(0, target), duration.value)
  position.value = video.currentTime
}

function retry() {
  if (!selected.value) {
    void loadParts(true)
    return
  }
  selectPart(selected.value, true)
}

function back() {
  if (showParts.value) {
    showParts.value = false
    return
  }
  stop()
  emit('back')
}

onMounted(() => {
  // Subscribe before taking the first snapshot; revision guards cover races.
  void audioSafety.connect(changed => listen<AudioOutputState>(LISTEN_KEY.AUDIO_OUTPUT_CHANGED, event => changed(event.payload)))
  void loadParts()
  progressTimer = setInterval(() => {
    const video = videoEl.value
    if (video && !restoring.value) reporter.sample(video.currentTime, video.ended)
  }, 1000)
})
onBeforeUnmount(() => {
  stop()
  clearInterval(progressTimer)
  audioSafety.dispose()
  disposed = true
  generation += 1
  loadGeneration += 1
})
defineExpose({ stop })
</script>

<template>
  <div
    class="video-player"
    :class="{ 'parts-open': showParts }"
  >
    <div class="player-heading">
      <button
        :aria-label="showParts ? '返回播放器' : '返回视频列表'"
        class="back"
        type="button"
        @click="back"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
        ><path d="m14 6-6 6 6 6" /></svg>
      </button>
      <span
        class="player-title"
        :title="item.title"
      >{{ item.title }}</span>
      <button
        v-if="parts.length > 1"
        :aria-expanded="showParts"
        class="parts-button"
        type="button"
        @click="showParts = !showParts"
      >
        P{{ selected?.page }} / {{ parts.length }}
      </button>
    </div>
    <div class="video-surface">
      <video
        v-if="selected"
        :key="`${selected.cid}:${generation}`"
        :ref="mountVideo"
        :aria-label="`${item.title} P${selected.page}`"
        controlslist="nofullscreen noremoteplayback nodownload"
        disablepictureinpicture
        disableremoteplayback
        muted
        playsinline
        preload="metadata"
        @contextmenu.prevent
        @dblclick.prevent
        @ended="onEnded"
        @error="onError"
        @loadedmetadata="onMetadata"
        @pause="onPause"
        @playing="onPlaying"
        @seeked="onSeeked"
        @seeking="onSuspended"
        @timeupdate="onTimeUpdate"
        @volumechange="onVolumeChange"
        @waiting="onSuspended"
      />
      <div
        v-if="loading || error"
        class="player-status"
        :role="error ? 'alert' : 'status'"
      >
        <span>{{ loading ? '正在加载选集…' : error }}</span>
        <button
          v-if="error"
          type="button"
          @click="retry"
        >
          重试
        </button>
      </div>
      <div
        v-if="showParts"
        aria-label="视频选集"
        class="parts-list"
      >
        <button
          v-for="part in parts"
          :key="part.cid"
          :aria-current="selected?.cid === part.cid ? 'true' : undefined"
          :class="{ active: selected?.cid === part.cid }"
          type="button"
          @click="selected?.cid === part.cid ? showParts = false : selectPart(part, true)"
        >
          <span>P{{ part.page }} {{ part.title }}</span>
          <span class="part-duration">{{ formatVideoTime(part.durationSec) }}</span>
        </button>
      </div>
    </div>
    <p
      v-if="(message || syncMessage) && !showParts && !error"
      class="player-message"
      role="status"
    >
      {{ message || syncMessage }}
    </p>
    <div
      aria-label="播放控制"
      class="player-controls"
    >
      <button
        :aria-label="paused ? '播放' : '暂停'"
        :disabled="!ready || !!error || restoring"
        type="button"
        @click="togglePlay"
      >
        <svg
          v-if="paused"
          aria-hidden="true"
          viewBox="0 0 24 24"
        ><path d="m8 5 11 7-11 7Z" /></svg>
        <svg
          v-else
          aria-hidden="true"
          viewBox="0 0 24 24"
        ><path d="M8 5v14M16 5v14" /></svg>
      </button>
      <button
        :aria-label="muted ? '开启声音' : '静音'"
        :aria-pressed="!muted"
        :disabled="!ready || !!error || restoring"
        type="button"
        @click="toggleMute"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
        >
          <path d="M10 5 5 9H2v6h3l5 4Z" />
          <path
            v-if="muted"
            d="m15 9 6 6m0-6-6 6"
          />
          <path
            v-else
            d="M15 8a7 7 0 0 1 0 8m3-11a11 11 0 0 1 0 14"
          />
        </svg>
      </button>
      <button
        :aria-label="`播放倍速：${playbackRate}倍，点击切换`"
        class="playback-rate"
        type="button"
        @click="cyclePlaybackRate"
      >
        {{ playbackRate }}×
      </button>
      <input
        aria-label="播放进度"
        :aria-valuetext="`${formatVideoTime(seekPreview ?? position)} / ${formatVideoTime(duration)}`"
        :disabled="!ready || !!error || restoring"
        :max="duration || 1"
        min="0"
        step="0.1"
        type="range"
        :value="seekPreview ?? position"
        @blur="seekPreview = undefined"
        @change="commitSeek"
        @input="previewSeek"
        @pointercancel="seekPreview = undefined"
      >
      <span class="time">{{ formatVideoTime(seekPreview ?? position) }} / {{ formatVideoTime(duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.player-controls .playback-rate {
  min-width: 32px;
  height: 22px;
  padding: 0 3px;
  font-size: 10px;
}
.video-player {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  color: #443d3e;
}
.player-heading {
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  height: 23px;
  align-items: center;
  gap: 3px;
  padding: 0 2px;
}
.player-heading,
.player-controls {
  background: rgb(0 0 0 / 65%);
  color: #fff;
  opacity: 0;
  pointer-events: none;
}
.video-player:hover .player-heading,
.video-player:hover .player-controls,
.video-player.parts-open .player-heading,
.video-player.parts-open .player-controls,
.video-player:has(:focus-visible) .player-heading,
.video-player:has(:focus-visible) .player-controls {
  opacity: 1;
  pointer-events: auto;
}
button {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
button:hover {
  background: rgb(68 61 62 / 9%);
}
button:disabled {
  cursor: default;
  opacity: 0.4;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid #817576;
  outline-offset: -1px;
}
svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.player-title {
  min-width: 0;
  overflow: hidden;
  flex: 1;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parts-button {
  font-size: 10px;
  white-space: nowrap;
}
.video-surface {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
video::-webkit-media-controls {
  display: none !important;
}
.player-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px;
  background: transparent;
  font-size: 11px;
  text-align: center;
}
.player-status button {
  background: rgb(68 61 62 / 8%);
}
.parts-list {
  position: absolute;
  z-index: 1;
  inset: 23px 0 26px;
  overflow-y: auto;
  background: rgb(0 0 0 / 82%);
  color: #fff;
}
.parts-list button {
  display: flex;
  width: 100%;
  justify-content: space-between;
  gap: 5px;
  padding: 6px;
  font-size: 11px;
  text-align: left;
}
.parts-list button > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parts-list .active {
  background: rgb(255 255 255 / 18%);
}
.part-duration {
  flex-shrink: 0;
  font-size: 10px;
}
.player-message {
  position: absolute;
  z-index: 2;
  right: 0;
  bottom: 28px;
  left: 0;
  overflow: hidden;
  margin: 0;
  padding: 2px 4px;
  background: rgb(0 0 0 / 65%);
  color: #fff;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-controls {
  position: absolute;
  z-index: 2;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  height: 26px;
  align-items: center;
  gap: 2px;
  padding: 0 3px;
}
.player-controls button {
  width: 23px;
  height: 23px;
}
input[type='range'] {
  width: 0;
  min-width: 24px;
  height: 18px;
  flex: 1;
  margin: 0 3px;
  accent-color: #443d3e;
  cursor: pointer;
}
.time {
  flex-shrink: 0;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
