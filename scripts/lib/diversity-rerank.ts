export interface DiversityRerankCandidate {
  id: string
  relevance: number
  authorKey?: string | null
  authorHandle?: string | null
  authorId?: string | null
  embedding?: readonly number[] | null
}

export interface DiversityRerankOptions<T extends DiversityRerankCandidate> {
  limit?: number
  lambda?: number
  perAuthorCap?: number
  similarity?: (candidate: T, picked: T) => number
}

export interface DiversityRerankedCandidate<T extends DiversityRerankCandidate> {
  candidate: T
  relevance: number
  mmrScore: number
  diversityPenalty: number
  maxSimilarityToPicked: number
  authorRank: number | null
  originalIndex: number
}

interface PendingCandidate<T extends DiversityRerankCandidate> {
  candidate: T
  originalIndex: number
}

const DEFAULT_LAMBDA = 0.7

export function diversityRerank<T extends DiversityRerankCandidate>(
  candidates: readonly T[],
  options: DiversityRerankOptions<T> = {},
): DiversityRerankedCandidate<T>[] {
  const limit = normalizeLimit(options.limit ?? candidates.length)
  const lambda = normalizeLambda(options.lambda ?? DEFAULT_LAMBDA)
  const perAuthorCap = normalizePerAuthorCap(options.perAuthorCap ?? Number.POSITIVE_INFINITY)
  const similarity = options.similarity ?? embeddingCosineSimilarity

  if (limit === 0 || candidates.length === 0) return []

  const pending: PendingCandidate<T>[] = candidates
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .sort(comparePendingByRelevance)
  const picked: DiversityRerankedCandidate<T>[] = []
  const authorCounts = new Map<string, number>()

  // Single pass over relevance-ordered candidates: score against the current
  // picked set, enforce author caps, and keep the best MMR-scored slice. Scores
  // are refreshed after each mutation so returned fields describe the final set.
  for (const item of pending) {
    const authorKey = authorKeyFor(item.candidate)
    if (authorKey && (authorCounts.get(authorKey) ?? 0) >= perAuthorCap) continue

    const maxSimilarityToPicked = maxSimilarity(item.candidate, picked, similarity)
    const diversityPenalty = diversityPenaltyFor(lambda, maxSimilarityToPicked)
    const mmrScore = mmrScoreFor(item.candidate.relevance, lambda, diversityPenalty)
    const authorRank = authorKey ? (authorCounts.get(authorKey) ?? 0) + 1 : null
    const ranked: DiversityRerankedCandidate<T> = {
      candidate: item.candidate,
      relevance: item.candidate.relevance,
      mmrScore,
      diversityPenalty,
      maxSimilarityToPicked,
      authorRank,
      originalIndex: item.originalIndex,
    }

    if (picked.length < limit) {
      picked.push(ranked)
      if (authorKey && authorRank !== null) authorCounts.set(authorKey, authorRank)
      recomputePickedScores(picked, lambda, similarity)
      continue
    }

    const replaceIndex = lowestRankedIndex(picked)
    if (replaceIndex !== -1 && rankedBreaksTie(ranked, picked[replaceIndex])) {
      decrementAuthor(authorCounts, authorKeyFor(picked[replaceIndex].candidate))
      picked[replaceIndex] = ranked
      if (authorKey && authorRank !== null) authorCounts.set(authorKey, authorRank)
      recomputePickedScores(picked, lambda, similarity)
    }
  }

  return picked.sort(compareRankedByScore)
}

function comparePendingByRelevance<T extends DiversityRerankCandidate>(
  a: PendingCandidate<T>,
  b: PendingCandidate<T>,
): number {
  if (a.candidate.relevance !== b.candidate.relevance) return b.candidate.relevance - a.candidate.relevance
  return a.originalIndex - b.originalIndex
}

function rankedBreaksTie<T extends DiversityRerankCandidate>(
  item: DiversityRerankedCandidate<T>,
  currentBest: DiversityRerankedCandidate<T>,
): boolean {
  return compareRankedByScore(item, currentBest) < 0
}

function compareRankedByScore<T extends DiversityRerankCandidate>(
  a: DiversityRerankedCandidate<T>,
  b: DiversityRerankedCandidate<T>,
): number {
  if (a.mmrScore !== b.mmrScore) return b.mmrScore - a.mmrScore
  if (a.relevance !== b.relevance) return b.relevance - a.relevance
  return a.originalIndex - b.originalIndex
}

function lowestRankedIndex<T extends DiversityRerankCandidate>(
  picked: readonly DiversityRerankedCandidate<T>[],
): number {
  let lowestIndex = -1
  for (let i = 0; i < picked.length; i++) {
    if (lowestIndex === -1 || compareRankedByScore(picked[i], picked[lowestIndex]) > 0) {
      lowestIndex = i
    }
  }
  return lowestIndex
}

function decrementAuthor(authorCounts: Map<string, number>, authorKey: string | null): void {
  if (!authorKey) return
  const nextCount = (authorCounts.get(authorKey) ?? 0) - 1
  if (nextCount <= 0) authorCounts.delete(authorKey)
  else authorCounts.set(authorKey, nextCount)
}

function recomputePickedScores<T extends DiversityRerankCandidate>(
  picked: DiversityRerankedCandidate<T>[],
  lambda: number,
  similarity: (candidate: T, picked: T) => number,
): void {
  for (let i = 0; i < picked.length; i++) {
    const item = picked[i]
    const maxSimilarityToPicked = maxSimilarity(item.candidate, picked, similarity, i)
    const diversityPenalty = diversityPenaltyFor(lambda, maxSimilarityToPicked)
    picked[i] = {
      ...item,
      mmrScore: mmrScoreFor(item.relevance, lambda, diversityPenalty),
      diversityPenalty,
      maxSimilarityToPicked,
    }
  }
}

function mmrScoreFor(relevance: number, lambda: number, diversityPenalty: number): number {
  return lambda * relevance - diversityPenalty
}

function diversityPenaltyFor(lambda: number, maxSimilarityToPicked: number): number {
  return (1 - lambda) * maxSimilarityToPicked
}

function maxSimilarity<T extends DiversityRerankCandidate>(
  candidate: T,
  picked: readonly DiversityRerankedCandidate<T>[],
  similarity: (candidate: T, picked: T) => number,
  excludeIndex: number | null = null,
): number {
  let max = 0
  for (let i = 0; i < picked.length; i++) {
    if (i === excludeIndex) continue
    const raw = similarity(candidate, picked[i].candidate)
    if (!Number.isFinite(raw)) continue
    max = Math.max(max, clamp(raw, 0, 1))
  }
  return max
}

function embeddingCosineSimilarity<T extends DiversityRerankCandidate>(candidate: T, picked: T): number {
  return cosineSimilarity(candidate.embedding, picked.embedding)
}

export function cosineSimilarity(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  if (normA === 0 || normB === 0) return 0
  return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), -1, 1)
}

function authorKeyFor(candidate: DiversityRerankCandidate): string | null {
  const raw = candidate.authorKey ?? candidate.authorHandle ?? candidate.authorId ?? null
  if (!raw) return null

  const normalized = raw.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer')
  }
  return limit
}

function normalizeLambda(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new Error('lambda must be between 0 and 1')
  }
  return lambda
}

function normalizePerAuthorCap(perAuthorCap: number): number {
  if (perAuthorCap === Number.POSITIVE_INFINITY) return perAuthorCap
  if (!Number.isInteger(perAuthorCap) || perAuthorCap < 1) {
    throw new Error('perAuthorCap must be a positive integer')
  }
  return perAuthorCap
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
