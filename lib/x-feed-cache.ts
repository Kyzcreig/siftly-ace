/**
 * X-feed timeline read-through cache (Wave 5 Feature 1).
 *
 * The x-feed-brief cron pulls Ace's full 24h reverse-chronological timeline
 * (~1,300 tweets, ~13 paginated reads, ~$6.50/run). Nothing was cached, so every
 * test rerun re-billed the whole sweep. This module adds a read-through cache:
 * the first run of the day pays; same-day reruns within the TTL cost ZERO reads;
 * stale reruns do a cheap incremental top-up (only pages newer than the cached
 * newest tweet, since the timeline is newest->oldest).
 *
 * This file is PURE LOGIC + IO seams only (no direct xurl dependency) so it is
 * fully unit-testable. The CLI wrapper (scripts/x-feed-fetch.ts) injects the real
 * xurl fetcher and clock.
 */
import { promises as fs } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'

export interface FeedTweet {
  id: string
  text?: string
  author_id?: string
  created_at?: string
  public_metrics?: Record<string, unknown>
  [key: string]: unknown
}

export interface FeedUser {
  id: string
  username?: string
  name?: string
  [key: string]: unknown
}

export interface FeedPage {
  data?: FeedTweet[]
  includes?: { users?: FeedUser[] }
  meta?: { result_count?: number; next_token?: string;[key: string]: unknown }
  errors?: unknown[]
  title?: string
  detail?: string
  status?: number
  [key: string]: unknown
}

export interface CacheMeta {
  fetched_at: string // ISO timestamp the cache was written
  since: string // 24h boundary used for this sweep
  page_count: number // paid pages spent producing this cache
  tweet_count: number
  newest_id: string | null // lexicographically-largest tweet id (X ids are monotonic)
  oldest_id: string | null
  day: string // YYYY-MM-DD logical day key
}

export interface CachePayload {
  meta: CacheMeta
  tweets: FeedTweet[]
  users: FeedUser[]
}

export type CacheStatus =
  | 'hit' // fresh cache within TTL, 0 reads
  | 'incremental' // stale cache, fetched only newer pages
  | 'miss' // no usable cache, full sweep
  | 'forced' // --force / FRESH=1 bypassed read, full sweep
  | 'no-cache' // --no-cache: neither read nor wrote cache

export interface FetchOutcome {
  status: CacheStatus
  tweets: FeedTweet[]
  users: FeedUser[]
  pagesFetched: number // PAID reads this run (0 on a pure hit)
  newCount: number // tweets newer than the prior cache (incremental) or total (miss)
  meta: CacheMeta
  cacheFile: string | null
}

export interface FetchOptions {
  userId?: string
  sinceHours?: number
  maxPages?: number
  ttlMinutes?: number
  force?: boolean // bypass read, full fresh sweep, still write cache
  noCache?: boolean // neither read nor write cache
  cacheDir?: string
  now?: Date
  /** Injected paid page fetcher. Receives a pagination token (undefined = first page). */
  fetchPage: (paginationToken: string | undefined) => Promise<FeedPage>
  logger?: Pick<Console, 'log' | 'warn'>
}

export const DEFAULT_USER_ID = '56282605' // @angalexg
export const DEFAULT_SINCE_HOURS = 24
export const DEFAULT_MAX_PAGES = 20
export const DEFAULT_TTL_MINUTES = 90
export const DEFAULT_CACHE_DIR = path.join(
  userInfo().homedir,
  '.hermes',
  'state',
  'cron',
  'x-feed-brief',
  'cache',
)

/** Logical cache day in America/Los_Angeles (PT) — matches the cron schedule
 *  (`30 7 * * *` fires in local PT) and the seen-list's PT `date` fields, so the
 *  "first run of the day" boundary is the day Ace actually experiences. Using UTC
 *  here was a latent bug: an evening PT rerun crosses into the next UTC day and
 *  would key a stale file under tomorrow's name. */
function isoDay(d: Date): string {
  // en-CA locale yields YYYY-MM-DD; timeZone shifts to PT.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function sinceBoundary(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3600_000).toISOString()
}

/** X tweet ids are 64-bit snowflakes: monotonic by NUMERIC value. Compare as BigInt
 *  (not string length+lex) so the comparison stays correct across digit-length changes
 *  (e.g. an 18-digit legacy id, or the eventual 19->20-digit rollover). */
export function idIsNewer(candidate: string, reference: string): boolean {
  try {
    return BigInt(candidate) > BigInt(reference)
  } catch {
    // Non-numeric id (shouldn't happen for X ids) — fall back to length-then-lex.
    if (candidate.length !== reference.length) return candidate.length > reference.length
    return candidate > reference
  }
}

export function maxId(ids: string[]): string | null {
  let best: string | null = null
  for (const id of ids) {
    if (best === null || idIsNewer(id, best)) best = id
  }
  return best
}

export function minId(ids: string[]): string | null {
  let best: string | null = null
  for (const id of ids) {
    if (best === null || idIsNewer(best, id)) best = id
  }
  return best
}

function cacheFilePath(cacheDir: string, day: string): string {
  return path.join(cacheDir, `timeline-${day}.json`)
}

export async function readCache(cacheDir: string, day: string): Promise<CachePayload | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(cacheDir, day), 'utf8')
    const parsed = JSON.parse(raw) as CachePayload
    if (!parsed?.meta || !Array.isArray(parsed.tweets)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeCache(cacheDir: string, payload: CachePayload): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true })
  const file = cacheFilePath(cacheDir, payload.meta.day)
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

function isFresh(meta: CacheMeta, now: Date, ttlMinutes: number): boolean {
  const age = now.getTime() - new Date(meta.fetched_at).getTime()
  return Number.isFinite(age) && age >= 0 && age < ttlMinutes * 60_000
}

/** Merge new tweets into existing, dedupe by id, newest-first ordering preserved by id. */
export function mergeTweets(existing: FeedTweet[], incoming: FeedTweet[]): FeedTweet[] {
  const byId = new Map<string, FeedTweet>()
  for (const t of existing) if (t?.id) byId.set(t.id, t)
  for (const t of incoming) if (t?.id) byId.set(t.id, t) // incoming wins (fresher)
  return [...byId.values()].sort((a, b) => (idIsNewer(a.id, b.id) ? -1 : 1))
}

export function mergeUsers(existing: FeedUser[], incoming: FeedUser[]): FeedUser[] {
  const byId = new Map<string, FeedUser>()
  for (const u of existing) if (u?.id) byId.set(u.id, u)
  for (const u of incoming) if (u?.id) byId.set(u.id, u)
  return [...byId.values()]
}

/**
 * Paginate the timeline, stopping when: (a) a tweet older than `since` appears
 * (24h window covered), (b) `stopAtId` is reached (incremental top-up — we already
 * have everything from there down), (c) no next_token, or (d) maxPages ceiling.
 */
async function sweep(
  opts: FetchOptions,
  since: string,
  stopAtId: string | null,
): Promise<{ tweets: FeedTweet[]; users: FeedUser[]; pages: number; reachedKnown: boolean }> {
  const log = opts.logger ?? console
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const tweets: FeedTweet[] = []
  const users: FeedUser[] = []
  let token: string | undefined
  let pages = 0
  let reachedKnown = false

  while (pages < maxPages) {
    pages += 1
    const page = await opts.fetchPage(token)
    const status = typeof page?.status === 'number' ? page.status : undefined
    if (page?.title || (status && status >= 400)) {
      throw new Error(`x-feed timeline page ${pages} API error: ${page.title ?? status ?? 'unknown'} ${page.detail ?? ''}`.trim())
    }
    const data = Array.isArray(page.data) ? page.data : []
    const pageUsers = page.includes?.users ?? []
    for (const u of pageUsers) users.push(u)

    let crossedWindow = false
    for (const t of data) {
      if (!t?.id) continue
      if (stopAtId && !idIsNewer(t.id, stopAtId)) {
        // We've reached tweets we already cached; stop (don't include this/older).
        reachedKnown = true
        break
      }
      if (t.created_at && t.created_at < since) {
        crossedWindow = true
        break
      }
      tweets.push(t)
    }

    if (reachedKnown) {
      log.log(`x-feed: reached cached newest id ${stopAtId} on page ${pages}; stopping incremental sweep`)
      break
    }
    if (crossedWindow) {
      log.log(`x-feed: crossed 24h boundary (since=${since}) on page ${pages}; sweep complete`)
      break
    }
    token = page.meta?.next_token
    if (!token) {
      log.log(`x-feed: no more pages after page ${pages}`)
      break
    }
  }
  if (pages >= maxPages && token) {
    log.warn(`x-feed: hit ${maxPages}-page ceiling; sweep capped (cost-safety)`)
  }
  return { tweets, users, pages, reachedKnown }
}

export async function fetchTimeline(opts: FetchOptions): Promise<FetchOutcome> {
  const log = opts.logger ?? console
  const now = opts.now ?? new Date()
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR
  const day = isoDay(now)
  const since = sinceBoundary(now, sinceHours)

  const buildMeta = (tweets: FeedTweet[], pageCount: number): CacheMeta => {
    const ids = tweets.map((t) => t.id).filter(Boolean)
    return {
      fetched_at: now.toISOString(),
      since,
      page_count: pageCount,
      tweet_count: tweets.length,
      newest_id: maxId(ids),
      oldest_id: minId(ids),
      day,
    }
  }

  // --no-cache: neither read nor write.
  if (opts.noCache) {
    const { tweets, users, pages } = await sweep(opts, since, null)
    log.log(`x-feed: cache DISABLED (--no-cache); full sweep, ${pages} reads, ${tweets.length} tweets`)
    return { status: 'no-cache', tweets, users, pagesFetched: pages, newCount: tweets.length, meta: buildMeta(tweets, pages), cacheFile: null }
  }

  const existing = opts.force ? null : await readCache(cacheDir, day)

  // Fresh cache within TTL -> pure hit, ZERO reads.
  if (existing && isFresh(existing.meta, now, ttlMinutes)) {
    const ageMin = Math.round((now.getTime() - new Date(existing.meta.fetched_at).getTime()) / 60_000)
    log.log(`x-feed: cache HIT (0 reads) — ${existing.tweets.length} tweets, age ${ageMin}m < TTL ${ttlMinutes}m`)
    return {
      status: 'hit',
      tweets: existing.tweets,
      users: existing.users ?? [],
      pagesFetched: 0,
      newCount: 0,
      meta: existing.meta,
      cacheFile: cacheFilePath(cacheDir, day),
    }
  }

  // Stale same-day cache -> incremental top-up (only pages newer than cached newest id).
  if (existing && existing.meta.newest_id) {
    // ANCHOR the retained window to the cache's ORIGINAL sweep boundary, not a per-run
    // recomputed `since`. Re-trimming the merged set against `now-24h` would silently
    // delete still-valid cached tweets (a tweet 23h old at first cache is 24h+ on a later
    // rerun), shrinking the window below a fresh sweep's. Fetch new pages bounded by the
    // original window; keep ALL existing cached tweets; only newly-fetched tweets are
    // window-checked (the sweep already stops at the boundary).
    const windowSince = existing.meta.since || since
    const { tweets: fresh, users: freshUsers, pages } = await sweep(opts, windowSince, existing.meta.newest_id)
    const merged = mergeTweets(existing.tweets, fresh)
    const mergedUsers = mergeUsers(existing.users ?? [], freshUsers)
    const meta: CacheMeta = { ...buildMeta(merged, (existing.meta.page_count ?? 0) + pages), since: windowSince }
    const payload: CachePayload = { meta, tweets: merged, users: mergedUsers }
    const file = await writeCache(cacheDir, payload)
    log.log(`x-feed: cache INCREMENTAL — ${pages} reads, merged ${fresh.length} new (total ${merged.length}, window since ${windowSince})`)
    return { status: 'incremental', tweets: merged, users: mergedUsers, pagesFetched: pages, newCount: fresh.length, meta, cacheFile: file }
  }

  // Miss (or forced) -> full sweep, write cache.
  const { tweets, users, pages } = await sweep(opts, since, null)
  const meta = buildMeta(tweets, pages)
  const payload: CachePayload = { meta, tweets, users }
  const file = await writeCache(cacheDir, payload)
  const label = opts.force ? 'FORCED' : 'MISS'
  log.log(`x-feed: cache ${label} (full sweep) — ${pages} reads, ${tweets.length} tweets (~$${(pages * 0.5).toFixed(2)} at $0.005/read×100)`)
  return { status: opts.force ? 'forced' : 'miss', tweets, users, pagesFetched: pages, newCount: tweets.length, meta, cacheFile: file }
}
