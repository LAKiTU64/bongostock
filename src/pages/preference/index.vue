<script setup lang="ts">
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, theme } from 'antdv-next'
import { computed, defineAsyncComponent, onScopeDispose, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'

import { getAntdLocale } from '@/locales/antd'
import { PREFERENCE_DESTINATION } from '@/plugins/window'
import { useAppStore } from '@/stores/app'
import { useGeneralStore } from '@/stores/general'
import { isMac } from '@/utils/platform'

import 'antdv-next/dist/reset.css'

import './settings.css'

const pages = {
  general: { icon: 'i-lucide:settings-2', component: defineAsyncComponent(() => import('./components/general/index.vue')) },
  connection: { icon: 'i-lucide:plug', component: defineAsyncComponent(() => import('./components/connection/index.vue')) },
  style: { icon: 'i-lucide:palette', component: defineAsyncComponent(() => import('./components/cat/index.vue')) },
  market: { icon: 'i-lucide:chart-no-axes-combined', component: defineAsyncComponent(() => import('./components/market/index.vue')) },
  video: { icon: 'i-lucide:play-square', component: defineAsyncComponent(() => import('./components/video/index.vue')) },
  about: { icon: 'i-lucide:info', component: defineAsyncComponent(() => import('./components/about/index.vue')) },
} as const

const { t } = useI18n()
const app = useAppStore()
const general = useGeneralStore()
const appWindow = getCurrentWebviewWindow()
const current = ref<keyof typeof pages>('general')

function selectRequestedPage() {
  if (localStorage.getItem(PREFERENCE_DESTINATION) === 'video') {
    current.value = 'video'
    localStorage.removeItem(PREFERENCE_DESTINATION)
  }
}
selectRequestedPage()
useEventListener(window, 'storage', (event) => {
  if (event.key === PREFERENCE_DESTINATION) selectRequestedPage()
})
useEventListener(window, 'focus', selectRequestedPage)

watchEffect(() => {
  void appWindow.setTitle(t('pages.preference.title'))
})

// Apply the native window preference even when the appearance page is closed.
watch(() => general.appearance.theme, async (mode, _, onCleanup) => {
  let active = true
  onCleanup(() => {
    active = false
  })
  const nativeTheme = mode === 'auto' ? null : mode
  await appWindow.setTheme(nativeTheme)
  const nextTheme = nativeTheme ?? await appWindow.theme()
  if (active) general.appearance.isDark = nextTheme === 'dark'
}, { immediate: true })
const stopThemeListener = appWindow.onThemeChanged(({ payload }) => {
  if (general.appearance.theme === 'auto') general.appearance.isDark = payload === 'dark'
})
onScopeDispose(() => {
  void stopThemeListener.then(stop => stop())
})
watchEffect(() => document.documentElement.classList.toggle('dark', general.appearance.isDark))

const design = computed(() => {
  const dark = general.appearance.isDark
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    components: { InputNumber: { controlWidth: 136 } },
    token: {
      colorPrimary: dark ? '#e5c3a4' : '#755946',
      colorLink: dark ? '#e5c3a4' : '#755946',
      colorText: dark ? '#f8efe4' : '#443d3e',
      colorTextSecondary: dark ? '#c6b8aa' : '#73675f',
      colorBorder: dark ? '#51483f' : '#ddd6cf',
      colorBgContainer: dark ? '#2b2623' : '#fffaf3',
      colorBgElevated: dark ? '#352f2a' : '#fffaf3',
      borderRadius: 7,
      fontFamily: 'var(--font-ui)',
    },
  }
})
</script>

<template>
  <ConfigProvider
    :locale="getAntdLocale(general.appearance.language)"
    :theme="design"
  >
    <div
      class="preferences"
      :class="{ 'preferences-mac': isMac }"
    >
      <aside class="preferences-sidebar">
        <div
          class="preferences-brand"
          data-tauri-drag-region
        >
          <img
            alt=""
            data-tauri-drag-region
            src="/logo.png"
          >
          <span data-tauri-drag-region>{{ app.name }}</span>
        </div>
        <nav :aria-label="t('pages.preference.title')">
          <button
            v-for="(page, key) in pages"
            :key="key"
            :aria-current="current === key ? 'page' : undefined"
            type="button"
            @click="current = key"
          >
            <i
              aria-hidden="true"
              :class="page.icon"
            />
            {{ t(`pages.preference.navigation.${key}`) }}
          </button>
        </nav>
      </aside>
      <main
        :key="current"
        aria-labelledby="preferences-title"
        class="preferences-pane"
      >
        <div class="preferences-content">
          <header data-tauri-drag-region>
            <h1
              id="preferences-title"
              data-tauri-drag-region
            >
              {{ t(`pages.preference.navigation.${current}`) }}
            </h1>
          </header>
          <component :is="pages[current].component" />
        </div>
      </main>
    </div>
  </ConfigProvider>
</template>
