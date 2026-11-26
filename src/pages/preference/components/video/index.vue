<script setup lang="ts">
import { emit, listen } from '@tauri-apps/api/event'
import { Modal, QRCode, Spin } from 'antdv-next'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { BiliQrcode, BiliSessionStatus } from '@/market/biliService'
import type { GatewayConnection } from '@/market/gatewayTransport'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { fetchBiliStatus, generateBiliQrcode, logoutBili, pollBiliQrcode } from '@/market/biliService'
import { captureGatewayConnection } from '@/market/gatewayRequest'
import { useMarketStore } from '@/stores/market'

import messages from './messages'

const { t } = useI18n({ useScope: 'local', messages })
const marketStore = useMarketStore()
const pageId = useId()
const session = ref<BiliSessionStatus | null>(null)
const statusBusy = ref(false)
const errorMessage = ref('')
const logoutBusy = ref(false)
const logoutOpen = ref(false)
const loginOpen = ref(false)
const qrcode = ref<BiliQrcode | null>(null)
const qrStatus = ref<'active' | 'loading' | 'scanned' | 'expired'>('loading')
const qrError = ref('')
const status = computed(() => {
  if (statusBusy.value) return t('checking')
  if (session.value?.logged) return session.value.nickname || t('logged')
  return t(session.value ? 'guest' : 'unknown')
})
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let statusRequest = 0
let lastKnownStatus: BiliSessionStatus | undefined

async function loadStatus(announce = true) {
  const request = ++statusRequest
  statusBusy.value = true
  errorMessage.value = ''
  try {
    const connection = captureGatewayConnection()
    const value = await fetchBiliStatus(connection)
    if (request === statusRequest) {
      const previous = lastKnownStatus
      lastKnownStatus = value
      session.value = value
      if (announce && previous && (previous.logged !== value.logged || previous.mid !== value.mid || previous.revision !== value.revision)) {
        void notifySessionChanged(connection)
      }
    }
  } catch (error) {
    if (request === statusRequest) {
      session.value = null
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (request === statusRequest) statusBusy.value = false
  }
}

function stopPolling() {
  clearTimeout(timer)
  generation += 1
}

async function notifySessionChanged(connection: GatewayConnection) {
  // A successful request can outlive the settings page. Only invalidate playback on its own gateway.
  try {
    const current = captureGatewayConnection()
    if (current.baseUrl === connection.baseUrl && current.bearerToken === connection.bearerToken) {
      await emit(LISTEN_KEY.BILI_SESSION_CHANGED, pageId)
    }
  } catch {
    // The gateway configuration may no longer be valid.
  }
}

async function poll(key: string, current: number, connection: GatewayConnection) {
  if (current !== generation || !loginOpen.value) return
  try {
    const result = await pollBiliQrcode(key, connection)
    if (result.status === 'success') void notifySessionChanged(connection)
    if (current !== generation || !loginOpen.value) return
    if (result.status === 'success') {
      loginOpen.value = false
      stopPolling()
      lastKnownStatus = undefined
      await loadStatus()
      return
    }
    if (result.status === 'expired') {
      qrStatus.value = 'expired'
      return
    }
    qrStatus.value = result.status === 'scanned' ? 'scanned' : 'active'
    timer = setTimeout(() => void poll(key, current, connection), 2500)
  } catch (error) {
    if (current !== generation) return
    qrStatus.value = 'expired'
    qrError.value = error instanceof Error ? error.message : String(error)
  }
}

async function startLogin() {
  stopPolling()
  statusRequest += 1
  statusBusy.value = false
  const current = generation
  loginOpen.value = true
  qrcode.value = null
  qrStatus.value = 'loading'
  qrError.value = ''
  try {
    const connection = captureGatewayConnection()
    const value = await generateBiliQrcode(connection)
    if (current !== generation || !loginOpen.value) return
    qrcode.value = value
    qrStatus.value = 'active'
    timer = setTimeout(() => void poll(value.key, current, connection), 2500)
  } catch (error) {
    if (current !== generation) return
    qrStatus.value = 'expired'
    qrError.value = error instanceof Error ? error.message : String(error)
  }
}

async function logout() {
  if (!logoutOpen.value || logoutBusy.value) return
  logoutOpen.value = false
  stopPolling()
  const request = ++statusRequest
  statusBusy.value = false
  logoutBusy.value = true
  errorMessage.value = ''
  try {
    const connection = captureGatewayConnection()
    await logoutBili(connection)
    void notifySessionChanged(connection)
    if (request !== statusRequest) return
    lastKnownStatus = { logged: false }
    session.value = lastKnownStatus
  } catch (error) {
    if (request === statusRequest) errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === statusRequest) logoutBusy.value = false
  }
}

watch(loginOpen, (open) => {
  if (!open) stopPolling()
})
watch(() => [marketStore.external.baseUrl, marketStore.bearerToken], () => {
  loginOpen.value = false
  logoutOpen.value = false
  stopPolling()
  logoutBusy.value = false
  session.value = null
  lastKnownStatus = undefined
  statusRequest += 1
  statusBusy.value = true
}, { flush: 'sync' })
watch(() => [marketStore.external.baseUrl, marketStore.bearerToken], () => loadStatus())
let stopListening: ReturnType<typeof listen> | undefined
onMounted(() => {
  stopListening = listen<string>(LISTEN_KEY.BILI_SESSION_CHANGED, ({ payload }) => {
    if (payload !== pageId && !logoutBusy.value) void loadStatus(false)
  })
  void loadStatus()
})
onUnmounted(() => {
  stopPolling()
  statusRequest += 1
  void stopListening?.then(stop => stop())
})
</script>

<template>
  <div id="bili-account">
    <ProList :title="t('account')">
      <ProListItem :title="t('status')">
        <div class="account-actions">
          <span
            aria-live="polite"
            class="account-status"
          >{{ status }}</span>
          <button
            :aria-label="session?.logged ? t('change') : t('login')"
            class="settings-button account-icon"
            :disabled="statusBusy || logoutBusy"
            type="button"
            @click="startLogin"
          >
            <i
              aria-hidden="true"
              class="i-lucide:qr-code"
            />
          </button>
          <button
            :aria-label="t('refresh')"
            class="settings-button account-icon"
            :disabled="statusBusy || logoutBusy || loginOpen"
            type="button"
            @click="loadStatus()"
          >
            <i
              aria-hidden="true"
              class="i-lucide:refresh-cw"
              :class="{ 'animate-spin': statusBusy }"
            />
          </button>
          <button
            v-if="session?.logged"
            :aria-label="t('logout')"
            class="settings-button account-icon account-logout"
            :disabled="logoutBusy || statusBusy"
            type="button"
            @click="logoutOpen = true"
          >
            <i
              aria-hidden="true"
              class="i-lucide:log-out"
            />
          </button>
        </div>
      </ProListItem>
      <p
        v-if="errorMessage"
        class="account-error"
        role="alert"
      >
        {{ errorMessage }}
      </p>
    </ProList>
  </div>

  <Modal
    v-model:open="loginOpen"
    centered
    :footer="null"
    :title="session?.logged ? t('change') : t('login')"
    :width="320"
  >
    <div class="login-content">
      <QRCode
        v-if="qrcode && qrStatus !== 'expired'"
        bg-color="#ffffff"
        color="#000000"
        :size="200"
        :status="qrStatus"
        type="svg"
        :value="qrcode.url"
      />
      <Spin
        v-else-if="qrStatus === 'loading'"
        class="qr-loading"
      />
      <button
        v-else-if="qrStatus === 'expired'"
        :aria-label="t('newCode')"
        class="settings-button account-icon"
        type="button"
        @click="startLogin"
      >
        <i
          aria-hidden="true"
          class="i-lucide:refresh-cw"
        />
      </button>
      <p
        aria-live="polite"
        class="qr-message"
      >
        {{ qrError || t(qrStatus) }}
      </p>
      <p class="qr-shared">
        {{ t('shared') }}
      </p>
    </div>
  </Modal>

  <Modal
    v-model:open="logoutOpen"
    centered
    :ok-button-props="{ danger: true }"
    :ok-text="t('logout')"
    :title="t('logout')"
    :width="340"
    @ok="logout"
  >
    <p>{{ t('sharedLogout') }}</p>
  </Modal>
</template>

<style scoped>
.account-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  min-width: 0;
}
.account-status {
  min-width: 0;
  margin-inline-end: 5px;
  color: var(--settings-muted);
  overflow-wrap: anywhere;
}
.account-icon {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
}
.account-logout {
  color: var(--settings-danger);
}
.account-error {
  margin: 0;
  padding: 8px 15px;
  color: var(--settings-danger);
  overflow-wrap: anywhere;
}
.login-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
}
.qr-loading {
  margin: 72px 0;
}
.qr-message {
  margin: 0;
  text-align: center;
  overflow-wrap: anywhere;
}
.qr-shared {
  margin: 0;
  color: var(--settings-muted);
  font-size: 12px;
  text-align: center;
}
</style>
