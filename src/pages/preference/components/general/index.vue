<script setup lang="ts">
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { Switch } from 'antdv-next'
import { nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'

import ProList from '@/components/pro-list/index.vue'
import { useGeneralStore } from '@/stores/general'
import { isMac, isWindows } from '@/utils/platform'

import Shortcuts from '../shortcut/index.vue'
import Language from './components/language/index.vue'
import MacosPermissions from './components/macos-permissions/index.vue'
import WindowsPermissions from './components/windows-permissions/index.vue'
import { useGeneralText } from './messages'

const text = useGeneralText()
const generalStore = useGeneralStore()
const shortcutsOpen = ref(false)
const shortcutLink = useTemplateRef('shortcutLink')
const initialFocus = useTemplateRef('initialFocus')
const startupError = ref('')
const changingStartup = ref(false)

async function changeAutostart(value: boolean) {
  if (changingStartup.value) return
  changingStartup.value = true
  startupError.value = ''
  try {
    if (await isEnabled() !== value) await (value ? enable() : disable())
    generalStore.app.autostart = value
  } catch (error) {
    startupError.value = String(error)
  } finally {
    changingStartup.value = false
  }
}

onMounted(() => changeAutostart(generalStore.app.autostart))

watch(shortcutsOpen, async (open) => {
  await nextTick()
  const target = open ? initialFocus.value : shortcutLink.value
  target?.focus()
})
</script>

<template>
  <template v-if="shortcutsOpen">
    <div class="general-subheading">
      <button
        ref="initialFocus"
        :aria-label="text('back')"
        class="settings-button general-icon"
        type="button"
        @click="shortcutsOpen = false"
      >
        <span
          aria-hidden="true"
          class="i-lucide:arrow-left"
        />
      </button>
      <h2>{{ $t('pages.preference.shortcut.title') }}</h2>
    </div>
    <Shortcuts />
  </template>
  <template v-else>
    <ProList :title="text('app')">
      <div class="settings-row">
        <span id="startup-label">{{ $t('pages.preference.general.labels.launchOnStartup') }}</span>
        <Switch
          aria-labelledby="startup-label"
          :checked="generalStore.app.autostart"
          :disabled="changingStartup"
          @update:checked="changeAutostart"
        />
      </div>
      <p
        v-if="startupError"
        class="general-feedback"
        role="alert"
      >
        {{ startupError }}
      </p>
      <div class="settings-row">
        <span id="taskbar-label">{{ isMac ? text('dock') : $t('pages.preference.general.labels.showTaskbarIcon') }}</span>
        <Switch
          v-model:checked="generalStore.app.taskbarVisible"
          aria-labelledby="taskbar-label"
        />
      </div>
      <div class="settings-row">
        <span id="tray-label">{{ isMac ? text('menuBar') : $t('pages.preference.general.labels.showTrayIcon') }}</span>
        <Switch
          v-model:checked="generalStore.app.trayVisible"
          aria-labelledby="tray-label"
        />
      </div>
      <Language />
      <button
        ref="shortcutLink"
        class="settings-row general-link"
        type="button"
        @click="shortcutsOpen = true"
      >
        {{ $t('pages.preference.shortcut.title') }} <span
          aria-hidden="true"
          class="i-lucide:chevron-right"
        />
      </button>
    </ProList>
    <MacosPermissions v-if="isMac" />
    <WindowsPermissions v-if="isWindows" />
  </template>
</template>

<style scoped>
.general-link {
  width: 100%;
  color: inherit;
  text-align: start;
  cursor: pointer;
  border-inline: 0;
  border-bottom: 0;
  border-radius: 0;
  background: transparent;
}
.general-link:hover {
  background: var(--settings-subtle);
}
.general-link span {
  color: var(--settings-muted);
}
.general-subheading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.general-subheading h2 {
  margin: 0;
  font-size: 16px;
}
.general-icon {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
}
.general-feedback {
  margin: 0;
  padding: 4px 16px;
  color: var(--settings-danger);
  font-size: 12px;
}
</style>
