import { describe, expect, it, vi } from 'vitest'

import {
  estimatePageCeilingCost,
  estimatePostReadCost,
  formatCostEstimate,
} from '../cost-estimate'
import { runIngestCli } from '../../scripts/ingest'

vi.mock('../../lib/db', () => ({
  default: { $disconnect: vi.fn() },
}))

const emptyIngestResult = {
  pagesFetched: 0,
  rowsFetched: 0,
  rowsDeduped: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  perSource: {
    bookmark: { pages: 0, rows: 0, nextCursor: null },
    like: { pages: 0, rows: 0, nextCursor: null },
  },
}

describe('xurl ingest cost estimate', () => {
  it('formats post-read costs at $0.005/read', () => {
    const estimate = estimatePostReadCost(4000)

    expect(estimate.reads).toBe(4000)
    expect(estimate.rateUsdPerRead).toBe(0.005)
    expect(estimate.costUsd).toBe(20)
    expect(estimate.formattedCostUsd).toBe('20.00')
    expect(formatCostEstimate(estimate)).toBe('est: 4000 reads ~= $20.00 (rate $0.005/read)')
  })

  it('uses maxPages * pageSize as the read-only full-run ceiling', () => {
    const estimate = estimatePageCeilingCost({ maxPages: 50, pageSize: 100 })

    expect(estimate.reads).toBe(5000)
    expect(estimate.costUsd).toBe(25)
  })

  it('prints an estimate and exits without ingesting when a non-dry full run lacks --confirm', async () => {
    const logs: string[] = []
    const ingest = vi.fn(async () => emptyIngestResult)

    await runIngestCli(['--max-pages', '40', '--page-size', '100'], {
      db: {} as never,
      ingest,
      log: (message) => logs.push(message),
    })

    expect(logs).toEqual(['est: 4000 reads ~= $20.00 (rate $0.005/read)'])
    expect(ingest).not.toHaveBeenCalled()
  })

  it('--confirm prints the estimate and then ingests a non-dry full run', async () => {
    const logs: string[] = []
    const ingest = vi.fn(async () => emptyIngestResult)

    await runIngestCli(['--confirm', '--max-pages', '40', '--page-size', '100'], {
      db: {} as never,
      ingest,
      log: (message) => logs.push(message),
    })

    expect(logs[0]).toBe('est: 4000 reads ~= $20.00 (rate $0.005/read)')
    expect(ingest).toHaveBeenCalledOnce()
  })

  it('--incremental skips the estimate gate and proceeds without an estimate', async () => {
    const logs: string[] = []
    const ingest = vi.fn(async () => emptyIngestResult)

    await runIngestCli(['--incremental', '--max-pages', '40', '--page-size', '100'], {
      db: {} as never,
      ingest,
      log: (message) => logs.push(message),
    })

    expect(logs.some((line) => line.startsWith('est: '))).toBe(false)
    expect(ingest).toHaveBeenCalledOnce()
  })
})
