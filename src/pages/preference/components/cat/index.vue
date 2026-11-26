<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { resolveResource } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { InputNumber, message, Modal, Switch } from 'antdv-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { deleteImportedSkin, importSkinPack, skinAssetUrl } from '@/skins/skinService'
import { useCatStore } from '@/stores/cat'
import { BUILTIN_SKIN_ID, BUILTIN_SKINS, useSkinStore } from '@/stores/skin'

import ThemeMode from '../general/components/theme-mode/index.vue'
import messages from './messages'
import PanelAppearance from './PanelAppearance.vue'
import PercentRange from './PercentRange.vue'

const { t } = useI18n({ useScope: 'local', messages })
const { t: generalText } = useI18n({ useScope: 'global' })
const catStore = useCatStore()
const skinStore = useSkinStore()
const builtinPreviews = ref<Record<string, string>>({})
const importing = ref(false)

const skins = computed(() => [
  ...BUILTIN_SKINS.map(item => ({
    id: item.id,
    image: builtinPreviews.value[item.id] ?? '/logo.png',
    name: t(item.mode),
    author: item.author,
    imported: false,
  })),
  ...skinStore.imported.map(item => ({
    id: item.id,
    image: skinAssetUrl(item.previewPath),
    name: item.name,
    author: item.author,
    imported: true,
  })),
])

onMounted(async () => {
  for (const item of BUILTIN_SKINS) {
    try {
      builtinPreviews.value[item.id] = convertFileSrc(await resolveResource(item.previewPath))
    } catch {
      // Keep the generic logo when a packaged preview is unavailable.
    }
  }
})

function label(key: string) {
  return generalText(`pages.preference.cat.labels.${key}`)
}

async function selectSkin(id: string) {
  catStore.skin = id
  await emit(LISTEN_KEY.SKIN_CHANGED, id)
}

async function handleImport() {
  if (importing.value) return
  importing.value = true
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'BongoStock Skin', extensions: ['bongoskin', 'zip'] }],
    })
    if (typeof selected !== 'string') return
    const imported = await importSkinPack(selected)
    await skinStore.refresh()
    await selectSkin(imported.id)
    message.success(t('imported', { name: imported.name }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    importing.value = false
  }
}

function confirmDelete(id: string) {
  const skin = skinStore.find(id)
  if (!skin) return
  Modal.confirm({
    title: t('removeSkin', { name: skin.name }),
    content: t('restore'),
    okText: t('remove'),
    okButtonProps: { danger: true },
    cancelText: t('cancel'),
    async onOk() {
      try {
        await deleteImportedSkin(id)
        await skinStore.refresh()
        await selectSkin(catStore.skin === id ? BUILTIN_SKIN_ID : catStore.skin)
        message.success(t('removed'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
</script>

<template>
  <ProList :title="t('interface')">
    <ThemeMode />
  </ProList>

  <section class="settings-section">
    <div class="skin-heading">
      <h2 class="settings-section-title">
        {{ label('skin') }}
      </h2>
      <button
        :aria-label="t('importSkin')"
        class="settings-button skin-icon"
        :disabled="importing"
        type="button"
        @click="handleImport"
      >
        <i
          aria-hidden="true"
          class="i-lucide:plus"
        />
      </button>
    </div>
    <div class="skin-grid">
      <div
        v-for="item in skins"
        :key="item.id"
        class="skin-card"
        :class="{ selected: catStore.skin === item.id }"
      >
        <button
          :aria-pressed="catStore.skin === item.id"
          class="skin-choice"
          type="button"
          @click="selectSkin(item.id)"
        >
          <img
            alt=""
            draggable="false"
            :src="item.image"
          >
          <span class="skin-caption">
            <strong>{{ item.name }}</strong>
            <small v-if="item.author">{{ item.author }}</small>
          </span>
          <i
            v-if="catStore.skin === item.id"
            aria-hidden="true"
            class="skin-check i-lucide:check"
          />
        </button>
        <button
          v-if="item.imported"
          :aria-label="t('removeSkin', { name: item.name })"
          class="settings-button skin-remove skin-icon"
          type="button"
          @click="confirmDelete(item.id)"
        >
          <i
            aria-hidden="true"
            class="i-lucide:trash-2"
          />
        </button>
      </div>
    </div>
  </section>

  <ProList :title="t('pet')">
    <ProListItem :title="label('windowSize')">
      <PercentRange
        v-model="catStore.window.scale"
        :label="label('windowSize')"
        :max="300"
        :min="50"
      />
    </ProListItem>
    <ProListItem :title="label('opacity')">
      <PercentRange
        v-model="catStore.window.opacity"
        :label="label('opacity')"
        :max="100"
        :min="10"
      />
    </ProListItem>
    <ProListItem :title="label('windowRadius')">
      <InputNumber
        :aria-label="label('windowRadius')"
        :min="0"
        suffix="%"
        :value="catStore.window.radius"
        @update:value="value => { if (typeof value === 'number') catStore.window.radius = value }"
      />
    </ProListItem>
    <ProListItem :title="label('alwaysOnTop')">
      <Switch
        v-model:checked="catStore.window.alwaysOnTop"
        :aria-label="label('alwaysOnTop')"
      />
    </ProListItem>
    <ProListItem :title="label('passThrough')">
      <Switch
        v-model:checked="catStore.window.passThrough"
        :aria-label="label('passThrough')"
      />
    </ProListItem>
    <ProListItem :title="label('keepInScreen')">
      <Switch
        v-model:checked="catStore.window.keepInScreen"
        :aria-label="label('keepInScreen')"
      />
    </ProListItem>
    <ProListItem :title="label('hideOnHover')">
      <Switch
        v-model:checked="catStore.window.hideOnHover"
        :aria-label="label('hideOnHover')"
      />
    </ProListItem>
    <ProListItem
      v-if="catStore.window.hideOnHover"
      :title="t('hoverDelay')"
    >
      <InputNumber
        :aria-label="t('hoverDelay')"
        :min="0"
        suffix="s"
        :value="catStore.window.hideOnHoverDelay"
        @update:value="value => { if (typeof value === 'number') catStore.window.hideOnHoverDelay = value }"
      />
    </ProListItem>
  </ProList>

  <PanelAppearance />
</template>

<style scoped>
.skin-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.skin-heading h2 {
  margin: 0;
}
.skin-icon {
  width: 28px;
  height: 28px;
  padding: 0;
}
.skin-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.skin-card {
  display: flex;
  align-items: center;
  min-width: 0;
  color: var(--settings-ink);
  background: var(--settings-surface);
  border: 1px solid var(--settings-line);
  border-radius: 9px;
}
.skin-card.selected {
  border-color: var(--settings-accent);
  background: var(--settings-selected);
}
.skin-choice {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 10px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.skin-choice img {
  flex: none;
  width: 46px;
  height: 40px;
  border-radius: 5px;
  object-fit: contain;
  background: var(--settings-subtle);
}
.skin-caption {
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.skin-caption strong {
  font-weight: 550;
}
.skin-caption small {
  color: var(--settings-muted);
  font-size: 11px;
}
.skin-check {
  flex: none;
  width: 15px;
  height: 15px;
  margin-inline-start: auto;
  color: var(--settings-accent);
}
.skin-remove {
  flex: none;
  margin-inline-end: 8px;
  color: var(--settings-danger);
}
</style>
