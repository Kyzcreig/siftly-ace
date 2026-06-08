import Database from 'better-sqlite3'

import { openVectorStore, type VecOptions } from '../vec'
import { buildEmbeddingInput, type EmbeddingProvider } from './embeddings'

export interface HybridSearchOptions {
  dbPath: string
  query: string
  provider: EmbeddingProvider
  limit?: number
  candidateLimit?: number
  vecOptions?: Omit<VecOptions, 'dbPath'>
  rebuildFts?: boolean
}

export interface HybridSearchResult {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  score: number
  scores: {
    semantic: number
    exact: number
    lexical: number
    source: number
  }
}

interface BookmarkSearchRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  semanticTags: string | null
  entities: string | null
  source: string
}

interface FtsCandidate {
  bookmarkId: string
  rank: number
}

const FTS_TABLE = 'bookmark_search_fts'
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of', 'is', 'it',
  'about', 'that', 'with', 'by', 'this', 'my', 'me', 'i', 'find', 'show', 'get',
])

export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
  const query = options.query.trim()
  if (!query) return []

  const limit = normalizeLimit(options.limit, 20)
  const candidateLimit = Math.max(limit, normalizeLimit(options.candidateLimit, 80))
  const [queryVector] = await options.provider.embed([query])
  const vectorStore = openVectorStore({ dbPath: options.dbPath, ...options.vecOptions })
  const db = new Database(options.dbPath)

  try {
    if (options.rebuildFts ?? false) rebuildSearchFts(db)
    const semanticCandidates = vectorStore.search(queryVector, candidateLimit, options.provider.model)
    const exactCandidates = ftsSearch(db, query, candidateLimit)

    const semanticById = new Map(semanticCandidates.map((row) => [row.bookmarkId, row.score]))
    const exactById = scoreFtsCandidates(exactCandidates)
    const candidateIds = unionIds(
      semanticCandidates.map((row) => row.bookmarkId),
      exactCandidates.map((row) => row.bookmarkId),
    )

    if (candidateIds.length === 0) return []

    const bookmarks = fetchBookmarksByIds(db, candidateIds)
    return bookmarks
      .map((bookmark) => rerankBookmark(bookmark, query, semanticById, exactById))
      .sort((a, b) => b.score - a.score || b.scores.exact - a.scores.exact || a.tweetId.localeCompare(b.tweetId))
      .slice(0, limit)
  } finally {
    vectorStore.close()
    db.close()
  }
}

export function rebuildSearchFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      bookmark_id UNINDEXED,
      text,
      semantic_tags,
      entities,
      author_handle,
      tokenize='porter unicode61'
    );
    DELETE FROM ${FTS_TABLE};
  `)

  const rows = db.prepare(`
    SELECT id, text, semanticTags, entities, authorHandle
    FROM Bookmark
    ORDER BY id ASC
  `).all() as { id: string; text: string; semanticTags: string | null; entities: string | null; authorHandle: string }[]

  const insert = db.prepare(`
    INSERT INTO ${FTS_TABLE} (bookmark_id, text, semantic_tags, entities, author_handle)
    VALUES (@id, @text, @semanticTags, @entities, @authorHandle)
  `)
  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      insert.run({
        id: row.id,
        text: row.text,
        semanticTags: row.semanticTags ?? '',
        entities: row.entities ?? '',
        authorHandle: row.authorHandle,
      })
    }
  })
  tx(rows)
}

function ftsSearch(db: Database.Database, query: string, limit: number): FtsCandidate[] {
  const matchQuery = ftsMatchQuery(query)
  if (!matchQuery) return []

  try {
    return db.prepare(`
      SELECT bookmark_id AS bookmarkId, bm25(${FTS_TABLE}) AS rank
      FROM ${FTS_TABLE}
      WHERE ${FTS_TABLE} MATCH @matchQuery
      ORDER BY rank
      LIMIT @limit
    `).all({ matchQuery, limit }) as FtsCandidate[]
  } catch {
    return []
  }
}

function ftsMatchQuery(query: string): string {
  return tokenize(query)
    .map((term) => `"${term.replace(/"/g, ' ')}"`)
    .join(' OR ')
}

function scoreFtsCandidates(candidates: FtsCandidate[]): Map<string, number> {
  const scores = new Map<string, number>()
  const count = Math.max(candidates.length, 1)
  candidates.forEach((candidate, index) => {
    const rankScore = Number.isFinite(candidate.rank) ? 1 / (1 + Math.max(0, candidate.rank)) : 0
    const positionScore = 1 - index / count
    scores.set(candidate.bookmarkId, Math.max(rankScore, positionScore))
  })
  return scores
}

function fetchBookmarksByIds(db: Database.Database, ids: string[]): BookmarkSearchRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db.prepare(`
    SELECT
      id,
      tweetId,
      text,
      authorHandle,
      authorName,
      semanticTags,
      entities,
      source
    FROM Bookmark
    WHERE id IN (${placeholders})
  `).all(...ids) as BookmarkSearchRow[]
}

function rerankBookmark(
  bookmark: BookmarkSearchRow,
  query: string,
  semanticById: Map<string, number>,
  exactById: Map<string, number>,
): HybridSearchResult {
  const semantic = semanticById.get(bookmark.id) ?? 0
  const exact = exactById.get(bookmark.id) ?? 0
  const lexical = lexicalScore(query, bookmark)
  const source = bookmark.source === 'bookmark' ? 1 : 0.3
  const score = (0.38 * semantic) + (0.42 * exact) + (0.17 * lexical) + (0.03 * source)

  return {
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    score,
    scores: { semantic, exact, lexical, source },
  }
}

function lexicalScore(query: string, bookmark: BookmarkSearchRow): number {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0

  const haystack = buildEmbeddingInput(bookmark).toLowerCase().replace(/sqlite-vec/g, 'sqlite vec')
  const matches = tokens.filter((token) => haystack.includes(token)).length
  const coverage = matches / tokens.length
  const phraseBoost = haystack.includes(query.toLowerCase()) ? 0.2 : 0
  return Math.min(1, coverage + phraseBoost)
}

function tokenize(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const term of query.toLowerCase().replace(/sqlite-vec/g, 'sqlite vec').split(/[^a-z0-9]+/)) {
    if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
  }
  return terms.slice(0, 16)
}

function unionIds(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const list of lists) {
    for (const id of list) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(200, Math.floor(value))
}
