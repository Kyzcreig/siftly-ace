import { describe, expect, it, vi } from 'vitest'
import { checkCreditFloor } from '@/lib/credit-guard'
import { runDailyIngest, DEFAULT_INGEST_MAX_PAGES, DEFAULT_PAGE_SIZE } from '../../scripts/daily-ingest'

vi.mock('../../lib/db', () => ({ default: { $disconnect: vi.fn() } }))

const SOURCE_COUNT = 2
const RESERVE = 50_000

describe('credit-floor at the raised incremental ceiling (RC-D / D-3)', () => {
  it('test_credit_floor_passes_at_raised_ceiling: batchCap = maxPages×pageSize×sources is passed and well under reserve', async () => {
    const expectedBatchCap = DEFAULT_INGEST_MAX_PAGES * DEFAULT_PAGE_SIZE * SOURCE_COUNT
    // sanity: the raised ceiling (5) yields 5×100×2 = 1000, far below the 50k reserve.
    expect(expectedBatchCap).toBe(1000)
    expect(expectedBatchCap).toBeLessThan(RESERVE)

    const checkCreditFloor = vi.fn().mockResolvedValue({
      remaining: 1_990_000, reserve: RESERVE, ok: true, reason: 'ample',
    })
    await runDailyIngest({
      checkCreditFloor,
      runStage: vi.fn(async () => ({ sourceRows: { bookmark: 0, like: 0 } })),
      sendAlert: vi.fn(),
      sendHeartbeat: vi.fn(),
      stages: [{ name: 'ingest', command: 'x', args: [] }],
      wallBudgetMs: 10_000,
      config: { env: { SIFTLY_DAILY_CRON: '1' } as never },
    })
    // The cron passes the ceiling-derived batchCap so the off-window fallback can proceed.
    expect(checkCreditFloor).toHaveBeenCalledWith(
      expect.objectContaining({ batchCap: expectedBatchCap, offWindow: true }),
    )
  })

  it('the REAL checkCreditFloor proceeds at batchCap=1000 when balance is unavailable off-window', async () => {
    // 200 but missing numeric data → balanceUnavailable path; with batchCap ≤ reserve
    // and offWindow it must return ok:true (proceed under the batch cap).
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    )
    const result = await checkCreditFloor({
      reserve: RESERVE,
      batchCap: DEFAULT_INGEST_MAX_PAGES * DEFAULT_PAGE_SIZE * SOURCE_COUNT, // 1000
      offWindow: true,
      bearer: 'app-only-bearer',
      fetchImpl: fetchImpl as never,
      logger: { warn: () => {} },
    })
    expect(result.ok).toBe(true)
    expect(result.balanceUnavailable).toBe(true)
  })
})
