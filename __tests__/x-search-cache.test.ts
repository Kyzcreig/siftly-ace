import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchInterestSearches,
  queryKey,
  readSearchCache,
  isFresh,
  isoDay,
  type SearchFetchOptions,
} from '@/lib/x-search-cache'

let cacheDir: string
const silent = { log: () => {}, warn: () => {} }

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'x-search-cache-'))
})
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

const QUERIES = ['AI agents framework launch', 'AI coding tool release', 'open source model release']

function makeFetch() {
  return vi.fn(async (query: string) => ({
    data: [{ id: '1', text: `result for ${query}`, author_id: 'a' }],
    users: [{ id: 'a', username: 'someone', name: 'Some One' }],
  }))
}

function opts(over: Partial<SearchFetchOptions> = {}): SearchFetchOptions {
  return { queries: QUERIES, fetchQuery: makeFetch(), cacheDir, logger: silent, ...over }
}

describe('x-search-cache (RC2 — interest-search read-through cache)', () => {
  it('cold MISS fetches every query and writes a cache file', async () => {
    const fetchQuery = makeFetch()
    const out = await fetchInterestSearches(opts({ fetchQuery, now: new Date('2026-06-09T15:00:00Z') }))
    expect(out.status).toBe('miss')
    expect(out.queriesFetched).toBe(3)
    expect(fetchQuery).toHaveBeenCalledTimes(3)
    expect(out.readsApprox).toBe(60)
    expect(out.cacheFile).toBeTruthy()
    expect(out.results).toHaveLength(3)
  })

  it('warm HIT within TTL costs ZERO reads (does not call fetch at all)', async () => {
    const now = new Date('2026-06-09T15:00:00Z')
    await fetchInterestSearches(opts({ fetchQuery: makeFetch(), now }))

    const fetchQuery = makeFetch()
    const warm = await fetchInterestSearches(
      opts({ fetchQuery, now: new Date('2026-06-09T15:30:00Z') }), // +30m < 90m TTL
    )
    expect(warm.status).toBe('hit')
    expect(warm.queriesFetched).toBe(0)
    expect(warm.readsApprox).toBe(0)
    expect(fetchQuery).not.toHaveBeenCalled()
    expect(warm.results).toHaveLength(3)
  })

  it('stale cache past TTL re-fetches (MISS)', async () => {
    const now = new Date('2026-06-09T15:00:00Z')
    await fetchInterestSearches(opts({ fetchQuery: makeFetch(), now }))

    const fetchQuery = makeFetch()
    const stale = await fetchInterestSearches(
      opts({ fetchQuery, now: new Date('2026-06-09T17:00:00Z') }), // +120m > 90m TTL
    )
    expect(stale.status).toBe('miss')
    expect(fetchQuery).toHaveBeenCalledTimes(3)
  })

  it('SAFETY: changing the query set invalidates the cache (different key → MISS, not stale wrong-query results)', async () => {
    const now = new Date('2026-06-09T15:00:00Z')
    await fetchInterestSearches(opts({ fetchQuery: makeFetch(), now }))

    // Edit one query — must NOT serve the old cache.
    const changed = ['AI agents framework launch', 'AI coding tool release', 'DIFFERENT TOPIC']
    const fetchQuery = makeFetch()
    const out = await fetchInterestSearches(
      opts({ queries: changed, fetchQuery, now: new Date('2026-06-09T15:10:00Z') }),
    )
    expect(out.status).toBe('miss')
    expect(fetchQuery).toHaveBeenCalledTimes(3)
  })

  it('queryKey is order-independent (same set, any order → same key)', () => {
    expect(queryKey(['a', 'b', 'c'])).toBe(queryKey(['c', 'a', 'b']))
    expect(queryKey(['a', 'b'])).not.toBe(queryKey(['a', 'b', 'c']))
  })

  it('--force fetches fresh even with a warm cache, and updates the cache', async () => {
    const now = new Date('2026-06-09T15:00:00Z')
    await fetchInterestSearches(opts({ fetchQuery: makeFetch(), now }))
    const fetchQuery = makeFetch()
    const out = await fetchInterestSearches(
      opts({ fetchQuery, force: true, now: new Date('2026-06-09T15:05:00Z') }),
    )
    expect(out.status).toBe('forced')
    expect(fetchQuery).toHaveBeenCalledTimes(3)
    expect(out.cacheFile).toBeTruthy()
  })

  it('--no-cache fetches and does NOT write a cache file', async () => {
    const fetchQuery = makeFetch()
    const out = await fetchInterestSearches(
      opts({ fetchQuery, noCache: true, now: new Date('2026-06-09T15:00:00Z') }),
    )
    expect(out.status).toBe('bypassed')
    expect(out.cacheFile).toBeUndefined()
    // nothing persisted
    const onDisk = await readSearchCache(cacheDir, isoDay(new Date('2026-06-09T15:00:00Z')), queryKey(QUERIES))
    expect(onDisk).toBeNull()
  })

  it('PT day key: an evening-PT fetch keys to the PT day, next morning is a fresh MISS', async () => {
    // 2026-06-09T05:00Z = 2026-06-08 22:00 PT -> PT day 2026-06-08
    const evening = new Date('2026-06-09T05:00:00Z')
    expect(isoDay(evening)).toBe('2026-06-08')
    await fetchInterestSearches(opts({ fetchQuery: makeFetch(), now: evening }))

    // Next morning 2026-06-09T14:30Z = 07:30 PT -> PT day 2026-06-09 -> different file -> MISS
    const morning = new Date('2026-06-09T14:30:00Z')
    expect(isoDay(morning)).toBe('2026-06-09')
    const fetchQuery = makeFetch()
    const out = await fetchInterestSearches(opts({ fetchQuery, now: morning }))
    expect(out.status).toBe('miss')
    expect(fetchQuery).toHaveBeenCalledTimes(3)
  })

  it('propagates a fetch error (API failure surfaces, not silently cached)', async () => {
    const fetchQuery = vi.fn(async () => { throw new Error('402 CreditsDepleted') })
    await expect(
      fetchInterestSearches(opts({ fetchQuery, now: new Date('2026-06-09T15:00:00Z') })),
    ).rejects.toThrow(/402/)
    // nothing cached on failure
    const onDisk = await readSearchCache(cacheDir, isoDay(new Date('2026-06-09T15:00:00Z')), queryKey(QUERIES))
    expect(onDisk).toBeNull()
  })

  it('isFresh: boundary — exactly at TTL is stale, just under is fresh', () => {
    const meta = { day: '2026-06-09', fetched_at: '2026-06-09T15:00:00.000Z', query_key: 'k', queries: QUERIES }
    expect(isFresh(meta, new Date('2026-06-09T16:29:00.000Z'), 90)).toBe(true)
    expect(isFresh(meta, new Date('2026-06-09T16:30:00.000Z'), 90)).toBe(false)
  })
})
