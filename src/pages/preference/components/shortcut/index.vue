<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import { useEventListener } from '@vueuse/core'
import { onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AppShortcutKey } from '@/composables/useAppShortcuts'

import { appShortcutKeys, SHORTCUT_CAPTURED, SHORTCUT_FAILED, SHORTCUT_RECORDING } from '@/composables/useAppShortcuts'
import { WINDOW_LABEL } from '@/constants'
import { useShortcutStore } from '@/stores/shortcut'
import { keys, standardKeys } from '@/utils/keyboard'

import { useGeneralText } from '../general/messages'

const text = useGeneralText()
const { t } = useI18n({ useScope: 'global' })
const store = useShortcutStore()
const recording = ref<AppShortcutKey>()
const feedback = ref('')
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
  return value.split('+').map(part => keys.find(key => key.tauriKey === part)?.symbol || part).join(' + ')
}
function sameShortcut(a: string, b: string) {
  return a.toLowerCase().split('+').sort().join('+') === b.toLowerCase().split('+').sort().join('+')
}
function endRecording() {
  if (!recording.value) return
  recording.value = undefined
  void emitTo(WINDOW_LABEL.MAIN, SHORTCUT_RECORDING, false)
}
function beginRecording(key: AppShortcutKey) {
  if (recording.value === key) {
    endRecording()
    return
  }
  feedback.value = ''
  recording.value = key
  void emitTo(WINDOW_LABEL.MAIN, SHORTCUT_RECORDING, true)
}
function commit(value: string) {
  const key = recording.value
  if (!key) return
  endRecording()
  if (appShortcutKeys.some(other => other !== key && sameShortcut(store[other], value))) {
    feedback.value = text('conflict')
    return
  }
  if (!sameShortcut(store[key], value)) store[key] = value
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
  const standard = standardKeys.find(item => item.eventKey === event.code)
  if (!standard || (!modified && !/^F\d+$/.test(event.code))) return
  const parts = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Command')
  parts.push(standard.tauriKey!)
  commit(parts.join('+'))
}
function clear(key: AppShortcutKey) {
  endRecording()
  store[key] = ''
  feedback.value = ''
}

useEventListener(window, 'blur', endRecording)
useEventListener(window, 'pagehide', endRecording)
const listeners = [
  listen<string>(SHORTCUT_CAPTURED, ({ payload }) => commit(payload)),
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
            @click="beginRecording(key)"
            @keydown="keyDown($event, key)"
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
        v-if="feedback"
        class="shortcut-feedback"
        role="status"
      >
        {{ feedback }}
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
