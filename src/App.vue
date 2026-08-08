<script setup lang="ts">
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { isString } from 'es-toolkit'
import isURL from 'is-url'
import { onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'

import type { MarketSettingsSnapshot } from './stores/market'

import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { LANGUAGE, LISTEN_KEY } from './constants'
import { hideWindow, showWindow } from './plugins/window'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useMarketStore } from './stores/market'
import { useShortcutStore } from './stores/shortcut.ts'
import { useSkinStore } from './stores/skin'
import { useWatchlistStore } from './stores/watchlist'

const appStore = useAppStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const marketStore = useMarketStore()
const skinStore = useSkinStore()
const shortcutStore = useShortcutStore()
const watchlistStore = useWatchlistStore()
const appWindow = getCurrentWebviewWindow()
const { isRestored, restoreState } = useWindowState()
const { locale } = useI18n()

onMounted(async () => {
  await skinStore.init()
  await appStore.$tauri.start()
  await appStore.init()
  await catStore.$tauri.start()
  catStore.init()
  await generalStore.$tauri.start()
  await generalStore.init()
  await marketStore.$tauri.start()
  marketStore.init()
  await shortcutStore.$tauri.start()
  await watchlistStore.$tauri.start()
  watchlistStore.init()
  await restoreState()
})

useTauriListen<MarketSettingsSnapshot>(LISTEN_KEY.MARKET_SETTINGS_CHANGED, ({ payload }) => {
  marketStore.replaceFromEvent(payload)
})

useTauriListen<string>(LISTEN_KEY.SKIN_CHANGED, async ({ payload }) => {
  await skinStore.refresh()
  catStore.skin = skinStore.resolveId(payload)
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  showWindow()
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  hideWindow()
})

useEventListener('unhandledrejection', ({ reason }) => {
  const message = isString(reason)
    ? reason
    : reason instanceof Error
      ? reason.stack ?? reason.message
      : JSON.stringify(reason)

  error(message)
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <RouterView v-if="isRestored" />
</template>
