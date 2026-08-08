import { error as logError, info as logInfo } from '@tauri-apps/plugin-log'
import { stocks } from 'stock-api'

type StockQuote = Awaited<ReturnType<typeof stocks.tencent.getStocks>>[number]

interface QuoteClient {
  getStocks: (codes: string[]) => Promise<StockQuote[]>
}

interface BatchResult {
  error?: string
  latencyMs: number
  received: number
  requested: number
  stocks: StockQuote[]
  success: boolean
  valid: number
}

export const PHASE_1_CODES = [
  'SH600000',
  'SH600036',
  'SH600519',
  'SH601318',
  'SH601398',
  'SH601857',
  'SH601988',
  'SH601288',
  'SH601166',
  'SH601668',
  'SH601888',
  'SH601899',
  'SH601919',
  'SH601728',
  'SH601727',
  'SH601179',
  'SH600030',
  'SH600276',
  'SH600309',
  'SH600887',
  'SZ000001',
  'SZ000002',
  'SZ000333',
  'SZ000651',
  'SZ000858',
  'SZ002594',
  'SZ300750',
  'SZ300059',
  'SZ002415',
  'SZ002475',
] as const

const MATRIX_SIZES = [1, 5, 20, 30] as const

function isValidStock(stock: StockQuote): boolean {
  return stock.name !== '---'
    && Number.isFinite(stock.now)
    && stock.now > 0
    && Number.isFinite(stock.percent)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function requestBatch(
  codes: readonly string[],
  client: QuoteClient = stocks.tencent,
): Promise<BatchResult> {
  const startedAt = performance.now()

  try {
    const result = await client.getStocks([...codes])
    const valid = result.filter(isValidStock).length

    return {
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      received: result.length,
      requested: codes.length,
      stocks: result,
      success: result.length === codes.length && valid === codes.length,
      valid,
    }
  } catch (error) {
    return {
      error: toErrorMessage(error),
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      received: 0,
      requested: codes.length,
      stocks: [],
      success: false,
      valid: 0,
    }
  }
}

async function verifyFailureIsolation(): Promise<void> {
  const result = await requestBatch(PHASE_1_CODES.slice(0, 5), {
    getStocks: async () => {
      throw new Error('intentional Phase 1 isolation check')
    },
  })

  if (result.success || result.error !== 'intentional Phase 1 isolation check') {
    throw new Error('quote failure isolation check failed')
  }

  await logInfo('[Phase 1] failure-isolation=passed')
}

export async function runPhase1PocFromEnv(signal?: AbortSignal): Promise<void> {
  await logInfo('[Phase 1] start provider=tencent mode=single-batch-matrix')
  await verifyFailureIsolation()

  for (const size of MATRIX_SIZES) {
    if (signal?.aborted) return

    const result = await requestBatch(PHASE_1_CODES.slice(0, size))
    const summary = `matrix=${size} requested=${result.requested} received=${result.received} valid=${result.valid} latencyMs=${result.latencyMs}`

    if (result.success) {
      await logInfo(`[Phase 1] ${summary} quotes=${JSON.stringify(result.stocks)}`)
    } else {
      await logError(`[Phase 1] ${summary} error=${result.error ?? 'incomplete quote data'}`)
    }
  }

  await logInfo('[Phase 1] finished; no background polling started')
}
