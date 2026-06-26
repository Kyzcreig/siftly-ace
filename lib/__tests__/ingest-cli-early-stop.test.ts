import { describe, expect, it, vi } from 'vitest'
import { runIngestCli } from '../../scripts/ingest'

vi.mock('../../lib/db', () => ({ default: { $disconnect: vi.fn() } }))

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

/** A db with the bookmark.findMany + ingestState delegates the early-stop wiring needs. */
function dbWithDelegates(opts: { lastFullWalkAt?: Date | null } = {}) {
  const findMany = vi.fn(async () => [] as { tweetId: string }[])
  const findUnique = vi.fn(async ({ where }: any) => ({
    source: where.source,
    lastFullWalkAt: opts.lastFullWalkAt ?? null,
  }))
  const upsert = vi.fn(async () => ({}))
  return {
    db: {
      bookmark: { findMany, findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      ingestState: { findUnique, upsert },
    } as never,
    findMany,
    findUnique,
    upsert,
  }
}

/** An ingest result with controllable per-source nextCursor (exhausted=null vs ceiling-capped). */
function resultWith(nextCursor: { bookmark: string | null; like: string | null }) {
  return {
    ...emptyIngestResult,
    perSource: {
      bookmark: { pages: 5, rows: 450, nextCursor: nextCursor.bookmark },
      like: { pages: 5, rows: 498, nextCursor: nextCursor.like },
    },
  }
}

describe('scripts/ingest.ts — early-stop wiring (Phase 2)', () => {
  it('test_incremental_cli_wires_known_ids: incremental passes the seam, backfill does not', async () => {
    // Incremental, fresh full-walk (so NOT a safety-net day) → seam wired.
    const inc = dbWithDelegates({ lastFullWalkAt: new Date() })
    const ingestInc = vi.fn(async () => emptyIngestResult)
    await runIngestCli(['--incremental', '--max-pages', '5'], {
      db: inc.db, ingest: ingestInc, log: () => {},
    })
    const incArgs = (ingestInc.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(incArgs.resumeFromCursor).toBe(false)
    expect(typeof incArgs.knownTweetIds).toBe('function') // seam wired

    // Backfill → never wires the seam (I2).
    const back = dbWithDelegates({ lastFullWalkAt: new Date() })
    const ingestBack = vi.fn(async () => emptyIngestResult)
    await runIngestCli(['--confirm', '--max-pages', '5'], {
      db: back.db, ingest: ingestBack, log: () => {},
    })
    const backArgs = (ingestBack.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(backArgs.resumeFromCursor).toBe(true)
    expect(backArgs.knownTweetIds).toBeUndefined()
  })

  it('test_kill_switch_omits_seam_and_sets_reason: SIFTLY_INCREMENTAL_EARLY_STOP=0 → full walk + reason', async () => {
    const env = process.env.SIFTLY_INCREMENTAL_EARLY_STOP
    process.env.SIFTLY_INCREMENTAL_EARLY_STOP = '0'
    try {
      const h = dbWithDelegates({ lastFullWalkAt: new Date() })
      const ingest = vi.fn(async () => ({ ...emptyIngestResult }))
      const logs: string[] = []
      await runIngestCli(['--incremental', '--max-pages', '5'], { db: h.db, ingest, log: (m) => logs.push(m) })
      const args = (ingest.mock.calls[0] as unknown[])[0] as Record<string, unknown>
      expect(args.knownTweetIds).toBeUndefined() // no seam
      expect(logs.some((l) => l.includes('reason=kill-switch'))).toBe(true)
    } finally {
      if (env === undefined) delete process.env.SIFTLY_INCREMENTAL_EARLY_STOP
      else process.env.SIFTLY_INCREMENTAL_EARLY_STOP = env
    }
  })

  it('test_safety_net_day_disables_early_stop_and_sets_reason: stale lastFullWalkAt → full walk + stamp', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000) // 30 days ago → due
    const h = dbWithDelegates({ lastFullWalkAt: stale })
    // both sources reach the frontier (nextCursor null) → both get stamped
    const ingest = vi.fn(async () => resultWith({ bookmark: null, like: null }))
    const logs: string[] = []
    await runIngestCli(['--incremental', '--max-pages', '5'], { db: h.db, ingest, log: (m) => logs.push(m) })
    const args = (ingest.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(args.knownTweetIds).toBeUndefined() // safety-net → no seam → full walk
    expect(logs.some((l) => l.includes('reason=safety-net'))).toBe(true)
    expect(h.upsert).toHaveBeenCalledTimes(2) // both sources stamped
  })

  it('test_safety_net_ceiling_capped_walk_STILL_stamps_cadence: a maxPages-capped sweep resets the daily cadence (bugfix 2026-06-26)', async () => {
    // The daily job runs --max-pages 5 against a corpus far larger than 5 pages,
    // so a safety-net walk can NEVER reach the absolute frontier (nextCursor stays
    // non-null). The OLD behavior (stamp only on exhaustion) meant lastFullWalkAt
    // never updated → the safety-net fired EVERY run forever → ~950 reads/night for
    // a handful of new items. The periodic deeper sweep DID happen; its CADENCE must
    // reset so it doesn't re-fire tomorrow. Stamp on a cleanly-completed budgeted
    // sweep regardless of absolute-frontier exhaustion.
    const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const h = dbWithDelegates({ lastFullWalkAt: stale })
    // bookmark hit the page ceiling (nextCursor non-null); like exhausted — BOTH stamp.
    const ingest = vi.fn(async () => resultWith({ bookmark: 'more-pages-cursor', like: null }))
    await runIngestCli(['--incremental', '--max-pages', '5'], { db: h.db, ingest, log: () => {} })
    expect(h.upsert).toHaveBeenCalledTimes(2) // BOTH sources reset the cadence
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { source: 'bookmark' } }))
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { source: 'like' } }))
  })

  it('safety-net interrupted/credit-depleted walk does NOT stamp (an incomplete sweep must not reset cadence)', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const h = dbWithDelegates({ lastFullWalkAt: stale })
    // a walk cut short by credit depletion is NOT a completed sweep → no stamp
    const ingest = vi.fn(async () => ({
      ...resultWith({ bookmark: 'cur', like: 'cur' }),
      creditsDepleted: { source: 'bookmark' as const, status: 402 as const, message: 'out of credits', savedCursor: 'cur', pagesFetched: 3, rowsFetched: 280 },
    }))
    await runIngestCli(['--incremental', '--max-pages', '5'], { db: h.db, ingest, log: () => {} })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('safety-net DRY run does NOT stamp lastFullWalkAt (only real completed walks reset the cadence)', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const h = dbWithDelegates({ lastFullWalkAt: stale })
    const ingest = vi.fn(async () => ({ ...emptyIngestResult }))
    await runIngestCli(['--incremental', '--dry', '--max-pages', '5'], { db: h.db, ingest, log: () => {} })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('a db without bookmark.findMany degrades to a plain full walk (no crash, additive-safe)', async () => {
    const ingest = vi.fn(async () => emptyIngestResult)
    await runIngestCli(['--incremental', '--max-pages', '5'], { db: {} as never, ingest, log: () => {} })
    const args = (ingest.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(args.resumeFromCursor).toBe(false)
    expect(args.knownTweetIds).toBeUndefined()
  })
})
