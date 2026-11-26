import type { Rect } from './windowGeometry'

export interface RecoveryWindow {
  place: (target: Rect, area: Rect) => Promise<unknown>
  show: () => Promise<unknown>
  verify: () => Promise<unknown>
  persist: () => Promise<unknown>
}

/**
 * Showing must not precede positioning. Hidden retained panels never pass
 * through the normal show/mode/playback lifecycle during recovery.
 */
export async function recoverWindowPlacement(window: RecoveryWindow, target: Rect, area: Rect, reveal: boolean): Promise<void> {
  await window.place(target, area)
  if (reveal) await window.show()
  // Showing/unminimizing can change native geometry too; verify afterwards.
  await window.verify()
  await window.persist()
}
