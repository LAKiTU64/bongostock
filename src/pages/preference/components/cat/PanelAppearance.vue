<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { InputNumber } from 'antdv-next'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import {
  MAX_DIMMED_OPACITY,
  MAX_FADE_DELAY_SECONDS,
  MAX_STATE_RETENTION_SECONDS,
  MIN_DIMMED_OPACITY,
  MIN_FADE_DELAY_SECONDS,
  MIN_STATE_RETENTION_SECONDS,
  useWatchlistStore,
} from '@/stores/watchlist'

import messages from './messages'
import PercentRange from './PercentRange.vue'

const store = useWatchlistStore()
const { t } = useI18n({ useScope: 'local', messages })
function update(values: Parameters<typeof store.updatePanelSettings>[0]) {
  store.updatePanelSettings(values)
  void emit(LISTEN_KEY.STOCK_PANEL_SETTINGS_CHANGED, { ...store.panel })
}

const dimOpacity = computed({
  get: () => store.panel.dimmedOpacity,
  set: value => update({ dimmedOpacity: value }),
})
</script>

<template>
  <ProList :title="t('panel')">
    <ProListItem :title="t('fadeDelay')">
      <InputNumber
        :aria-label="t('fadeDelay')"
        :max="MAX_FADE_DELAY_SECONDS"
        :min="MIN_FADE_DELAY_SECONDS"
        :precision="0"
        suffix="s"
        :value="store.panel.fadeDelaySeconds"
        @update:value="value => typeof value === 'number' && update({ fadeDelaySeconds: value })"
      />
    </ProListItem>
    <ProListItem :title="t('dimOpacity')">
      <PercentRange
        v-model="dimOpacity"
        :label="t('dimOpacity')"
        :max="MAX_DIMMED_OPACITY"
        :min="MIN_DIMMED_OPACITY"
      />
    </ProListItem>
    <ProListItem :title="t('retention')">
      <InputNumber
        :aria-label="t('retention')"
        :max="MAX_STATE_RETENTION_SECONDS"
        :min="MIN_STATE_RETENTION_SECONDS"
        :precision="0"
        suffix="s"
        :value="store.panel.stateRetentionSeconds"
        @update:value="value => typeof value === 'number' && update({ stateRetentionSeconds: value })"
      />
    </ProListItem>
  </ProList>
</template>
