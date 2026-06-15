import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FULLWALK_EVERY_DAYS,
  decideEarlyStop,
  earlyStopEnabled,
  earlyStopK,
  fullWalkEveryDays,
  loadIngestStates,
  makePrismaKnownTweetIds,
  shouldFullWalk,
  stampFullWalk,
  type IngestStateRow,
} from '@/lib/incremental-early-stop'
import type { KnownTweetIdsLookup } from '@/lib/xurl-ingest'

const probe: KnownTweetIdsLookup = async (ids) => new Set(ids)

describe('incremental early-stop wiring helpers (D-7/D-8/D-9)', () => {
  // ── D-8 kill switch ──
  it('earlyStopEnabled: default on; disabled by 0/false/no/off; on otherwise', () => {
    expect(earlyStopEnabled({})).toBe(true)
    expect(earlyStopEnabled({ SIFTLY_INCREMENTAL_EARLY_STOP: '' })).toBe(true)
    expect(earlyStopEnabled({ SIFTLY_INCREMENTAL_EARLY_STOP: '0' })).toBe(false)
    expect(earlyStopEnabled({ SIFTLY_INCREMENTAL_EARLY_STOP: 'false' })).toBe(false)
    expect(earlyStopEnabled({ SIFTLY_INCREMENTAL_EARLY_STOP: 'OFF' })).toBe(false)
    expect(earlyStopEnabled({ SIFTLY_INCREMENTAL_EARLY_STOP: '1' })).toBe(true)
  })

  it('fullWalkEveryDays / earlyStopK: parse env with sane fallbacks', () => {
    expect(fullWalkEveryDays({})).toBe(DEFAULT_FULLWALK_EVERY_DAYS)
    expect(fullWalkEveryDays({ SIFTLY_INCREMENTAL_FULLWALK_EVERY_DAYS: '3' })).toBe(3)
    expect(fullWalkEveryDays({ SIFTLY_INCREMENTAL_FULLWALK_EVERY_DAYS: 'x' })).toBe(DEFAULT_FULLWALK_EVERY_DAYS)
    expect(earlyStopK({})).toBeUndefined()
    expect(earlyStopK({ SIFTLY_INCREMENTAL_EARLY_STOP_K: '5' })).toBe(5)
  })

  // ── D-7/RC-C wall-clock cadence ──
  it('test_should_full_walk_cadence_walltime: fires when null or ≥ N days; not when fresh', () => {
    const now = new Date('2026-06-15T12:00:00Z')
    // no state yet → baseline full walk
    expect(shouldFullWalk([], 7, now)).toBe(true)
    // never full-walked → due
    expect(shouldFullWalk([{ source: 'bookmark', lastFullWalkAt: null }], 7, now)).toBe(true)
    // fresh (1 day ago) → not due
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 3600 * 1000)
    expect(shouldFullWalk([{ source: 'bookmark', lastFullWalkAt: oneDayAgo }], 7, now)).toBe(false)
    // stale (8 days ago) → due
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000)
    expect(shouldFullWalk([{ source: 'bookmark', lastFullWalkAt: eightDaysAgo }], 7, now)).toBe(true)
    // ANY stale source triggers (per-source independence of cadence)
    expect(
      shouldFullWalk(
        [
          { source: 'bookmark', lastFullWalkAt: oneDayAgo },
          { source: 'like', lastFullWalkAt: eightDaysAgo },
        ],
        7,
        now,
      ),
    ).toBe(true)
    // invalid date string → treated as never-walked → due
    expect(shouldFullWalk([{ source: 'bookmark', lastFullWalkAt: 'not-a-date' }], 7, now)).toBe(true)
  })

  it('cadence is robust to dry/failed runs (no runCount dependence): only lastFullWalkAt matters', () => {
    // The helper has no access to runCount at all — by construction a dry/failed run that
    // bumps runCount but not lastFullWalkAt cannot advance the cadence.
    const now = new Date('2026-06-15T12:00:00Z')
    const fresh = new Date(now.getTime() - 2 * 24 * 3600 * 1000)
    expect(shouldFullWalk([{ source: 'bookmark', lastFullWalkAt: fresh }], 7, now)).toBe(false)
  })

  // ── D-9 decision precedence ──
  it('decideEarlyStop: kill-switch > safety-net > early-stop-on', () => {
    const freshStates: IngestStateRow[] = [{ source: 'bookmark', lastFullWalkAt: new Date() }]
    // kill switch wins even if a full walk would also be due
    expect(
      decideEarlyStop({ probe, states: [], env: { SIFTLY_INCREMENTAL_EARLY_STOP: '0' } }),
    ).toEqual({ fullWalkReason: 'kill-switch' })
    // safety-net day → reason set, no seam
    expect(decideEarlyStop({ probe, states: [], env: {} })).toEqual({ fullWalkReason: 'safety-net' })
    // normal day → seam wired, no reason
    const d = decideEarlyStop({ probe, states: freshStates, env: {} })
    expect(d.fullWalkReason).toBeUndefined()
    expect(d.knownTweetIds).toBe(probe)
  })

  // ── D-2 probe ──
  it('makePrismaKnownTweetIds: identity-only IN query; empty ids short-circuits', async () => {
    const findMany = vi.fn(async ({ where }: any) => {
      const ids: string[] = where.tweetId.in
      return ids.filter((id) => id === 'known').map((tweetId) => ({ tweetId }))
    })
    const p = makePrismaKnownTweetIds({ findMany } as any)
    expect(await p([])).toEqual(new Set())
    expect(findMany).not.toHaveBeenCalled() // empty short-circuits, no query
    expect(await p(['new', 'known'])).toEqual(new Set(['known']))
    expect(findMany).toHaveBeenCalledWith({ where: { tweetId: { in: ['new', 'known'] } }, select: { tweetId: true } })
  })

  // ── state load / stamp ──
  it('loadIngestStates: returns a row per source, synthesizing null for missing', async () => {
    const findUnique = vi.fn(async ({ where }: any) =>
      where.source === 'bookmark' ? { source: 'bookmark', lastFullWalkAt: new Date('2026-06-10') } : null,
    )
    const states = await loadIngestStates({ findUnique } as any, ['bookmark', 'like'])
    expect(states).toHaveLength(2)
    expect(states[1]).toEqual({ source: 'like', lastFullWalkAt: null })
  })

  it('stampFullWalk: upserts lastFullWalkAt for each source', async () => {
    const upsert = vi.fn(async () => ({}))
    const now = new Date('2026-06-15T00:00:00Z')
    await stampFullWalk({ upsert } as any, ['bookmark', 'like'], now)
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledWith({
      where: { source: 'bookmark' },
      update: { lastFullWalkAt: now },
      create: { source: 'bookmark', lastFullWalkAt: now },
    })
  })
})
