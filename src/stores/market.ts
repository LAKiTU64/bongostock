import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export interface MarketSettingsSnapshot {
  bearerToken?: string
  external: {
    baseUrl: string
    timeoutMs: number
  }
}

export interface MarketStore {
  external: {
    baseUrl: string
    timeoutMs: number
  }
  bearerToken: string
}

export const DEFAULT_BASE_URL = 'https://123.57.156.148'

/** Keep configured endpoints, including old local gateways. The transport validates the scheme. */
export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL
}

function normalizeTimeout(value: number) {
  return Math.min(30_000, Math.max(1_000, Number.isFinite(value) ? Math.round(value) : 8_000))
}

export const useMarketStore = defineStore('market', () => {
  const bearerToken = ref('')
  const external = reactive<MarketStore['external']>({
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 8_000,
  })

  function init() {
    external.baseUrl = normalizeBaseUrl(external.baseUrl)
    external.timeoutMs = normalizeTimeout(external.timeoutMs)
  }

  function snapshot(): MarketSettingsSnapshot {
    return {
      bearerToken: bearerToken.value,
      external: {
        baseUrl: external.baseUrl,
        timeoutMs: external.timeoutMs,
      },
    }
  }

  function replaceFromEvent(value: MarketSettingsSnapshot) {
    bearerToken.value = value.bearerToken ?? bearerToken.value
    external.baseUrl = normalizeBaseUrl(value.external?.baseUrl ?? external.baseUrl)
    external.timeoutMs = normalizeTimeout(value.external?.timeoutMs ?? 8_000)
  }

  return {
    external,
    bearerToken,
    init,
    snapshot,
    replaceFromEvent,
  }
}, {
  // 正式构建才把 token 从持久化里摘掉（它存在系统凭据库，见 src/market/gatewayToken.ts）。
  // 开发模式保持明文落盘：tauri dev 每次重编译都会换掉二进制，macOS 会把新二进制
  // 当成另一个程序，于是反复弹出「请输入登录钥匙串密码」的授权框。
  ...(import.meta.env.DEV ? {} : { tauri: { filterKeys: ['bearerToken'] } }),
})
