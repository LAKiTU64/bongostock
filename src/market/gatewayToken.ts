import type { Pinia } from 'pinia'

import { appDataDir, join } from '@tauri-apps/api/path'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { ref } from 'vue'

import { clearGatewayToken, loadGatewayToken, saveGatewayToken } from '@/plugins/secret'
import { useMarketStore } from '@/stores/market'

/** 开发版重编译会反复触发系统授权，因此仅正式构建使用系统凭据库。 */
export const keychainEnabled = !import.meta.env.DEV
export const tokenStorageLabel = keychainEnabled ? '系统凭据库' : '本地配置文件（开发模式）'
export const tokenStored = ref(false)

/** 写入系统凭据库成功之前保留旧文件，迁移失败不能丢掉现有令牌。 */
async function readLegacyToken(): Promise<string> {
  try {
    const path = await join(await appDataDir(), 'tauri-plugin-pinia', 'market.json')
    const parsed = JSON.parse(await readTextFile(path)) as Record<string, unknown>
    return typeof parsed.bearerToken === 'string' ? parsed.bearerToken.trim() : ''
  } catch {
    return ''
  }
}

async function removeLegacyToken() {
  const path = await join(await appDataDir(), 'tauri-plugin-pinia', 'market.json')
  const parsed = JSON.parse(await readTextFile(path)) as Record<string, unknown>
  if (!('bearerToken' in parsed)) return
  delete parsed.bearerToken
  await writeTextFile(path, JSON.stringify(parsed))
}

export async function syncGatewayToken(pinia?: Pinia) {
  const store = useMarketStore(pinia)
  if (!keychainEnabled) {
    tokenStored.value = Boolean(store.bearerToken.trim())
    return
  }

  const legacy = await readLegacyToken()
  let stored: string | null
  try {
    stored = await loadGatewayToken()
  } catch {
    // 系统拒绝读取时不要覆盖已有凭据，也不要删除原文件。
    if (legacy) store.bearerToken = legacy
    tokenStored.value = false
    console.warn('[bongostock] 读取系统凭据失败，已保留原配置')
    return
  }

  if (stored) {
    store.bearerToken = stored
    tokenStored.value = true
  } else if (legacy) {
    store.bearerToken = legacy
    try {
      await saveGatewayToken(legacy)
      tokenStored.value = true
    } catch {
      tokenStored.value = false
      console.warn('[bongostock] 迁移令牌失败，已保留原配置')
      return
    }
  } else {
    tokenStored.value = false
    return
  }

  if (legacy) {
    try {
      await removeLegacyToken()
    } catch {
      console.warn('[bongostock] 令牌已存入系统凭据库，但旧配置字段清理失败')
    }
  }
}

export async function commitGatewayToken(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return
  if (keychainEnabled) await saveGatewayToken(trimmed)
  useMarketStore().bearerToken = trimmed
  tokenStored.value = true
  if (keychainEnabled) {
    await removeLegacyToken().catch(() => {})
  }
}

export async function forgetGatewayToken() {
  if (keychainEnabled) await clearGatewayToken()
  useMarketStore().bearerToken = ''
  tokenStored.value = false
  if (keychainEnabled) await removeLegacyToken().catch(() => {})
}
