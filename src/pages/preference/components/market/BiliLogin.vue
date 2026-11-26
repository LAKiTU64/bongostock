<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { Button, Modal, QRCode, Spin } from 'antdv-next'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { BiliQrcode, BiliSessionStatus } from '@/market/biliService'
import type { GatewayConnection } from '@/market/gatewayTransport'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { fetchBiliStatus, generateBiliQrcode, logoutBili, pollBiliQrcode } from '@/market/biliService'
import { captureGatewayConnection } from '@/market/gatewayRequest'
import { useMarketStore } from '@/stores/market'

const marketStore = useMarketStore()
const session = ref<BiliSessionStatus | null>(null)
const statusBusy = ref(false)
const errorMessage = ref('')
const logoutBusy = ref(false)
const loginOpen = ref(false)
const qrcode = ref<BiliQrcode | null>(null)
const qrStatus = ref<'active' | 'loading' | 'scanned' | 'expired'>('loading')
const qrMessage = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let statusRequest = 0

async function loadStatus() {
  const request = ++statusRequest
  statusBusy.value = true
  errorMessage.value = ''
  try {
    const value = await fetchBiliStatus(captureGatewayConnection())
    if (request === statusRequest) {
      const previous = session.value
      session.value = value
      if (previous?.logged !== value.logged || previous?.mid !== value.mid || previous?.revision !== value.revision) void notifySessionChanged()
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

async function notifySessionChanged() {
  await emit(LISTEN_KEY.BILI_SESSION_CHANGED).catch(() => {})
}

async function poll(key: string, current: number, connection: GatewayConnection) {
  if (current !== generation || !loginOpen.value) return
  try {
    const result = await pollBiliQrcode(key, connection)
    if (current !== generation || !loginOpen.value) return
    if (result.status === 'success') {
      loginOpen.value = false
      stopPolling()
      await notifySessionChanged()
      await loadStatus()
      return
    }
    if (result.status === 'expired') {
      qrStatus.value = 'expired'
      qrMessage.value = '二维码已过期，请点击刷新。'
      return
    }
    qrStatus.value = result.status === 'scanned' ? 'scanned' : 'active'
    qrMessage.value = result.status === 'scanned' ? '已扫码，请在手机上确认登录。' : '使用 B 站手机客户端扫码。'
    timer = setTimeout(() => void poll(key, current, connection), 2500)
  } catch (error) {
    if (current !== generation) return
    qrStatus.value = 'expired'
    qrMessage.value = error instanceof Error ? error.message : String(error)
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
  qrMessage.value = '正在生成二维码…'
  try {
    const connection = captureGatewayConnection()
    const value = await generateBiliQrcode(connection)
    if (current !== generation || !loginOpen.value) return
    qrcode.value = value
    qrStatus.value = 'active'
    qrMessage.value = '使用 B 站手机客户端扫码。'
    timer = setTimeout(() => void poll(value.key, current, connection), 2500)
  } catch (error) {
    if (current !== generation) return
    qrStatus.value = 'expired'
    qrMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function logout() {
  loginOpen.value = false
  stopPolling()
  const request = ++statusRequest
  statusBusy.value = false
  logoutBusy.value = true
  errorMessage.value = ''
  try {
    await logoutBili(captureGatewayConnection())
    if (request !== statusRequest) return
    session.value = { logged: false }
    await notifySessionChanged()
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
  stopPolling()
  logoutBusy.value = false
  session.value = null
  statusRequest += 1
  statusBusy.value = true
}, { flush: 'sync' })
watch(() => [marketStore.external.baseUrl, marketStore.bearerToken], loadStatus)
onMounted(loadStatus)
onUnmounted(() => {
  stopPolling()
  statusRequest += 1
})
</script>

<template>
  <div id="bili-account">
    <ProList title="B 站账号">
      <ProListItem
        description="登录后可查看个性化推荐、关注视频和账号历史，并同步实际播放进度。历史与续播仅使用云端账号记录。不登录也能看游客推荐、每周必看和排行。"
        title="登录状态"
        vertical
      >
        <div class="account-actions">
          <span aria-live="polite">
            {{ statusBusy ? '正在查询…' : session?.logged ? `已登录${session.nickname ? `：${session.nickname}` : ''}` : session ? '未登录' : '暂未获取状态' }}
          </span>
          <Button
            :disabled="statusBusy || logoutBusy"
            @click="startLogin"
          >
            {{ session?.logged ? '更换账号' : '扫码登录' }}
          </Button>
          <Button
            v-if="session?.logged"
            :loading="logoutBusy"
            @click="logout"
          >
            退出登录
          </Button>
          <Button
            :disabled="logoutBusy || loginOpen"
            :loading="statusBusy"
            type="text"
            @click="loadStatus"
          >
            刷新状态
          </Button>
        </div>
        <p
          v-if="errorMessage"
          class="account-error"
          role="alert"
        >
          {{ errorMessage }}
        </p>
        <p class="account-note">
          登录状态保存在你配置的网关，本机不保存 B 站 Cookie。连接同一网关的客户端共用这个 B 站账号。历史和进度同步需要支持账号身份的新网关；接口不可用时会提示重试，不回退到本地记录。断网或异常退出时，最后一次未同步的进度可能丢失。
        </p>
      </ProListItem>
    </ProList>
  </div>

  <Modal
    v-model:open="loginOpen"
    centered
    :footer="null"
    title="登录 B 站"
    :width="320"
  >
    <div class="login-content">
      <QRCode
        v-if="qrcode"
        bg-color="#ffffff"
        color="#000000"
        :size="200"
        :status="qrStatus"
        type="svg"
        :value="qrcode.url"
        @refresh="startLogin"
      />
      <Spin
        v-else-if="qrStatus === 'loading'"
        class="qr-loading"
      />
      <p
        aria-live="polite"
        class="qr-message"
      >
        {{ qrMessage }}
      </p>
      <Button
        v-if="qrStatus === 'expired'"
        @click="startLogin"
      >
        重新生成二维码
      </Button>
    </div>
  </Modal>
</template>

<style scoped>
.account-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.account-note {
  margin: 10px 0 0;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.account-error {
  margin: 8px 0 0;
  color: var(--ant-color-error);
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
}
</style>
