import type { FeedItem, FeedSource } from './feedService'

export type VideoSource = FeedSource | 'history'
export type FavoriteCacheKey = `favorites:${string}`
export type WeeklyCacheKey = `weekly:${number}`
export type VideoCacheKey = VideoSource | FavoriteCacheKey | WeeklyCacheKey

export function weeklyCacheKey(number: number): WeeklyCacheKey {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('每周必看期号无效。')
  return `weekly:${number}`
}

export function isWeeklyCacheKey(key: VideoCacheKey): key is WeeklyCacheKey {
  return key.startsWith('weekly:')
}

export function favoriteCacheKey(folderId: string): FavoriteCacheKey {
  return `favorites:${folderId}`
}

export function isFavoriteCacheKey(key: VideoCacheKey): key is FavoriteCacheKey {
  return key.startsWith('favorites:')
}

export type PageDirection = -1 | 1
export const VIDEO_PAGE_SIZE = 2
const MAX_API_PAGES = 50
const MAX_EMPTY_BATCHES = 3

export interface VideoBatch {
  items: FeedItem[]
  hasMore: boolean
  nextCursor?: string
  notice?: string
  weeklyNumber?: number
  fallbackSource?: string
}

export interface FeedPagerState {
  items: readonly FeedItem[]
  /** Zero-based presentation page, never an API page. */
  page: number
  apiPage: number
  nextCursor?: string
  hasMore: boolean
  loaded: boolean
  loading: boolean
  refreshing: boolean
  pendingNext: boolean
  error: string
  notice: string
  weeklyNumber?: number
  fallbackSource?: 'bili'
  failedRefresh: boolean
}

interface Dependencies {
  fetch: (source: VideoCacheKey, page: number, cursor: string | undefined, refresh: boolean) => Promise<VideoBatch>
  changed: () => void
}

export function visibleVideoItems(state: Pick<FeedPagerState, 'items' | 'page'>): readonly FeedItem[] {
  return state.items.slice(state.page * VIDEO_PAGE_SIZE, (state.page + 1) * VIDEO_PAGE_SIZE)
}

export function hasCachedNext(state: Pick<FeedPagerState, 'items' | 'page' | 'hasMore'>): boolean {
  const end = (state.page + 2) * VIDEO_PAGE_SIZE
  return state.items.length >= end || (!state.hasMore && state.items.length > end - VIDEO_PAGE_SIZE)
}

function emptyState(): FeedPagerState {
  return { items: [], page: 0, apiPage: 0, hasMore: true, loaded: false, loading: false, refreshing: false, pendingNext: false, error: '', notice: '', failedRefresh: false }
}

/** Per-source, per-account memory cache. Only a successful refresh replaces ordering. */
export function createFeedPager(deps: Dependencies) {
  const states = new Map<VideoCacheKey, FeedPagerState>()
  const cursors = new Map<VideoCacheKey, Set<string>>()
  const metadata = new Map<VideoCacheKey, Map<string, FeedItem>>()
  const flights = new Map<VideoCacheKey, Promise<void>>()
  let epoch = 0
  let navigation = 0
  let active: VideoCacheKey = 'rcmd'
  let disposed = false

  function snapshot(source = active): FeedPagerState {
    if (!states.has(source)) states.set(source, emptyState())
    return states.get(source)!
  }

  function publish(source: VideoCacheKey, patch: Partial<FeedPagerState>) {
    states.set(source, { ...snapshot(source), ...patch })
    if (!disposed) deps.changed()
  }

  function fill(source: VideoCacheKey, minimum: number, refresh = false): Promise<void> {
    if (disposed) return Promise.resolve()
    const running = flights.get(source)
    if (running) return running
    if (refresh && source === active) cancelNavigation()
    const requestEpoch = epoch
    const original = snapshot(source)
    let candidate = refresh ? emptyState() : { ...original }
    let requiresRefresh = refresh
    const seen = new Set(refresh ? [] : cursors.get(source))
    publish(source, { loading: true, refreshing: refresh, error: '', failedRefresh: false })
    const flight = (async () => {
      // Register the flight before calling a dependency that may throw synchronously.
      await Promise.resolve()
      try {
        // A run of filtered/duplicate pages is bounded; retry resumes from the last
        // committed cursor, not a fabricated empty presentation page.
        for (let attempt = 0; attempt < MAX_EMPTY_BATCHES; attempt += 1) {
          if (disposed || requestEpoch !== epoch) return
          const apiPage = candidate.apiPage + 1
          const cursor = candidate.nextCursor
          const result = await deps.fetch(source, apiPage, cursor, refresh && apiPage === 1)
          if (disposed || requestEpoch !== epoch) return
          const weekly = source === 'weekly' || isWeeklyCacheKey(source)
          const weeklyNumber = weekly && Number.isSafeInteger(result.weeklyNumber) && (result.weeklyNumber ?? 0) > 0 ? result.weeklyNumber : undefined
          if (isWeeklyCacheKey(source) && weeklyNumber !== Number(source.slice('weekly:'.length))) {
            throw new Error('返回的每周必看期号不匹配，请重试。')
          }
          const fallbackSource = source === 'rank' && result.fallbackSource === 'bili' ? 'bili' : undefined
          if (candidate.loaded && (candidate.weeklyNumber !== weeklyNumber || candidate.fallbackSource !== fallbackSource)) {
            requiresRefresh = true
            throw new Error(weekly ? '每周必看已更新，请刷新列表。' : '榜单来源已更新，请刷新列表。')
          }
          const byId = new Map(candidate.items.map(item => [item.id, item]))
          for (const item of result.items) {
            if (!byId.has(item.id)) byId.set(item.id, item)
          }
          const items = [...byId.values()]
          const repeated = Boolean(result.nextCursor && (result.nextCursor === cursor || seen.has(result.nextCursor)))
          if (result.nextCursor) seen.add(result.nextCursor)
          candidate = {
            ...candidate,
            items,
            apiPage,
            nextCursor: result.nextCursor,
            loaded: true,
            // Favorites enforce their own server cap and explain it in notice.
            hasMore: result.hasMore && !repeated && (isFavoriteCacheKey(source) || apiPage < MAX_API_PAGES),
            notice: result.notice ?? '',
            weeklyNumber,
            fallbackSource,
          }
          if (items.length >= minimum || !candidate.hasMore) break
          if (attempt === MAX_EMPTY_BATCHES - 1) {
            throw new Error('暂未取得下一页视频，请重试。')
          }
        }
        // Commit pagination and list together. Failure leaves both unchanged.
        cursors.set(source, seen)
        // A recent-progress refresh can finish while this batch is in flight.
        // Apply its metadata at commit time, without changing either ordering.
        candidate.items = candidate.items.map(item => metadata.get(source)?.get(item.id) ?? item)
        publish(source, { ...candidate, page: refresh ? 0 : snapshot(source).page, loading: true, refreshing: refresh, pendingNext: snapshot(source).pendingNext, error: '', failedRefresh: false })
      } catch (error) {
        if (!disposed && requestEpoch === epoch) publish(source, { error: error instanceof Error ? error.message : String(error), failedRefresh: requiresRefresh })
      } finally {
        if (!disposed && requestEpoch === epoch) {
          flights.delete(source)
          publish(source, { loading: false, refreshing: false })
        }
      }
    })()
    flights.set(source, flight)
    return flight
  }

  async function ensure(source = active) {
    if (snapshot(source).loaded || disposed) return
    await fill(source, VIDEO_PAGE_SIZE)
  }

  function prefetch(source = active) {
    const state = snapshot(source)
    if (!state.loaded || state.loading || state.error || !state.hasMore || disposed) return Promise.resolve()
    const remaining = state.items.length - (state.page + 1) * VIDEO_PAGE_SIZE
    if (remaining > VIDEO_PAGE_SIZE * 2) return Promise.resolve()
    return fill(source, Math.max(state.items.length + VIDEO_PAGE_SIZE, (state.page + 2) * VIDEO_PAGE_SIZE))
  }

  async function move(pages: number, retry = false): Promise<boolean> {
    const source = active
    const state = snapshot(source)
    if (disposed || state.refreshing || !Number.isFinite(pages) || !Number.isInteger(pages) || !pages || (pages > 0 && state.pendingNext)) return false
    const requestEpoch = epoch
    const requestNavigation = ++navigation
    // Jump within the cache in one synchronous update, never an async loop per
    // crossed page. An unfinished half-page is only visible at the end of a feed.
    const pageCount = state.hasMore ? Math.floor(state.items.length / VIDEO_PAGE_SIZE) : Math.ceil(state.items.length / VIDEO_PAGE_SIZE)
    const lastPage = Math.max(0, pageCount - 1)
    let target = pages < 0
      ? state.page - Math.min(-pages, state.page)
      : state.page + Math.min(pages, Math.max(0, lastPage - state.page))
    let moved = target !== state.page
    if (moved || state.pendingNext) publish(source, { page: target, pendingNext: false })
    if (pages > 0 && pages > target - state.page && state.hasMore && (!state.error || retry)) {
      // At the cache boundary retain only one requested next page, regardless
      // of the input distance. Wheel never retries a failed batch automatically.
      publish(source, { pendingNext: true })
      await fill(source, (target + 2) * VIDEO_PAGE_SIZE)
      if (disposed || requestEpoch !== epoch || requestNavigation !== navigation || source !== active) return false
      if (hasCachedNext(snapshot(source))) {
        target += 1
        moved = true
      }
      publish(source, { page: target, pendingNext: false })
    }
    if (moved) void prefetch(source)
    return moved
  }

  function cancelNavigation() {
    navigation += 1
    for (const [source, state] of states) {
      if (state.pendingNext) publish(source, { pendingNext: false })
    }
  }

  return {
    snapshot,
    ensure,
    prefetch,
    move,
    cancelNavigation,
    select(source: VideoCacheKey, load = true) {
      if (disposed) return Promise.resolve()
      if (source !== active) cancelNavigation()
      active = source
      deps.changed()
      return load ? ensure(source) : Promise.resolve()
    },
    async refresh(source = active) {
      cancelNavigation()
      const requestEpoch = epoch
      // Do not race a refresh with an append on the same source.
      await flights.get(source)
      if (disposed || epoch !== requestEpoch) return
      await fill(source, VIDEO_PAGE_SIZE, true)
    },
    async retry() {
      const source = active
      const state = snapshot(source)
      if (state.failedRefresh) return this.refresh(source)
      if (!state.loaded) return ensure(source)
      await fill(source, Math.max(state.items.length + VIDEO_PAGE_SIZE, (state.page + 2) * VIDEO_PAGE_SIZE))
    },
    /** Update cloud metadata without moving, adding or removing visible cards. */
    updateMetadata(source: VideoCacheKey, items: readonly FeedItem[]) {
      if (disposed) return
      const updates = new Map(items.map(item => [item.id, item]))
      metadata.set(source, updates)
      publish(source, { items: snapshot(source).items.map(item => updates.get(item.id) ?? item) })
    },
    invalidate() {
      epoch += 1
      navigation += 1
      states.clear()
      cursors.clear()
      metadata.clear()
      flights.clear()
      if (!disposed) deps.changed()
    },
    dispose() {
      disposed = true
      this.invalidate()
    },
  }
}
