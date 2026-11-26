import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { LISTEN_KEY, WINDOW_LABEL } from '../constants'

export type WindowLabel = typeof WINDOW_LABEL[keyof typeof WINDOW_LABEL]

const COMMAND = {
  SHOW_WINDOW: 'plugin:custom-window|show_window',
  SHOW_LABELED_WINDOW: 'plugin:custom-window|show_labeled_window',
  HIDE_WINDOW: 'plugin:custom-window|hide_window',
  HIDE_PANEL_FOR_HOUR: 'plugin:custom-window|hide_panel_for_hour',
  SET_ALWAYS_ON_TOP: 'plugin:custom-window|set_always_on_top',
  SET_TASKBAR_VISIBILITY: 'plugin:custom-window|set_taskbar_visibility',
}

/** Position via windowPlacement before showing; native x/y arguments are physical. */
export function showWindow(label?: WindowLabel) {
  if (label) {
    return invoke(COMMAND.SHOW_LABELED_WINDOW, { label })
  }

  return invoke(COMMAND.SHOW_WINDOW)
}

// The destination survives creation of a preference webview that has not mounted yet.
// Storage events deliver the same request to an already-open preference window.
export const PREFERENCE_DESTINATION = 'bongostock.preference.destination'

export async function openVideoPreferences() {
  localStorage.setItem(PREFERENCE_DESTINATION, 'video')
  try {
    await showWindow(WINDOW_LABEL.PREFERENCE)
  } catch (error) {
    localStorage.removeItem(PREFERENCE_DESTINATION)
    throw error
  }
}

export function hideWindow(label?: WindowLabel) {
  if (label) {
    return emit(LISTEN_KEY.HIDE_WINDOW, label)
  }

  return invoke(COMMAND.HIDE_WINDOW)
}

export function hidePanelForHour() {
  return invoke<void>(COMMAND.HIDE_PANEL_FOR_HOUR)
}

export function setAlwaysOnTop(alwaysOnTop: boolean) {
  invoke(COMMAND.SET_ALWAYS_ON_TOP, { alwaysOnTop })
}

export async function toggleWindowVisible(label?: WindowLabel) {
  const appWindow = getCurrentWebviewWindow()

  if (appWindow.label !== label) return

  const visible = await appWindow.isVisible()

  if (visible) {
    return hideWindow(label)
  }

  return showWindow(label)
}

export async function setTaskbarVisibility(visible: boolean) {
  invoke(COMMAND.SET_TASKBAR_VISIBILITY, { visible })
}
