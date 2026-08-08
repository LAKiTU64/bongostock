import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'

import { WINDOW_LABEL } from '@/constants'
import { hideWindow, showWindow } from '@/plugins/window'

const PANEL_GAP = 12

/**
 * Toggle the panel beside the compact pet and keep it inside the current
 * monitor's work area. Positions and sizes returned by Tauri are physical
 * pixels, which keeps placement stable on Retina displays.
 */
export async function toggleStockPanel(): Promise<void> {
  const panel = await WebviewWindow.getByLabel(WINDOW_LABEL.STOCK_PANEL)

  if (!panel) return

  if (await panel.isVisible()) {
    await hideWindow(WINDOW_LABEL.STOCK_PANEL)
    return
  }

  const pet = WebviewWindow.getCurrent()
  const [petPosition, petSize, panelSize, monitors] = await Promise.all([
    pet.outerPosition(),
    pet.outerSize(),
    panel.outerSize(),
    availableMonitors(),
  ])

  const petCenterX = petPosition.x + petSize.width / 2
  const petCenterY = petPosition.y + petSize.height / 2
  const monitor = monitors.find(({ position, size }) => (
    petCenterX >= position.x
    && petCenterX < position.x + size.width
    && petCenterY >= position.y
    && petCenterY < position.y + size.height
  )) ?? monitors[0]

  const availableArea = monitor?.workArea ?? monitor
  const workLeft = availableArea?.position.x ?? petPosition.x
  const workTop = availableArea?.position.y ?? petPosition.y
  const workRight = availableArea
    ? availableArea.position.x + availableArea.size.width
    : Number.POSITIVE_INFINITY
  const workBottom = availableArea
    ? availableArea.position.y + availableArea.size.height
    : Number.POSITIVE_INFINITY

  let x = petCenterX - panelSize.width / 2
  let y = petPosition.y + petSize.height + PANEL_GAP

  if (y + panelSize.height > workBottom) {
    y = petPosition.y - panelSize.height - PANEL_GAP
  }

  x = Math.max(workLeft, Math.min(x, workRight - panelSize.width))
  y = Math.max(workTop, Math.min(y, workBottom - panelSize.height))

  await panel.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
  await showWindow(WINDOW_LABEL.STOCK_PANEL)
}
