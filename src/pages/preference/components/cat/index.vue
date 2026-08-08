<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { resolveResource } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { Button, Divider, Flex, InputNumber, message, Modal, Slider, SpaceAddon, SpaceCompact, Switch } from 'antdv-next'
import { computed, onMounted, ref } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { deleteImportedSkin, importSkinPack, skinAssetUrl } from '@/skins/skinService'
import { useCatStore } from '@/stores/cat'
import { BUILTIN_SKINS, useSkinStore } from '@/stores/skin'

const catStore = useCatStore()
const skinStore = useSkinStore()
const builtinPreviews = ref<Record<string, string>>({})

const skins = computed(() => [
  ...BUILTIN_SKINS.map(item => ({
    id: item.id,
    image: builtinPreviews.value[item.id] ?? '/logo.png',
    name: item.name,
    description: `作者：${item.author} · ${item.description}`,
    imported: false,
  })),
  ...skinStore.imported.map(item => ({
    id: item.id,
    image: skinAssetUrl(item.previewPath),
    name: item.name,
    description: `作者：${item.author}`,
    imported: true,
  })),
])

onMounted(async () => {
  for (const item of BUILTIN_SKINS) {
    try {
      builtinPreviews.value[item.id] = convertFileSrc(await resolveResource(item.previewPath))
    } catch {
      // Keep the generic logo fallback when a packaged preview is unavailable.
    }
  }
})

async function selectSkin(id: string) {
  catStore.skin = id
  await emit(LISTEN_KEY.SKIN_CHANGED, id)
}

async function handleImport() {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'BongoStock Skin', extensions: ['bongoskin', 'zip'] }],
  })

  if (typeof selected !== 'string') return

  try {
    const imported = await importSkinPack(selected)
    await skinStore.refresh()
    await selectSkin(imported.id)
    message.success(`已导入皮肤：${imported.name}`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function handleDelete(id: string) {
  const skin = skinStore.find(id)
  if (!skin) return

  const confirmed = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: `删除导入皮肤“${skin.name}”？`,
      content: '删除后需要重新导入皮肤包才能恢复。',
      okText: '删除',
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
  if (!confirmed) return

  try {
    await deleteImportedSkin(id)
    await skinStore.refresh()
    await selectSkin(catStore.skin === id ? BUILTIN_SKIN_ID : catStore.skin)
    message.success('皮肤已删除')
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <ProList :title="$t('pages.preference.cat.labels.skinSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.skinSettings')"
      :title="$t('pages.preference.cat.labels.skin')"
      vertical
    >
      <div class="mb-3 flex items-center justify-between gap-3">
        <Button
          type="primary"
          @click="handleImport"
        >
          导入皮肤包
        </Button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <button
          v-for="item in skins"
          :key="item.id"
          class="skin-card"
          :class="{ 'is-selected': catStore.skin === item.id }"
          type="button"
          @click="selectSkin(item.id)"
        >
          <span class="skin-preview">
            <img
              alt=""
              draggable="false"
              :src="item.image"
            >
          </span>

          <span class="min-w-0 flex-1 text-left">
            <span class="block text-3.5 font-medium">
              {{ item.name }}
            </span>
            <span class="mt-1 block text-3 color-text-tertiary">
              {{ item.description }}
            </span>
          </span>

          <Button
            v-if="item.imported"
            aria-label="删除导入皮肤"
            danger
            size="small"
            @click.stop="handleDelete(item.id)"
          >
            删除
          </Button>

          <span
            aria-hidden="true"
            class="skin-radio"
          >
            <span v-if="catStore.skin === item.id" />
          </span>
        </button>
      </div>
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.cat.labels.windowSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.passThrough')"
      :title="$t('pages.preference.cat.labels.passThrough')"
    >
      <Switch v-model:checked="catStore.window.passThrough" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.alwaysOnTop')"
      :title="$t('pages.preference.cat.labels.alwaysOnTop')"
    >
      <Switch v-model:checked="catStore.window.alwaysOnTop" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.hideOnHover')"
      :title="$t('pages.preference.cat.labels.hideOnHover')"
    >
      <Flex align="center">
        <Switch v-model:checked="catStore.window.hideOnHover" />

        <Flex
          align="center"
          class="overflow-hidden transition-all"
          :class="[catStore.window.hideOnHover ? 'w-28 opacity-100' : 'w-0 opacity-0']"
        >
          <Divider type="vertical" />

          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.window.hideOnHoverDelay"
              class="w-16"
              :min="0"
            />

            <SpaceAddon>s</SpaceAddon>
          </SpaceCompact>
        </Flex>
      </Flex>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.keepInScreen')"
      :title="$t('pages.preference.cat.labels.keepInScreen')"
    >
      <Switch v-model:checked="catStore.window.keepInScreen" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.windowSize')"
      :title="$t('pages.preference.cat.labels.windowSize')"
      vertical
    >
      <div class="flex items-center gap-4">
        <Slider
          v-model:value="catStore.window.scale"
          class="min-w-0 flex-1 m-0!"
          :max="300"
          :min="50"
          :step="1"
          :tooltip="{
            formatter(value) {
              return `${value}%`
            },
          }"
        />

        <span class="w-12 text-right text-3.5 tabular-nums color-text-secondary">
          {{ catStore.window.scale }}%
        </span>
      </div>
    </ProListItem>

    <ProListItem :title="$t('pages.preference.cat.labels.windowRadius')">
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.window.radius"
          class="w-20"
          :min="0"
        />

        <SpaceAddon>%</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      :title="$t('pages.preference.cat.labels.opacity')"
      vertical
    >
      <Slider
        v-model:value="catStore.window.opacity"
        class="m-0!"
        :max="100"
        :min="10"
        :tooltip="{
          formatter(value) {
            return `${value}%`
          },
        }"
      />
    </ProListItem>
  </ProList>
</template>

<style scoped>
.skin-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 84px;
  padding: 12px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 8px;
  background: var(--ant-color-bg-container);
  color: var(--ant-color-text);
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.skin-card:hover {
  border-color: var(--ant-color-primary-border-hover);
  background: var(--ant-color-fill-quaternary);
}

.skin-card:active {
  background: var(--ant-color-fill-tertiary);
}

.skin-card.is-selected {
  border-color: var(--ant-color-primary);
  background: var(--ant-color-primary-bg);
}

.skin-preview {
  display: grid;
  width: 64px;
  height: 54px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 6px;
  background: var(--ant-color-fill-quaternary);
}

.skin-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.skin-radio {
  display: grid;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--ant-color-border);
  border-radius: 50%;
  background: var(--ant-color-bg-container);
}

.skin-radio span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ant-color-primary);
}
</style>
