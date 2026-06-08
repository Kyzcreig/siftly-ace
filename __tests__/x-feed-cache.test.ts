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
  it('idIsNewer / maxId / minId order snowflake ids correctly', () => {
    const a = '1000000000000000001'
    const b = '1000000000000000002'
    expect(idIsNewer(b, a)).toBe(true)
    expect(idIsNewer(a, b)).toBe(false)
    expect(maxId([a, b])).toBe(b)
    expect(minId([a, b])).toBe(a)
    // different length -> longer is newer
    expect(idIsNewer('10000000000000000000', a)).toBe(true)
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
})
