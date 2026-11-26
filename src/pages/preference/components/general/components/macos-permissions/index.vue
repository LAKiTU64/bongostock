<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  checkAccessibilityPermission,
  checkInputMonitoringPermission,
  requestAccessibilityPermission,
  requestInputMonitoringPermission,
} from 'tauri-plugin-macos-permissions-api'
import { onMounted, onUnmounted, ref } from 'vue'

import ProList from '@/components/pro-list/index.vue'
import { INVOKE_KEY } from '@/constants'

import { useGeneralText } from '../../messages'

const text = useGeneralText()
const permissions = ref([
  { key: 'accessibilityPermission', hint: 'access', authorized: undefined as boolean | undefined, check: checkAccessibilityPermission },
  { key: 'inputMonitoringPermission', hint: 'monitor', authorized: undefined as boolean | undefined, check: checkInputMonitoringPermission },
])
const errorMessage = ref('')
let disposed = false
let unlisten: (() => void) | undefined
async function refresh() {
  await Promise.all(permissions.value.map(async (item) => {
    try {
      item.authorized = await item.check()
    } catch (error) {
      errorMessage.value = String(error)
    }
  }))
}
async function authorize(key: string) {
  try {
    if (key === 'inputMonitoringPermission') {
      await invoke(INVOKE_KEY.REQUEST_INPUT_MONITORING_ACCESS)
      await requestInputMonitoringPermission()
    } else {
      await requestAccessibilityPermission()
      await invoke(INVOKE_KEY.OPEN_MACOS_ACCESSIBILITY_SETTINGS)
    }
    errorMessage.value = ''
    await refresh()
  } catch (error) {
    errorMessage.value = String(error)
  }
}
onMounted(async () => {
  void refresh()
  const off = await getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
    if (payload) void refresh()
  })
  if (disposed) off()
  else unlisten = off
})
onUnmounted(() => {
  disposed = true
  unlisten?.()
})
</script>

<template>
  <ProList :title="$t('pages.preference.general.labels.permissionsSettings')">
    <div
      v-for="item in permissions"
      :key="item.key"
      class="settings-row"
    >
      <div>
        <span>{{ $t(`pages.preference.general.labels.${item.key}`) }}</span>
        <p
          v-if="item.authorized === false"
          class="permission-hint"
        >
          {{ text(item.hint) }}
        </p>
      </div>
      <span
        v-if="item.authorized"
        class="permission-status"
      >
        <span
          aria-hidden="true"
          class="i-lucide:check"
        /> {{ $t('pages.preference.general.status.authorized') }}
      </span>
      <button
        v-else-if="item.authorized === false"
        class="settings-button"
        type="button"
        @click="authorize(item.key)"
      >
        {{ $t('pages.preference.general.status.authorize') }}
      </button>
    </div>
    <p
      v-if="errorMessage"
      class="permission-hint"
      role="alert"
    >
      {{ errorMessage }}
    </p>
  </ProList>
</template>

<style scoped>
.permission-hint {
  margin: 3px 0 0;
  color: var(--settings-muted);
  font-size: 12px;
}
.permission-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--settings-accent);
  font-size: 12px;
  white-space: nowrap;
}
</style>
