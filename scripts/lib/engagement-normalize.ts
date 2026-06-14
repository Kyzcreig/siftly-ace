export type EngagementSource = 'hackernews' | 'hn' | 'reddit' | 'x' | 'github-trending'

const SUPPORTED_SOURCES = new Set<EngagementSource>(['hackernews', 'hn', 'reddit', 'x', 'github-trending'])
const DEFAULT_Z_SCORE = 1.96

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function wilsonLowerBound(successes: number, trials: number, z = DEFAULT_Z_SCORE): number {
  if (successes <= 0 || trials <= 0) return 0

  const phat = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const center = phat + z2 / (2 * trials)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * trials)) / trials)

  return clamp01((center - margin) / denominator)
}

/**
 * Source-local Wilson lower-bound normalizer.
 *
 * raw is the positive signal (HN points, Reddit upvotes, X likes, GitHub
 * stars-today/stars); n is a caller-supplied denominator in the same
 * source-local observation basis. This function does not make raw magnitudes
 * comparable across sources by itself: cross-source ranking requires the caller
 * to define a common basis first (for example source-local percentiles or real
 * exposure counts). For fixed raw, a larger denominator means a lower positive
 * rate and therefore a lower score.
 */
export function normalizeEngagement(source: EngagementSource, raw: number, n: number): number {
  if (!SUPPORTED_SOURCES.has(source)) {
    throw new RangeError(`Unsupported engagement source: ${source}`)
  }

  const successes = nonNegativeFinite(raw)
  const trials = nonNegativeFinite(n)
  if (successes > trials) {
    throw new RangeError('Engagement denominator n must be greater than or equal to raw; refusing to rewrite it')
  }

  return wilsonLowerBound(successes, trials)
}
