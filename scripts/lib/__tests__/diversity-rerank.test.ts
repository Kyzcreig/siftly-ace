import { describe, expect, it } from 'vitest'

import { diversityRerank } from '../diversity-rerank'

function candidate(
  id: string,
  relevance: number,
  authorHandle: string,
  embedding: readonly number[],
) {
  return { id, relevance, authorHandle, embedding }
}

function vectorWithCosine(cosine: number): readonly number[] {
  return [cosine, Math.sqrt(1 - cosine ** 2)]
}

describe('diversityRerank', () => {
  it('caps five near-identical same-author candidates to the configured author cap', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => candidate(
      `same-${i + 1}`,
      1 - i * 0.01,
      'repeat_author',
      [1, i * 0.001],
    ))

    const ranked = diversityRerank(candidates, { perAuthorCap: 2 })

    expect(ranked).toHaveLength(2)
    expect(ranked.map((item) => item.candidate.id)).toEqual(['same-1', 'same-2'])
    expect(ranked.every((item) => item.candidate.authorHandle === 'repeat_author')).toBe(true)
  })

  it('uses MMR to prefer a less-similar candidate over a near duplicate with higher relevance', () => {
    const candidates = [
      candidate('best', 0.95, 'author-a', [1, 0]),
      candidate('near-duplicate', 0.94, 'author-b', [1, 0.001]),
      candidate('different', 0.7, 'author-c', [0, -1]),
    ]

    const ranked = diversityRerank(candidates, { limit: 2, perAuthorCap: 3, lambda: 0.3 })

    expect(ranked.map((item) => item.candidate.id)).toEqual(['best', 'different'])
    expect(ranked[1].maxSimilarityToPicked).toBe(0)
    expect(ranked[1].mmrScore).toBeCloseTo(0.21)
  })

  it('keeps relevance dominant for non-orthogonal candidates by default', () => {
    const candidates = [
      candidate('best', 1, 'author-a', [1, 0]),
      candidate('relevant-overlap', 0.9, 'author-b', vectorWithCosine(0.2)),
      candidate('less-relevant-diverse', 0.65, 'author-c', vectorWithCosine(0.1)),
    ]

    const ranked = diversityRerank(candidates, { limit: 2, perAuthorCap: 3 })

    expect(ranked.map((item) => item.candidate.id)).toEqual(['best', 'relevant-overlap'])
    expect(ranked[1].maxSimilarityToPicked).toBeCloseTo(0.2)
    expect(ranked[1].mmrScore).toBeCloseTo(0.57)
  })

  it('rejects lambda values above one', () => {
    expect(() => diversityRerank([
      candidate('best', 1, 'author-a', [1, 0]),
    ], { lambda: 1.01 })).toThrow('lambda must be between 0 and 1')
  })

  it('recomputes retained scores after eviction churn', () => {
    const bY = Math.sqrt(1 - 0.9 ** 2)
    const cY = (0.5 - 0.2 * 0.9) / bY
    const cZ = Math.sqrt(1 - 0.2 ** 2 - cY ** 2)
    const candidates = [
      candidate('a', 1, 'author-a', [1, 0, 0, 0]),
      candidate('b', 0.99, 'author-b', [0.9, bY, 0, 0]),
      candidate('c', 0.98, 'author-c', [0.2, cY, cZ, 0]),
      candidate('d', 0.97, 'author-d', [0, 0, 0, 1]),
    ]

    const ranked = diversityRerank(candidates, { limit: 3, perAuthorCap: 3, lambda: 0.7 })
    const ids = ranked.map((item) => item.candidate.id)
    const retained = ranked.find((item) => item.candidate.id === 'c')

    expect(ids).toEqual(['d', 'a', 'c'])
    expect(ids).not.toContain('b')
    expect(retained?.maxSimilarityToPicked).toBeCloseTo(0.2)
    expect(retained?.diversityPenalty).toBeCloseTo(0.06)
    expect(retained?.mmrScore).toBeCloseTo(0.626)
  })

  it('is pure: input order and candidate objects are not mutated', () => {
    const candidates = [
      candidate('best', 1, 'author-a', [1, 0]),
      candidate('near-duplicate', 0.99, 'author-a', [1, 0.001]),
      candidate('different', 0.98, 'author-b', [0, 1]),
    ]
    const originalJson = JSON.stringify(candidates)

    diversityRerank(candidates, { limit: 2, perAuthorCap: 1, lambda: 0.7 })

    expect(JSON.stringify(candidates)).toBe(originalJson)
    expect(candidates.map((item) => item.id)).toEqual(['best', 'near-duplicate', 'different'])
    expect(candidates[0]).not.toHaveProperty('mmrScore')
  })
})
