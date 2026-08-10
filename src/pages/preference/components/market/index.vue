<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { Button, Input, InputNumber, Select, Slider, SpaceAddon, SpaceCompact } from 'antdv-next'
import { computed, ref, watch } from 'vue'

import type { SecurityCandidate } from '@/market/marketService'
import type { WatchlistGroup } from '@/stores/watchlist'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { fetchQuotes, searchSecurityCandidates, testExternalMarketConnection } from '@/market/marketService'
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
const marketSource = computed({
  get: () => marketStore.source,
  set: (value) => {
    marketStore.source = value
    emitMarketSettings()
  },
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

watch(groups, (values) => {
  if (values.some(group => group.id === selectedGroupId.value)) return

  selectedGroupId.value = values[0]?.id ?? ''
}, { immediate: true })

watch(
  [() => marketStore.source, () => [...watchlistStore.codes]],
  ([, codes]) => void loadQuoteNames(codes),
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
  <ProList title="行情数据源">
    <ProListItem
      description="内置源使用当前 stock-api；外接源只访问下面配置的 BongoStock API v1 地址。"
      title="数据来源"
      vertical
    >
      <Select
        v-model:value="marketSource"
        class="w-full"
        :options="[
          { label: '内置 stock-api（推荐）', value: 'builtin' },
          { label: '外接行情服务', value: 'external' },
        ]"
      />
    </ProListItem>

    <template v-if="marketSource === 'external'">
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
        description="令牌保存在本机应用数据中，重启后会自动恢复。请勿分享或提交包含令牌的配置文件。"
        title="Bearer Token（可选）"
      >
        <Input
          v-model:value="marketStore.bearerToken"
          type="password"
          @change="emitMarketSettings"
        />
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
    </template>
  </ProList>

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
      description="创建分组后，可以把不同用途的股票分别展示。分组名称可直接修改。"
      title="管理分组"
      vertical
    >
      <div class="flex flex-wrap items-center gap-2">
        <Input
          v-model:value="inputGroupName"
          aria-label="新分组名称"
          class="min-w-55 flex-1"
          maxlength="20"
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
          maxlength="8"
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
      <div class="grid gap-3">
        <section
          v-for="group in groups"
          :key="group.id"
          class="overflow-hidden border-[--ant-color-border-secondary] bg-[--ant-color-bg-container] border rounded-lg"
        >
          <header class="flex items-center gap-2 border-b border-b-[--ant-color-border-secondary] bg-[--ant-color-fill-quaternary] px-3 py-2.5">
            <Input
              :aria-label="`分组名称：${group.name}`"
              class="min-w-0 flex-1 text-3.5 font-600 px-0!"
              maxlength="20"
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
            class="grid"
          >
            <div
              v-for="code in group.codes"
              :key="code"
              class="flex items-center justify-between border-b border-b-[--ant-color-border-secondary] px-3 py-2.5 last:border-b-0"
            >
              <div class="min-w-0 flex flex-col">
                <span class="truncate text-3.5 font-600">{{ getQuoteName(code) }}</span>
                <code class="text-3 color-[--ant-color-text-tertiary]">{{ code }}</code>
              </div>
              <Button
                danger
                size="small"
                @click="removeCode(group.id, code)"
              >
                删除
              </Button>
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
    </ProListItem>
  </ProList>
</template>
