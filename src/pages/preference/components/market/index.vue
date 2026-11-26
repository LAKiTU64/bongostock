<script setup lang="ts">
import { openUrl } from '@tauri-apps/plugin-opener'
import { message, Modal } from 'antdv-next'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SecurityCandidate } from '@/market/marketService'
import type { CloudWatchlistResult } from '@/market/watchlistSync'
import type { WatchlistGroup } from '@/stores/watchlist'

import { fetchQuotes, searchSecurityCandidates } from '@/market/marketService'
import {
  confirmWatchlistPush,
  diffWatchlist,
  fetchCloudWatchlist,
  hasWatchlistDifference,
  resumeWatchlistSync,
  WatchlistConflictError,
  watchlistSyncError,
} from '@/market/watchlistSync'
import { useMarketStore } from '@/stores/market'
import { MAX_WATCHLIST_GROUPS, MAX_WATCHLIST_SIZE, useWatchlistStore } from '@/stores/watchlist'

import { marketMessages } from './marketMessages'
import { useWatchlistDrag } from './watchlistDrag'

const { t } = useI18n({ useScope: 'local', messages: marketMessages })
const watchlist = useWatchlistStore()
const market = useMarketStore()
const groups = computed(() => watchlist.groups)
const selectedId = ref('')
const selected = computed(() => groups.value.find(group => group.id === selectedId.value))
const groupName = ref('')
const renaming = ref(false)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement>()
const deleteId = ref('')
const deletion = computed(() => groups.value.find(group => group.id === deleteId.value))
const groupError = ref('')
const query = ref('')
const candidates = ref<SecurityCandidate[]>([])
const searching = ref(false)
const searchMessage = ref('')
const quoteNames = ref<Record<string, string>>({})
const watchlistRoot = ref<HTMLElement>()
const { active, announcement, start, cancel, groupCue, codeCue } = useWatchlistDrag({
  root: watchlistRoot,
  groups: () => groups.value,
  moveGroup: (from, to) => watchlist.moveGroup(from, to),
  moveCode: (id, from, to) => watchlist.moveCode(id, from, to),
})

watch(groups, (current, previous) => {
  if (current.some(group => group.id === selectedId.value)) return
  const index = previous?.findIndex(group => group.id === selectedId.value) ?? 0
  selectedId.value = current[Math.max(0, Math.min(index, current.length - 1))]?.id ?? ''
}, { immediate: true, flush: 'sync' })

let searchRevision = 0
watch(selectedId, () => {
  cancel()
  query.value = ''
  renaming.value = false
  deleteId.value = ''
  groupError.value = ''
}, { flush: 'sync' })
watch([selectedId, query], () => {
  searchRevision++
  searching.value = false
  candidates.value = []
  searchMessage.value = ''
}, { flush: 'sync' })
onScopeDispose(() => {
  searchRevision++
})

function validationError(error: string) {
  switch (error) {
    case '请输入分组名称':
    case '分组名称不能为空': return t('requiredGroup')
    case '已经有同名分组': return t('duplicateGroup')
    case '至少保留一个分组': return t('keepGroup')
    case '这个代码已经在当前分组中': return t('duplicateCode')
    case `最多创建 ${MAX_WATCHLIST_GROUPS} 个分组`: return t('groupLimit', { count: MAX_WATCHLIST_GROUPS })
    case `自选列表最多保存 ${MAX_WATCHLIST_SIZE} 只股票或基金`: return t('codeLimit', { count: MAX_WATCHLIST_SIZE })
    default: return error
  }
}

function addGroup() {
  const error = watchlist.addGroup(groupName.value)
  groupError.value = validationError(error)
  if (error) return
  groupName.value = ''
  selectedId.value = groups.value.at(-1)!.id
}

async function editName(group: WatchlistGroup) {
  renameDraft.value = group.name
  renaming.value = true
  groupError.value = ''
  await nextTick()
  renameInput.value?.select()
}

function saveName(group: WatchlistGroup) {
  const error = watchlist.renameGroup(group.id, renameDraft.value)
  groupError.value = validationError(error)
  if (!error) renaming.value = false
}

function deleteGroup() {
  if (!deletion.value) return
  groupError.value = validationError(watchlist.removeGroup(deletion.value.id))
  deleteId.value = ''
}

async function search() {
  const groupId = selectedId.value
  const value = query.value.trim()
  if (!value || !groupId || searching.value) return
  const revision = ++searchRevision
  searching.value = true
  candidates.value = []
  searchMessage.value = ''
  try {
    const rows = await searchSecurityCandidates(value)
    if (revision !== searchRevision || groupId !== selectedId.value) return
    const normalized = value.toUpperCase()
    const matches = /^(?:SH|SZ)?\d{6}$/.test(normalized)
      ? rows.filter(row => normalized.length === 6 ? row.code.slice(2) === normalized : row.code === normalized)
      : rows
    if (matches.length === 1) addCandidate(matches[0]!, groupId)
    else if (matches.length) candidates.value = matches
    else searchMessage.value = t('noMatch')
  } catch (error) {
    if (revision === searchRevision) searchMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (revision === searchRevision) searching.value = false
  }
}

function addCandidate(candidate: SecurityCandidate, groupId: string) {
  if (groupId !== selectedId.value || !selected.value) return
  const error = watchlist.addCode(candidate.code, groupId)
  searchMessage.value = validationError(error)
  if (error) return
  quoteNames.value[candidate.code] = candidate.name
  query.value = ''
}

watch(
  () => [...watchlist.codes].sort().join(','),
  async (key, _, onCleanup) => {
    if (!key) {
      quoteNames.value = {}
      return
    }
    let current = true
    onCleanup(() => {
      current = false
    })
    try {
      const quotes = await fetchQuotes(key.split(','))
      if (!current) return
      for (const quote of quotes) {
        if (quote.name && quote.name !== '---') quoteNames.value[quote.code.toUpperCase()] = quote.name
      }
    } catch { /* Codes remain visible while quotes are unavailable. */ }
  },
  { immediate: true },
)

function hasGateway() {
  if (market.external.baseUrl && market.bearerToken.trim()) return true
  message.warning(t('gateway'))
  return false
}

async function openWatchlistPage() {
  if (!hasGateway()) return
  try {
    const url = new URL('watchlist', `${market.external.baseUrl.replace(/\/+$/, '')}/`)
    url.searchParams.set('t', market.bearerToken.trim())
    await openUrl(url.toString())
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

type SyncDirection = 'pull' | 'push'
const direction = ref<SyncDirection>('pull')
const syncOpen = ref(false)
const syncBusy = ref(false)
const cloud = ref<CloudWatchlistResult>()
const diff = computed(() => cloud.value ? diffWatchlist(groups.value, cloud.value.groups) : undefined)
const differences = computed(() => {
  const result = diff.value
  if (!result) return []
  return [
    { key: 'localGroups', items: result.localOnlyGroups },
    { key: 'cloudGroups', items: result.cloudOnlyGroups },
    { key: 'localCodes', items: result.localOnlyCodes },
    { key: 'cloudCodes', items: result.cloudOnlyCodes },
  ].filter(entry => entry.items.length)
})

watch([() => market.external.baseUrl, () => market.bearerToken], () => {
  syncOpen.value = false
  cloud.value = undefined
})

async function openSync(value: SyncDirection) {
  if (syncBusy.value || !hasGateway()) return
  direction.value = value
  syncBusy.value = true
  syncOpen.value = true
  cloud.value = undefined
  try {
    const result = await fetchCloudWatchlist()
    if (!syncOpen.value) return
    if (result) {
      cloud.value = result
    } else {
      message.info(t('same'))
      syncOpen.value = false
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
    syncOpen.value = false
  } finally {
    syncBusy.value = false
  }
}

async function confirmSync() {
  if (!cloud.value || syncBusy.value) return
  syncBusy.value = true
  try {
    if (direction.value === 'pull') {
      watchlist.setGroups(cloud.value.groups, true, false)
      watchlist.markSynced(cloud.value.updatedAt)
      resumeWatchlistSync()
    } else {
      await confirmWatchlistPush(cloud.value.updatedAt)
    }
    syncOpen.value = false
    message.success(t('synced'))
  } catch (error) {
    if (error instanceof WatchlistConflictError) {
      cloud.value = error.cloudState
      message.warning(t('conflict'))
    } else {
      message.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    syncBusy.value = false
  }
}
</script>

<template>
  <div class="market">
    <section class="settings-group sync">
      <div class="settings-row sync-row">
        <h2>{{ t('sync') }}</h2>
        <div class="sync-actions">
          <button
            :aria-label="t('pull')"
            class="settings-button icon"
            :disabled="syncBusy"
            :title="t('pull')"
            @click="openSync('pull')"
          >
            <i
              aria-hidden="true"
              class="i-lucide:cloud-download"
            />
          </button>
          <button
            :aria-label="t('push')"
            class="settings-button icon"
            :disabled="syncBusy"
            :title="t('push')"
            @click="openSync('push')"
          >
            <i
              aria-hidden="true"
              class="i-lucide:cloud-upload"
            />
          </button>
          <button
            :aria-label="t('openWeb')"
            class="settings-button icon"
            :title="t('openWeb')"
            @click="openWatchlistPage"
          >
            <i
              aria-hidden="true"
              class="i-lucide:external-link"
            />
          </button>
        </div>
      </div>
      <p
        v-if="watchlistSyncError"
        class="feedback"
        role="alert"
      >
        {{ t('conflict') }}
      </p>
    </section>

    <div
      ref="watchlistRoot"
      class="watchlist"
      :class="{ dragging: active }"
    >
      <section class="list-panel">
        <header class="list-heading">
          <h2>{{ t('groups') }}</h2><span class="count">{{ groups.length }}</span>
        </header>
        <ul
          class="group-list"
          data-watchlist-groups
        >
          <li
            v-for="(group, index) in groups"
            :key="group.id"
            class="group-row"
            :class="[groupCue(group.id, index), { selected: selectedId === group.id, source: active?.kind === 'group' && active.groupId === group.id }]"
            :data-watchlist-group="group.id"
          >
            <span
              aria-hidden="true"
              class="handle"
              :class="{ inactive: groups.length < 2 }"
              @dragstart.prevent
              @pointerdown="start($event, { kind: 'group', groupId: group.id })"
            ><i class="i-lucide:grip-vertical" /></span>
            <button
              :aria-current="selectedId === group.id"
              class="select-group"
              type="button"
              @click="selectedId = group.id"
            >
              <span>{{ group.name }}</span><span class="count">{{ group.codes.length }}</span>
            </button>
          </li>
        </ul>
        <form
          class="create-group"
          @submit.prevent="addGroup"
        >
          <input
            v-model="groupName"
            :aria-label="t('newGroup')"
            class="settings-input"
            maxlength="20"
            :placeholder="t('newGroup')"
          >
          <button
            :aria-label="t('addGroup')"
            class="settings-button icon"
            :disabled="groups.length >= MAX_WATCHLIST_GROUPS || !groupName.trim()"
          >
            <i
              aria-hidden="true"
              class="i-lucide:plus"
            />
          </button>
        </form>
        <p
          v-if="groupError"
          class="feedback"
          role="alert"
        >
          {{ groupError }}
        </p>
      </section>

      <section class="list-panel details">
        <template v-if="selected">
          <header class="list-heading">
            <form
              v-if="renaming"
              class="rename-form"
              @submit.prevent="saveName(selected)"
            >
              <input
                ref="renameInput"
                v-model="renameDraft"
                :aria-label="t('newGroup')"
                class="settings-input"
                maxlength="20"
                @keydown.esc.prevent="renaming = false"
              >
              <button
                :aria-label="t('save')"
                class="icon"
              >
                <i
                  aria-hidden="true"
                  class="i-lucide:check"
                />
              </button>
              <button
                :aria-label="t('cancel')"
                class="icon"
                type="button"
                @click="renaming = false"
              >
                <i
                  aria-hidden="true"
                  class="i-lucide:x"
                />
              </button>
            </form>
            <template v-else>
              <h2>{{ selected.name }}</h2><span class="count">{{ selected.codes.length }}</span>
              <button
                :aria-label="t('rename', { item: selected.name })"
                class="icon"
                @click="editName(selected)"
              >
                <i
                  aria-hidden="true"
                  class="i-lucide:pencil"
                />
              </button>
              <button
                :aria-label="t('remove', { item: selected.name })"
                class="icon remove-group"
                :disabled="groups.length <= 1"
                @click="deleteId = selected.id"
              >
                <i
                  aria-hidden="true"
                  class="i-lucide:x"
                />
              </button>
            </template>
          </header>
          <form
            class="search"
            @submit.prevent="search"
          >
            <input
              v-model="query"
              :aria-label="t('query')"
              class="settings-input"
              maxlength="32"
              :placeholder="t('query')"
            >
            <button
              :aria-label="t('search')"
              class="settings-button icon"
              :disabled="searching || !query.trim()"
            >
              <i
                aria-hidden="true"
                :class="searching ? 'i-lucide:loader-circle spinning' : 'i-lucide:search'"
              />
            </button>
          </form>
          <p
            v-if="searchMessage"
            class="feedback"
            role="status"
          >
            {{ searchMessage }}
          </p>
          <ul
            v-if="candidates.length"
            class="candidates"
          >
            <li
              v-for="candidate in candidates"
              :key="candidate.code"
            >
              <button
                class="candidate"
                type="button"
                @click="addCandidate(candidate, selected.id)"
              >
                <span>{{ candidate.name }}</span><code>{{ candidate.code }}</code><i
                  aria-hidden="true"
                  class="i-lucide:plus"
                />
              </button>
            </li>
          </ul>
          <div
            v-if="selected.codes.length"
            class="stock-head"
          >
            <span>{{ t('name') }}</span><span>{{ t('code') }}</span>
          </div>
          <ul
            class="code-list"
            :data-watchlist-codes="selected.id"
          >
            <li
              v-for="(code, index) in selected.codes"
              :key="code"
              class="stock-row"
              :class="[codeCue(selected.id, code, index), { source: active?.kind === 'code' && active.groupId === selected.id && active.code === code }]"
              :data-watchlist-code="code"
            >
              <span
                aria-hidden="true"
                class="handle"
                :class="{ inactive: selected.codes.length < 2 }"
                @dragstart.prevent
                @pointerdown="start($event, { kind: 'code', groupId: selected.id, code })"
              ><i class="i-lucide:grip-vertical" /></span>
              <span class="security-name">{{ quoteNames[code] || '—' }}</span><code>{{ code }}</code>
              <button
                :aria-label="t('remove', { item: code })"
                class="icon remove-code"
                data-watchlist-remove
                @click="watchlist.removeCode(selected.id, code)"
              >
                <i
                  aria-hidden="true"
                  class="i-lucide:x"
                />
              </button>
            </li>
            <li
              v-if="!selected.codes.length"
              class="empty"
            >
              {{ t('empty') }}
            </li>
          </ul>
        </template>
        <p
          v-else
          class="empty"
        >
          {{ t('emptyGroups') }}
        </p>
      </section>
      <span
        class="sr-status"
        role="status"
      >{{ announcement === 'cancelled' ? t('cancelled') : announcement ? t('moved', announcement) : '' }}</span>
    </div>

    <Modal
      :cancel-text="t('cancel')"
      :ok-button-props="{ danger: true }"
      :ok-text="t('deleteGroup')"
      :open="!!deletion"
      :title="t('deleteGroup')"
      @cancel="deleteId = ''"
      @ok="deleteGroup"
    >
      <p v-if="deletion">
        {{ t('deleteConfirm', { name: deletion.name, count: deletion.codes.length }) }}
      </p>
    </Modal>
    <Modal
      v-model:open="syncOpen"
      :cancel-text="t('cancel')"
      :confirm-loading="syncBusy"
      :ok-button-props="{ danger: true, disabled: !cloud }"
      :ok-text="t(direction)"
      :title="t(direction === 'pull' ? 'pullReview' : 'pushReview')"
      @ok="confirmSync"
    >
      <template v-if="diff">
        <p>{{ t('local') }} · {{ t('counts', { groups: diff.localGroups, codes: diff.localCodes }) }}</p>
        <p>{{ t('cloud') }} · {{ t('counts', { groups: diff.cloudGroups, codes: diff.cloudCodes }) }}</p>
        <dl
          v-if="differences.length"
          class="diff-list"
        >
          <template
            v-for="entry in differences"
            :key="entry.key"
          >
            <dt>{{ t(entry.key) }}</dt><dd>{{ entry.items.join(', ') }}</dd>
          </template>
        </dl>
        <p
          v-else
          class="review-note"
        >
          {{ t(hasWatchlistDifference(diff) ? 'structure' : 'same') }}
        </p>
      </template>
      <p v-else>
        {{ t('reading') }}
      </p>
    </Modal>
  </div>
</template>

<style scoped>
.market {
  container-type: inline-size;
  color: var(--settings-ink);
}
.watchlist {
  display: grid;
  grid-template-columns: minmax(138px, 0.65fr) minmax(0, 1.65fr);
  align-items: start;
  gap: 12px;
}
.list-panel {
  min-width: 0;
  background: var(--settings-surface);
  border: 1px solid var(--settings-line);
  border-radius: 10px;
}
.list-heading,
.create-group,
.rename-form,
.search,
.sync-actions,
.candidate {
  display: flex;
  gap: 6px;
  align-items: center;
}
.list-heading {
  min-height: 48px;
  padding: 8px 12px;
}
.market h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.count,
.empty,
.handle,
.icon,
.stock-head,
code {
  color: var(--settings-muted);
}
.count,
code {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.group-list {
  padding: 0 4px 4px;
}
.group-list,
.code-list {
  max-height: min(410px, 55vh);
  overflow-y: auto;
}
.group-row,
.stock-row {
  position: relative;
  min-width: 0;
}
.group-row {
  display: flex;
  align-items: center;
  border-radius: 5px;
}
.group-row.selected {
  background: var(--settings-selected);
}
.select-group,
.icon,
.candidate {
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.select-group,
.candidate,
.icon:not(.settings-button) {
  background: transparent;
  border: 0;
}
.select-group {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px 4px 0;
  text-align: start;
  overflow-wrap: anywhere;
}
.selected .select-group {
  font-weight: 600;
}
.create-group {
  padding: 9px;
  border-top: 1px solid var(--settings-line);
}
.create-group input,
.rename-form input,
.search input {
  flex: 1;
  min-width: 0;
  width: 0;
}
.rename-form {
  width: 100%;
}
.search {
  padding: 0 12px 10px;
}
.icon,
.handle {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 27px;
  height: 30px;
  padding: 0;
  border-radius: 5px;
  color: var(--settings-muted);
}
.icon.settings-button {
  width: 31px;
  min-width: 31px;
  padding-inline: 0;
}
.icon i,
.handle i,
.candidate i {
  display: inline-block;
  width: 16px;
  height: 16px;
}
.icon:enabled:hover,
.candidate:hover {
  background: var(--settings-subtle);
  color: var(--settings-ink);
}
.icon:disabled {
  cursor: default;
  opacity: 0.4;
}
.remove-group {
  margin-inline-start: auto;
}
.remove-group:enabled:hover,
.remove-code:hover {
  color: var(--settings-danger);
}
.handle {
  width: 23px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.handle.inactive {
  opacity: 0.35;
  cursor: default;
}
.dragging,
.dragging .handle {
  cursor: grabbing;
  user-select: none;
  -webkit-user-select: none;
}
.source {
  outline: 1px dashed var(--settings-accent);
  outline-offset: -2px;
}
.drop-before::before,
.drop-after::after {
  position: absolute;
  z-index: 1;
  inset-inline: 0;
  height: 2px;
  content: '';
  pointer-events: none;
  background: var(--settings-accent);
}
.drop-before::before {
  top: 0;
}
.drop-after::after {
  bottom: 0;
}
.stock-head,
.stock-row {
  display: grid;
  grid-template-columns: 23px minmax(0, 1fr) minmax(68px, 27%) 27px;
  gap: 4px;
  align-items: center;
  padding-inline: 4px;
}
.stock-head {
  min-height: 27px;
  background: var(--settings-subtle);
  font-size: 12px;
}
.stock-head span:first-child {
  grid-column: 2;
}
.stock-row {
  min-height: 37px;
}
.stock-row + .stock-row {
  border-top: 1px solid var(--settings-line);
}
.stock-row code {
  font-size: 11px;
}
.security-name {
  font-size: 13px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.empty,
.feedback {
  margin: 0;
  padding: 9px 12px;
  font-size: 13px;
}
.feedback {
  color: var(--settings-danger);
  overflow-wrap: anywhere;
}
.candidates {
  margin: 0 12px 10px;
  border: 1px solid var(--settings-line);
  border-radius: 5px;
}
.candidate {
  width: 100%;
  padding: 5px 8px;
  text-align: start;
}
.candidate code {
  margin-inline-start: auto;
}
.sync {
  margin-bottom: 16px;
}
.sync-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.sync-actions {
  flex-wrap: wrap;
}
.diff-list {
  max-height: 40vh;
  overflow: auto;
  margin-top: 12px;
}
.diff-list dt {
  margin-top: 8px;
  font-weight: 600;
}
.diff-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.review-note {
  margin-top: 12px;
}
.sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.spinning {
  animation: market-spin 1s linear infinite;
}
@keyframes market-spin {
  to {
    transform: rotate(360deg);
  }
}
@container (max-width: 388px) {
  .watchlist {
    grid-template-columns: minmax(0, 1fr);
  }
  .group-list {
    max-height: 150px;
  }
}
</style>
