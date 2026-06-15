/**
 * Incremental early-stop wiring helpers (PRD §5, D-7/D-8/D-9).
 *
 * The CORE early-stop lives in lib/xurl-ingest.ts (fetchSourcePages). This module owns
 * the WIRING-LAYER decisions that gate it for the daily incremental run:
 *   - D-8 kill switch (SIFTLY_INCREMENTAL_EARLY_STOP=0)
 *   - D-7 periodic full-walk safety net (every N days, wall-clock via IngestState.lastFullWalkAt)
 *   - D-9 fullWalkReason disambiguation
 *
 * The decision collapses to: "do we pass `knownTweetIds` to ingestXurlSources or not?"
 * Not passing it = full walk (reusing the I3 no-seam path), with a reason recorded.
 */
import type { KnownTweetIdsLookup, XurlSource } from '@/lib/xurl-ingest'

export const DEFAULT_FULLWALK_EVERY_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** Minimal shape of an IngestState row we read for the safety-net cadence. */
export interface IngestStateRow {
  source: string
  lastFullWalkAt?: Date | string | null
}

export type EarlyStopEnv = Record<string, string | undefined>

/** D-8: early-stop is ON unless explicitly disabled with 0/false/no/off. */
export function earlyStopEnabled(env: EarlyStopEnv = process.env): boolean {
  const raw = env.SIFTLY_INCREMENTAL_EARLY_STOP?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}

export function fullWalkEveryDays(env: EarlyStopEnv = process.env): number {
  const raw = Number(env.SIFTLY_INCREMENTAL_FULLWALK_EVERY_DAYS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FULLWALK_EVERY_DAYS
}

export function earlyStopK(env: EarlyStopEnv = process.env): number | undefined {
  const raw = Number(env.SIFTLY_INCREMENTAL_EARLY_STOP_K)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
}

/**
 * D-7/RC-C: wall-clock cadence. A full walk is due when ANY source has never full-walked
 * (lastFullWalkAt null) or its last full walk is ≥ N days old. Robust to dry/failed runs
 * (which bump runCount but not lastFullWalkAt). Returns true on the day a safety-net walk fires.
 */
export function shouldFullWalk(
  states: IngestStateRow[],
  everyDays: number,
  now: Date = new Date(),
): boolean {
  if (everyDays <= 0) return false
  if (states.length === 0) return true // no state yet → take a full walk to establish a baseline
  for (const s of states) {
    const last = s.lastFullWalkAt ? new Date(s.lastFullWalkAt) : null
    if (!last || Number.isNaN(last.getTime())) return true
    if (now.getTime() - last.getTime() >= everyDays * DAY_MS) return true
  }
  return false
}

export type FullWalkReason = 'safety-net' | 'kill-switch'

/** Minimal Prisma delegate shapes the wiring needs (avoids `any` while staying test-friendly). */
export interface BookmarkFindManyDelegate {
  findMany: (args: {
    where: { tweetId: { in: string[] } }
    select: { tweetId: true }
  }) => Promise<{ tweetId: string }[]>
}
export interface IngestStateReadDelegate {
  findUnique: (args: { where: { source: string } }) => Promise<IngestStateRow | null>
}
export interface IngestStateUpsertDelegate {
  upsert: (args: {
    where: { source: string }
    update: { lastFullWalkAt: Date }
    create: { source: string; lastFullWalkAt: Date }
  }) => Promise<unknown>
}

export interface EarlyStopDecision {
  /** Pass this to ingestXurlSources.knownTweetIds (undefined ⇒ full walk). */
  knownTweetIds?: KnownTweetIdsLookup
  earlyStopK?: number
  /** Set when early-stop was deliberately skipped (D-9). undefined ⇒ early-stop active. */
  fullWalkReason?: FullWalkReason
}

/**
 * Decide whether to wire the early-stop probe for this incremental run.
 * Precedence: kill-switch (D-8) > safety-net (D-7) > early-stop on.
 */
export function decideEarlyStop(args: {
  probe: KnownTweetIdsLookup
  states: IngestStateRow[]
  env?: EarlyStopEnv
  now?: Date
}): EarlyStopDecision {
  const env = args.env ?? process.env
  if (!earlyStopEnabled(env)) {
    return { fullWalkReason: 'kill-switch' }
  }
  if (shouldFullWalk(args.states, fullWalkEveryDays(env), args.now)) {
    return { fullWalkReason: 'safety-net' }
  }
  return { knownTweetIds: args.probe, earlyStopK: earlyStopK(env) }
}

/** The default Prisma-backed known-IDs probe (D-2, identity-only over the shared Bookmark table). */
export function makePrismaKnownTweetIds(bookmark: BookmarkFindManyDelegate): KnownTweetIdsLookup {
  return async (ids) => {
    if (ids.length === 0) return new Set()
    const rows = await bookmark.findMany({ where: { tweetId: { in: ids } }, select: { tweetId: true } })
    return new Set(rows.map((r) => r.tweetId))
  }
}

/** Per-source IngestState reader for the cadence check. */
export async function loadIngestStates(
  ingestState: IngestStateReadDelegate | undefined,
  sources: XurlSource[],
): Promise<IngestStateRow[]> {
  if (!ingestState) return []
  const out: IngestStateRow[] = []
  for (const source of sources) {
    const row = await ingestState.findUnique({ where: { source } })
    if (row) out.push(row)
    else out.push({ source, lastFullWalkAt: null }) // missing row ⇒ never full-walked
  }
  return out
}

/**
 * Stamp lastFullWalkAt=now ONLY for sources whose walk terminated by EXHAUSTION
 * (nextCursor === null) — NOT for sources that hit the maxPages ceiling. A ceiling-capped
 * "full walk" did not reach the frontier, so stamping it would reset the cadence on an
 * incomplete recovery and silently defeat the safety net (Opus diff-review B1).
 */
export async function stampFullWalk(
  ingestState: IngestStateUpsertDelegate | undefined,
  exhaustedSources: XurlSource[],
  now: Date = new Date(),
): Promise<void> {
  if (!ingestState) return
  for (const source of exhaustedSources) {
    await ingestState.upsert({
      where: { source },
      update: { lastFullWalkAt: now },
      create: { source, lastFullWalkAt: now },
    })
  }
}
