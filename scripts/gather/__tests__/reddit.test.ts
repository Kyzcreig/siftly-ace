import { describe, expect, it, vi } from 'vitest'

import { gatherRedditPosts } from '../reddit'

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
      fetchImpl: vi.fn(async () => response(200, { data: { children: [] } })),
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
})
