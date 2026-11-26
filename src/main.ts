import { createPlugin } from '@tauri-store/pinia'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './locales/i18n'
import { syncGatewayToken } from './market/gatewayToken'
import router from './router'

import 'virtual:uno.css'

import './assets/css/global.scss'

const pinia = createPinia()
pinia.use(createPlugin({
  saveInterval: 1000,
  saveOnChange: true,
  saveStrategy: 'debounce',
}))

async function bootstrap() {
  const app = createApp(App).use(router).use(pinia).use(i18n)

  // Token 存在系统凭据库，必须在任何组件发请求之前读进内存，
  // 否则启动阶段的自选同步会拿着空 token 打到云端。
  await syncGatewayToken(pinia)

  app.mount('#app')
}

void bootstrap()
