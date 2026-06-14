import { describe, expect, it, vi } from 'vitest'

import { gatherRedditPosts, __resetRedditTokenCacheForTests } from '../reddit'

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('reddit gatherer', () => {
  it('parses reddit JSON posts into normalized digest candidates', async () => {
    const fetchImpl = vi.fn(async () => response(200, {
      data: {
        children: [
          {
            kind: 't3',
            data: {
              title: 'Local LLM release notes',
              url: 'https://example.com/local-llm',
              permalink: '/r/LocalLLaMA/comments/abc/local_llm_release_notes/',
              selftext: 'A concise summary of the release.',
              author: 'model_builder',
              score: 212,
              ups: 214,
              num_comments: 38,
              created_utc: 1781390000,
            },
          },
        ],
      },
    }))

    const candidates = await gatherRedditPosts({
      subreddits: ['LocalLLaMA'],
      limit: 1,
      fetchImpl,
      logger: { warn: vi.fn() },
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.reddit.com/r/LocalLLaMA/hot.json?limit=1',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    )
    expect(candidates).toEqual([
      {
        title: 'Local LLM release notes',
        url: 'https://example.com/local-llm',
        summary: 'A concise summary of the release.',
        source: 'reddit',
        authorHandle: 'u/model_builder',
        engagement_raw: {
          score: 212,
          upvotes: 214,
          comments: 38,
          normalized: expect.any(Number),
        },
        created_at: '2026-06-13T22:33:20.000Z',
      },
    ])
  })

  it('returns [] and warns on rate limits instead of throwing', async () => {
    const warn = vi.fn()
    const candidates = await gatherRedditPosts({
      subreddits: ['MachineLearning'],
      fetchImpl: vi.fn(async () => response(429, { message: 'too many requests' })),
      logger: { warn },
    })

    expect(candidates).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reddit.*429/i))
  })

  it('returns [] and warns on empty or malformed payloads instead of throwing', async () => {
    const warn = vi.fn()

    await expect(gatherRedditPosts({
      subreddits: ['LocalLLaMA'],
      fetchImpl: vi.fn(async (_url?: string, _init?: RequestInit) => response(200, { data: { children: [] } })),
      logger: { warn },
    })).resolves.toEqual([])

    await expect(gatherRedditPosts({
      subreddits: ['LocalLLaMA'],
      fetchImpl: vi.fn(async () => response(200, { data: { children: [{ data: null }] } })),
      logger: { warn },
    })).resolves.toEqual([])

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reddit.*empty/i))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reddit.*malformed/i))
  })

  it('uses app-only OAuth (Bearer + oauth host) when REDDIT creds are set', async () => {
    __resetRedditTokenCacheForTests()
    const prevId = process.env.REDDIT_CLIENT_ID
    const prevSecret = process.env.REDDIT_CLIENT_SECRET
    process.env.REDDIT_CLIENT_ID = 'cid'
    process.env.REDDIT_CLIENT_SECRET = 'csecret'
    try {
      const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes('/api/v1/access_token')) {
          return response(200, { access_token: 'tok-123', expires_in: 3600, token_type: 'bearer' })
        }
        return response(200, { data: { children: [] } })
      })
      await gatherRedditPosts({ subreddits: ['LocalLLaMA'], limit: 3, fetchImpl, logger: { warn: vi.fn() } })
      const tokenCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/api/v1/access_token'))
      expect(tokenCall).toBeTruthy()
      expect(tokenCall?.[1]).toMatchObject({ method: 'POST', body: 'grant_type=client_credentials' })
      expect((tokenCall?.[1] as RequestInit).headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) })
      const readCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/hot.json'))
      expect(String(readCall?.[0])).toContain('oauth.reddit.com')
      expect((readCall?.[1] as { headers: Record<string, string> }).headers).toMatchObject({ Authorization: 'Bearer tok-123' })
    } finally {
      process.env.REDDIT_CLIENT_ID = prevId
      process.env.REDDIT_CLIENT_SECRET = prevSecret
      __resetRedditTokenCacheForTests()
    }
  })

  it('falls back to anon reads when token fetch fails (no throw)', async () => {
    __resetRedditTokenCacheForTests()
    const prevId = process.env.REDDIT_CLIENT_ID
    const prevSecret = process.env.REDDIT_CLIENT_SECRET
    process.env.REDDIT_CLIENT_ID = 'cid'
    process.env.REDDIT_CLIENT_SECRET = 'csecret'
    const warn = vi.fn()
    try {
      const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes('/api/v1/access_token')) return response(500, { error: 'boom' })
        return response(200, { data: { children: [] } })
      })
      await gatherRedditPosts({ subreddits: ['LocalLLaMA'], fetchImpl, logger: { warn } })
      const readCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/hot.json'))
      expect(String(readCall?.[0])).toContain('www.reddit.com')
      expect((readCall?.[1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reddit oauth.*token endpoint HTTP 500/i))
    } finally {
      process.env.REDDIT_CLIENT_ID = prevId
      process.env.REDDIT_CLIENT_SECRET = prevSecret
      __resetRedditTokenCacheForTests()
    }
  })

  it('stays on anon reads when no Reddit creds are configured', async () => {
    __resetRedditTokenCacheForTests()
    const prevId = process.env.REDDIT_CLIENT_ID
    const prevSecret = process.env.REDDIT_CLIENT_SECRET
    delete process.env.REDDIT_CLIENT_ID
    delete process.env.REDDIT_CLIENT_SECRET
    try {
      const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => response(200, { data: { children: [] } }))
      await gatherRedditPosts({ subreddits: ['LocalLLaMA'], fetchImpl, logger: { warn: vi.fn() } })
      expect(fetchImpl.mock.calls.every((c) => !String(c[0]).includes('/api/v1/access_token'))).toBe(true)
      const readCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/hot.json'))
      expect(String(readCall?.[0])).toContain('www.reddit.com')
    } finally {
      process.env.REDDIT_CLIENT_ID = prevId
      process.env.REDDIT_CLIENT_SECRET = prevSecret
      __resetRedditTokenCacheForTests()
    }
  })
})
