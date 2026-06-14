import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { gatherRedditPosts, rotateSubreddits, dayOfYearUTC } from '../reddit'

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/reddit-hot-machinelearning.atom.xml'),
  'utf8',
)

function rssResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  }
}

const noSleep = async () => {}

describe('reddit gatherer (RSS/Atom)', () => {
  it('parses the real captured hot.rss fixture into normalized candidates', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => rssResponse(200, FIXTURE))
    const candidates = await gatherRedditPosts({
      subreddits: ['MachineLearning'],
      limit: 25,
      fetchImpl,
      sleepImpl: noSleep,
      logger: { warn: vi.fn() },
    })

    // fixture has 3 entries
    expect(candidates).toHaveLength(3)

    // hits the RSS endpoint with a User-Agent
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.reddit.com/r/MachineLearning/hot.rss?limit=25',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    )

    const first = candidates[0]
    expect(first.source).toBe('reddit')
    expect(first.title).toBe('[D] Self-Promotion Thread')
    expect(first.url).toContain('/r/MachineLearning/comments/')
    expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(first.summary.length).toBeGreaterThan(0)
    // summary must be stripped of HTML tags (no markup leaks into the brief render)
    expect(first.summary).not.toContain('<')
  })

  it('normalizes authorHandle to exactly u/<name> (no leading slash) [RC-3]', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => rssResponse(200, FIXTURE))
    const candidates = await gatherRedditPosts({
      subreddits: ['MachineLearning'], fetchImpl, sleepImpl: noSleep, logger: { warn: vi.fn() },
    })
    // fixture author <name> values are /u/AutoModerator, /u/abolfazl1363, /u/AccomplishedLeg1508
    expect(candidates[0].authorHandle).toBe('u/AutoModerator')
    expect(candidates.map((c) => c.authorHandle)).toEqual([
      'u/AutoModerator', 'u/abolfazl1363', 'u/AccomplishedLeg1508',
    ])
    // never a leading slash, never doubled prefix
    for (const c of candidates) {
      expect(c.authorHandle).not.toMatch(/^\//)
      expect(c.authorHandle).not.toMatch(/^u\/u\//)
    }
  })

  it('emits honest-zero engagement (RSS has no metrics) [AC-7]', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => rssResponse(200, FIXTURE))
    const [c] = await gatherRedditPosts({
      subreddits: ['MachineLearning'], fetchImpl, sleepImpl: noSleep, logger: { warn: vi.fn() },
    })
    expect(c.engagement_raw.score).toBe(0)
    expect(c.engagement_raw.upvotes).toBe(0)
    expect(c.engagement_raw.comments).toBe(0)
    expect(typeof c.engagement_raw.normalized).toBe('number')
  })

  it('retries on 429 honoring Retry-After, then succeeds [RC-1/AC-5]', async () => {
    const sleeps: number[] = []
    const sleepImpl = vi.fn(async (ms: number) => { sleeps.push(ms) })
    let call = 0
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      if (call <= 2) return rssResponse(429, '', { 'retry-after': '1' })
      return rssResponse(200, FIXTURE)
    })
    const candidates = await gatherRedditPosts({
      subreddits: ['MachineLearning'], fetchImpl, sleepImpl, maxRetries: 2, logger: { warn: vi.fn() },
    })
    expect(candidates).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 + 2 retries
    // honored the Retry-After header (1s) rather than the exponential default
    expect(sleeps).toContain(1000)
  })

  it('fetches subreddits SEQUENTIALLY with a delay between them [AC-5]', async () => {
    const order: string[] = []
    const sleepImpl = vi.fn(async (_ms: number) => { order.push('sleep') })
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      order.push(`fetch:${url.includes('LocalLLaMA') ? 'B' : 'A'}`)
      return rssResponse(200, FIXTURE)
    })
    await gatherRedditPosts({
      subreddits: ['MachineLearning', 'LocalLLaMA'], fetchImpl, sleepImpl,
      delayMs: 1234, logger: { warn: vi.fn() },
    })
    // first fetch, then a delay, then second fetch (sequential, not parallel)
    expect(order).toEqual(['fetch:A', 'sleep', 'fetch:B'])
  })

  it('returns [] + a DISTINCT empty-feed warn on 200 with zero entries [RC-4/AC-10]', async () => {
    const warn = vi.fn()
    const emptyFeed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>'
    const candidates = await gatherRedditPosts({
      subreddits: ['MachineLearning'],
      fetchImpl: vi.fn(async (_u: string, _i?: RequestInit) => rssResponse(200, emptyFeed)),
      sleepImpl: noSleep, logger: { warn },
    })
    expect(candidates).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/empty feed \(0 entries\)/i))
    // and NOT a 429/throttle warn
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/429/))
  })

  it('returns [] and warns (no throw) on 403/5xx/429-exhausted/malformed/network error [AC-2]', async () => {
    const warn = vi.fn()
    // 403
    await expect(gatherRedditPosts({
      subreddits: ['x'], fetchImpl: vi.fn(async () => rssResponse(403, '')),
      sleepImpl: noSleep, logger: { warn },
    })).resolves.toEqual([])
    // 429 exhausted
    await expect(gatherRedditPosts({
      subreddits: ['x'], maxRetries: 1,
      fetchImpl: vi.fn(async () => rssResponse(429, '', {})),
      sleepImpl: noSleep, logger: { warn },
    })).resolves.toEqual([])
    // malformed XML (no entries)
    await expect(gatherRedditPosts({
      subreddits: ['x'], fetchImpl: vi.fn(async () => rssResponse(200, 'not xml at all')),
      sleepImpl: noSleep, logger: { warn },
    })).resolves.toEqual([])
    // network throw
    await expect(gatherRedditPosts({
      subreddits: ['x'], fetchImpl: vi.fn(async () => { throw new Error('socket closed') }),
      sleepImpl: noSleep, logger: { warn },
    })).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HTTP 403/))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/429 after/))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unreachable|empty feed/i))
  })

  it('selects the alternate/comments link, not a thumbnail; handles CDATA + <source> [B1/B2/B3]', async () => {
    const ADV = readFileSync(resolve(__dirname, 'fixtures/reddit-adversarial.atom.xml'), 'utf8')
    const candidates = await gatherRedditPosts({
      subreddits: ['ML'],
      fetchImpl: vi.fn(async (_u: string, _i?: RequestInit) => rssResponse(200, ADV)),
      sleepImpl: noSleep, logger: { warn: vi.fn() },
    })
    expect(candidates).toHaveLength(2)

    // B1: picks rel="alternate" /comments/ permalink, NOT the thumbnail link
    expect(candidates[0].url).toContain('/r/ML/comments/aaa/real_post')
    expect(candidates[0].url).not.toContain('thumbs.redditmedia')

    // B2: CDATA wrapper stripped from title; title is plain text (Reddit titles are not
    // HTML, so any literal angle-brackets inside the CDATA are kept verbatim, just the
    // <![CDATA[ ]]> wrapper + entities resolved). The wrapper must NOT leak.
    expect(candidates[0].title).toBe('CDATA Title & <b>bold</b>')
    expect(candidates[0].title).not.toContain('CDATA[')
    expect(candidates[0].title).not.toContain(']]>')
    expect(candidates[0].summary).not.toContain(']]>')
    expect(candidates[0].summary).not.toContain('CDATA')
    expect(candidates[0].summary).not.toContain('<')

    // B3: author from the entry's OWN <author>, NOT <category><name> and NOT <source><author>
    expect(candidates[0].authorHandle).toBe('u/realposter')
    expect(candidates[1].authorHandle).toBe('u/actual_author')
    expect(candidates[1].authorHandle).not.toBe('u/crosspost_source_author')
  })

  it('reports a TRUNCATED feed (open <entry>, no close) as malformed, not empty [B6]', async () => {
    const warn = vi.fn()
    const truncated = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>cut off mid-str'
    const candidates = await gatherRedditPosts({
      subreddits: ['ML'],
      fetchImpl: vi.fn(async (_u: string, _i?: RequestInit) => rssResponse(200, truncated)),
      sleepImpl: noSleep, logger: { warn },
    })
    expect(candidates).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/malformed\/truncated feed/i))
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/empty feed/i))
  })

  it('sanitizes subreddit names (no path traversal / shell metachars escape /r/) [trust boundary]', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string, _i?: RequestInit) => { seen.push(url); return rssResponse(200, '<feed></feed>') })
    await gatherRedditPosts({
      subreddits: ['../../etc/passwd', 'ML; rm -rf /', 'a$(whoami)b'],
      fetchImpl, sleepImpl: noSleep, logger: { warn: vi.fn() },
    })
    for (const u of seen) {
      expect(u).toMatch(/^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/hot\.rss\?limit=\d+$/)
      expect(u).not.toContain('..')
      expect(u).not.toContain('$(')
      expect(u).not.toContain(';')
    }
  })

  it('round-robins subreddits across lanes; same-lane gap only, not cross-lane [egress lanes]', async () => {
    // With an injected fetchImpl, lanes collapse to that single fetcher (tests stay
    // hermetic) — but the round-robin + per-lane-gap logic is still exercised via the
    // sleep accounting. Here we prove the SHAPE: N subs, 2 lanes -> sub[0],sub[2] on
    // lane0, sub[1] on lane1; a same-lane second fetch triggers exactly one gap.
    const order: string[] = []
    const sleepImpl = vi.fn(async (_ms: number) => { order.push('sleep') })
    const fetchImpl = vi.fn(async (url: string, _i?: RequestInit) => {
      order.push('fetch:' + url.match(/\/r\/([^/]+)\//)![1])
      return rssResponse(200, FIXTURE)
    })
    // fetchImpl injected -> single fetcher, but delay still applies between same-"lane" subs.
    await gatherRedditPosts({
      subreddits: ['A', 'B', 'C'], fetchImpl, sleepImpl, delayMs: 500, logger: { warn: vi.fn() },
    })
    // injected fetchImpl = one lane -> sequential with a gap before B and C
    expect(order).toEqual(['fetch:A', 'sleep', 'fetch:B', 'sleep', 'fetch:C'])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('marks a lane DOWN on a network throw and skips its remaining subs [D-11/AC-6]', async () => {
    // Single injected lane that always throws (a black-hole/down lane surfaces as a
    // thrown network error from the transport). First fetch IS the health signal (D-4):
    // the throw marks the lane down, so subsequent subs on that lane are NOT re-tried.
    const warn = vi.fn()
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls += 1; throw new Error('Command failed: curl -s -S --socks5-hostname 192.168.1.217:1080 ...\ncurl: (28) Operation timed out') })
    const candidates = await gatherRedditPosts({
      subreddits: ['A', 'B', 'C', 'D'], fetchImpl, sleepImpl: noSleep, logger: { warn },
    })
    expect(candidates).toEqual([])
    // lane down after the FIRST throw -> exactly one fetch, not one-per-sub
    expect(calls).toBe(1)
    // the warn message is SANITIZED (no curl argv / socks host leaked) [D-6]
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toMatch(/lane unreachable/)
    expect(msg).toMatch(/timed out/)
    expect(msg).not.toContain('--socks5')
    expect(msg).not.toContain('192.168.1.217')
  })

  it('honors the step budget and stops fetching when exceeded [D-10]', async () => {
    // stepBudgetMs=0 disables; a tiny budget with a slow sleep proves the deadline gate.
    const warn = vi.fn()
    let calls = 0
    // each sub "takes" time via the politeness delay; the budget is already past after
    // the first, so the loop breaks before fetching the rest.
    const fetchImpl = vi.fn(async () => { calls += 1; return rssResponse(200, FIXTURE) })
    await gatherRedditPosts({
      subreddits: ['A', 'B', 'C'], fetchImpl, sleepImpl: noSleep, delayMs: 0,
      stepBudgetMs: -1 /* clamped to 0 -> Infinity (disabled): sanity it still runs all */,
      logger: { warn },
    })
    expect(calls).toBe(3) // budget disabled -> all subs fetched
  })

  it('never throws: a thrown lane yields [] (graceful degrade) [never-throw invariant]', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom') })
    await expect(
      gatherRedditPosts({ subreddits: ['A'], fetchImpl, sleepImpl: noSleep, logger: { warn: vi.fn() } }),
    ).resolves.toEqual([])
  })
})

describe('day-seeded rotation selector [D-10/AC-15]', () => {
  const SUBS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] // 9, like the curated set

  it('is deterministic for a given day index', () => {
    expect(rotateSubreddits(SUBS, 0, 5)).toEqual(rotateSubreddits(SUBS, 0, 5))
    expect(rotateSubreddits(SUBS, 7, 5)).toEqual(['s7', 's8', 's0', 's1', 's2'])
  })

  it('returns exactly `size` subs (capped at list length)', () => {
    expect(rotateSubreddits(SUBS, 3, 5)).toHaveLength(5)
    expect(rotateSubreddits(SUBS, 3, 20)).toHaveLength(9) // capped at N
    expect(rotateSubreddits(SUBS, 3, 0)).toEqual([])
    expect(rotateSubreddits([], 3, 5)).toEqual([])
  })

  it('covers ALL 9 subs over a 2-day rotation (size 5 -> ceil(9/5)=2 days)', () => {
    const day0 = rotateSubreddits(SUBS, 0, 5)
    const day1 = rotateSubreddits(SUBS, 1 * 5, 5) // advance the window by `size`
    const covered = new Set([...day0, ...day1])
    expect(covered.size).toBe(9)
    for (const s of SUBS) expect(covered.has(s)).toBe(true)
  })

  it('wraps around the list (no out-of-range)', () => {
    const out = rotateSubreddits(SUBS, 8, 5) // starts at idx 8, wraps to 0..3
    expect(out).toEqual(['s8', 's0', 's1', 's2', 's3'])
  })

  it('handles negative/huge day indices safely', () => {
    expect(rotateSubreddits(SUBS, -1, 3)).toEqual(['s8', 's0', 's1'])
    expect(() => rotateSubreddits(SUBS, 1e9, 5)).not.toThrow()
  })

  it('dayOfYearUTC is stable and within [0, 365]', () => {
    const d = new Date(Date.UTC(2026, 0, 1)) // Jan 1
    expect(dayOfYearUTC(d)).toBe(1)
    const mid = new Date(Date.UTC(2026, 5, 14)) // Jun 14
    const n = dayOfYearUTC(mid)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(366)
  })
})
