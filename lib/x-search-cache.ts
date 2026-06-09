/**
 * Read-through cache for the x-feed brief's interest `search/recent` calls — Wave 5 RC2.
 *
 * The brief supplements the timeline with 3 fixed interest searches
 * (`/2/tweets/search/recent?query=…`), ~20 reads each (~$0.30/run). Like the timeline
 * cache, the first run of the PT day pays; same-day reruns within the TTL cost ZERO reads.
 *
 * Unlike the timeline, interest searches are SINGLE-PAGE (no pagination) and there are a
 * fixed small set of them, so the cache is simpler: one PT-day file holding the raw API
 * response per query, keyed by a stable hash of the (sorted) query set. A query-set change
 * invalidates the cache (different key → MISS), so editing the queries never serves stale
 * results for the wrong query.
 *
 * Pure module (no network, no process state) so it is deterministically unit-testable;
 * the CLI (`scripts/x-search-fetch.ts`) injects the real fetch.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'

/** A single interest query and the raw X API response captured for it. */
export interface SearchQueryResult {
  query: string
  /** Raw `data[]` tweets exactly as returned (verbatim text preserved). */
  data: unknown[]
  /** Raw `includes.users[]` (author records) for author→handle matching. */
  users: unknown[]
}

export interface SearchCacheMeta {
  day: string // PT logical day, YYYY-MM-DD
  fetched_at: string // ISO timestamp of the paid fetch
  query_key: string // hash of the sorted query set
  queries: string[] // the exact queries this file covers (sorted)
}

export interface SearchCachePayload {
  meta: SearchCacheMeta
  results: SearchQueryResult[]
}

export type SearchCacheStatus =
  | 'hit' // fresh cache within TTL for this exact query set → 0 reads
  | 'miss' // no usable cache → full fetch of every query
  | 'forced' // caller forced a fresh fetch (--force)
  | 'bypassed' // caller disabled the cache (--no-cache)

export interface SearchFetchOutcome {
  status: SearchCacheStatus
  results: SearchQueryResult[]
  queriesFetched: number // number of queries that hit the real API (0 on cache hit)
  readsApprox: number // ~queriesFetched * pageSize, for cost logging
  cacheFile?: string
  day: string
}

export interface SearchFetchOptions {
  queries: string[]
  /** Inject the real per-query fetch. Must resolve `{data, users}` or throw on API error. */
  fetchQuery: (query: string) => Promise<{ data: unknown[]; users: unknown[] }>
  now?: Date
  cacheDir?: string
  ttlMinutes?: number
  pageSize?: number // ~reads per query, for cost estimate only
  force?: boolean
  noCache?: boolean
  logger?: Pick<Console, 'log' | 'warn'>
}

export const DEFAULT_TTL_MINUTES = 90
export const DEFAULT_PAGE_SIZE = 20
export const DEFAULT_CACHE_DIR = path.join(
  userInfo().homedir,
  '.hermes',
  'state',
  'cron',
  'x-feed-brief',
  'cache',
)

/** PT logical day — matches the cron schedule + timeline cache + seen-list dates. */
export function isoDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** Stable key for a query SET (order-independent): sort, join, sha1 (first 12). */
export function queryKey(queries: string[]): string {
  const norm = [...queries].map((q) => q.trim()).sort()
  return createHash('sha1').update(norm.join('\u0000')).digest('hex').slice(0, 12)
}

function cacheFilePath(cacheDir: string, day: string, key: string): string {
  return path.join(cacheDir, `interest-${day}-${key}.json`)
}

export async function readSearchCache(
  cacheDir: string,
  day: string,
  key: string,
): Promise<SearchCachePayload | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(cacheDir, day, key), 'utf8')
    const parsed = JSON.parse(raw) as SearchCachePayload
    if (!parsed?.meta || !Array.isArray(parsed.results)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeSearchCache(
  cacheDir: string,
  payload: SearchCachePayload,
): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true })
  const file = cacheFilePath(cacheDir, payload.meta.day, payload.meta.query_key)
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

export function isFresh(meta: SearchCacheMeta, now: Date, ttlMinutes: number): boolean {
  const age = now.getTime() - new Date(meta.fetched_at).getTime()
  return Number.isFinite(age) && age >= 0 && age < ttlMinutes * 60_000
}

/**
 * Read-through fetch for the interest searches. Fresh same-day cache for the exact
 * query set → 0 reads. Otherwise fetch every query once and cache.
 */
export async function fetchInterestSearches(
  opts: SearchFetchOptions,
): Promise<SearchFetchOutcome> {
  const log = opts.logger ?? console
  const now = opts.now ?? new Date()
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const day = isoDay(now)
  const key = queryKey(opts.queries)

  const fetchAll = async (status: SearchCacheStatus): Promise<SearchFetchOutcome> => {
    const results: SearchQueryResult[] = []
    for (const query of opts.queries) {
      const { data, users } = await opts.fetchQuery(query)
      results.push({ query, data, users })
    }
    const readsApprox = opts.queries.length * pageSize
    let cacheFile: string | undefined
    if (status !== 'bypassed') {
      const payload: SearchCachePayload = {
        meta: { day, fetched_at: now.toISOString(), query_key: key, queries: [...opts.queries].sort() },
        results,
      }
      cacheFile = await writeSearchCache(cacheDir, payload)
    }
    log.log(
      `x-search: ${status.toUpperCase()} — fetched ${opts.queries.length} queries (~${readsApprox} reads)`,
    )
    return { status, results, queriesFetched: opts.queries.length, readsApprox, cacheFile, day }
  }

  if (opts.noCache) return fetchAll('bypassed')
  if (opts.force) return fetchAll('forced')

  const existing = await readSearchCache(cacheDir, day, key)
  if (existing && isFresh(existing.meta, now, ttlMinutes)) {
    const ageMin = Math.round((now.getTime() - new Date(existing.meta.fetched_at).getTime()) / 60_000)
    log.log(
      `x-search: cache HIT (0 reads) — ${existing.results.length} queries, age ${ageMin}m < TTL ${ttlMinutes}m`,
    )
    return {
      status: 'hit',
      results: existing.results,
      queriesFetched: 0,
      readsApprox: 0,
      cacheFile: cacheFilePath(cacheDir, day, key),
      day,
    }
  }

  return fetchAll('miss')
}
