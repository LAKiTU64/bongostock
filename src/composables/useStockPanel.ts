import { emit } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { showWindow } from '@/plugins/window'
import { placePanel, selectScreen } from '@/utils/windowGeometry'
import { desktopGeometry, placeWindow, readWindowRect } from '@/utils/windowPlacement'

/** Place before showing, using one desktop coordinate space for both windows. */
export async function positionStockPanelNearPet(): Promise<void> {
  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)
  const pet = await WebviewWindow.getByLabel(WINDOW_LABEL.MAIN)
  if (!panel || !pet) throw new Error('Pet or stock panel window is unavailable')
  const [petRect, panelRect, desktop] = await Promise.all([
    readWindowRect(pet),
    readWindowRect(panel),
    desktopGeometry(),
  ])
  const screen = selectScreen(desktop.screens, desktop.primaryId, petRect)
  await placeWindow(panel, placePanel(petRect, panelRect, screen.work), screen.work)
}

export async function toggleStockPanel(): Promise<void> {
  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)

  if (!panel) {
    await showWindow(WINDOW_LABEL.STOCK_PANEL)
    return
  }

  if (await panel.isVisible()) {
    await closeStockPanel('retain')
    return
  }

  await showWindow(WINDOW_LABEL.STOCK_PANEL)
}

export type StockPanelCloseReason = 'discard' | 'retain'

export function closeStockPanel(reason: StockPanelCloseReason): Promise<void> {
  return emit(LISTEN_KEY.CLOSE_STOCK_PANEL, reason)
}
