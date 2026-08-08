import { convertFileSrc, invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'

export interface SkinLayout {
  top: string
  left: string
  width: string
}

export interface ImportedSkin {
  id: string
  name: string
  author: string
  engine: 'layered-png-v1'
  previewPath: string
  leftIdlePath: string
  leftPunchPath: string
  rightIdlePath: string
  rightPunchPath: string
  layout: SkinLayout
}

export function skinAssetUrl(path: string) {
  return convertFileSrc(path)
}

export async function listImportedSkins() {
  return invoke<ImportedSkin[]>(INVOKE_KEY.LIST_IMPORTED_SKINS)
}

export async function importSkinPack(sourcePath: string) {
  return invoke<ImportedSkin>(INVOKE_KEY.IMPORT_SKIN_PACK, { sourcePath })
}

export async function deleteImportedSkin(skinId: string) {
  return invoke<void>(INVOKE_KEY.DELETE_IMPORTED_SKIN, { skinId })
}
