<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button, Input, InputNumber, message, Modal, Select, Slider, SpaceAddon, SpaceCompact, Tag, theme } from 'antdv-next'
import { computed, ref, watch } from 'vue'

import type { SecurityCandidate } from '@/market/marketService'
import type { WatchlistDiff } from '@/market/watchlistSync'
import type { WatchlistGroup } from '@/stores/watchlist'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { commitGatewayToken, forgetGatewayToken, keychainEnabled, tokenStored } from '@/market/gatewayToken'
import { fetchQuotes, searchSecurityCandidates, testExternalMarketConnection } from '@/market/marketService'
import {
  confirmWatchlistPush,
  diffWatchlist,
  fetchCloudWatchlist,
  hasWatchlistDifference,
  resumeWatchlistSync,
  watchlistSyncError,
} from '@/market/watchlistSync'
import { normalizeBaseUrl, useMarketStore } from '@/stores/market'
import {
  MAX_DIMMED_OPACITY,
  MAX_FADE_DELAY_SECONDS,
  MAX_STATE_RETENTION_SECONDS,
  MAX_WATCHLIST_GROUPS,
  MAX_WATCHLIST_SIZE,
  MIN_DIMMED_OPACITY,
  MIN_FADE_DELAY_SECONDS,
  MIN_STATE_RETENTION_SECONDS,
  useWatchlistStore,
} from '@/stores/watchlist'

import BiliLogin from './BiliLogin.vue'
import { useWatchlistDrag } from './watchlistDrag'

const { token: themeToken } = theme.useToken()
const watchlistStore = useWatchlistStore()
const marketStore = useMarketStore()
const inputCode = ref('')
const inputGroupName = ref('')
const selectedGroupId = ref('')
const errorMessage = ref('')
const pendingDeleteGroupId = ref('')
const securityCandidates = ref<SecurityCandidate[]>([])
const quoteNames = ref<Record<string, string>>({})
const isSearching = ref(false)
const groups = computed(() => watchlistStore.groups)
const watchlistRoot = ref<HTMLElement>()
const {
  active: dragSource,
  announcement: dragAnnouncement,
  start: startDrag,
  keyboard: moveWithKeyboard,
  groupCue,
  codeCue,
} = useWatchlistDrag({
  root: watchlistRoot,
  groups: () => groups.value,
  moveGroup: (from, to) => watchlistStore.moveGroup(from, to),
  moveCode: (groupId, from, to) => watchlistStore.moveCode(groupId, from, to),
})
const groupOptions = computed(() => groups.value.map(group => ({ label: group.name, value: group.id })))
const fadeDelaySeconds = computed({
  get: () => watchlistStore.panel.fadeDelaySeconds,
  set: value => updatePanelSettings({ fadeDelaySeconds: value }),
})
const dimmedOpacity = computed({
  get: () => watchlistStore.panel.dimmedOpacity,
  set: value => updatePanelSettings({ dimmedOpacity: value }),
})
const stateRetentionSeconds = computed({
  get: () => watchlistStore.panel.stateRetentionSeconds,
  set: value => updatePanelSettings({ stateRetentionSeconds: value }),
})
// Edited as a local draft: writing to the store on every keystroke broadcasts a
// settings event that this same window receives and normalizes, which would
// rewrite the field mid-edit. The draft is committed on blur or Enter instead.
const baseUrlDraft = ref(marketStore.external.baseUrl)

watch(() => marketStore.external.baseUrl, (value) => {
  if (value !== baseUrlDraft.value) baseUrlDraft.value = value
})

function commitBaseUrl() {
  const normalized = normalizeBaseUrl(baseUrlDraft.value)

  baseUrlDraft.value = normalized

  if (normalized === marketStore.external.baseUrl) return

  marketStore.external.baseUrl = normalized
  emitMarketSettings()
}
const externalTimeout = computed({
  get: () => marketStore.external.timeoutMs,
  set: (value) => {
    marketStore.external.timeoutMs = Number(value)
    emitMarketSettings()
  },
})
const isTestingConnection = ref(false)
const connectionMessage = ref('')
const externalUsesHttp = computed(() => baseUrlDraft.value.trim().toLowerCase().startsWith('http://'))
let quoteNameRequestId = 0

// Token 不落在配置文件里，也没法回显（读出来只用于请求）。
// 输入框只当草稿：提交后写进系统钥匙串并立刻清空，因此界面上永远是空的。
const tokenDraft = ref('')
const tokenBusy = ref(false)

// 正式版看钥匙串，开发模式看 store（此时 token 仍随配置文件明文落盘）。
const hasToken = computed(() => keychainEnabled ? tokenStored.value : Boolean(marketStore.bearerToken.trim()))
const tokenDescription = computed(() => {
  if (!keychainEnabled) return '开发模式：令牌保存在本地配置文件里，重启后自动恢复。'
  return hasToken.value
    ? '令牌保存在系统钥匙串中，不写入应用配置文件。输入新值可替换。'
    : '令牌将保存在系统钥匙串中，不写入应用配置文件。'
})

async function commitToken() {
  const value = tokenDraft.value.trim()
  if (!value) return

  tokenBusy.value = true
  try {
    await commitGatewayToken(value)
    tokenDraft.value = ''
    emitMarketSettings()
    message.success(keychainEnabled ? '令牌已保存到系统凭据库' : '令牌已保存在本地配置文件')
  } catch (error) {
    message.error(`保存令牌失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    tokenBusy.value = false
  }
}

async function clearToken() {
  tokenBusy.value = true
  try {
    await forgetGatewayToken()
    emitMarketSettings()
    message.success(keychainEnabled ? '已清除系统凭据库中的令牌' : '已清除本地配置中的令牌')
  } catch (error) {
    message.error(`清除令牌失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    tokenBusy.value = false
  }
}

/**
 * 用系统浏览器打开自选管理页。
 * token 通过 ?t= 传一次，服务端换成 HttpOnly cookie 后立刻 302 到干净地址，
 * 所以地址栏和浏览器历史里不会长期留着 token。
 */
function openWatchlistPage() {
  commitBaseUrl()
  const base = marketStore.external.baseUrl.replace(/\/+$/, '')
  const token = marketStore.bearerToken.trim()

  if (!base) {
    message.warning('请先填写外接服务地址')
    return
  }
  if (!token) {
    message.warning('请先设置 Bearer Token')
    return
  }

  void openUrl(`${base}/watchlist?t=${encodeURIComponent(token)}`)
}

watch(groups, (values) => {
  if (values.some(group => group.id === selectedGroupId.value)) return

  selectedGroupId.value = values[0]?.id ?? ''
}, { immediate: true })

watch(
  () => [...watchlistStore.codes],
  codes => void loadQuoteNames(codes),
  { immediate: true },
)

watch(inputCode, () => {
  securityCandidates.value = []
})

function addGroup() {
  const result = watchlistStore.addGroup(inputGroupName.value)

  if (result) {
    errorMessage.value = result
    return
  }

  selectedGroupId.value = groups.value.at(-1)?.id ?? selectedGroupId.value
  inputGroupName.value = ''
  errorMessage.value = ''
}

function renameGroup(group: WatchlistGroup, event: Event) {
  const input = event.target as HTMLInputElement
  const result = watchlistStore.renameGroup(group.id, input.value)

  if (result) {
    errorMessage.value = result
    input.value = group.name
    return
  }

  errorMessage.value = ''
}

function removeGroup(group: WatchlistGroup) {
  if (pendingDeleteGroupId.value !== group.id) {
    pendingDeleteGroupId.value = group.id
    errorMessage.value = group.codes.length > 0
      ? `再次点击确认删除“${group.name}”及其中 ${group.codes.length} 只股票`
      : `再次点击确认删除“${group.name}”`
    return
  }

  const result = watchlistStore.removeGroup(group.id)
  pendingDeleteGroupId.value = ''

  if (result) {
    errorMessage.value = result
    return
  }

  errorMessage.value = ''
}

async function addCode() {
  if (isSearching.value) return
  if (!/^(?:SH|SZ)?\d{6}$/i.test(inputCode.value.trim())) {
    errorMessage.value = '请输入 6 位证券代码，或带 SH/SZ 前缀的代码'
    return
  }

  isSearching.value = true
  errorMessage.value = ''
  securityCandidates.value = []

  try {
    const candidates = await searchSecurityCandidates(inputCode.value)

    if (candidates.length === 0) {
      errorMessage.value = '没有找到对应的股票、基金或指数'
      return
    }

    if (candidates.length === 1) {
      addCandidate(candidates[0]!)
      return
    }

    securityCandidates.value = candidates
  } catch (error) {
    errorMessage.value = `代码查询失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    isSearching.value = false
  }
}

function addCandidate(candidate: SecurityCandidate) {
  const result = watchlistStore.addCode(candidate.code, selectedGroupId.value)

  if (result) {
    errorMessage.value = result
    return
  }

  quoteNames.value = { ...quoteNames.value, [candidate.code]: candidate.name }
  inputCode.value = ''
  securityCandidates.value = []
  errorMessage.value = ''
}

function removeCode(groupId: string, code: string) {
  watchlistStore.removeCode(groupId, code)
  errorMessage.value = ''
}

function moveCodeUp(groupId: string, index: number) {
  if (index <= 0) return
  watchlistStore.moveCode(groupId, index, index - 1)
}

function moveCodeDown(groupId: string, index: number, length: number) {
  if (index >= length - 1) return
  watchlistStore.moveCode(groupId, index, index + 1)
}

function moveGroupUp(index: number) {
  if (index <= 0) return
  watchlistStore.moveGroup(index, index - 1)
}

function moveGroupDown(index: number, length: number) {
  if (index >= length - 1) return
  watchlistStore.moveGroup(index, index + 1)
}

function updatePanelSettings(values: Parameters<typeof watchlistStore.updatePanelSettings>[0]) {
  watchlistStore.updatePanelSettings(values)
  void emit(LISTEN_KEY.STOCK_PANEL_SETTINGS_CHANGED, { ...watchlistStore.panel })
}

function emitMarketSettings() {
  void emit(LISTEN_KEY.MARKET_SETTINGS_CHANGED, marketStore.snapshot())
}

async function testConnection() {
  if (isTestingConnection.value) return

  commitBaseUrl()

  isTestingConnection.value = true
  connectionMessage.value = ''

  try {
    await testExternalMarketConnection()
    connectionMessage.value = '连接成功，已收到 capabilities 响应。'
  } catch (error) {
    connectionMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isTestingConnection.value = false
  }
}

type SyncDirection = 'pull' | 'push'

const syncOpen = ref(false)
const syncDirection = ref<SyncDirection>('pull')
const syncBusy = ref(false)
const syncDiff = ref<WatchlistDiff | null>(null)
const syncCloudGroups = ref<WatchlistGroup[]>([])
const syncCloudUpdatedAt = ref(0)

function syncDirectionLabel(direction: SyncDirection) {
  return direction === 'pull' ? '从云端拉取' : '推送到云端'
}

function syncSummary(direction: SyncDirection, diff: WatchlistDiff) {
  if (direction === 'pull') {
    return `将用云端数据覆盖本地（本地 ${diff.localGroups} 组 ${diff.localCodes} 只 → 云端 ${diff.cloudGroups} 组 ${diff.cloudCodes} 只）`
  }
  return `将用本地数据覆盖云端（云端 ${diff.cloudGroups} 组 ${diff.cloudCodes} 只 → 本地 ${diff.localGroups} 组 ${diff.localCodes} 只）`
}

async function openSync(direction: SyncDirection) {
  commitBaseUrl()

  if (!marketStore.external.baseUrl || !marketStore.bearerToken.trim()) {
    message.warning('请先在上方配置外接服务地址与 Bearer Token')
    return
  }

  syncDirection.value = direction
  syncBusy.value = true
  syncDiff.value = null
  syncOpen.value = true

  try {
    const cloud = await fetchCloudWatchlist()
    if (!cloud) {
      message.info('云端自选为空')
      syncOpen.value = false
      return
    }
    const cloudGroups = cloud.groups
    syncCloudGroups.value = cloudGroups
    syncCloudUpdatedAt.value = cloud.updatedAt
    syncDiff.value = diffWatchlist(watchlistStore.groups, cloudGroups)
  } catch (error) {
    message.error(`读取云端自选失败：${error instanceof Error ? error.message : String(error)}`)
    syncOpen.value = false
  } finally {
    syncBusy.value = false
  }
}

async function confirmSync() {
  if (!syncDiff.value) return

  syncBusy.value = true

  try {
    if (syncDirection.value === 'pull') {
      watchlistStore.setGroups(syncCloudGroups.value, true, false)
      watchlistStore.markSynced(syncCloudUpdatedAt.value)
      resumeWatchlistSync()
    } else {
      await confirmWatchlistPush(syncCloudUpdatedAt.value)
    }
    message.success(`${syncDirectionLabel(syncDirection.value)}成功`)
    syncOpen.value = false
  } catch (error) {
    message.error(`${syncDirectionLabel(syncDirection.value)}失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    syncBusy.value = false
  }
}

async function loadQuoteNames(codes: string[]) {
  const requestId = ++quoteNameRequestId

  if (codes.length === 0) {
    quoteNames.value = {}
    return
  }

  try {
    const quotes = await fetchQuotes(codes)

    if (requestId !== quoteNameRequestId) return

    quoteNames.value = Object.fromEntries(quotes
      .filter(quote => quote.name && quote.name !== '---')
      .map(quote => [quote.code.toUpperCase(), quote.name]))
  } catch {
    // Keep the codes usable when the quote provider is temporarily unavailable.
  }
}

function getQuoteName(code: string) {
  return quoteNames.value[code] ?? '名称暂不可用'
}
</script>

<template>
  <ProList title="行情服务">
    <ProListItem
      description="服务端应实现 /v1/capabilities、/v1/quotes、/v1/search、/v1/trends 和 /v1/klines。"
      title="外接服务地址"
      vertical
    >
      <Input
        v-model:value="baseUrlDraft"
        placeholder="https://example.com"
        @blur="commitBaseUrl"
        @press-enter="commitBaseUrl"
      />
      <div
        v-if="externalUsesHttp"
        class="mt-2 text-3 color-[--ant-color-warning]"
      >
        当前使用 HTTP：股票代码、请求内容和令牌可能被网络设备看到。建议改用 HTTPS。
      </div>
    </ProListItem>

    <ProListItem
      :description="tokenDescription"
      title="Bearer Token（可选）"
    >
      <SpaceCompact>
        <Input
          v-model:value="tokenDraft"
          :disabled="tokenBusy"
          :placeholder="hasToken ? '已保存，输入新值可替换' : '未设置'"
          type="password"
          @blur="commitToken"
          @press-enter="commitToken"
        />
        <Button
          v-if="hasToken"
          :loading="tokenBusy"
          @click="clearToken"
        >
          清除
        </Button>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="外接服务无响应时，超过此时间会结束请求。"
      title="连接超时"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="externalTimeout"
          class="w-24"
          :max="30000"
          :min="1000"
          :precision="0"
        />
        <SpaceAddon>毫秒</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="只测试 /v1/capabilities，不会请求股票代码。"
      title="连接测试"
    >
      <div class="flex items-center gap-3">
        <Button
          :loading="isTestingConnection"
          @click="testConnection"
        >
          测试连接
        </Button>
        <span
          v-if="connectionMessage"
          class="text-3 color-text-secondary"
        >
          {{ connectionMessage }}
        </span>
      </div>
    </ProListItem>

    <ProListItem
      description="用系统浏览器打开云端自选管理页，可直接增删分组和股票。打开一次后 30 天内免输令牌。"
      title="自选管理页"
    >
      <Button @click="openWatchlistPage">
        打开管理页
      </Button>
    </ProListItem>
  </ProList>

  <BiliLogin />

  <ProList title="行情浮窗">
    <ProListItem
      description="点击浮窗和桌宠以外区域自动关闭后，在这段时间内重新打开会恢复原来的模式、详情和筛选状态；0 表示不保留。"
      title="关闭后状态保留"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="stateRetentionSeconds"
          class="w-22"
          :max="MAX_STATE_RETENTION_SECONDS"
          :min="MIN_STATE_RETENTION_SECONDS"
          :precision="0"
        />

        <SpaceAddon>秒</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="浮窗停止操作后，等待多久开始变淡。"
      title="变淡等待时间"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="fadeDelaySeconds"
          class="w-22"
          :max="MAX_FADE_DELAY_SECONDS"
          :min="MIN_FADE_DELAY_SECONDS"
          :precision="0"
        />

        <SpaceAddon>秒</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      description="数值越低，闲置后的浮窗越淡；100% 表示不变淡。"
      title="变淡后不透明度"
      vertical
    >
      <Slider
        v-model:value="dimmedOpacity"
        class="m-0!"
        :max="MAX_DIMMED_OPACITY"
        :min="MIN_DIMMED_OPACITY"
        :tooltip="{
          formatter(value) {
            return `${value}%`
          },
        }"
      />
    </ProListItem>
  </ProList>

  <ProList title="自选行情">
    <ProListItem
      description="自选分组与股票保存在云端网关；两个方向都是全量覆盖，操作前会展示差异供确认。"
      title="云端同步"
      vertical
    >
      <div class="flex flex-wrap items-center gap-2">
        <Button
          :loading="syncBusy && syncDirection === 'pull'"
          @click="openSync('pull')"
        >
          从云端拉取
        </Button>
        <Button
          :loading="syncBusy && syncDirection === 'push'"
          @click="openSync('push')"
        >
          推送到云端
        </Button>
      </div>
      <p
        v-if="watchlistSyncError"
        class="mt-2 text-3 color-[--ant-color-warning]"
        role="alert"
      >
        {{ watchlistSyncError }}
      </p>
    </ProListItem>

    <ProListItem
      description="创建分组后，可以把不同用途的股票分别展示。分组名称可直接修改。"
      title="管理分组"
      vertical
    >
      <div class="flex flex-wrap items-center gap-2">
        <Input
          v-model:value="inputGroupName"
          aria-label="新分组名称"
          class="min-w-55 flex-1"
          :maxlength="20"
          placeholder="例如：长期持有"
          @press-enter="addGroup"
        />
        <Button
          :disabled="groups.length >= MAX_WATCHLIST_GROUPS"
          @click="addGroup"
        >
          新建分组
        </Button>
      </div>
    </ProListItem>

    <ProListItem
      description="输入 6 位代码后会在线匹配证券名称与交易所；出现同号候选时，可确认后再加入。也支持 SH/SZ 前缀。"
      title="添加股票或基金"
      vertical
    >
      <div class="flex flex-wrap items-center gap-2">
        <Select
          v-model:value="selectedGroupId"
          aria-label="选择分组"
          class="w-32"
          :options="groupOptions"
        />
        <Input
          v-model:value="inputCode"
          aria-label="股票或基金代码"
          class="min-w-48 flex-1"
          :maxlength="8"
          placeholder="输入 6 位代码，例如 588170"
          @press-enter="addCode"
        />
        <Button
          :disabled="watchlistStore.totalCodes >= MAX_WATCHLIST_SIZE"
          :loading="isSearching"
          @click="addCode"
        >
          匹配并添加
        </Button>
      </div>

      <div
        v-if="securityCandidates.length"
        class="grid mt-2 gap-1 border-[--ant-color-border-secondary] bg-[--ant-color-fill-quaternary] p-2 border rounded-lg"
      >
        <div class="px-2 pb-1 text-3 color-[--ant-color-text-secondary]">
          找到多个同号证券，请选择：
        </div>
        <Button
          v-for="candidate in securityCandidates"
          :key="candidate.code"
          class="h-auto! flex! justify-between! px-2! py-2! text-left!"
          type="text"
          @click="addCandidate(candidate)"
        >
          <span class="font-600">{{ candidate.name }}</span>
          <code class="color-[--ant-color-text-tertiary]">{{ candidate.code }}</code>
        </Button>
      </div>

      <div
        v-if="errorMessage"
        class="mt-2 text-3 color-[--ant-color-error]"
      >
        {{ errorMessage }}
      </div>
    </ProListItem>

    <ProListItem
      description="行情面板会按下面的分组顺序展示。删除分组时，其中的股票会一并移除。"
      title="当前分组"
      vertical
    >
      <div
        ref="watchlistRoot"
        class="watchlist-sort grid gap-3"
        :class="{ 'is-dragging': dragSource }"
        :style="{ '--watchlist-sort-accent': themeToken.colorPrimary }"
      >
        <section
          v-for="(group, groupIndex) in groups"
          :key="group.id"
          class="watchlist-group border-[--ant-color-border-secondary] bg-[--ant-color-bg-container] border rounded-lg"
          :class="[groupCue(group.id, groupIndex), { 'drag-source': dragSource?.kind === 'group' && dragSource.groupId === group.id }]"
          :data-watchlist-group="group.id"
        >
          <header class="flex flex-wrap items-center gap-1.5 border-b border-b-[--ant-color-border-secondary] bg-[--ant-color-fill-quaternary] px-2.5 py-1.5 rounded-t-lg">
            <Button
              aria-keyshortcuts="ArrowUp ArrowDown Home End"
              :aria-label="`拖动分组“${group.name}”排序，也可用上下方向键或 Home、End`"
              class="sort-handle"
              :disabled="groups.length < 2"
              size="small"
              title="拖动分组排序"
              type="text"
              @dragstart.prevent
              @keydown="moveWithKeyboard($event, { kind: 'group', groupId: group.id })"
              @pointerdown="startDrag($event, { kind: 'group', groupId: group.id })"
            >
              <span
                aria-hidden="true"
                class="i-lucide:grip-vertical"
              />
            </Button>
            <SpaceCompact size="small">
              <Button
                :aria-label="`分组“${group.name}”上移`"
                :disabled="groupIndex === 0"
                size="small"
                @click="moveGroupUp(groupIndex)"
              >
                ↑
              </Button>
              <Button
                :aria-label="`分组“${group.name}”下移`"
                :disabled="groupIndex === groups.length - 1"
                size="small"
                @click="moveGroupDown(groupIndex, groups.length)"
              >
                ↓
              </Button>
            </SpaceCompact>
            <Input
              :aria-label="`分组名称：${group.name}`"
              class="min-w-0 flex-1 text-3.5 font-600 px-0!"
              :maxlength="20"
              size="small"
              :value="group.name"
              variant="borderless"
              @change="renameGroup(group, $event)"
            />
            <span class="text-3 color-[--ant-color-text-tertiary]">
              {{ group.codes.length }} 只
            </span>
            <Button
              danger
              :disabled="groups.length <= 1"
              size="small"
              @click="removeGroup(group)"
            >
              {{ pendingDeleteGroupId === group.id ? '确认删除' : '删除分组' }}
            </Button>
          </header>

          <div
            v-if="group.codes.length"
            class="watchlist-codes grid"
            :data-watchlist-codes="group.id"
          >
            <div
              v-for="(code, codeIndex) in group.codes"
              :key="code"
              class="watchlist-code flex items-center gap-2 border-b border-b-[--ant-color-border-secondary] px-2.5 py-1.5 last:border-b-0"
              :class="[codeCue(group.id, code, codeIndex), { 'drag-source': dragSource?.kind === 'code' && dragSource.groupId === group.id && dragSource.code === code }]"
              :data-watchlist-code="code"
            >
              <Button
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
                :aria-label="`拖动${group.name}中的${getQuoteName(code)}（${code}）排序，也可用上下方向键或 Home、End`"
                class="sort-handle"
                :disabled="group.codes.length < 2"
                size="small"
                title="拖动股票排序"
                type="text"
                @dragstart.prevent
                @keydown="moveWithKeyboard($event, { kind: 'code', groupId: group.id, code })"
                @pointerdown="startDrag($event, { kind: 'code', groupId: group.id, code })"
              >
                <span
                  aria-hidden="true"
                  class="i-lucide:grip-vertical"
                />
              </Button>
              <div class="min-w-0 flex flex-1 flex-col">
                <span class="truncate text-3.5 font-600 leading-5">{{ getQuoteName(code) }}</span>
                <code class="text-3 color-[--ant-color-text-tertiary] leading-4">{{ code }}</code>
              </div>
              <SpaceCompact
                class="shrink-0"
                size="small"
              >
                <Button
                  :aria-label="`${group.name}中的${code}上移`"
                  :disabled="codeIndex === 0"
                  size="small"
                  @click="moveCodeUp(group.id, codeIndex)"
                >
                  ↑
                </Button>
                <Button
                  :aria-label="`${group.name}中的${code}下移`"
                  :disabled="codeIndex === group.codes.length - 1"
                  size="small"
                  @click="moveCodeDown(group.id, codeIndex, group.codes.length)"
                >
                  ↓
                </Button>
                <Button
                  danger
                  size="small"
                  @click="removeCode(group.id, code)"
                >
                  删除
                </Button>
              </SpaceCompact>
            </div>
          </div>

          <div
            v-else
            class="px-2 py-2 text-3 color-[--ant-color-text-tertiary]"
          >
            这个分组还没有股票
          </div>
        </section>
      </div>
      <div
        aria-live="polite"
        class="sort-status"
        role="status"
      >
        {{ dragAnnouncement }}
      </div>
    </ProListItem>
  </ProList>

  <Modal
    v-model:open="syncOpen"
    cancel-text="取消"
    :confirm-loading="syncBusy"
    :ok-button-props="{ danger: true }"
    :ok-text="syncDirectionLabel(syncDirection)"
    :title="`${syncDirectionLabel(syncDirection)} · 确认差异`"
    @ok="confirmSync"
  >
    <template v-if="syncDiff">
      <div class="mb-3 text-3.5 font-600">
        {{ syncSummary(syncDirection, syncDiff) }}
      </div>

      <div class="mb-2 text-3 color-[--ant-color-text-secondary]">
        本地 {{ syncDiff.localGroups }} 组 · {{ syncDiff.localCodes }} 只 ｜ 云端 {{ syncDiff.cloudGroups }} 组 · {{ syncDiff.cloudCodes }} 只
      </div>

      <div
        v-if="hasWatchlistDifference(syncDiff)"
        class="text-3 color-[--ant-color-warning]"
      >
        ⚠ 同步后以下差异将被覆盖：
      </div>

      <div
        v-if="syncDiff.localOnlyGroups.length"
        class="mt-2"
      >
        <div class="text-3 color-[--ant-color-text-secondary]">
          仅本地有分组（{{ syncDiff.localOnlyGroups.length }}）
        </div>
        <div class="flex flex-wrap gap-1">
          <Tag
            v-for="name in syncDiff.localOnlyGroups"
            :key="name"
          >
            {{ name }}
          </Tag>
        </div>
      </div>

      <div
        v-if="syncDiff.cloudOnlyGroups.length"
        class="mt-2"
      >
        <div class="text-3 color-[--ant-color-text-secondary]">
          仅云端有分组（{{ syncDiff.cloudOnlyGroups.length }}）
        </div>
        <div class="flex flex-wrap gap-1">
          <Tag
            v-for="name in syncDiff.cloudOnlyGroups"
            :key="name"
          >
            {{ name }}
          </Tag>
        </div>
      </div>

      <div
        v-if="syncDiff.localOnlyCodes.length"
        class="mt-2"
      >
        <div class="text-3 color-[--ant-color-text-secondary]">
          仅本地有股票（{{ syncDiff.localOnlyCodes.length }}）
        </div>
        <code class="text-3">{{ syncDiff.localOnlyCodes.slice(0, 20).join('、') }}<template v-if="syncDiff.localOnlyCodes.length > 20"> 等 {{ syncDiff.localOnlyCodes.length }} 只</template></code>
      </div>

      <div
        v-if="syncDiff.cloudOnlyCodes.length"
        class="mt-2"
      >
        <div class="text-3 color-[--ant-color-text-secondary]">
          仅云端有股票（{{ syncDiff.cloudOnlyCodes.length }}）
        </div>
        <code class="text-3">{{ syncDiff.cloudOnlyCodes.slice(0, 20).join('、') }}<template v-if="syncDiff.cloudOnlyCodes.length > 20"> 等 {{ syncDiff.cloudOnlyCodes.length }} 只</template></code>
      </div>

      <div
        v-if="syncDiff.structureChanged && !syncDiff.localOnlyGroups.length && !syncDiff.cloudOnlyGroups.length && !syncDiff.localOnlyCodes.length && !syncDiff.cloudOnlyCodes.length"
        class="mt-2 text-3"
      >
        分组名称、股票归属或排列顺序不同。
      </div>

      <div
        v-if="!hasWatchlistDifference(syncDiff)"
        class="mt-2 text-3 color-[--ant-color-success]"
      >
        本地与云端完全一致，无需变更。
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.watchlist-sort.is-dragging {
  cursor: grabbing;
  user-select: none;
  -webkit-user-select: none;
}

.watchlist-group,
.watchlist-code {
  position: relative;
  min-width: 0;
}

.watchlist-codes {
  max-height: min(28rem, 55vh);
  overflow-y: auto;
  overscroll-behavior-y: auto;
  padding-block: 3px;
  border-radius: 0 0 8px 8px;
}

.sort-handle {
  flex: none;
  cursor: grab;
  touch-action: none;
}

.sort-handle:disabled {
  cursor: default;
}

.is-dragging .sort-handle {
  cursor: grabbing;
}

.drag-source {
  outline: 1px dashed var(--watchlist-sort-accent);
  outline-offset: -2px;
}

.drop-before::before,
.drop-after::after {
  position: absolute;
  z-index: 1;
  right: 0;
  left: 0;
  height: 3px;
  pointer-events: none;
  content: '';
  background: var(--watchlist-sort-accent);
  border-radius: 2px;
}

.drop-before::before {
  top: -2px;
}

.drop-after::after {
  bottom: -2px;
}

.sort-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
