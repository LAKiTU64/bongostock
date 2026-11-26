import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'

/**
 * 以下三个方法只和系统凭据库打交道，不碰任何文件。
 * macOS 走钥匙串，Windows 走凭据管理器，Linux 走 Secret Service。
 */
export function saveGatewayToken(token: string) {
  return invoke<void>(INVOKE_KEY.SAVE_GATEWAY_TOKEN, { token })
}

/** 没有存过时返回 null，调用方按「未设置」处理即可。 */
export function loadGatewayToken() {
  return invoke<string | null>(INVOKE_KEY.LOAD_GATEWAY_TOKEN)
}

export function clearGatewayToken() {
  return invoke<void>(INVOKE_KEY.CLEAR_GATEWAY_TOKEN)
}
