import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isNil } from 'es-toolkit'
import { onMounted, ref } from 'vue'

import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { inBetween } from '@/utils/is'
import { isMac } from '@/utils/platform'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { useTauriListen } from './useTauriListen'

interface MouseButtonEvent {
  kind: 'MousePress' | 'MouseRelease'
  value: string
}

export interface CursorPoint {
  x: number
  y: number
}

interface MouseMoveEvent {
  kind: 'MouseMove'
  value: CursorPoint
}

interface KeyboardEvent {
  kind: 'KeyboardPress' | 'KeyboardRelease'
  value: string
}

type DeviceEvent = MouseButtonEvent | MouseMoveEvent | KeyboardEvent

const appWindow = getCurrentWebviewWindow()

const keyAliases: Record<string, string> = {
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
}

function normalizeKey(value: string) {
  return keyAliases[value] ?? value
}

export function useDevice() {
  const appStore = useAppStore()
  const catStore = useCatStore()
  const scaleFactor = ref(1)
  const mouseLeftDown = ref(false)
  const mouseRightDown = ref(false)
  const pressedKeys = ref<string[]>([])

  onMounted(async () => {
    scaleFactor.value = isMac ? await appWindow.scaleFactor() : 1

    appWindow.onScaleChanged(({ payload }) => {
      if (!isMac) return

      scaleFactor.value = payload.scaleFactor
    })
  })

  const startListening = () => {
    invoke(INVOKE_KEY.START_DEVICE_LISTENING)
  }

  const onHideOnHover = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasInWindow = false

    return (x: number, y: number) => {
      const { x: winX, y: winY, width, height } = appStore.windowState[WINDOW_LABEL.MAIN] ?? {}

      if (isNil(winX) || isNil(winY) || isNil(width) || isNil(height)) return

      const isInWindow = inBetween(x, winX, winX + width)
        && inBetween(y, winY, winY + height)

      if (isInWindow === wasInWindow) return

      if (timer) {
        clearTimeout(timer)
        timer = void 0
      }

      if (isInWindow) {
        timer = setTimeout(() => {
          document.body.style.setProperty('opacity', '0')
          appWindow.setIgnoreCursorEvents(true)
        }, catStore.window.hideOnHoverDelay * 1000)
      } else {
        document.body.style.setProperty('opacity', 'unset')
        appWindow.setIgnoreCursorEvents(catStore.window.passThrough)
      }

      wasInWindow = isInWindow
    }
  })()

  useTauriListen<DeviceEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
    if (payload.kind === 'MousePress' || payload.kind === 'MouseRelease') {
      const pressed = payload.kind === 'MousePress'

      if (payload.value === 'Left') mouseLeftDown.value = pressed
      if (payload.value === 'Right') mouseRightDown.value = pressed
    }

    if (payload.kind === 'KeyboardPress') {
      const key = normalizeKey(payload.value)
      if (!pressedKeys.value.includes(key)) pressedKeys.value.push(key)
    }

    if (payload.kind === 'KeyboardRelease') {
      const key = normalizeKey(payload.value)
      pressedKeys.value = pressedKeys.value.filter(value => value !== key)
    }

    if (payload.kind === 'KeyboardPress' || payload.kind === 'MousePress') {
      catStore.interactionCount += 1
      return
    }

    if (payload.kind !== 'MouseMove' || !catStore.window.hideOnHover) return

    onHideOnHover(
      payload.value.x * scaleFactor.value,
      payload.value.y * scaleFactor.value,
    )
  })

  return {
    startListening,
    mouseLeftDown,
    mouseRightDown,
    pressedKeys,
  }
}
