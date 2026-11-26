import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from '@tauri-apps/plugin-dialog'
import { error as logError } from '@tauri-apps/plugin-log'
import { ref } from 'vue'

import type { Rect } from '@/utils/windowGeometry'

import { WINDOW_LABEL } from '@/constants'
import { i18n } from '@/locales/i18n'
import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { placePair } from '@/utils/windowGeometry'
import { coordinateSpace, ensureWindowOnScreen, placeWindow, readWindowRect, recoveryScreen, saveWindowRect, windowPositionQueue } from '@/utils/windowPlacement'
import { recoverWindowPlacement } from '@/utils/windowRecoveryFlow'

import { showWindow } from './window'

const RECOVER_EVENT = 'recover-desktop-windows'
const PANEL_REQUEST = 'recover-panel-request'
const PANEL_REPLY = 'recover-panel-reply'
const COMMAND = 'plugin:custom-window|'
export const recoveringWindows = ref(false)
export const recoveringPanel = ref(false)
let reportingError = false

export async function reportWindowRecoveryError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error)
  await logError(`[window recovery] ${detail}`)
  if (reportingError) return
  reportingError = true
  try {
    await message(`${i18n.global.t('composables.useAppMenu.labels.recoveryFailed')}\n${detail}`, { kind: 'error' })
  } finally {
    reportingError = false
  }
}

export async function requestWindowRecovery() {
  try {
    await invoke(`${COMMAND}request_window_recovery`)
  } catch (error) {
    await reportWindowRecoveryError(error)
  }
}

interface PanelRequest {
  id: string
  phase: 'prepare' | 'finish' | 'cancel'
  target?: Rect
  area?: Rect
}
interface PanelReply { id: string, visible?: boolean, error?: string }

async function callPanel(phase: PanelRequest['phase'], target?: Rect, area?: Rect): Promise<PanelReply> {
  const id = crypto.randomUUID()
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setInterval> | undefined
  let resolve!: (reply: PanelReply) => void
  let reject!: (error: Error) => void
  const result = new Promise<PanelReply>((yes, no) => {
    resolve = yes
    reject = no
  })
  const unlisten = await listen<PanelReply>(PANEL_REPLY, ({ payload }) => {
    if (payload.id !== id) return
    if (payload.error) reject(new Error(payload.error))
    else resolve(payload)
  })
  const send = () => emitTo(WINDOW_LABEL.STOCK_PANEL, PANEL_REQUEST, { id, phase, target, area }).catch(error => reject(new Error(String(error))))
  try {
    // A just-created webview may still be mounting. Retry one id; the receiver
    // deduplicates it, so neither show nor positioning can execute twice.
    timer = setTimeout(() => reject(new Error('Stock panel did not acknowledge window recovery')), 5000)
    retry = setInterval(() => void send(), 200)
    void send()
    return await result
  } finally {
    clearTimeout(timer)
    clearInterval(retry)
    unlisten()
  }
}

/** Called after the panel's normal show listener has been installed. */
export async function installPanelRecovery() {
  const replies = new Map<string, Promise<PanelReply>>()
  let wasVisible = false
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  const unlisten = await listen<PanelRequest>(PANEL_REQUEST, async ({ payload }) => {
    let reply = replies.get(payload.id)
    if (!reply) {
      reply = windowPositionQueue(async (): Promise<PanelReply> => {
        const panel = WebviewWindow.getCurrent()
        try {
          if (payload.phase === 'prepare') {
            recoveringPanel.value = true
            clearTimeout(releaseTimer)
            releaseTimer = setTimeout(() => {
              recoveringPanel.value = false
            }, 8000)
            wasVisible = await panel.isVisible()
            if (wasVisible && await panel.isMinimized()) await panel.unminimize()
            return { id: payload.id, visible: wasVisible }
          }
          if (payload.phase === 'finish' && payload.target && payload.area) {
            await recoverWindowPlacement({
              place: (target, area) => placeWindow(panel, target, area),
              // Never dispatch SHOW_WINDOW: it resets mode/pin/retained state.
              show: () => showWindow(),
              verify: async () => {
                await ensureWindowOnScreen(panel)
                if (wasVisible && !await panel.isVisible()) throw new Error('Stock panel could not be shown')
              },
              persist: () => persistWindow(panel),
            }, payload.target, payload.area, wasVisible)
          }
          return { id: payload.id }
        } catch (error) {
          return { id: payload.id, error: String(error) }
        } finally {
          if (payload.phase !== 'prepare') {
            recoveringPanel.value = false
            clearTimeout(releaseTimer)
          }
        }
      })
      replies.set(payload.id, reply)
      if (replies.size > 16) replies.delete(replies.keys().next().value!)
    }
    await emitTo(WINDOW_LABEL.MAIN, PANEL_REPLY, await reply)
  })
  return () => {
    unlisten()
    clearTimeout(releaseTimer)
    recoveringPanel.value = false
  }
}

async function persistWindow(window: WebviewWindow) {
  const state = await saveWindowRect(window)
  if (state) useAppStore().windowState[window.label] = state
}

async function recoverDesktopWindows() {
  const pet = WebviewWindow.getCurrent()
  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)
  recoveringWindows.value = true
  let panelPrepared = false
  let panelFailure: unknown
  try {
    // Serialize against the panel's pending show/resize before touching either
    // window. Its 30-second state retention never restores a stale position.
    let panelState: PanelReply | undefined
    if (panel) {
      panelPrepared = true
      try {
        panelState = await callPanel('prepare')
      } catch (error) {
        // A broken/unresponsive panel must not prevent rescuing the pet.
        panelFailure = error
      }
    }
    const screen = await recoveryScreen()
    await windowPositionQueue(async () => {
      // Windows reports an iconic/offscreen frame while minimized; restore
      // before reading or attempting bounded position verification.
      if (await pet.isMinimized()) await pet.unminimize()
      const petRect = await readWindowRect(pet)
      // Absent panel is only used to reserve space; never create or show it.
      const pair = placePair(petRect, {
        width: 296 * (coordinateSpace === 'macos-logical' ? 1 : screen.scale),
        height: 225 * (coordinateSpace === 'macos-logical' ? 1 : screen.scale),
      }, screen.work)
      await recoverWindowPlacement({
        place: (target, area) => placeWindow(pet, target, area),
        show: async () => {
          // Clear transient hover hiding only; preserve all appearance settings.
          document.body.style.setProperty('opacity', 'unset')
          await pet.setIgnoreCursorEvents(useCatStore().window.passThrough)
          await invoke(`${COMMAND}reveal_recovered_main`)
          useCatStore().window.visible = true
        },
        verify: async () => {
          await ensureWindowOnScreen(pet)
          if (!await pet.isVisible()) throw new Error('Pet window could not be shown')
        },
        persist: () => persistWindow(pet),
      }, pair.pet, screen.work, true)
      if (panelState) {
        await callPanel('finish', pair.panel, screen.work)
        panelPrepared = false
      }
    })
    if (panelFailure) throw panelFailure
  } finally {
    try {
      if (panelPrepared) await callPanel('cancel')
    } finally {
      recoveringWindows.value = false
    }
  }
}

/**
 * Listener first, then consume the native pending bit: Reopen cannot get lost
 * while Vue/stores/skin sizing are still starting. Only the main page calls it.
 */
export async function installWindowRecovery() {
  let draining = false
  let requested = false
  const drain = async () => {
    requested = true
    if (draining) return
    draining = true
    try {
      do {
        requested = false
        while (await invoke<boolean>(`${COMMAND}take_window_recovery_request`)) {
          try {
            await recoverDesktopWindows()
          } catch (error) {
            await reportWindowRecoveryError(error)
          }
        }
      } while (requested)
    } catch (error) {
      await reportWindowRecoveryError(error)
    } finally {
      draining = false
    }
  }
  const unlisten = await listen(RECOVER_EVENT, () => void drain())
  await drain()
  return unlisten
}
