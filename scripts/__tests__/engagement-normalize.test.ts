import { describe, expect, it } from 'vitest'

import { normalizeEngagement, type EngagementSource } from '../lib/engagement-normalize'

const sources: EngagementSource[] = ['hackernews', 'reddit', 'x', 'github-trending']

describe('normalizeEngagement', () => {
  it('scores a 3-upvote Reddit item below a 200-upvote Reddit item', () => {
    const sourceTotal = 200
    const tiny = normalizeEngagement('reddit', 3, sourceTotal)
    const substantial = normalizeEngagement('reddit', 200, sourceTotal)

    expect(tiny).toBeGreaterThanOrEqual(0)
    expect(substantial).toBeLessThanOrEqual(1)
    expect(tiny).toBeLessThan(substantial)
  })

  it('uses the Wilson lower-bound confidence discount for count-only engagement', () => {
    expect(normalizeEngagement('reddit', 3, 3)).toBeCloseTo(0.4385, 4)
    expect(normalizeEngagement('reddit', 200, 200)).toBeCloseTo(0.9812, 4)
  })

  it('preserves monotonic ordering independently for HN points, Reddit upvotes, X likes, and GitHub stars', () => {
    for (const source of sources) {
      const sourceTotal = 200
      const scores = [0, 1, 3, 20, 200].map((raw) => normalizeEngagement(source, raw, sourceTotal))
      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1])
      }
    }
  })

  it('refuses to silently rewrite a denominator below the positive count', () => {
    expect(() => normalizeEngagement('reddit', 500, 0)).toThrow(/denominator/i)
    expect(() => normalizeEngagement('github-trending', 1200, 42)).toThrow(/denominator/i)
  })

  it('documents denominator ordering: fixed positives score lower as the denominator grows', () => {
    const sameUpvotesLowCommentVolume = normalizeEngagement('reddit', 50, 100)
    const sameUpvotesHighCommentVolume = normalizeEngagement('reddit', 50, 500)

    expect(sameUpvotesHighCommentVolume).toBeLessThan(sameUpvotesLowCommentVolume)
  })

  it('orders cross-source examples only after the caller supplies a comparable denominator basis', () => {
    const scored = [
      { source: 'hackernews', raw: 60, n: 100 },
      { source: 'reddit', raw: 30, n: 100 },
      { source: 'x', raw: 30, n: 300 },
      { source: 'github-trending', raw: 45, n: 100 },
    ].map((item) => ({ ...item, score: normalizeEngagement(item.source as EngagementSource, item.raw, item.n) }))

    const rankedSources = scored.toSorted((a, b) => b.score - a.score).map((item) => item.source)

    expect(rankedSources).toEqual(['hackernews', 'github-trending', 'reddit', 'x'])
  })
})
