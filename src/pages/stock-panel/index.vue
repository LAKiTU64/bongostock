<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import type { IntradayPoint, StockKline, StockQuote, TrendSeries } from '@/market/marketService'
import type { MarketSettingsSnapshot } from '@/stores/market'
import type { StockPanelSettings, WatchlistGroup } from '@/stores/watchlist'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { fetchDailyKlines, fetchQuotes, fetchTrendSeries } from '@/market/marketService'
import { hideWindow } from '@/plugins/window'
import { useMarketStore } from '@/stores/market'
import { useWatchlistStore } from '@/stores/watchlist'

const appWindow = getCurrentWebviewWindow()
const marketStore = useMarketStore()
const watchlistStore = useWatchlistStore()
const quotes = ref<StockQuote[]>([])
const loading = ref(false)
const errorMessage = ref('')
const activeGroupId = ref('')
const isDimmed = ref(false)
const isPinned = ref(false)
const selectedQuote = ref<StockQuote>()
const detailMode = ref<DetailMode>('intraday')
const detailLoading = ref(false)
const intradaySeries = ref<TrendSeries>()
const trendSeries = ref<TrendSeries>()
const dailyKlines = ref<StockKline[]>([])
const chartHover = ref<ChartHoverState>()
const intradayError = ref('')
const trendError = ref('')
const klineError = ref('')
let idleFadeTimer: ReturnType<typeof setTimeout> | undefined
let detailAbortController: AbortController | undefined
let detailRequestId = 0
let quoteRequestId = 0
let dragPointerStart: { x: number, y: number } | undefined
let unlistenFocus: (() => void) | undefined

const DRAG_THRESHOLD = 4
const CHART_WIDTH = 248
const CHART_HEIGHT = 74
const CHART_PADDING_X = 4
const CHART_PADDING_Y = 5

type DetailMode = 'intraday' | 'five-day' | 'day-k'
interface ChartHoverState {
  left: number
  top: number
  alignRight: boolean
  title: string
  detail: string
}
const detailTabs: readonly { mode: DetailMode, label: string }[] = [
  { mode: 'intraday', label: '分时' },
  { mode: 'five-day', label: '5日' },
  { mode: 'day-k', label: '日K' },
]

const activeGroup = computed(() => watchlistStore.groups.find(group => group.id === activeGroupId.value)
  ?? watchlistStore.groups[0])

const displayQuotes = computed(() => {
  const quoteByCode = new Map(quotes.value.map(quote => [quote.code.toUpperCase(), quote]))

  return (activeGroup.value?.codes ?? []).map(code => quoteByCode.get(code) ?? createPlaceholderQuote(code))
})

const detailPoints = computed(() => {
  const series = detailMode.value === 'intraday'
    ? intradaySeries.value ?? trendSeries.value
    : trendSeries.value
  const points = series?.points ?? []

  if (detailMode.value === 'five-day') return points

  const lastDate = points.at(-1)?.date
  return lastDate ? points.filter(point => point.date === lastDate) : []
})

const detailChart = computed(() => buildTrendChart(detailPoints.value, detailMode.value))
const klineChart = computed(() => buildKlineChart(dailyKlines.value))
const detailError = computed(() => {
  if (detailMode.value === 'day-k') return klineError.value
  return detailMode.value === 'intraday' ? intradayError.value : trendError.value
})
const detailReady = computed(() => detailMode.value === 'day-k'
  ? dailyKlines.value.length > 0
  : detailMode.value === 'intraday'
    ? Boolean(intradaySeries.value?.points.length || trendSeries.value?.points.length)
    : Boolean(trendSeries.value?.points.length))
const detailPrice = computed(() => {
  const latestTrend = (intradaySeries.value ?? trendSeries.value)?.points.at(-1)?.close
  return latestTrend && latestTrend > 0 ? latestTrend : selectedQuote.value?.now ?? 0
})
const detailPercent = computed(() => selectedQuote.value?.percent ?? 0)
const detailLastTimestamp = computed(() => (intradaySeries.value ?? trendSeries.value)?.points.at(-1)?.timestamp ?? '')
const detailTabLabel = computed(() => {
  if (detailMode.value === 'intraday') return '分时'
  if (detailMode.value === 'five-day') return '5日'
  return '日K'
})

watch(() => watchlistStore.groups, (groups) => {
  if (groups.some(group => group.id === activeGroupId.value)) return

  activeGroupId.value = groups[0]?.id ?? ''
}, { deep: true, immediate: true })

watch(activeGroupId, resetIdleFade)
watch(() => [
  watchlistStore.panel.fadeDelaySeconds,
  watchlistStore.panel.dimmedOpacity,
], resetIdleFade)

useTauriListen<string>(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (payload !== WINDOW_LABEL.STOCK_PANEL) return

  closeDetail()
  setPinned(false)
  resetIdleFade()
  void refreshQuotes()
})

useTauriListen<WatchlistGroup[] | string[]>(LISTEN_KEY.WATCHLIST_CHANGED, ({ payload }) => {
  watchlistStore.replaceFromEvent(payload)
  closeDetail()
  quotes.value = []
  errorMessage.value = ''
  resetIdleFade()
  void refreshIfVisible()
})

useTauriListen<StockPanelSettings>(LISTEN_KEY.STOCK_PANEL_SETTINGS_CHANGED, ({ payload }) => {
  watchlistStore.updatePanelSettings(payload)
  resetIdleFade()
})

useTauriListen<MarketSettingsSnapshot>(LISTEN_KEY.MARKET_SETTINGS_CHANGED, ({ payload }) => {
  marketStore.replaceFromEvent(payload)
  closeDetail()
  quotes.value = []
  errorMessage.value = ''
  void refreshIfVisible()
})

useEventListener('keydown', (event) => {
  resetIdleFade()

  if (event.key !== 'Escape') return

  event.preventDefault()
  closePanel()
})

onMounted(async () => {
  resetIdleFade()
  unlistenFocus = await appWindow.onFocusChanged(async ({ payload: focused }) => {
    if (focused || isPinned.value) return

    const mainWindow = await WebviewWindow.getByLabel(WINDOW_LABEL.MAIN)
    const [mainFocused, panelFocused] = await Promise.all([
      mainWindow?.isFocused() ?? false,
      appWindow.isFocused(),
    ])

    if (!mainFocused && !panelFocused && !isPinned.value) closePanel()
  })

  if (await appWindow.isVisible()) void refreshQuotes()
})

onUnmounted(() => {
  clearTimeout(idleFadeTimer)
  detailAbortController?.abort()
  unlistenFocus?.()
})

function resetIdleFade() {
  isDimmed.value = false
  clearTimeout(idleFadeTimer)
  idleFadeTimer = setTimeout(() => {
    isDimmed.value = true
  }, watchlistStore.panel.fadeDelaySeconds * 1000)
}

function handleDragPointerDown(event: PointerEvent) {
  if (event.button !== 0) return

  dragPointerStart = { x: event.screenX, y: event.screenY }
  resetIdleFade()
}

function handleDragPointerMove(event: PointerEvent) {
  if (!dragPointerStart || (event.buttons & 1) === 0) return

  const distance = Math.hypot(
    event.screenX - dragPointerStart.x,
    event.screenY - dragPointerStart.y,
  )

  if (distance < DRAG_THRESHOLD) return

  dragPointerStart = undefined
  void appWindow.startDragging()
}

function handleDragPointerEnd() {
  dragPointerStart = undefined
}

async function refreshQuotes() {
  const requestId = ++quoteRequestId

  if (watchlistStore.totalCodes === 0) {
    quotes.value = []
    errorMessage.value = ''
    return
  }

  loading.value = true
  errorMessage.value = ''
  resetIdleFade()

  try {
    const nextQuotes = await fetchQuotes(watchlistStore.codes)

    if (requestId !== quoteRequestId) return

    quotes.value = nextQuotes
  } catch (error) {
    if (requestId !== quoteRequestId) return

    errorMessage.value = `行情不可用：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (requestId === quoteRequestId) loading.value = false
  }
}

async function refreshIfVisible() {
  if (await appWindow.isVisible()) void refreshQuotes()
}

function selectGroup(id: string) {
  closeDetail()
  activeGroupId.value = id
  resetIdleFade()
}

function togglePinned() {
  setPinned(!isPinned.value)
  resetIdleFade()
}

function closePanel() {
  closeDetail()
  setPinned(false)
  void hideWindow(WINDOW_LABEL.STOCK_PANEL)
}

function setPinned(value: boolean) {
  isPinned.value = value
  void emit(LISTEN_KEY.STOCK_PANEL_PIN_CHANGED, value)
}

function closeDetail() {
  detailRequestId += 1
  detailAbortController?.abort()
  detailAbortController = undefined
  selectedQuote.value = undefined
  trendSeries.value = undefined
  intradaySeries.value = undefined
  dailyKlines.value = []
  intradayError.value = ''
  trendError.value = ''
  klineError.value = ''
  chartHover.value = undefined
  detailLoading.value = false
  detailMode.value = 'intraday'
}

function openDetail(quote: StockQuote) {
  if (!quote.code || quote.name === '等待行情') return

  selectedQuote.value = quote
  detailMode.value = 'intraday'
  void loadDetail(quote)
}

async function loadDetail(quote: StockQuote, force = false) {
  detailRequestId += 1
  const requestId = detailRequestId
  detailAbortController?.abort()
  const controller = new AbortController()
  detailAbortController = controller
  trendSeries.value = undefined
  intradaySeries.value = undefined
  dailyKlines.value = []
  intradayError.value = ''
  trendError.value = ''
  klineError.value = ''
  chartHover.value = undefined
  detailLoading.value = true
  resetIdleFade()

  const [intradayResult, trendResult, klineResult] = await Promise.allSettled([
    fetchTrendSeries(quote.code, 1, controller.signal, force),
    fetchTrendSeries(quote.code, 5, controller.signal, force),
    fetchDailyKlines(quote.code, 30, force),
  ])

  if (requestId !== detailRequestId || selectedQuote.value?.code !== quote.code) return

  if (intradayResult.status === 'fulfilled') intradaySeries.value = intradayResult.value
  else if (!isAbortError(intradayResult.reason)) intradayError.value = formatDetailError(intradayResult.reason)

  if (trendResult.status === 'fulfilled') trendSeries.value = trendResult.value
  else if (!isAbortError(trendResult.reason)) trendError.value = formatDetailError(trendResult.reason)

  if (klineResult.status === 'fulfilled') dailyKlines.value = klineResult.value
  else klineError.value = formatDetailError(klineResult.reason)

  detailLoading.value = false
  detailAbortController = undefined
}

function reloadDetail() {
  if (!selectedQuote.value || detailLoading.value) return

  void loadDetail(selectedQuote.value, true)
}

function selectDetailMode(mode: DetailMode) {
  detailMode.value = mode
  chartHover.value = undefined
  resetIdleFade()
}

function handleChartPointerMove(event: PointerEvent) {
  const chartBox = event.currentTarget

  if (!(chartBox instanceof HTMLElement)) return

  const rect = chartBox.getBoundingClientRect()
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
  const alignRight = x > rect.width * 0.68

  if (detailMode.value === 'day-k') {
    const visible = dailyKlines.value.slice(-30)
    const index = nearestIndex(x, rect.width, visible.length)
    const kline = visible[index]

    if (!kline) return

    chartHover.value = {
      left: x,
      top: Math.max(3, y - 32),
      alignRight,
      title: kline.date,
      detail: `开 ${formatChartPrice(kline.open)}  高 ${formatChartPrice(kline.high)}  低 ${formatChartPrice(kline.low)}  收 ${formatChartPrice(kline.close)}`,
    }
    return
  }

  const points = detailPoints.value
  const index = nearestIndex(x, rect.width, points.length)
  const point = points[index]

  if (!point) return

  chartHover.value = {
    left: x,
    top: Math.max(3, y - 29),
    alignRight,
    title: point.timestamp,
    detail: `价格 ${formatChartPrice(point.close)}  均价 ${formatChartPrice(point.average)}`,
  }
}

function nearestIndex(x: number, width: number, length: number) {
  if (length <= 1 || width <= 0) return 0
  return Math.max(0, Math.min(length - 1, Math.round(x / width * (length - 1))))
}

function clearChartHover() {
  chartHover.value = undefined
}

function createPlaceholderQuote(code: string): StockQuote {
  return { code, name: '等待行情', now: 0, low: 0, high: 0, percent: 0, yesterday: 0 }
}

function formatPrice(value: number) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : '--'
}

function formatChartPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value < 10) return value.toFixed(3)
  return value.toFixed(2)
}

function formatChartDate(value: string) {
  const normalized = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
    : value
  const [, month = '', day = ''] = normalized.split('-')
  return month && day ? `${month}-${day}` : value
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return '--'

  const percent = value * 100
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
}

function quoteClass(quote: StockQuote) {
  if (quote.percent > 0) return 'up'
  if (quote.percent < 0) return 'down'
  return 'flat'
}

function formatDetailError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (/failed to fetch|fetch failed|socket|连接/i.test(message)) {
    return '数据源连接失败，请检查网络代理设置'
  }

  return message || '数据加载失败'
}

function isAbortError(error: unknown) {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
}

function buildTrendChart(points: IntradayPoint[], mode: DetailMode) {
  if (points.length === 0) return undefined

  const values = points.flatMap(point => [point.close, point.average]).filter(Number.isFinite)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || Math.max(Math.abs(max) * 0.01, 0.01)
  const innerWidth = CHART_WIDTH - CHART_PADDING_X * 2
  const innerHeight = CHART_HEIGHT - CHART_PADDING_Y * 2
  const toX = (index: number) => points.length <= 1
    ? CHART_WIDTH / 2
    : CHART_PADDING_X + index / (points.length - 1) * innerWidth
  const toY = (value: number) => CHART_PADDING_Y + (max - value) / range * innerHeight
  const buildPath = (selector: (point: IntradayPoint) => number) => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index).toFixed(2)} ${toY(selector(point)).toFixed(2)}`)
    .join(' ')

  const morningEndIndex = points.findLastIndex(point => point.time <= '11:30')
  const afternoonStartIndex = points.findIndex(point => point.time >= '13:00')
  const sessionDividerX = mode === 'intraday'
    && morningEndIndex >= 0
    && afternoonStartIndex > morningEndIndex
    ? toX((morningEndIndex + afternoonStartIndex) / 2)
    : undefined
  const dividerX = sessionDividerX ?? CHART_WIDTH / 2
  const timeLabels = mode === 'intraday'
    ? [
        { label: '09:30', x: CHART_PADDING_X, align: 'left' },
        { label: '11:30', x: Math.max(CHART_PADDING_X, dividerX - 2), align: 'right' },
        { label: '13:00', x: Math.min(CHART_WIDTH - CHART_PADDING_X, dividerX + 2), align: 'left' },
        { label: '15:00', x: CHART_WIDTH - CHART_PADDING_X, align: 'right' },
      ] as const
    : []

  return {
    closePath: buildPath(point => point.close),
    averagePath: buildPath(point => point.average),
    min,
    max,
    firstDate: points[0]?.date ?? '',
    lastDate: points.at(-1)?.date ?? '',
    sessionDividerX,
    timeLabels,
  }
}

function buildKlineChart(klines: StockKline[]) {
  const visible = klines.slice(-30)
  if (visible.length === 0) return undefined

  const values = visible.flatMap(kline => [kline.high, kline.low]).filter(Number.isFinite)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || Math.max(Math.abs(max) * 0.01, 0.01)
  const innerWidth = CHART_WIDTH - CHART_PADDING_X * 2
  const innerHeight = CHART_HEIGHT - CHART_PADDING_Y * 2
  const slotWidth = innerWidth / visible.length
  const candleWidth = Math.max(2, Math.min(7, slotWidth * 0.58))
  const toY = (value: number) => CHART_PADDING_Y + (max - value) / range * innerHeight

  return {
    min,
    max,
    firstDate: visible[0]?.date ?? '',
    lastDate: visible.at(-1)?.date ?? '',
    candles: visible.map((kline, index) => {
      const center = CHART_PADDING_X + slotWidth * (index + 0.5)
      const open = toY(kline.open)
      const close = toY(kline.close)

      return {
        key: kline.date,
        x: center,
        bodyX: center - candleWidth / 2,
        bodyY: Math.min(open, close),
        bodyHeight: Math.max(1, Math.abs(close - open)),
        highY: toY(kline.high),
        lowY: toY(kline.low),
        width: candleWidth,
        rising: kline.close >= kline.open,
      }
    }),
  }
}
</script>

<template>
  <main
    class="stock-panel"
    :class="{ 'is-dimmed': isDimmed }"
    :style="{ '--dimmed-opacity': watchlistStore.panel.dimmedOpacity / 100 }"
    @pointerdown="resetIdleFade"
    @pointerenter="resetIdleFade"
    @pointermove.passive="resetIdleFade"
    @wheel.passive="resetIdleFade"
  >
    <header
      class="panel-bar"
      data-tauri-drag-region
      @pointercancel="handleDragPointerEnd"
      @pointerdown="handleDragPointerDown"
      @pointermove="handleDragPointerMove"
      @pointerup="handleDragPointerEnd"
    >
      <nav
        aria-label="行情分组"
        class="group-tabs"
        role="tablist"
      >
        <button
          v-for="group in watchlistStore.groups"
          :key="group.id"
          :aria-selected="activeGroup?.id === group.id"
          class="group-tab"
          :class="{ active: activeGroup?.id === group.id }"
          role="tab"
          type="button"
          @click.stop="selectGroup(group.id)"
          @pointerdown.stop
        >
          {{ group.name }}
        </button>
      </nav>

      <button
        :aria-pressed="isPinned"
        class="pin-button"
        :class="{ active: isPinned }"
        title="常驻浮窗"
        type="button"
        @click.stop="togglePinned"
        @pointerdown.stop
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
        >
          <path d="M9 3h6l-1 6 3 3v2h-4v7l-1 1-1-1v-7H7v-2l3-3-1-6Z" />
        </svg>
      </button>

      <button
        aria-label="刷新行情"
        class="refresh-button"
        :disabled="loading"
        title="刷新行情"
        type="button"
        @click.stop="refreshQuotes"
        @pointerdown.stop
      >
        {{ loading ? '…' : '↻' }}
      </button>
    </header>

    <section
      v-if="selectedQuote"
      class="detail-view"
      @click.stop
      @pointerdown="resetIdleFade"
      @pointerenter="resetIdleFade"
      @wheel.passive="resetIdleFade"
    >
      <header
        class="detail-header"
        data-tauri-drag-region
        @pointercancel="handleDragPointerEnd"
        @pointerdown="handleDragPointerDown"
        @pointermove="handleDragPointerMove"
        @pointerup="handleDragPointerEnd"
      >
        <button
          aria-label="返回自选列表"
          class="detail-back"
          type="button"
          @click.stop="closeDetail"
          @pointerdown.stop
        >
          ‹
        </button>
        <div class="detail-title">
          <strong>{{ selectedQuote.name }}</strong>
          <span>{{ selectedQuote.code }}<template v-if="detailLastTimestamp"> · {{ detailLastTimestamp }}</template></span>
        </div>
        <button
          aria-label="刷新详细行情"
          class="detail-refresh"
          :disabled="detailLoading"
          title="刷新详细行情"
          type="button"
          @click.stop="reloadDetail"
          @pointerdown.stop
        >
          {{ detailLoading ? '…' : '↻' }}
        </button>
      </header>

      <nav
        aria-label="详细行情周期"
        class="detail-tabs"
        role="tablist"
      >
        <button
          v-for="tab in detailTabs"
          :key="tab.mode"
          :aria-selected="detailMode === tab.mode"
          class="detail-tab"
          :class="{ active: detailMode === tab.mode }"
          role="tab"
          type="button"
          @click.stop="selectDetailMode(tab.mode)"
          @pointerdown.stop
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="detail-summary">
        <strong>{{ formatPrice(detailPrice) }}</strong>
        <span :class="quoteClass(selectedQuote)">{{ formatPercent(detailPercent) }}</span>
        <small>{{ detailTabLabel }}</small>
      </div>

      <div
        v-if="detailLoading && !detailReady"
        class="detail-status"
      >
        正在加载详细行情…
      </div>
      <div
        v-else-if="detailError && !detailReady"
        class="detail-status error"
      >
        {{ detailError }}
        <button
          type="button"
          @click.stop="reloadDetail"
          @pointerdown.stop
        >
          重试
        </button>
      </div>
      <div
        v-else-if="detailMode !== 'day-k' && detailChart"
        class="chart-box"
        @pointerleave="clearChartHover"
        @pointermove="handleChartPointerMove"
      >
        <svg
          aria-label="分时价格走势"
          class="price-chart"
          preserveAspectRatio="none"
          role="img"
          :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
        >
          <line
            class="chart-grid"
            :x1="CHART_PADDING_X"
            :x2="CHART_WIDTH - CHART_PADDING_X"
            :y1="CHART_HEIGHT / 2"
            :y2="CHART_HEIGHT / 2"
          />
          <line
            v-if="detailMode === 'intraday' && detailChart.sessionDividerX !== undefined"
            class="chart-session-divider"
            :x1="detailChart.sessionDividerX"
            :x2="detailChart.sessionDividerX"
            :y1="CHART_PADDING_Y"
            :y2="CHART_HEIGHT - CHART_PADDING_Y"
          />
          <path
            class="average-line"
            :d="detailChart.averagePath"
          />
          <path
            class="close-line"
            :d="detailChart.closePath"
            :stroke="detailPercent >= 0 ? '#dc5146' : '#39a56e'"
          />
        </svg>
        <div class="chart-labels">
          <span>{{ formatChartPrice(detailChart.max) }}</span>
          <span>{{ formatChartPrice(detailChart.min) }}</span>
        </div>
        <div
          v-if="detailMode === 'intraday'"
          class="trend-time-axis"
        >
          <span
            v-for="timeLabel in detailChart.timeLabels"
            :key="timeLabel.label"
            class="axis-label"
            :class="`align-${timeLabel.align}`"
            :style="{ left: `${timeLabel.x / CHART_WIDTH * 100}%` }"
          >
            {{ timeLabel.label }}
          </span>
        </div>
        <div
          v-else
          class="chart-axis"
        >
          <span>{{ formatChartDate(detailChart.firstDate) }}</span>
          <span>{{ formatChartDate(detailChart.lastDate) }}</span>
        </div>
        <div
          v-if="chartHover"
          class="chart-tooltip"
          :class="{ 'align-right': chartHover.alignRight }"
          :style="{ left: `${chartHover.left}px`, top: `${chartHover.top}px` }"
        >
          <strong>{{ chartHover.detail }}</strong>
          <span>{{ chartHover.title }}</span>
        </div>
      </div>
      <div
        v-else-if="detailMode === 'day-k' && klineChart"
        class="chart-box"
        @pointerleave="clearChartHover"
        @pointermove="handleChartPointerMove"
      >
        <svg
          aria-label="日K线"
          class="price-chart"
          preserveAspectRatio="none"
          role="img"
          :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
        >
          <line
            class="chart-grid"
            :x1="CHART_PADDING_X"
            :x2="CHART_WIDTH - CHART_PADDING_X"
            :y1="CHART_HEIGHT / 2"
            :y2="CHART_HEIGHT / 2"
          />
          <g
            v-for="candle in klineChart.candles"
            :key="candle.key"
          >
            <line
              class="candle-wick"
              :class="{ rising: candle.rising }"
              :x1="candle.x"
              :x2="candle.x"
              :y1="candle.highY"
              :y2="candle.lowY"
            />
            <rect
              class="candle-body"
              :class="{ rising: candle.rising }"
              :height="candle.bodyHeight"
              :width="candle.width"
              :x="candle.bodyX"
              :y="candle.bodyY"
            />
          </g>
        </svg>
        <div class="chart-labels">
          <span>{{ formatChartPrice(klineChart.max) }}</span>
          <span>{{ formatChartPrice(klineChart.min) }}</span>
        </div>
        <div class="chart-axis">
          <span>{{ formatChartDate(klineChart.firstDate) }}</span>
          <span>{{ formatChartDate(klineChart.lastDate) }}</span>
        </div>
        <div
          v-if="chartHover"
          class="chart-tooltip"
          :class="{ 'align-right': chartHover.alignRight }"
          :style="{ left: `${chartHover.left}px`, top: `${chartHover.top}px` }"
        >
          <strong>{{ chartHover.detail }}</strong>
          <span>{{ chartHover.title }}</span>
        </div>
      </div>
      <div
        v-else
        class="detail-status"
      >
        暂无{{ detailTabLabel }}数据
      </div>
    </section>

    <section
      v-else-if="watchlistStore.totalCodes === 0"
      class="empty-state"
    >
      还没有自选股
      <span>请在偏好设置 → 行情中添加。</span>
    </section>

    <section
      v-else-if="!activeGroup?.codes.length"
      class="empty-state"
    >
      {{ activeGroup?.name }}暂无股票
      <span>可在偏好设置中添加到这个分组。</span>
    </section>

    <section
      v-else
      aria-live="polite"
      class="quote-list"
    >
      <button
        v-for="quote in displayQuotes"
        :key="quote.code"
        class="quote-row"
        :disabled="quote.name === '等待行情'"
        type="button"
        @click.stop="openDetail(quote)"
        @pointerdown.stop
      >
        <div class="quote-name">
          <strong>{{ quote.name === '---' ? '未找到' : quote.name }}</strong>
          <span>{{ quote.code }}</span>
        </div>
        <div class="quote-price">
          <strong>{{ formatPrice(quote.now) }}</strong>
          <span :class="quoteClass(quote)">{{ formatPercent(quote.percent) }}</span>
        </div>
      </button>
    </section>
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
  background-color: transparent !important;
}

.stock-panel {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  flex-direction: column;
  padding: 6px;
  overflow: hidden;
  border: 1px solid rgb(68 61 62 / 14%);
  border-radius: 14px;
  background: rgb(255 250 243 / 97%);
  clip-path: inset(0 round 14px);
  color: #443d3e;
  font-family: var(--font-ui);
  opacity: 1;
  transition: opacity 500ms ease;
}

.stock-panel.is-dimmed {
  opacity: var(--dimmed-opacity);
}

.detail-view {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  padding: 1px 1px 0;
  overflow: hidden;
}

.detail-header {
  display: flex;
  min-height: 23px;
  flex: none;
  align-items: center;
  gap: 3px;
  cursor: grab;
}

.detail-header:active {
  cursor: grabbing;
}

.detail-back,
.detail-refresh {
  display: grid;
  width: 22px;
  height: 21px;
  flex: none;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: rgb(68 61 62 / 9%);
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  line-height: 1;
}

.detail-back {
  padding-bottom: 2px;
  font-size: 19px;
}

.detail-refresh {
  font-size: 13px;
}

.detail-refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

.detail-title {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0;
}

.detail-title strong {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-title span {
  overflow: hidden;
  color: #8d8182;
  font-size: 8px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-tabs {
  display: flex;
  min-height: 21px;
  flex: none;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: rgb(68 61 62 / 7%);
}

.detail-tab {
  flex: 1;
  padding: 3px 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #817576;
  cursor: pointer;
  font: inherit;
  font-size: 9px;
  line-height: 1.05;
}

.detail-tab.active {
  background: #443d3e;
  color: #fffaf3;
  font-weight: 650;
}

.detail-summary {
  display: flex;
  min-height: 17px;
  flex: none;
  align-items: baseline;
  gap: 5px;
  padding: 0 2px;
}

.detail-summary strong {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.detail-summary span {
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.detail-summary small {
  margin-left: auto;
  color: #9a8e8f;
  font-size: 8px;
}

.detail-status {
  display: grid;
  min-height: 0;
  flex: 1;
  place-content: center;
  gap: 5px;
  color: #817576;
  font-size: 10px;
  text-align: center;
}

.detail-status.error {
  color: #b85d55;
}

.detail-status button {
  justify-self: center;
  padding: 3px 8px;
  border: 0;
  border-radius: 5px;
  background: rgb(68 61 62 / 10%);
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  font-size: 9px;
}

.chart-box {
  position: relative;
  min-height: 0;
  flex: 1;
  padding: 1px 0 13px;
}

.price-chart {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 48px;
  overflow: visible;
}

.chart-grid {
  stroke: rgb(68 61 62 / 12%);
  stroke-dasharray: 2 3;
  stroke-width: 0.7;
}

.chart-session-divider {
  stroke: rgb(68 61 62 / 18%);
  stroke-dasharray: 1.5 2.5;
  stroke-width: 0.7;
}

.close-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.average-line {
  fill: none;
  stroke: rgb(132 117 118 / 65%);
  stroke-dasharray: 2 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 0.8;
}

.candle-wick {
  stroke: #39a56e;
  stroke-width: 0.9;
}

.candle-wick.rising {
  stroke: #dc5146;
}

.candle-body {
  fill: #39a56e;
  stroke: #39a56e;
  stroke-width: 0.7;
}

.candle-body.rising {
  fill: #dc5146;
  stroke: #dc5146;
}

.chart-labels {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 0 1px 13px 0;
  color: #9a8e8f;
  font-size: 7px;
  line-height: 1;
  pointer-events: none;
}

.chart-axis {
  position: absolute;
  right: 4px;
  bottom: 0;
  left: 4px;
  display: flex;
  justify-content: space-between;
  color: #9a8e8f;
  font-size: 7px;
  line-height: 1;
  pointer-events: none;
}

.trend-time-axis {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 10px;
  color: #9a8e8f;
  font-size: 7px;
  line-height: 1;
  pointer-events: none;
}

.trend-time-axis .axis-label {
  position: absolute;
  top: 0;
  white-space: nowrap;
}

.trend-time-axis .align-right {
  transform: translateX(-100%);
}

.chart-tooltip {
  position: absolute;
  z-index: 2;
  display: flex;
  max-width: calc(100% - 8px);
  flex-direction: column;
  gap: 2px;
  padding: 3px 5px;
  border: 1px solid rgb(68 61 62 / 12%);
  border-radius: 5px;
  background: rgb(255 250 243 / 96%);
  box-shadow: 0 2px 7px rgb(68 61 62 / 12%);
  color: #443d3e;
  pointer-events: none;
  transform: translateY(-100%);
  white-space: nowrap;
}

.chart-tooltip.align-right {
  transform: translate(-100%, -100%);
}

.chart-tooltip strong {
  overflow: hidden;
  font-size: 8px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  text-overflow: ellipsis;
}

.chart-tooltip span {
  color: #8d8182;
  font-size: 7px;
  line-height: 1.1;
}

.panel-bar {
  display: flex;
  min-height: 29px;
  flex: none;
  align-items: center;
  gap: 3px;
  border-bottom: 1px solid rgb(68 61 62 / 9%);
  cursor: grab;
}

.panel-bar:active {
  cursor: grabbing;
}

.group-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 2px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.group-tabs::-webkit-scrollbar {
  display: none;
}

.group-tab {
  flex: none;
  padding: 4px 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #817576;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  line-height: 1.1;
  white-space: nowrap;
}

.group-tab.active {
  background: #443d3e;
  color: #fffaf3;
  font-weight: 650;
}

.pin-button,
.refresh-button {
  display: grid;
  width: 24px;
  height: 22px;
  flex: none;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: rgb(68 61 62 / 9%);
  color: #443d3e;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}

.pin-button svg {
  width: 13px;
  height: 13px;
  fill: currentcolor;
}

.pin-button.active {
  background: #443d3e;
  color: #fffaf3;
}

.refresh-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.quote-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-height: 0;
  flex: 1;
  align-content: start;
  gap: 3px;
  margin-top: 4px;
  padding-right: 1px;
  overflow-x: hidden;
  overflow-y: auto;
}

.quote-list::-webkit-scrollbar {
  width: 4px;
}

.quote-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgb(68 61 62 / 18%);
}

.quote-row {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  padding: 2px 5px;
  border: 1px solid rgb(68 61 62 / 8%);
  border-radius: 7px;
  background: rgb(255 255 255 / 58%);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.quote-row:hover:not(:disabled) {
  background: rgb(255 255 255 / 86%);
}

.quote-row:disabled {
  cursor: default;
}

.quote-name,
.quote-price {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.quote-name {
  min-width: 0;
}

.quote-name strong {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quote-name span {
  color: #8d8182;
  font-size: 8.5px;
  line-height: 1.2;
}

.quote-price {
  align-items: flex-end;
  margin-left: 2px;
}

.quote-price strong {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.quote-price span {
  font-size: 8.5px;
  line-height: 1.2;
}

.empty-state {
  display: grid;
  flex: 1;
  place-content: center;
  gap: 4px;
  color: #655b5c;
  font-size: 12px;
  text-align: center;
}

.empty-state span {
  color: #938788;
  font-size: 10px;
}

.up {
  color: #dc5146;
}

.down {
  color: #39a56e;
}

.flat {
  color: #817576;
}
</style>
