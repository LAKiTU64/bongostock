import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'
import { useMarketStore } from '@/stores/market'

export interface StockQuote {
  code: string
  name: string
  now: number
  low: number
  high: number
  percent: number
  yesterday: number
}

export type SecurityCandidate = Pick<StockQuote, 'code' | 'name'>

export interface StockKline {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  source?: string
}

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

/**
 * Public facade for market data. All data comes from the external
 * BongoStock API v1 (cloud) — there is no built-in local data source.
 */
export async function fetchQuotes(codes: readonly string[]): Promise<StockQuote[]> {
  return fetchExternalQuotes(codes)
}

export async function fetchTrendSeries(
  code: string,
  days: 1 | 5 = 5,
  signal?: AbortSignal,
  _force = false,
): Promise<TrendSeries> {
  return fetchExternalTrendSeries(code, days, signal)
}

export async function fetchDailyKlines(code: string, count = 30, force = false): Promise<StockKline[]> {
  return fetchExternalDailyKlines(code, count, force)
}

export async function searchSecurityCandidates(value: string): Promise<SecurityCandidate[]> {
  return fetchExternalSearch(value)
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
  const payload = await requestExternal('/v1/klines', 'POST', { code, period: 'day', count, adjust: 'qfq' })
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
  source?: string
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

function normalizeExternalKline(row: ExternalKline): StockKline {
  return {
    date: String(row.date ?? ''),
    open: toFiniteNumber(row.open),
    close: toFiniteNumber(row.close),
    high: toFiniteNumber(row.high),
    low: toFiniteNumber(row.low),
    volume: toFiniteNumber(row.volume),
    source: row.source,
  }
}

function toFiniteNumber(value: string | number | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
