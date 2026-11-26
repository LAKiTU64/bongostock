import type { Ref } from 'vue'

import { onScopeDispose, shallowRef, watch } from 'vue'

interface DragGroup {
  id: string
  name: string
  codes: readonly string[]
}

export type WatchlistDragSource = { kind: 'group', groupId: string } | { kind: 'code', groupId: string, code: string }
export type WatchlistDragTarget = { kind: 'group', before: string | null } | { kind: 'code', groupId: string, before: string | null }

interface DragMove {
  kind: 'group' | 'code'
  groupId: string
  from: number
  to: number
}

/** Targets are insertion slots in the original list; the store expects an index after removal. */
export function resolveWatchlistDrop(groups: readonly DragGroup[], source: WatchlistDragSource, target: WatchlistDragTarget | null): DragMove | null {
  if (!target || source.kind !== target.kind) return null
  const group = groups.find(item => item.id === source.groupId)
  if (!group) return null
  if (target.kind === 'code' && target.groupId !== source.groupId) return null

  const items = source.kind === 'group' ? groups.map(item => item.id) : group.codes
  const from = items.indexOf(source.kind === 'group' ? source.groupId : source.code)
  const slot = target.before === null ? items.length : items.indexOf(target.before)
  if (from < 0 || slot < 0) return null
  const to = slot > from ? slot - 1 : slot
  return to === from ? null : { kind: source.kind, groupId: source.groupId, from, to }
}

/** A bounded, time-based edge speed, including small visible scroll areas. */
export function watchlistScrollSpeed(y: number, top: number, bottom: number) {
  if (bottom <= top || y < top - 24 || y > bottom + 24) return 0
  const edge = Math.min(48, (bottom - top) / 3)
  if (y < top + edge) return -720 * Math.min(1, (top + edge - y) / edge)
  if (y > bottom - edge) return 720 * Math.min(1, (y - bottom + edge) / edge)
  return 0
}

interface DragOptions {
  root: Ref<HTMLElement | undefined>
  groups: () => readonly DragGroup[]
  moveGroup: (from: number, to: number) => void
  moveCode: (groupId: string, from: number, to: number) => void
}

export function useWatchlistDrag(options: DragOptions) {
  const active = shallowRef<WatchlistDragSource | null>(null)
  const target = shallowRef<WatchlistDragTarget | null>(null)
  const announcement = shallowRef<'cancelled' | { item: string, position: number } | null>(null)
  let session: {
    source: WatchlistDragSource
    snapshot: string
    handle: HTMLElement
    pointerId: number
    startX: number
    startY: number
    x: number
    y: number
    scrollParents: HTMLElement[]
  } | null = null
  let frame = 0
  let lastFrame = 0

  function snapshot() {
    return JSON.stringify(options.groups().map(group => [group.id, group.name, group.codes]))
  }

  function cancel() {
    const previous = session
    session = null
    if (active.value) announcement.value = 'cancelled'
    active.value = null
    target.value = null
    cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    window.removeEventListener('pointermove', pointerMove, true)
    window.removeEventListener('pointerup', pointerUp, true)
    window.removeEventListener('pointercancel', pointerCancel, true)
    window.removeEventListener('keydown', keyDown, true)
    window.removeEventListener('blur', cancel)
    document.removeEventListener('visibilitychange', visibilityChange)
    previous?.handle.removeEventListener('lostpointercapture', cancel)
    if (previous?.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId)
  }

  function apply(source: WatchlistDragSource, drop: WatchlistDragTarget | null) {
    const move = resolveWatchlistDrop(options.groups(), source, drop)
    if (!move) return
    const group = options.groups().find(group => group.id === source.groupId)!
    const label = source.kind === 'group' ? group.name : source.code
    if (move.kind === 'group') options.moveGroup(move.from, move.to)
    else options.moveCode(move.groupId, move.from, move.to)
    announcement.value = { item: label, position: move.to + 1 }
  }

  function hitTest(): WatchlistDragTarget | null {
    const root = options.root.value
    if (!root || !session || !active.value) return null
    const { x, y, source } = session
    const hit = document.elementFromPoint(x, y)
    // Hit testing (rather than captured event.target) rejects overlays and out-of-list drops.
    if (!hit || !root.contains(hit)) return null
    if (source.kind === 'group') {
      const list = hit.closest<HTMLElement>('[data-watchlist-groups]')
      if (!list) return null
      const sections = [...list.querySelectorAll<HTMLElement>('[data-watchlist-group]')]
      const before = sections.find(section => y < midpoint(section))?.dataset.watchlistGroup ?? null
      return { kind: 'group', before }
    }
    if (hit.closest('[data-watchlist-remove]')) return null
    const list = hit.closest<HTMLElement>('[data-watchlist-codes]')
    if (!list || list.dataset.watchlistCodes !== source.groupId) return null
    const rows = [...list.querySelectorAll<HTMLElement>('[data-watchlist-code]')]
    const before = rows.find(row => y < midpoint(row))?.dataset.watchlistCode ?? null
    return { kind: 'code', groupId: source.groupId, before }
  }

  function midpoint(element: HTMLElement) {
    const bounds = element.getBoundingClientRect()
    return (bounds.top + bounds.bottom) / 2
  }

  function refreshTarget() {
    const next = hitTest()
    target.value = session && resolveWatchlistDrop(options.groups(), session.source, next) ? next : null
  }

  function tick(time: number) {
    if (!session || !active.value) return
    if (session.snapshot !== snapshot() || !session.handle.getClientRects().length) {
      cancel()
      return
    }
    const seconds = Math.min((time - (lastFrame || time)) / 1000, 0.04)
    lastFrame = time
    const sourceList = session.handle.closest<HTMLElement>(session.source.kind === 'code' ? '[data-watchlist-codes]' : '[data-watchlist-groups]')
    // Start with the source list; outer panes may reveal a clipped list edge, but
    // must not keep scrolling the source list away once that edge is visible.
    // Intersect with every clipping ancestor so partly offscreen lists still have reachable edges.
    for (const element of session.scrollParents) {
      const bounds = element.getBoundingClientRect()
      let top = Math.max(0, bounds.top)
      let bottom = Math.min(window.innerHeight, bounds.bottom)
      let left = Math.max(0, bounds.left)
      let right = Math.min(window.innerWidth, bounds.right)
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue
        const clip = parent.getBoundingClientRect()
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }
      if (session.x < left || session.x > right) continue
      const speed = watchlistScrollSpeed(session.y, top, bottom)
      let delta = speed * seconds
      if (sourceList && element !== sourceList && element.contains(sourceList)) {
        const sourceBounds = sourceList.getBoundingClientRect()
        // Bound the last step too: even a single overshooting frame can put the
        // pointer outside the source list and invalidate the release hit-test.
        delta = delta > 0
          ? Math.min(delta, Math.max(0, sourceBounds.bottom - bottom))
          : Math.max(delta, Math.min(0, sourceBounds.top - top))
      }
      const oldTop = element.scrollTop
      element.scrollTop += delta
      if (element.scrollTop !== oldTop) break
    }
    refreshTarget()
    frame = requestAnimationFrame(tick)
  }

  function start(event: PointerEvent, source: WatchlistDragSource) {
    if (!event.isPrimary || event.button !== 0 || session) return
    const group = options.groups().find(group => group.id === source.groupId)
    if (!group || (source.kind === 'group' ? options.groups().length < 2 : group.codes.length < 2 || !group.codes.includes(source.code))) return
    const handle = event.currentTarget as HTMLElement
    event.preventDefault()
    event.stopPropagation()
    handle.focus({ preventScroll: true })
    const scrollParents: HTMLElement[] = []
    for (let parent = handle.parentElement; parent; parent = parent.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) scrollParents.push(parent)
    }
    const scrollingElement = document.scrollingElement as HTMLElement | null
    if (scrollingElement && !scrollParents.includes(scrollingElement)) scrollParents.push(scrollingElement)
    session = {
      source,
      snapshot: snapshot(),
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      scrollParents,
    }
    // No native HTML drag events: Tauri's file-drop handler can intercept those.
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      cancel()
      return
    }
    handle.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', pointerMove, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerCancel, true)
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibilityChange)
  }

  function pointerMove(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return
    if (!(event.buttons & 1) || session.snapshot !== snapshot()) {
      cancel()
      return
    }
    event.preventDefault()
    session.x = event.clientX
    session.y = event.clientY
    if (!active.value && Math.hypot(session.x - session.startX, session.y - session.startY) >= 5) {
      active.value = session.source
      frame = requestAnimationFrame(tick)
    }
    refreshTarget()
  }

  function pointerUp(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return
    session.x = event.clientX
    session.y = event.clientY
    const source = session.source
    const drop = active.value && session.snapshot === snapshot() ? hitTest() : null
    cancel()
    apply(source, drop)
  }

  function pointerCancel(event: PointerEvent) {
    if (event.pointerId === session?.pointerId) cancel()
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  function visibilityChange() {
    if (document.hidden) cancel()
  }

  // Cancel even if a same-valued remote replacement arrives; never commit an old gesture over it.
  watch(options.groups, cancel, { deep: true, flush: 'sync' })
  onScopeDispose(cancel)

  function groupCue(groupId: string, index: number) {
    if (target.value?.kind !== 'group') return ''
    if (target.value.before === groupId) return 'drop-before'
    return target.value.before === null && index === options.groups().length - 1 ? 'drop-after' : ''
  }

  function codeCue(groupId: string, code: string, index: number) {
    if (target.value?.kind !== 'code' || target.value.groupId !== groupId) return ''
    if (target.value.before === code) return 'drop-before'
    const group = options.groups().find(group => group.id === groupId)
    return target.value.before === null && index === (group?.codes.length ?? 0) - 1 ? 'drop-after' : ''
  }

  return { active, announcement, start, groupCue, codeCue, cancel }
}
