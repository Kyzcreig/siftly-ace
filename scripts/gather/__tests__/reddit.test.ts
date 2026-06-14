import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { gatherRedditPosts } from '../reddit'

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
})
