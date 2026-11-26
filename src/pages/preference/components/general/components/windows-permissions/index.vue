<script lang="ts">
</script>

<script setup lang="ts">
import { confirm } from '@tauri-apps/plugin-dialog'
import { exit } from '@tauri-apps/plugin-process'
import { Switch } from 'antdv-next'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ProList from '@/components/pro-list/index.vue'
import { isRunningAsAdministrator } from '@/plugins/adminStatus'
import { useGeneralStore } from '@/stores/general'

let promptedThisSession = false

const authorized = ref<boolean>()
const { t } = useI18n()
const store = useGeneralStore()
onMounted(async () => {
  authorized.value = await isRunningAsAdministrator()
  if (authorized.value || promptedThisSession || store.app.suppressAdminPrompt) return
  promptedThisSession = true
  await showGuide()
})
async function showGuide() {
  if (await confirm(t('pages.preference.general.hints.administratorPermissionGuide'), {
    title: t('pages.preference.general.labels.administratorPermission'),
    okLabel: t('pages.preference.general.buttons.exitApp'),
    cancelLabel: t('pages.preference.general.buttons.setLater'),
    kind: 'warning',
  })) {
    await exit(0)
  }
}
</script>

<template>
  <ProList :title="t('pages.preference.general.labels.permissionsSettings')">
    <div class="settings-row">
      <span>{{ t('pages.preference.general.labels.administratorPermission') }}</span>
      <span
        v-if="authorized"
        class="admin-status"
      >{{ t('pages.preference.general.status.adminEnabled') }}</span>
      <button
        v-else-if="authorized === false"
        class="settings-button"
        type="button"
        @click="showGuide"
      >
        {{ t('pages.preference.general.status.viewGuide') }}
      </button>
    </div>
    <div class="settings-row">
      <span id="admin-prompt-label">{{ t('pages.preference.general.labels.suppressAdminPrompt') }}</span>
      <Switch
        v-model:checked="store.app.suppressAdminPrompt"
        aria-labelledby="admin-prompt-label"
      />
    </div>
  </ProList>
</template>

<style scoped>
.admin-status {
  color: var(--settings-accent);
  font-size: 12px;
}
</style>
