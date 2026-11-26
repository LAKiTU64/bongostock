<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import { useEventListener } from '@vueuse/core'
import { onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AppShortcutKey } from '@/composables/useAppShortcuts'
import type { HidStatus } from '@/composables/useShortcutHid'

import { appShortcutKeys, SHORTCUT_CAPTURED, SHORTCUT_FAILED, SHORTCUT_RECORDING } from '@/composables/useAppShortcuts'
import { SHORTCUT_HID_RECORDED, SHORTCUT_HID_STATUS } from '@/composables/useShortcutHid'
import { WINDOW_LABEL } from '@/constants'
import { useShortcutStore } from '@/stores/shortcut'
import { findShortcutKey, keys, modifierKeys } from '@/utils/keyboard'
import { isMac } from '@/utils/platform'
import { isPcFunctionAlias, isShortcutHidKey, shortcutAlias, shortcutHidLabel } from '@/utils/shortcutHid'

import { useGeneralText } from '../general/messages'

const text = useGeneralText()
const { t } = useI18n({ useScope: 'global' })
const store = useShortcutStore()
const recording = ref<AppShortcutKey>()
const feedback = ref('')
const hidFeedback = ref('')
let aliasTimer: ReturnType<typeof setTimeout> | undefined
const labels = {
  bossKey: 'pages.preference.shortcut.labels.bossKey',
  visibleCat: 'pet',
  visiblePreference: 'settings',
  penetrable: 'pages.preference.shortcut.labels.passThrough',
  alwaysOnTop: 'pages.preference.shortcut.labels.alwaysOnTop',
}

function label(key: AppShortcutKey) {
  return key === 'visibleCat' || key === 'visiblePreference' ? text(labels[key]) : t(labels[key])
}
function format(value: string) {
  if (isShortcutHidKey(value)) return shortcutHidLabel(value)
  return value.split('+').map(part => keys.find(key => key.tauriKey === part)?.symbol || part).join(' + ')
}
function sameShortcut(a: string, b: string) {
  return a.toLowerCase().split('+').sort().join('+') === b.toLowerCase().split('+').sort().join('+')
}
function endRecording() {
  if (!recording.value) return
  finishRecording(false)
}
function finishRecording(state: false | { captured: string }) {
  clearTimeout(aliasTimer)
  recording.value = undefined
  hidFeedback.value = ''
  void emitTo(WINDOW_LABEL.MAIN, SHORTCUT_RECORDING, state)
}
function beginRecording(key: AppShortcutKey, event: MouseEvent) {
  if (recording.value === key) {
    endRecording()
    return
  }
  // WKWebView on macOS leaves keyboard focus outside a mouse-clicked button.
  const button = event.currentTarget as HTMLButtonElement
  button.focus({ preventScroll: true })
  clearTimeout(aliasTimer)
  feedback.value = ''
  recording.value = key
  void emitTo(WINDOW_LABEL.MAIN, SHORTCUT_RECORDING, true)
}
function commit(value: string) {
  const key = recording.value
  if (!key) return
  finishRecording({ captured: value })
  const canonical = (binding: string) => isMac ? shortcutAlias(binding) : binding
  if (appShortcutKeys.some(other => other !== key && sameShortcut(canonical(store[other]), canonical(value)))) {
    feedback.value = text('conflict')
    return
  }
  feedback.value = ''
  if (!sameShortcut(store[key], value)) store[key] = value
}
function captureShortcut(value: string) {
  if (!recording.value) return
  // Some PC keyboards also produce F13–F15 for Print Screen/Scroll Lock/Pause. Give the
  // raw key event priority, retaining the function key on keyboards without it.
  clearTimeout(aliasTimer)
  if (isMac && isPcFunctionAlias(value)) {
    aliasTimer = setTimeout(() => commit(value), 90)
  } else {
    commit(value)
  }
}
function keyDown(event: KeyboardEvent, key: AppShortcutKey) {
  if (recording.value !== key || event.isComposing) return
  const modified = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
  if (!modified && event.key === 'Tab') {
    endRecording()
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (!modified && event.key === 'Escape') {
    endRecording()
    return
  }
  if (event.repeat) return
  if (isMac && !modified && (isShortcutHidKey(event.code) || isShortcutHidKey(event.key)
    || ['LaunchApplication1', 'LaunchApplication2', 'LaunchMediaPlayer'].includes(event.key))) {
    return
  }
  const standard = findShortcutKey(event)
  if (!standard) {
    if (!modifierKeys.some(item => item.eventKey === event.key.replace('Meta', 'Command'))) {
      feedback.value = text('unavailable')
    }
    return
  }
  const parts = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Command')
  parts.push(standard.tauriKey!)
  captureShortcut(parts.join('+'))
}
function clear(key: AppShortcutKey) {
  endRecording()
  store[key] = ''
  feedback.value = ''
}

useEventListener(window, 'blur', endRecording)
useEventListener(window, 'pagehide', endRecording)
const listeners = [
  listen<string>(SHORTCUT_CAPTURED, ({ payload }) => captureShortcut(payload)),
  listen<string>(SHORTCUT_HID_RECORDED, ({ payload }) => {
    if (isMac && isShortcutHidKey(payload)) captureShortcut(payload)
  }),
  listen<HidStatus>(SHORTCUT_HID_STATUS, ({ payload }) => {
    if (!recording.value) return
    const messages = { permissionDenied: 'hidPermission', noDevice: 'hidNoDevice', unavailable: 'hidUnavailable' } as const
    hidFeedback.value = payload && payload in messages ? text(messages[payload as keyof typeof messages]) : ''
  }),
  listen<AppShortcutKey>(SHORTCUT_FAILED, () => {
    feedback.value = text('unavailable')
  }),
]
onScopeDispose(() => {
  endRecording()
  for (const listener of listeners) void listener.then(off => off())
})
</script>

<template>
  <section
    :aria-label="$t('pages.preference.shortcut.title')"
    class="settings-section"
  >
    <div class="settings-group">
      <div
        v-for="key in appShortcutKeys"
        :key="key"
        class="settings-row"
      >
        <div class="shortcut-label">
          <span>{{ label(key) }}</span>
          <div
            v-if="key === 'bossKey'"
            id="boss-key-description"
            class="settings-row-detail"
          >
            {{ t('pages.preference.shortcut.hints.bossKey') }}
          </div>
        </div>
        <div class="shortcut-controls">
          <button
            :aria-describedby="key === 'bossKey' ? 'boss-key-description' : undefined"
            :aria-label="`${label(key)} · ${text('record')}`"
            :aria-pressed="recording === key"
            class="settings-button shortcut-value"
            :class="{ recording: recording === key }"
            type="button"
            @blur="endRecording"
            @click="beginRecording(key, $event)"
            @keydown="keyDown($event, key)"
            @mousedown.prevent
          >
            {{ recording === key ? text('press') : store[key] ? format(store[key]) : text('unset') }}
          </button>
          <button
            v-if="store[key]"
            :aria-label="`${text('clear')} · ${label(key)}`"
            class="settings-button shortcut-clear"
            type="button"
            @click="clear(key)"
          >
            <span
              aria-hidden="true"
              class="i-lucide:x"
            />
          </button>
        </div>
      </div>
      <p
        v-if="feedback || hidFeedback"
        class="shortcut-feedback"
        role="status"
      >
        {{ feedback || hidFeedback }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.shortcut-label {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.shortcut-label > span {
  white-space: nowrap;
}
.shortcut-label .settings-row-detail {
  margin: 0;
}

.shortcut-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.shortcut-value {
  min-width: 88px;
  font-variant-numeric: tabular-nums;
}
.shortcut-value.recording {
  outline: 2px solid var(--settings-accent);
}
.shortcut-clear {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
}
.shortcut-feedback {
  margin: 0;
  padding: 4px 16px 10px;
  color: var(--settings-danger);
  font-size: 12px;
}
</style>
