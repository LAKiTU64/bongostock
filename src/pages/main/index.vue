<script setup lang="ts">
import { LogicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import CompactCat from '@/components/CompactCat.vue'
import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { toggleStockPanel } from '@/composables/useStockPanel'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useSkinStore } from '@/stores/skin'
import { isWindows } from '@/utils/platform'

const { mouseLeftDown, mouseRightDown, pressedKeys, startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const generalStore = useGeneralStore()
const skinStore = useSkinStore()
const leftPulse = ref(false)
const rightPulse = ref(false)
const phase1Controller = new AbortController()
const COMPACT_CONTENT_WIDTH = 150
const BUILTIN_CONTENT_WIDTH = 180
const COMPACT_LEFT_GUTTER = 6
const COMPACT_VISIBLE_HEIGHT = 106
const BUILTIN_VISIBLE_HEIGHT = 137
const displayScaleFactor = ref(globalThis.devicePixelRatio)
const compactScale = computed(() => catStore.window.scale / 100)
const selectedSkin = computed(() => skinStore.resolveId(catStore.skin))
const importedSkin = computed(() => skinStore.find(selectedSkin.value))
const builtinSkin = computed(() => skinStore.findBuiltin(selectedSkin.value))
const compactContentWidth = computed(() => builtinSkin.value ? BUILTIN_CONTENT_WIDTH : COMPACT_CONTENT_WIDTH)
const compactContentHeight = computed(() => builtinSkin.value ? BUILTIN_VISIBLE_HEIGHT : COMPACT_VISIBLE_HEIGHT)
const compactPetStyle = computed(() => ({
  '--pet-scale': compactScale.value,
  'left': `${COMPACT_LEFT_GUTTER * compactScale.value / displayScaleFactor.value}px`,
  'top': '0px',
  'width': `${compactContentWidth.value * compactScale.value / displayScaleFactor.value}px`,
  'height': `${compactContentHeight.value * compactScale.value / displayScaleFactor.value}px`,
}))
let leftPulseTimer: ReturnType<typeof setTimeout> | undefined
let rightPulseTimer: ReturnType<typeof setTimeout> | undefined
let pointerStart: { x: number, y: number } | undefined
let isDragging = false
let contextMenuOpen = false
let panelFocusTimer: ReturnType<typeof setTimeout> | undefined
let unlistenMainFocus: (() => void) | undefined
const panelPinned = ref(false)

const DRAG_THRESHOLD = 5

onMounted(startListening)

onMounted(async () => {
  if (!import.meta.env.DEV || import.meta.env.VITE_MARKET_POC !== 'true') return

  try {
    const { runPhase1PocFromEnv } = await import('@/market/phase1Poc')
    await runPhase1PocFromEnv(phase1Controller.signal)
  } catch (error) {
    // This guard keeps an unexpected PoC failure outside the desktop-pet lifecycle.
    globalThis.console.error('[Phase 1] unexpected PoC failure', error)
  }
})

onUnmounted(() => {
  clearTimeout(leftPulseTimer)
  clearTimeout(rightPulseTimer)
  clearTimeout(panelFocusTimer)
  unlistenMainFocus?.()
  phase1Controller.abort()
})

onMounted(async () => {
  await setCompactWindowSize()
  await appWindow.onScaleChanged(async () => {
    displayScaleFactor.value = globalThis.devicePixelRatio
    await setCompactWindowSize()
  })

  unlistenMainFocus = await appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused || contextMenuOpen) return

    scheduleCloseStockPanelIfUnfocused()
  })
})

watch([() => catStore.window.scale, () => catStore.skin], setCompactWindowSize)

useTauriListen<boolean>(LISTEN_KEY.STOCK_PANEL_PIN_CHANGED, ({ payload }) => {
  panelPinned.value = payload
})

watch(() => catStore.interactionCount, (count) => {
  const useLeftPaw = count % 2 === 1

  if (useLeftPaw) {
    clearTimeout(leftPulseTimer)
    leftPulse.value = true
    leftPulseTimer = setTimeout(() => leftPulse.value = false, 90)
    return
  }

  clearTimeout(rightPulseTimer)
  rightPulse.value = true
  rightPulseTimer = setTimeout(() => rightPulse.value = false, 90)
})

watch(() => catStore.window.visible, async (value) => {
  if (value) {
    showWindow()
    return
  }

  hideWindow()
  hideWindow(WINDOW_LABEL.STOCK_PANEL)
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return

  pointerStart = { x: event.screenX, y: event.screenY }
  isDragging = false
}

function handlePointerMove(event: PointerEvent) {
  if (!pointerStart || isDragging || (event.buttons & 1) === 0) return

  const distance = Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y)

  if (distance < DRAG_THRESHOLD) return

  isDragging = true
  pointerStart = undefined
  void appWindow.startDragging()
}

function handlePointerEnd() {
  pointerStart = undefined
}

function handlePetClick() {
  if (isDragging) {
    isDragging = false
    return
  }

  void toggleStockPanel()
}

async function setCompactWindowSize() {
  displayScaleFactor.value = globalThis.devicePixelRatio

  await appWindow.setSize(new LogicalSize({
    width: (compactContentWidth.value + COMPACT_LEFT_GUTTER) * compactScale.value / displayScaleFactor.value,
    height: (compactContentHeight.value + 1) * compactScale.value / displayScaleFactor.value,
  }))
}

function scheduleCloseStockPanelIfUnfocused() {
  clearTimeout(panelFocusTimer)
  panelFocusTimer = setTimeout(() => void closeStockPanelIfUnfocused(), 80)
}

async function closeStockPanelIfUnfocused() {
  if (contextMenuOpen || panelPinned.value) return

  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)

  if (!panel || !await panel.isVisible()) return

  const [mainFocused, panelFocused] = await Promise.all([
    appWindow.isFocused(),
    panel.isFocused(),
  ])

  if (!mainFocused && !panelFocused && !panelPinned.value) {
    await hideWindow(WINDOW_LABEL.STOCK_PANEL)
  }
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu(),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  contextMenuOpen = true

  try {
    await menu.popup()
  } finally {
    contextMenuOpen = false
    scheduleCloseStockPanelIfUnfocused()
  }

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}
</script>

<template>
  <div
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :style="{
      opacity: catStore.window.opacity / 100,
      borderRadius: `${catStore.window.radius}%`,
    }"
    @click.stop="handlePetClick"
    @contextmenu="handleContextmenu"
    @pointercancel="handlePointerEnd"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerEnd"
  >
    <CompactCat
      :count="catStore.interactionCount"
      :imported-skin="importedSkin"
      :left-paw-down="leftPulse"
      :mouse-left-down="mouseLeftDown"
      :mouse-right-down="mouseRightDown"
      :pressed-keys="pressedKeys"
      :right-paw-down="rightPulse"
      :skin="selectedSkin"
      :style="compactPetStyle"
      @menu="handleContextmenu"
    />
  </div>
</template>
