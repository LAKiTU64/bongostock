<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Theme } from '@/stores/general'

import ProListItem from '@/components/pro-list-item/index.vue'
import SettingsSelect from '@/pages/preference/components/SettingsSelect.vue'
import { useGeneralStore } from '@/stores/general'

const generalStore = useGeneralStore()
const { t } = useI18n()

const options = computed<Array<{ label: string, value: Theme }>>(() => [
  { label: t('pages.preference.general.options.auto'), value: 'auto' },
  { label: t('pages.preference.general.options.lightMode'), value: 'light' },
  { label: t('pages.preference.general.options.darkMode'), value: 'dark' },
])
</script>

<template>
  <ProListItem :title="$t('pages.preference.general.labels.themeMode')">
    <SettingsSelect
      v-model="generalStore.appearance.theme"
      :label="$t('pages.preference.general.labels.themeMode')"
      :options="options"
    />
  </ProListItem>
</template>
