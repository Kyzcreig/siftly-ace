import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  fetchTimeline,
  readCache,
  mergeTweets,
  idIsNewer,
  maxId,
  minId,
  type FeedPage,
  type FeedTweet,
} from '../lib/x-feed-cache'

// Build a fake timeline page. ids are zero-padded so lexicographic == numeric order.
function tweet(id: number, minutesAgo: number, now: Date): FeedTweet {
  return {
    id: String(id).padStart(19, '0'),
    text: `tweet ${id}`,
    author_id: 'a1',
    created_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  }
}

function page(tweets: FeedTweet[], nextToken?: string): FeedPage {
  return {
    data: tweets,
    includes: { users: [{ id: 'a1', username: 'alice', name: 'Alice' }] },
    meta: { result_count: tweets.length, ...(nextToken ? { next_token: nextToken } : {}) },
  }
}

const silent = { log: () => {}, warn: () => {} }

describe('x-feed-cache helpers', () => {
  it('idIsNewer / maxId / minId order snowflake ids by NUMERIC value (BigInt, not lex)', () => {
    const a = '1000000000000000001'
    const b = '1000000000000000002'
    expect(idIsNewer(b, a)).toBe(true)
    expect(idIsNewer(a, b)).toBe(false)
    expect(maxId([a, b])).toBe(b)
    expect(minId([a, b])).toBe(a)
    // cross-digit-length: a 20-digit id is numerically larger than a 19-digit id
    expect(idIsNewer('10000000000000000000', a)).toBe(true)
    // REGRESSION (B1.2): lexicographic compare would call a shorter-but-larger-prefix id
    // "older"; BigInt gets it right. '900...'(18d) < '1000...'(19d) numerically.
    expect(idIsNewer('1000000000000000000', '999999999999999999')).toBe(true)
    expect(idIsNewer('999999999999999999', '1000000000000000000')).toBe(false)
  })

  it('mergeTweets dedupes by id and sorts newest-first', () => {
    const now = new Date('2026-06-08T20:00:00Z')
    const merged = mergeTweets([tweet(1, 60, now)], [tweet(2, 10, now), tweet(1, 60, now)])
    expect(merged.map((t) => t.text)).toEqual(['tweet 2', 'tweet 1'])
  })
})

describe('fetchTimeline read-through cache', () => {
  let dir: string
  const now = new Date('2026-06-08T20:00:00Z')

  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'xfeed-cache-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('MISS: full sweep paginates to 24h boundary, writes cache', async () => {
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async (token) => {
        calls += 1
        if (!token) return page([tweet(100, 10, now), tweet(99, 30, now)], 'p2')
        return page([tweet(98, 60, now), tweet(1, 60 * 25, now) /* older than 24h */])
      },
    })
    expect(out.status).toBe('miss')
    expect(calls).toBe(2)
    expect(out.pagesFetched).toBe(2)
    expect(out.tweets.map((t) => t.id.slice(-3))).toEqual(['100', '099', '098']) // older-than-24h dropped
    const cached = await readCache(dir, '2026-06-08')
    expect(cached?.meta.tweet_count).toBe(3)
    expect(cached?.meta.newest_id?.slice(-3)).toBe('100')
  })

  it('HIT: fresh cache within TTL does ZERO reads', async () => {
    // seed cache via a MISS
    await fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async () => page([tweet(100, 10, now), tweet(1, 60 * 25, now)]),
    })
    // rerun 5 min later, TTL 90
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, ttlMinutes: 90, now: new Date(now.getTime() + 5 * 60_000), logger: silent,
      fetchPage: async () => { calls += 1; return page([]) },
    })
    expect(out.status).toBe('hit')
    expect(calls).toBe(0)
    expect(out.pagesFetched).toBe(0)
    expect(out.tweets.length).toBe(1)
  })

  it('INCREMENTAL: stale cache fetches only pages newer than cached newest id', async () => {
    await fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async () => page([tweet(100, 10, now), tweet(99, 30, now), tweet(1, 60 * 25, now)]),
    })
    // 2h later (TTL 90 -> stale). New tweets 102,101 then we hit cached 100 -> stop.
    const later = new Date(now.getTime() + 120 * 60_000)
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, ttlMinutes: 90, now: later, logger: silent,
      fetchPage: async (token) => {
        calls += 1
        if (!token) return page([tweet(102, 5, later), tweet(101, 8, later), tweet(100, 130, later)], 'p2')
        return page([tweet(99, 150, later)]) // should never be fetched (we stop at 100)
      },
    })
    expect(out.status).toBe('incremental')
    expect(calls).toBe(1) // stopped after reaching cached newest id on page 1
    expect(out.newCount).toBe(2) // 102, 101
    // merged set still bounded to 24h window and deduped
    expect(out.tweets.some((t) => t.id.slice(-3) === '102')).toBe(true)
    expect(out.tweets.some((t) => t.id.slice(-3) === '100')).toBe(true)
  })

  it('FORCED: --force bypasses fresh cache and does a full sweep', async () => {
    await fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async () => page([tweet(100, 10, now), tweet(1, 60 * 25, now)]),
    })
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, force: true, now: new Date(now.getTime() + 60_000), logger: silent,
      fetchPage: async () => { calls += 1; return page([tweet(200, 5, now), tweet(1, 60 * 25, now)]) },
    })
    expect(out.status).toBe('forced')
    expect(calls).toBe(1)
    expect(out.tweets[0].id.slice(-3)).toBe('200')
  })

  it('NO-CACHE: neither reads nor writes cache', async () => {
    const out = await fetchTimeline({
      cacheDir: dir, noCache: true, now, logger: silent,
      fetchPage: async () => page([tweet(100, 10, now), tweet(1, 60 * 25, now)]),
    })
    expect(out.status).toBe('no-cache')
    expect(out.cacheFile).toBeNull()
    expect(await readCache(dir, '2026-06-08')).toBeNull()
  })

  it('20-page ceiling caps a runaway sweep', async () => {
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, now, maxPages: 20, logger: silent,
      // every page is recent and always returns a next_token -> would never stop without the cap
      fetchPage: async () => { calls += 1; return page([tweet(1000 + calls, 1, now)], `p${calls + 1}`) },
    })
    expect(out.status).toBe('miss')
    expect(calls).toBe(20)
    expect(out.pagesFetched).toBe(20)
  })

  it('propagates a 402 CreditsDepleted page as an error (does not silently cache empty)', async () => {
    await expect(fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async () => ({ status: 402, title: 'CreditsDepleted', detail: 'out of credits' }),
    })).rejects.toThrow(/402|CreditsDepleted/)
    expect(await readCache(dir, '2026-06-08')).toBeNull()
  })

  it('cache file is valid JSON with meta + tweets', async () => {
    const out = await fetchTimeline({
      cacheDir: dir, now, logger: silent,
      fetchPage: async () => page([tweet(100, 10, now), tweet(1, 60 * 25, now)]),
    })
    const raw = await readFile(out.cacheFile!, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.meta.day).toBe('2026-06-08')
    expect(Array.isArray(parsed.tweets)).toBe(true)
  })

  it('REGRESSION B1.1: incremental top-up does NOT shrink the window against a moving since', async () => {
    // Seed at 13:00 PT with a tweet that is 23h old. fetched_at recorded.
    const seedNow = new Date('2026-06-08T20:00:00Z')
    await fetchTimeline({
      cacheDir: dir, now: seedNow, logger: silent,
      fetchPage: async () => page([
        tweet(100, 10, seedNow), // fresh
        tweet(50, 23 * 60, seedNow), // 23h old — inside window at seed time
        tweet(1, 26 * 60, seedNow), // 26h old — dropped on the seeding sweep
      ]),
    })
    const seeded = await readCache(dir, '2026-06-08')
    expect(seeded!.tweets.some((t) => t.id.slice(-2) === '50')).toBe(true) // 23h tweet retained at seed

    // Rerun 2h later (TTL 90 -> stale). New tweet 102. The 23h-old tweet is now ~25h old.
    // BUG would re-trim it against now-24h and DELETE it. Fixed code anchors to original window.
    const later = new Date(seedNow.getTime() + 120 * 60_000)
    const out = await fetchTimeline({
      cacheDir: dir, ttlMinutes: 90, now: later, logger: silent,
      fetchPage: async (token) => {
        if (!token) return page([tweet(102, 5, later), tweet(100, 130, later)], 'p2')
        return page([]) // stops at cached newest (100) on page 1
      },
    })
    expect(out.status).toBe('incremental')
    // The previously-cached 23h(now 25h) tweet MUST still be present (not silently dropped).
    expect(out.tweets.some((t) => t.id.slice(-2) === '50')).toBe(true)
    // And the genuinely-new tweet is merged in.
    expect(out.tweets.some((t) => t.id.slice(-3) === '102')).toBe(true)
  })

  it('REGRESSION B2/B3: cache day key is PT, so a 7:30am PT run is a fresh first-of-day MISS', async () => {
    // 2026-06-08T14:30:00Z == 07:30 PT on 2026-06-08. PT day = 2026-06-08.
    const morningPT = new Date('2026-06-08T14:30:00Z')
    const out = await fetchTimeline({
      cacheDir: dir, now: morningPT, logger: silent,
      fetchPage: async () => page([tweet(100, 10, morningPT), tweet(1, 26 * 60, morningPT)]),
    })
    expect(out.meta.day).toBe('2026-06-08')
    // An evening-before rerun (2026-06-08T05:00Z = 2026-06-07 22:00 PT) keys to the PT day 06-07,
    // NOT 06-08 — so it cannot leave a stale file under the morning run's key.
    const eveningBefore = new Date('2026-06-08T05:00:00Z')
    const out2 = await fetchTimeline({
      cacheDir: dir, now: eveningBefore, logger: silent,
      fetchPage: async () => page([tweet(90, 10, eveningBefore), tweet(1, 26 * 60, eveningBefore)]),
    })
    expect(out2.meta.day).toBe('2026-06-07')
    expect(out2.meta.day).not.toBe(out.meta.day)
  })

  it('REGRESSION RC1: 20-page ceiling is honored on the INCREMENTAL path too', async () => {
    const seedNow = new Date('2026-06-08T20:00:00Z')
    await fetchTimeline({
      cacheDir: dir, now: seedNow, logger: silent,
      fetchPage: async () => page([tweet(100, 10, seedNow), tweet(1, 26 * 60, seedNow)]),
    })
    const later = new Date(seedNow.getTime() + 120 * 60_000)
    let calls = 0
    const out = await fetchTimeline({
      cacheDir: dir, ttlMinutes: 90, maxPages: 20, now: later, logger: silent,
      // every page is new and never reaches the cached newest id -> would page forever without the cap
      fetchPage: async () => { calls += 1; return page([tweet(1000 + calls, 1, later)], `p${calls + 1}`) },
    })
    expect(out.status).toBe('incremental')
    expect(calls).toBe(20)
    expect(out.pagesFetched).toBe(20)
  })
})
