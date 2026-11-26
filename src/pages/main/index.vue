<script setup lang="ts">
import { LogicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import CompactCat from '@/components/CompactCat.vue'
import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { closeStockPanel, toggleStockPanel } from '@/composables/useStockPanel'
import { useTauriListen } from '@/composables/useTauriListen'
import { useTray } from '@/composables/useTray'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { installWindowRecovery, recoveringWindows, reportWindowRecoveryError } from '@/plugins/windowRecovery'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useSkinStore } from '@/stores/skin'
import { compactPetLayout } from '@/utils/petLayout'
import { isMac, isWindows } from '@/utils/platform'
import { ensureWindowOnScreen, windowPositionQueue } from '@/utils/windowPlacement'

const { mouseLeftDown, mouseRightDown, pressedKeys, startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
useTray()
const generalStore = useGeneralStore()
const skinStore = useSkinStore()
const leftPulse = ref(false)
const rightPulse = ref(false)
const displayScaleFactor = ref(globalThis.devicePixelRatio)
const selectedSkin = computed(() => skinStore.resolveId(catStore.skin))
const importedSkin = computed(() => skinStore.find(selectedSkin.value))
const builtinSkin = computed(() => skinStore.findBuiltin(selectedSkin.value))
const layout = computed(() => compactPetLayout(Boolean(builtinSkin.value), catStore.window.scale, isMac ? 1 : displayScaleFactor.value))
const compactPetStyle = computed(() => ({
  '--pet-scale': layout.value.scale,
  '--pet-radius': `${catStore.window.radius}%`,
  '--counter-font-size': `${(isMac ? 13 : 11) * layout.value.scale}px`,
  'left': `${layout.value.left}px`,
  'top': '0px',
  'width': `${layout.value.width}px`,
  'height': `${layout.value.height}px`,
}))
let leftPulseTimer: ReturnType<typeof setTimeout> | undefined
let rightPulseTimer: ReturnType<typeof setTimeout> | undefined
let pointerStart: { x: number, y: number } | undefined
let isDragging = false
let dragResetTimer: ReturnType<typeof setTimeout> | undefined
let contextMenuOpen = false
let panelFocusTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const listeners: (() => void)[] = []
function keepListener(unlisten: () => void) {
  if (disposed) unlisten()
  else listeners.push(unlisten)
  return !disposed
}
const panelPinned = ref(false)

const DRAG_THRESHOLD = 5

onMounted(startListening)

onUnmounted(() => {
  disposed = true
  clearTimeout(leftPulseTimer)
  clearTimeout(rightPulseTimer)
  clearTimeout(panelFocusTimer)
  clearTimeout(dragResetTimer)
  listeners.forEach(unlisten => unlisten())
})

onMounted(async () => {
  if (!keepListener(await installWindowRecovery())) return
  const unlistenScale = await appWindow.onScaleChanged(async ({ payload }) => {
    if (disposed) return
    displayScaleFactor.value = isMac ? payload.scaleFactor : globalThis.devicePixelRatio
    await setCompactWindowSize()
  })
  if (!keepListener(unlistenScale)) return

  keepListener(await appWindow.onFocusChanged(({ payload: focused }) => {
    if (!disposed && !focused && !contextMenuOpen) scheduleCloseStockPanelIfUnfocused()
  }))
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
    if (recoveringWindows.value) return
    showWindow()
    return
  }

  hideWindow()
  void closeStockPanel('discard')
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return

  clearTimeout(dragResetTimer)
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

  // startDragging() can make Windows swallow the synthetic click that would
  // normally clear this flag. Keep it through the current event turn so a
  // real post-drag click is still suppressed, then release it automatically.
  if (isDragging) dragResetTimer = setTimeout(() => isDragging = false, 0)
}

function handlePetClick() {
  if (isDragging) {
    isDragging = false
    return
  }

  void toggleStockPanel()
}

async function setCompactWindowSize() {
  const forceSafePosition = recoveringWindows.value
  await windowPositionQueue(async () => {
    if (disposed) return
    if (!isMac) displayScaleFactor.value = globalThis.devicePixelRatio

    await appWindow.setSize(new LogicalSize({
      width: layout.value.windowWidth,
      height: layout.value.windowHeight,
    }))
    if (!disposed && (forceSafePosition || catStore.window.keepInScreen)) await ensureWindowOnScreen(appWindow)
  }).catch(reportWindowRecoveryError)
}

function scheduleCloseStockPanelIfUnfocused() {
  clearTimeout(panelFocusTimer)
  panelFocusTimer = setTimeout(() => void closeStockPanelIfUnfocused(), 80)
}

async function closeStockPanelIfUnfocused() {
  if (contextMenuOpen || recoveringWindows.value || panelPinned.value) return

  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)

  if (!panel || !await panel.isVisible()) return

  const [mainFocused, panelFocused] = await Promise.all([
    appWindow.isFocused(),
    panel.isFocused(),
  ])

  if (!mainFocused && !panelFocused && !panelPinned.value) {
    await closeStockPanel('retain')
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
