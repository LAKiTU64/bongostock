import { createPlugin } from '@tauri-store/pinia'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './locales/i18n'
import router from './router'

import 'virtual:uno.css'

import './assets/css/global.scss'

const pinia = createPinia()
pinia.use(createPlugin({
  saveInterval: 1000,
  saveOnChange: true,
  saveStrategy: 'debounce',
}))

createApp(App).use(router).use(pinia).use(i18n).mount('#app')
