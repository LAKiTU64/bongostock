<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { InputNumber } from 'antdv-next'
import { computed, ref, watch } from 'vue'

import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { commitGatewayToken, forgetGatewayToken, keychainEnabled, tokenStored } from '@/market/gatewayToken'
import { testExternalMarketConnection } from '@/market/marketService'
import { normalizeBaseUrl, useMarketStore } from '@/stores/market'

import { useGeneralText } from '../general/messages'

const text = useGeneralText()
const market = useMarketStore()
const address = ref(market.external.baseUrl)
const timeoutDraft = ref<number | null>(market.external.timeoutMs)
const token = ref('')
const hasToken = computed(() => keychainEnabled ? tokenStored.value : Boolean(market.bearerToken))
const tokenBusy = ref(false)
const testing = ref(false)
const notice = ref('')
const failed = ref(false)
let pendingToken: Promise<boolean> | undefined

watch(() => market.external.baseUrl, value => address.value = value)
watch(() => market.external.timeoutMs, value => timeoutDraft.value = value)
function broadcast() {
  return emit(LISTEN_KEY.MARKET_SETTINGS_CHANGED, market.snapshot())
}
function commitAddress() {
  address.value = normalizeBaseUrl(address.value)
  if (market.external.baseUrl === address.value) return
  market.external.baseUrl = address.value
  void broadcast()
}
function commitTimeout() {
  const timeout = timeoutDraft.value ?? market.external.timeoutMs
  timeoutDraft.value = timeout
  if (market.external.timeoutMs === timeout) return
  market.external.timeoutMs = timeout
  void broadcast()
}
function updateToken(clear = false) {
  if (pendingToken) return pendingToken
  const value = token.value.trim()
  if (!value && !clear) return Promise.resolve(true)
  tokenBusy.value = true
  failed.value = false
  notice.value = ''
  pendingToken = (async () => {
    try {
      if (clear) await forgetGatewayToken()
      else await commitGatewayToken(value)
      token.value = ''
      await broadcast()
      notice.value = text(clear ? 'removed' : 'stored')
      return true
    } catch (error) {
      failed.value = true
      notice.value = String(error)
      return false
    } finally {
      tokenBusy.value = false
      pendingToken = undefined
    }
  })()
  return pendingToken
}
async function testConnection() {
  if (testing.value) return
  testing.value = true
  try {
    commitAddress()
    if (!await updateToken()) return
    failed.value = false
    notice.value = text('testing')
    await testExternalMarketConnection()
    notice.value = text('connected')
  } catch (error) {
    failed.value = true
    notice.value = String(error)
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <ProList :title="text('gateway')">
    <div class="settings-row gateway-row">
      <label for="gateway-address">{{ text('address') }}</label>
      <input
        id="gateway-address"
        v-model="address"
        class="settings-input"
        placeholder="https://example.com"
        spellcheck="false"
        @blur="commitAddress"
        @keydown.enter.prevent="commitAddress"
      >
    </div>
    <p
      v-if="/^http:\/\//i.test(address.trim())"
      class="gateway-note"
      role="status"
    >
      {{ text('http') }}
    </p>
    <div class="settings-row gateway-row">
      <label for="gateway-token">{{ text('token') }}</label>
      <div class="gateway-controls">
        <input
          id="gateway-token"
          v-model="token"
          autocomplete="off"
          class="settings-input"
          :placeholder="text(hasToken ? 'saved' : 'unset')"
          :readonly="tokenBusy"
          spellcheck="false"
          type="password"
          @blur="updateToken()"
          @keydown.enter.prevent="updateToken()"
        >
        <button
          v-if="token.trim()"
          :aria-label="text('save')"
          class="settings-button gateway-icon"
          :disabled="tokenBusy"
          type="button"
          @click="updateToken()"
          @mousedown.prevent
        >
          <span
            aria-hidden="true"
            class="i-lucide:check"
          />
        </button>
        <button
          v-else-if="hasToken"
          :aria-label="`${text('clear')} ${text('token')}`"
          class="settings-button gateway-icon"
          :disabled="tokenBusy"
          type="button"
          @click="updateToken(true)"
        >
          <span
            aria-hidden="true"
            class="i-lucide:x"
          />
        </button>
      </div>
    </div>
    <div class="settings-row">
      <label for="gateway-timeout">{{ text('timeout') }}</label>
      <InputNumber
        id="gateway-timeout"
        v-model:value="timeoutDraft"
        :max="30000"
        :min="1000"
        :precision="0"
        :suffix="text('milliseconds')"
        @blur="commitTimeout"
        @press-enter="commitTimeout"
        @step="commitTimeout"
      />
    </div>
    <div class="settings-row">
      <span id="connection-label">{{ text('connection') }}</span>
      <button
        aria-labelledby="connection-label"
        class="settings-button gateway-icon"
        :disabled="testing"
        type="button"
        @click="testConnection"
      >
        <span
          aria-hidden="true"
          :class="testing ? 'i-lucide:loader-circle animate-spin' : 'i-lucide:plug-zap'"
        />
      </button>
    </div>
    <p
      v-if="notice"
      class="gateway-note"
      :class="{ 'gateway-error': failed }"
      role="status"
    >
      {{ notice }}
    </p>
  </ProList>
</template>

<style scoped>
.gateway-row {
  flex-wrap: wrap;
}
.gateway-row > input,
.gateway-controls {
  width: min(100%, 19rem);
}
.gateway-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.gateway-controls input {
  flex: 1;
  min-width: 0;
}
.gateway-icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
}
.gateway-note {
  color: var(--settings-muted);
  font-size: 12px;
  margin: 0;
  padding: 0 16px 9px;
  overflow-wrap: anywhere;
}
.gateway-error {
  color: var(--settings-danger);
}
</style>
