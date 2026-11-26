<script setup lang="ts">
import { LANGUAGE } from '@/constants'
import SettingsSelect from '@/pages/preference/components/SettingsSelect.vue'
import { useGeneralStore } from '@/stores/general'

const generalStore = useGeneralStore()
const options = [
  { label: '简体中文', value: LANGUAGE.ZH_CN },
  { label: '繁體中文', value: LANGUAGE.ZH_TW },
  { label: 'English', value: LANGUAGE.EN_US },
  { label: 'Tiếng Việt', value: LANGUAGE.VI_VN },
  { label: 'Português', value: LANGUAGE.PT_BR },
]
</script>

<template>
  <div class="settings-row">
    <label for="settings-language">{{ $t('pages.preference.general.labels.language') }}</label>
    <SettingsSelect
      id="settings-language"
      v-model="generalStore.appearance.language"
      :label="$t('pages.preference.general.labels.language')"
      :options="options"
    />
  </div>
</template>
