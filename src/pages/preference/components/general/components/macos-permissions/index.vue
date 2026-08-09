<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Space } from 'antdv-next'
import { checkAccessibilityPermission, requestAccessibilityPermission } from 'tauri-plugin-macos-permissions-api'
import { onMounted, onUnmounted, ref } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { INVOKE_KEY } from '@/constants'

const authorized = ref(false)
const appWindow = getCurrentWebviewWindow()
let unlistenFocus: (() => void) | undefined

async function refreshPermission() {
  authorized.value = await checkAccessibilityPermission()
}

async function openAccessibilitySettings() {
  await requestAccessibilityPermission()
  await invoke(INVOKE_KEY.OPEN_MACOS_ACCESSIBILITY_SETTINGS)
}

onMounted(async () => {
  await refreshPermission()
  unlistenFocus = await appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) void refreshPermission()
  })
})

onUnmounted(() => {
  unlistenFocus?.()
})
</script>

<template>
  <ProList
    :title="$t('pages.preference.general.labels.permissionsSettings')"
  >
    <ProListItem
      :description="$t('pages.preference.general.hints.accessibilityPermission')"
      :title="$t('pages.preference.general.labels.accessibilityPermission')"
    >
      <Space
        v-if="authorized"
        class="text-success font-bold"
        :size="4"
      >
        <div class="i-solar:verified-check-bold text-4.5" />

        <span class="whitespace-nowrap">{{ $t('pages.preference.general.status.authorized') }}</span>
      </Space>

      <Space
        v-else
        class="cursor-pointer text-error font-bold"
        :size="4"
        @click="openAccessibilitySettings"
      >
        <div class="i-solar:round-arrow-right-bold text-4.5" />

        <span class="whitespace-nowrap">{{ $t('pages.preference.general.status.authorize') }}</span>
      </Space>
    </ProListItem>
  </ProList>
</template>
