import { invoke } from '@tauri-apps/api/core'
import { stocks } from 'stock-api'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'

export type StockQuote = Awaited<ReturnType<typeof stocks.auto.getStocks>>[number]
export type SecurityCandidate = Pick<StockQuote, 'code' | 'name'>
export type StockKline = Awaited<ReturnType<typeof stocks.auto.getKlines>>[number]

export interface IntradayPoint {
  timestamp: string
  date: string
  time: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number
  average: number
}

export interface TrendSeries {
  code: string
  name: string
  preClose: number
  points: IntradayPoint[]
  source: 'eastmoney' | 'tencent'
}

/** Initial values used when no local watchlist has been saved yet. */
export const DEFAULT_WATCHLIST = [
  'SH000001',
  'SZ399001',
  'SH000300',
  'SH000688',
] as const

const QUOTE_BATCH_SIZE = 25
const TREND_HISTORY_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
const TREND_LIVE_ENDPOINTS = [
  'https://push2.eastmoney.com/api/qt/stock/trends2/get',
  'https://push2delay.eastmoney.com/api/qt/stock/trends2/get',
] as const
const TENCENT_MINUTE_ENDPOINT = 'https://ifzq.gtimg.cn/appstock/app/minute/query'
const TENCENT_FIVE_DAY_ENDPOINT = 'https://ifzq.gtimg.cn/appstock/app/day/query'
const TREND_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58'
const TREND_REQUEST_RETRIES = 1
const TREND_CACHE_TTL_MS = 30_000
const KLINE_CACHE_TTL_MS = 5 * 60_000
const TREND_HOSTS = [
  'push2his.eastmoney.com',
  '7.push2his.eastmoney.com',
  '33.push2his.eastmoney.com',
  '63.push2his.eastmoney.com',
  '91.push2his.eastmoney.com',
] as const
const trendCache = new Map<string, CachedValue<TrendSeries>>()
const klineCache = new Map<string, CachedValue<StockKline[]>>()

async function fetchBuiltInQuotes(codes: readonly string[]): Promise<StockQuote[]> {
  if (codes.length === 0) return []

  const batches: string[][] = []

  for (let index = 0; index < codes.length; index += QUOTE_BATCH_SIZE) {
    batches.push(codes.slice(index, index + QUOTE_BATCH_SIZE))
  }

  return (await Promise.all(batches.map(batch => stocks.auto.getStocks(batch)))).flat()
}

/**
 * Fetch minute-by-minute data only when a user opens a stock detail view.
 * `days: 5` includes the latest trading day, so the one-day view can be
 * rendered by taking the last trading session from the same response.
 */
async function fetchBuiltInTrendSeries(
  code: string,
  days: 1 | 5 = 5,
  signal?: AbortSignal,
  force = false,
): Promise<TrendSeries> {
  const normalizedCode = code.trim().toUpperCase()
  const market = normalizedCode.startsWith('SH') ? '1' : normalizedCode.startsWith('SZ') ? '0' : ''
  const numberCode = normalizedCode.slice(2)

  if (!market || !/^\d{6}$/.test(numberCode)) {
    throw new Error('无法识别股票代码')
  }

  const cacheKey = `${normalizedCode}:${days}`
  const cached = getCached(trendCache, cacheKey)

  if (cached && !force) return cached

  const query = new URLSearchParams({
    secid: `${market}.${numberCode}`,
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
    fields2: TREND_FIELDS,
    iscr: '0',
    iscca: '0',
    ndays: String(days),
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    _: String(Date.now()),
  })

  let result: TrendSeries

  try {
    const response = await fetchTrendWithFallback(query, days, signal)
    const payload = await response.json() as EastmoneyTrendResponse
    const points = (payload.data?.trends ?? []).flatMap(parseTrendPoint)

    if (points.length === 0) throw new Error('暂无分时数据')

    result = {
      code: normalizedCode,
      name: payload.data?.name || normalizedCode,
      preClose: toFiniteNumber(payload.data?.preClose),
      points,
      source: 'eastmoney',
    }
  } catch (error) {
    if (signal?.aborted) throw error
    result = await fetchTencentTrendSeries(normalizedCode, days, signal, error)
  }

  trendCache.set(cacheKey, { expiresAt: Date.now() + TREND_CACHE_TTL_MS, value: result })
  return result
}

async function fetchBuiltInDailyKlines(code: string, count = 30, force = false): Promise<StockKline[]> {
  const normalizedCode = code.trim().toUpperCase()
  const cacheKey = `${normalizedCode}:${count}`
  const cached = getCached(klineCache, cacheKey)

  if (cached && !force) return cached

  const result = await stocks.auto.getKlines(normalizedCode, {
    period: 'day',
    count,
    adjust: 'none',
  })

  klineCache.set(cacheKey, { expiresAt: Date.now() + KLINE_CACHE_TTL_MS, value: result })
  return result
}

async function searchBuiltInSecurityCandidates(value: string): Promise<SecurityCandidate[]> {
  const query = value.trim().toUpperCase()

  if (/^(?:SH|SZ)\d{6}$/.test(query)) {
    const quote = await stocks.auto.getStock(query)
    return isAvailableQuote(quote) ? [{ code: quote.code, name: quote.name }] : []
  }

  if (!/^\d{6}$/.test(query)) return []

  const matches = await stocks.auto.searchStocks(query)
  const candidates = new Map<string, SecurityCandidate>()

  for (const quote of matches) {
    const code = quote.code.toUpperCase()

    if (!/^(?:SH|SZ)\d{6}$/.test(code) || code.slice(2) !== query || !isAvailableQuote(quote)) continue

    candidates.set(code, { code, name: quote.name })
  }

  return [...candidates.values()]
}

interface EastmoneyTrendResponse {
  data?: {
    name?: string
    preClose?: number | string
    trends?: string[]
  }
}

interface TencentTrendPayload {
  data?: Record<string, {
    data?: {
      date?: string
      data?: string[]
    } | Array<{
      date?: string
      data?: string[]
    }>
    qt?: Record<string, string[]>
  }>
}

interface CachedValue<T> {
  expiresAt: number
  value: T
}

function getCached<T>(cache: Map<string, CachedValue<T>>, key: string) {
  const entry = cache.get(key)

  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }

  return entry.value
}

function parseTrendPoint(raw: string): IntradayPoint[] {
  const [timestamp, open, close, high, low, volume, amount, average] = raw.split(',')

  if (!timestamp) return []

  const [date = timestamp, time = ''] = timestamp.split(' ')
  const closeValue = toFiniteNumber(close)

  if (!Number.isFinite(closeValue)) return []

  return [{
    timestamp,
    date,
    time,
    open: positiveOrFallback(open, closeValue),
    close: closeValue,
    high: positiveOrFallback(high, closeValue),
    low: positiveOrFallback(low, closeValue),
    volume: toFiniteNumber(volume),
    amount: toFiniteNumber(amount),
    average: positiveOrFallback(average, closeValue),
  }]
}

async function fetchTencentTrendSeries(
  code: string,
  days: 1 | 5,
  signal: AbortSignal | undefined,
  primaryError: unknown,
): Promise<TrendSeries> {
  const apiCode = code.toLowerCase()
  const url = new URL(days === 1 ? TENCENT_MINUTE_ENDPOINT : TENCENT_FIVE_DAY_ENDPOINT)
  const query: Record<string, string> = days === 1
    ? {
        code: apiCode,
        r: String(Math.random()),
      }
    : {
        _var: `fdays_data_${apiCode}`,
        code: apiCode,
        r: String(Math.random()),
      }

  url.search = new URLSearchParams(query).toString()
  const response = await fetchWithRetry(url, signal)
  const text = await response.text()
  const payload = parseTencentPayload(text) as TencentTrendPayload
  const security = payload.data?.[apiCode]

  if (!security) throw primaryError instanceof Error ? primaryError : new Error('暂无分时数据')

  const points = days === 1
    ? parseTencentIntradayPoints(security)
    : parseTencentFiveDayPoints(security)

  if (points.length === 0) throw primaryError instanceof Error ? primaryError : new Error('暂无分时数据')

  return {
    code,
    name: security.qt?.[apiCode]?.[1] || code,
    preClose: toFiniteNumber(security.qt?.[apiCode]?.[4]),
    points,
    source: 'tencent',
  }
}

function parseTencentPayload(text: string) {
  const separator = text.indexOf('=')
  if (separator < 0) throw new Error('数据源返回格式异常')

  return JSON.parse(text.slice(separator + 1)) as TencentTrendPayload
}

function parseTencentIntradayPoints(security: NonNullable<TencentTrendPayload['data']>[string]) {
  if (!security.data || Array.isArray(security.data)) return []

  const date = security.data.date ?? ''
  return (security.data.data ?? []).flatMap(row => parseTencentMinutePoint(date, row))
}

function parseTencentFiveDayPoints(security: NonNullable<TencentTrendPayload['data']>[string]) {
  if (!security.data || !Array.isArray(security.data)) return []

  return security.data
    .flatMap(day => (day.data ?? []).flatMap(row => parseTencentMinutePoint(day.date ?? '', row)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

function parseTencentMinutePoint(date: string, raw: string): IntradayPoint[] {
  const [rawTime, price, volume, amount] = raw.trim().split(/\s+/)
  const close = toFiniteNumber(price)

  if (!date || !rawTime || close <= 0) return []

  const normalizedDate = date.length === 8
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date
  const normalizedTime = rawTime.length === 4
    ? `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}`
    : rawTime
  const volumeValue = toFiniteNumber(volume)
  const amountValue = toFiniteNumber(amount)

  return [{
    timestamp: `${normalizedDate} ${normalizedTime}`,
    date: normalizedDate,
    time: normalizedTime,
    open: close,
    close,
    high: close,
    low: close,
    volume: volumeValue,
    amount: amountValue,
    // Tencent returns cumulative volume in lots (100 shares/units), while
    // amount is in currency. Converting lots to units keeps average in price
    // scale; omitting the factor makes the chart's y-axis ~100x too large.
    average: volumeValue > 0 ? amountValue / (volumeValue * 100) : close,
  }]
}

function positiveOrFallback(value: string | number | undefined, fallback: number) {
  const number = toFiniteNumber(value)
  return number > 0 ? number : fallback
}

function toFiniteNumber(value: string | number | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

async function fetchWithRetry(url: URL, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= TREND_REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal,
      })

      if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`)

      return response
    } catch (error) {
      lastError = error

      if (signal?.aborted || attempt === TREND_REQUEST_RETRIES) throw error

      await new Promise(resolve => setTimeout(resolve, 160))
    }
  }

  throw lastError instanceof Error ? lastError : new Error('行情请求失败')
}

async function fetchTrendWithFallback(query: URLSearchParams, days: 1 | 5, signal?: AbortSignal) {
  let lastError: unknown
  const endpoints: readonly string[] = days === 1
    ? TREND_LIVE_ENDPOINTS
    : TREND_HOSTS.map((host) => {
        const url = new URL(TREND_HISTORY_ENDPOINT)
        url.hostname = host
        return url.toString()
      })

  for (const endpoint of endpoints) {
    const url = new URL(endpoint)
    url.search = query.toString()

    try {
      return await fetchWithRetry(url, signal)
    } catch (error) {
      lastError = error

      if (signal?.aborted) throw error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('行情请求失败')
}

function isAvailableQuote(quote: StockQuote) {
  return Boolean(quote.name && quote.name !== '---')
}

/**
 * Public facade for the two supported data sources. The built-in source is
 * intentionally kept as the default and the external source is never used as
 * a silent fallback.
 */
export async function fetchQuotes(codes: readonly string[]): Promise<StockQuote[]> {
  const settings = useMarketStore()
  if (settings.source === 'external') {
    return fetchExternalQuotes(codes)
  }

  return fetchBuiltInQuotes(codes)
}

export async function fetchTrendSeries(
  code: string,
  days: 1 | 5 = 5,
  signal?: AbortSignal,
  force = false,
): Promise<TrendSeries> {
  const settings = useMarketStore()
  if (settings.source === 'external') {
    return fetchExternalTrendSeries(code, days, signal)
  }

  return fetchBuiltInTrendSeries(code, days, signal, force)
}

export async function fetchDailyKlines(code: string, count = 30, force = false): Promise<StockKline[]> {
  const settings = useMarketStore()
  if (settings.source === 'external') {
    return fetchExternalDailyKlines(code, count, force)
  }

  return fetchBuiltInDailyKlines(code, count, force)
}

export async function searchSecurityCandidates(value: string): Promise<SecurityCandidate[]> {
  const settings = useMarketStore()
  if (settings.source === 'external') {
    return fetchExternalSearch(value)
  }

  return searchBuiltInSecurityCandidates(value)
}

export async function testExternalMarketConnection(): Promise<void> {
  await requestExternal('/v1/capabilities', 'GET')
}

interface ExternalMarketResponse {
  status: number
  body: string
}

async function requestExternal(path: string, method: 'GET' | 'POST', body?: unknown) {
  const settings = useMarketStore()
  const result = await invoke<ExternalMarketResponse>(INVOKE_KEY.MARKET_REQUEST, {
    request: {
      baseUrl: settings.external.baseUrl,
      path,
      method,
      body: body ?? null,
      bearerToken: settings.bearerToken.trim() || null,
      timeoutMs: settings.external.timeoutMs,
    },
  })

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`外接行情返回 HTTP ${result.status}`)
  }

  try {
    return result.body ? JSON.parse(result.body) as unknown : {}
  } catch {
    throw new Error('外接行情返回的不是有效 JSON')
  }
}

async function fetchExternalQuotes(codes: readonly string[]) {
  if (codes.length === 0) return []
  const payload = await requestExternal('/v1/quotes', 'POST', { codes })
  const rows = extractArray<ExternalQuote>(payload, 'quotes')
  return rows.map(normalizeExternalQuote)
}

async function fetchExternalSearch(value: string) {
  const payload = await requestExternal('/v1/search', 'POST', { query: value.trim() })
  const rows = extractArray<ExternalCandidate>(payload, 'candidates')
  return rows
    .map(row => ({ code: String(row.code ?? '').toUpperCase(), name: String(row.name ?? '') }))
    .filter(row => /^(?:SH|SZ)\d{6}$/.test(row.code) && Boolean(row.name))
}

async function fetchExternalTrendSeries(code: string, days: 1 | 5, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  const payload = await requestExternal('/v1/trends', 'POST', { code, days }) as Partial<TrendSeries> & { data?: Partial<TrendSeries> }
  const value = payload.data && Array.isArray(payload.data.points) ? payload.data : payload

  if (!Array.isArray(value.points) || value.points.length === 0) {
    throw new Error('外接行情没有返回分时数据')
  }

  return {
    code: String(value.code ?? code).toUpperCase(),
    name: String(value.name ?? code),
    preClose: Number(value.preClose ?? 0),
    points: value.points.map(normalizeExternalPoint),
    source: value.source === 'tencent' ? 'tencent' : 'eastmoney',
  } satisfies TrendSeries
}

async function fetchExternalDailyKlines(code: string, count: number, _force: boolean) {
  const payload = await requestExternal('/v1/klines', 'POST', { code, period: 'day', count })
  const rows = extractArray<ExternalKline>(payload, 'klines')
  return rows.map(normalizeExternalKline) as StockKline[]
}

interface ExternalQuote {
  code?: string
  name?: string
  now?: number | string
  price?: number | string
  low?: number | string
  high?: number | string
  percent?: number | string
  changePercent?: number | string
  yesterday?: number | string
  preClose?: number | string
}

interface ExternalCandidate { code?: string, name?: string }

interface ExternalKline {
  date?: string
  open?: number | string
  close?: number | string
  high?: number | string
  low?: number | string
  volume?: number | string
}

function extractArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>)[key])) {
    return (payload as Record<string, unknown>)[key] as T[]
  }
  throw new Error(`外接行情响应缺少 ${key} 数组`)
}

function normalizeExternalQuote(row: ExternalQuote): StockQuote {
  const percent = toFiniteNumber(row.percent ?? row.changePercent)
  return {
    code: String(row.code ?? '').toUpperCase(),
    name: String(row.name ?? '---'),
    now: toFiniteNumber(row.now ?? row.price),
    low: toFiniteNumber(row.low),
    high: toFiniteNumber(row.high),
    percent: Math.abs(percent) > 1 ? percent / 100 : percent,
    yesterday: toFiniteNumber(row.yesterday ?? row.preClose),
  }
}

function normalizeExternalPoint(row: Partial<IntradayPoint>): IntradayPoint {
  const timestamp = String(row.timestamp ?? '')
  const [date = timestamp, time = ''] = timestamp.split(' ')
  const close = toFiniteNumber(row.close)
  return {
    timestamp,
    date: String(row.date ?? date),
    time: String(row.time ?? time),
    open: toFiniteNumber(row.open) || close,
    close,
    high: toFiniteNumber(row.high) || close,
    low: toFiniteNumber(row.low) || close,
    volume: toFiniteNumber(row.volume),
    amount: toFiniteNumber(row.amount),
    average: toFiniteNumber(row.average) || close,
  }
}

function normalizeExternalKline(row: ExternalKline) {
  return {
    date: String(row.date ?? ''),
    open: toFiniteNumber(row.open),
    close: toFiniteNumber(row.close),
    high: toFiniteNumber(row.high),
    low: toFiniteNumber(row.low),
    volume: toFiniteNumber(row.volume),
  }
}
