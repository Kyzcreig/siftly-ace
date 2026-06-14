import { describe, expect, it, vi } from 'vitest'

import { gatherGitHubTrending } from '../github-trending'

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }
}

const TRENDING_HTML = `
<html><body>
  <article class="Box-row">
    <h2 class="h3 lh-condensed">
      <a href="/owner/repo">
        owner / repo
      </a>
    </h2>
    <p class="col-9 color-fg-muted my-1 pr-4">Build agents with typed workflow graphs.</p>
    <a href="/owner/repo/stargazers">1,234</a>
    <a href="/owner/repo/forks">56</a>
    <span class="d-inline-block float-sm-right">42 stars today</span>
  </article>
</body></html>`

const ABBREVIATED_COUNT_HTML = `
<html><body>
  <article class="Box-row">
    <h2 class="h3 lh-condensed">
      <a href="/owner/popular">
        owner / popular
      </a>
    </h2>
    <p>Popular repo.</p>
    <a href="/owner/popular/stargazers">1.2k</a>
    <a href="/owner/popular/forks">2.5m</a>
    <span class="d-inline-block float-sm-right">3.4k stars today</span>
  </article>
</body></html>`

describe('github-trending gatherer', () => {
  it('parses GitHub Trending HTML into normalized digest candidates', async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, TRENDING_HTML))

    const candidates = await gatherGitHubTrending({
      fetchImpl,
      logger: { warn: vi.fn() },
      now: new Date('2026-06-13T12:00:00.000Z'),
    })

    expect(fetchImpl).toHaveBeenCalledWith('https://github.com/trending?since=daily')
    expect(candidates).toEqual([
      {
        title: 'owner/repo',
        url: 'https://github.com/owner/repo',
        summary: 'Build agents with typed workflow graphs.',
        source: 'github-trending',
        authorHandle: 'owner',
        engagement_raw: {
          stars: 1234,
          forks: 56,
          starsToday: 42,
          normalized: expect.any(Number),
        },
        created_at: '2026-06-13T12:00:00.000Z',
      },
    ])
  })

  it('parses abbreviated k/m counts before normalizing engagement', async () => {
    const candidates = await gatherGitHubTrending({
      fetchImpl: vi.fn(async () => textResponse(200, ABBREVIATED_COUNT_HTML)),
      logger: { warn: vi.fn() },
      now: new Date('2026-06-13T12:00:00.000Z'),
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].engagement_raw).toMatchObject({
      stars: 1200,
      forks: 2_500_000,
      starsToday: 3400,
    })
  })

  it('returns [] and warns on rate limits instead of throwing', async () => {
    const warn = vi.fn()
    const candidates = await gatherGitHubTrending({
      fetchImpl: vi.fn(async () => textResponse(429, 'rate limited')),
      logger: { warn },
    })

    expect(candidates).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/github trending.*429/i))
  })

  it('returns [] and warns on empty or malformed HTML instead of throwing', async () => {
    const warn = vi.fn()

    await expect(gatherGitHubTrending({
      fetchImpl: vi.fn(async () => textResponse(200, '<html><body></body></html>')),
      logger: { warn },
    })).resolves.toEqual([])

    await expect(gatherGitHubTrending({
      fetchImpl: vi.fn(async () => textResponse(200, '<article><h2>missing link</h2></article>')),
      logger: { warn },
    })).resolves.toEqual([])

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/github trending.*empty/i))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/github trending.*malformed/i))
  })
})
