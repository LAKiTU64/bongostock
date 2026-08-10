import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export type MarketSource = 'builtin' | 'external'

export interface MarketSettingsSnapshot {
  source: MarketSource
  bearerToken?: string
  external: {
    baseUrl: string
    timeoutMs: number
  }
}

export interface MarketStore {
  source: MarketSource
  external: {
    baseUrl: string
    timeoutMs: number
  }
  bearerToken: string
}

export const DEFAULT_BASE_URL = 'https://127.0.0.1:8443'

/**
 * Only an empty or non-HTTP(S) value falls back to the default. A value that
 * merely fails to parse is kept verbatim, so a half-typed or mistyped address
 * stays on screen instead of being silently replaced.
 */
export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE_URL

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_BASE_URL
    return trimmed
  } catch {
    return trimmed
  }
}

function normalizeTimeout(value: number) {
  return Math.min(30_000, Math.max(1_000, Number.isFinite(value) ? Math.round(value) : 8_000))
}

export const useMarketStore = defineStore('market', () => {
  const source = ref<MarketSource>('builtin')
  const bearerToken = ref('')
  const external = reactive<MarketStore['external']>({
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 8_000,
  })

  function init() {
    source.value = source.value === 'external' ? 'external' : 'builtin'
    external.baseUrl = normalizeBaseUrl(external.baseUrl)
    external.timeoutMs = normalizeTimeout(external.timeoutMs)
  }

  function snapshot(): MarketSettingsSnapshot {
    return {
      source: source.value,
      bearerToken: bearerToken.value,
      external: {
        baseUrl: external.baseUrl,
        timeoutMs: external.timeoutMs,
      },
    }
  }

  function replaceFromEvent(value: MarketSettingsSnapshot) {
    source.value = value.source === 'external' ? 'external' : 'builtin'
    bearerToken.value = value.bearerToken ?? bearerToken.value
    external.baseUrl = normalizeBaseUrl(value.external?.baseUrl ?? '')
    external.timeoutMs = normalizeTimeout(value.external?.timeoutMs ?? 8_000)
  }

  return {
    source,
    external,
    bearerToken,
    init,
    snapshot,
    replaceFromEvent,
  }
})
