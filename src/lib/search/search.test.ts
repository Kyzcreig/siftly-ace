import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { openVectorStore } from '../vec'
import { buildEmbeddingInput, buildMediaSearchText, createEmbeddingProviderFromEnv, embedBookmarkCorpus, type EmbeddingProvider } from './embeddings'
import { hybridSearch } from './index'

const VECTOR_TERMS = [
  'xurl', 'oauth', 'bookmarks', 'likes', 'dedupe',
  'sqlite', 'vec', 'hybrid', 'fts5', 'semantic',
  'openai', 'embedding', 'local', 'model', 'macos',
  'obsidian', 'rerank', 'search', 'video', 'transcript',
]

class KeywordEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'fixture-keyword-embedding'
  readonly dimensions = VECTOR_TERMS.length

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => keywordVector(text))
  }
}

function keywordVector(text: string): number[] {
  const normalized = text.toLowerCase().replace(/sqlite-vec/g, 'sqlite vec')
  const tokens = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean))
  return VECTOR_TERMS.map((term) => (tokens.has(term) ? 1 : 0))
}

const provider = new KeywordEmbeddingProvider()

const fixtures = [
  {
    id: 'b-xurl',
    tweetId: 'tweet-xurl-oauth-dedupe',
    text: 'xurl OAuth2 pulls bookmarks and likes, paginates next_token, and dedupes with bookmark precedence.',
    semanticTags: JSON.stringify(['xurl', 'oauth', 'bookmarks', 'likes', 'dedupe']),
    entities: JSON.stringify({ tools: ['xurl'], hashtags: ['OAuth2'] }),
    source: 'bookmark',
  },
  {
    id: 'b-sqlite-vec',
    tweetId: 'tweet-sqlite-vec-hybrid-search',
    text: 'sqlite-vec on macOS keeps embeddings in SQLite and combines semantic vector search with FTS5 exact matches.',
    semanticTags: JSON.stringify(['sqlite-vec', 'hybrid search', 'FTS5', 'semantic search']),
    entities: JSON.stringify({ tools: ['sqlite-vec', 'SQLite', 'FTS5'] }),
    source: 'bookmark',
  },
  {
    id: 'b-openai-local',
    tweetId: 'tweet-openai-embedding-provider-swap',
    text: 'OpenAI text-embedding-3-small is a default embedding provider, but the local ACE-AI model swap should be config driven.',
    semanticTags: JSON.stringify(['OpenAI embeddings', 'local model', 'provider swap']),
    entities: JSON.stringify({ companies: ['OpenAI'], tools: ['ACE-AI'] }),
    source: 'bookmark',
  },
  {
    id: 'b-obsidian',
    tweetId: 'tweet-obsidian-export-notes',
    text: 'Obsidian export writes markdown notes with backlinks and a browsable index for saved X posts.',
    semanticTags: JSON.stringify(['Obsidian', 'markdown', 'export']),
    entities: JSON.stringify({ tools: ['Obsidian'] }),
    source: 'like',
  },
  {
    id: 'b-video',
    tweetId: 'tweet-video-transcript-search',
    text: 'Bookmarked video transcripts become searchable after yt-dlp and Whisper finish the local enrichment queue.',
    semanticTags: JSON.stringify(['video', 'transcript', 'search']),
    entities: JSON.stringify({ tools: ['yt-dlp', 'Whisper'] }),
    source: 'bookmark',
  },
]

function createFixtureDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'siftly-search-'))
  const dbPath = path.join(dir, 'siftly-test.db')
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE Bookmark (
        id TEXT PRIMARY KEY,
        tweetId TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        authorHandle TEXT NOT NULL,
        authorName TEXT NOT NULL,
        tweetCreatedAt DATETIME,
        importedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        rawJson TEXT NOT NULL,
        semanticTags TEXT,
        entities TEXT,
        enrichedAt DATETIME,
        enrichmentMeta TEXT,
        source TEXT NOT NULL DEFAULT 'bookmark'
      );
      CREATE TABLE MediaItem (
        id TEXT PRIMARY KEY,
        bookmarkId TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        thumbnailUrl TEXT,
        localPath TEXT,
        imageTags TEXT
      );
    `)

    const insert = db.prepare(`
      INSERT INTO Bookmark (id, tweetId, text, authorHandle, authorName, tweetCreatedAt, rawJson, semanticTags, entities, source)
      VALUES (@id, @tweetId, @text, @authorHandle, @authorName, @tweetCreatedAt, @rawJson, @semanticTags, @entities, @source)
    `)

    for (const fixture of fixtures) {
      insert.run({
        ...fixture,
        authorHandle: `author_${fixture.id}`,
        authorName: `Author ${fixture.id}`,
        tweetCreatedAt: '2026-06-07T12:00:00.000Z',
        rawJson: JSON.stringify({ id: fixture.tweetId, text: fixture.text }),
      })
    }
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

function probeSqliteVecAvailability(): { available: boolean; reason: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'siftly-vec-probe-'))
  const dbPath = path.join(dir, 'probe.db')
  const store = openVectorStore({ dbPath })
  try {
    return {
      available: store.mode === 'sqlite-vec',
      reason: store.status.reason,
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const sqliteVecAvailability = probeSqliteVecAvailability()
const realSqliteVecIt = sqliteVecAvailability.available ? it : it.skip
const realSqliteVecTestName = sqliteVecAvailability.available
  ? 'keeps real sqlite-vec results complete across dimension changes and metadata filters'
  : `keeps real sqlite-vec results complete across dimension changes and metadata filters (skipped: ${sqliteVecAvailability.reason})`

type StoreWithInternalDb = ReturnType<typeof openVectorStore> & { db: Database.Database }

function storeInternalDb(store: ReturnType<typeof openVectorStore>): Database.Database {
  return (store as StoreWithInternalDb).db
}

function seedOutOfScopeSqliteVecCandidate(
  db: Database.Database,
  bookmarkId: string,
  model: string,
  vector: number[],
): void {
  db.prepare(`
    INSERT INTO bookmark_embeddings (bookmark_id, vector_json, model, dimensions, embedded_at)
    VALUES (@bookmarkId, @vectorJson, @model, @dimensions, CURRENT_TIMESTAMP)
  `).run({
    bookmarkId,
    vectorJson: JSON.stringify(vector),
    model,
    dimensions: vector.length,
  })
  db.prepare('INSERT OR IGNORE INTO bookmark_vec_idmap (bookmark_id) VALUES (?)').run(bookmarkId)
  const row = db.prepare('SELECT rowid FROM bookmark_vec_idmap WHERE bookmark_id = ?').get(bookmarkId) as { rowid: number } | undefined
  if (!row) throw new Error(`missing sqlite-vec id map row for ${bookmarkId}`)
  const rowid = BigInt(row.rowid)
  db.prepare('DELETE FROM bookmark_vec WHERE rowid = ?').run(rowid)
  db.prepare('INSERT INTO bookmark_vec (rowid, embedding) VALUES (?, ?)').run(rowid, JSON.stringify(vector))
}

describe('hybrid bookmark search', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('loads sqlite-vec when available or reports and proves the brute-force cosine fallback', async () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    const actualStore = openVectorStore({ dbPath })
    try {
      console.info(`sqlite-vec mode: ${actualStore.mode} (${actualStore.status.reason})`)
      expect(['sqlite-vec', 'bruteforce']).toContain(actualStore.mode)
      expect(actualStore.status.checked).toBe(true)
      if (actualStore.mode === 'bruteforce') {
        expect(actualStore.status.reason).toMatch(/sqlite-vec|fallback/i)
      }
    } finally {
      actualStore.close()
    }

    const embedResult = await embedBookmarkCorpus({
      dbPath,
      provider,
      force: true,
      vecOptions: { forceFallback: true },
    })
    expect(embedResult.embedded).toBe(fixtures.length)
    expect(embedResult.vecMode).toBe('bruteforce')

    const fallbackStore = openVectorStore({ dbPath, forceFallback: true })
    try {
      const nearest = fallbackStore.search(keywordVector('sqlite vec macos semantic search'), 3, provider.model)
      expect(nearest[0]?.bookmarkId).toBe('b-sqlite-vec')
      expect(nearest[0]?.score).toBeGreaterThan(0)
    } finally {
      fallbackStore.close()
    }
  })

  realSqliteVecIt(realSqliteVecTestName, () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    const store = openVectorStore({ dbPath })
    try {
      expect(store.mode).toBe('sqlite-vec')

      store.upsert({ bookmarkId: 'b-sqlite-vec', model: 'old-two-dimensional-model', vector: [1, 0] })
      expect(store.search([1, 0], 1, 'old-two-dimensional-model')).toMatchObject([
        { bookmarkId: 'b-sqlite-vec', mode: 'sqlite-vec' },
      ])

      const activeModel = 'active-three-dimensional-model'
      store.upsert({ bookmarkId: 'b-xurl', model: activeModel, vector: [0.7, 0.3, 0] })
      store.upsert({ bookmarkId: 'b-openai-local', model: activeModel, vector: [0.65, 0.35, 0] })
      store.upsert({ bookmarkId: 'b-obsidian', model: activeModel, vector: [0, 1, 0] })

      const db = storeInternalDb(store)
      const meta = db.prepare('SELECT model, dimensions FROM bookmark_vec_meta WHERE key = ?').get('active')
      expect(meta).toEqual({ model: activeModel, dimensions: 3 })

      // Reproduce the vec0 starvation bug: the closest KNN rows can belong to
      // another model/dimension and then get filtered out after MATCH.
      seedOutOfScopeSqliteVecCandidate(db, 'other-nearest-a', 'other-three-dimensional-model', [1, 0, 0])
      seedOutOfScopeSqliteVecCandidate(db, 'other-nearest-b', 'other-three-dimensional-model', [0.99, 0.01, 0])

      const nearest = store.search([1, 0, 0], 2, activeModel)
      expect(nearest).toHaveLength(2)
      expect(nearest.map((row) => row.mode)).toEqual(['sqlite-vec', 'sqlite-vec'])
      expect(nearest.map((row) => row.bookmarkId)).toEqual(['b-xurl', 'b-openai-local'])
    } finally {
      store.close()
    }
  })

  realSqliteVecIt('self-heals legacy sqlite-vec rowids shadow table while embedding', async () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    const db = new Database(dbPath)
    try {
      db.exec('CREATE TABLE bookmark_vec_rowids (rowid INTEGER PRIMARY KEY, bookmark_id TEXT NOT NULL UNIQUE)')
    } finally {
      db.close()
    }

    const embedResult = await embedBookmarkCorpus({ dbPath, provider, force: true })
    expect(embedResult.vecMode).toBe('sqlite-vec')

    const store = openVectorStore({ dbPath })
    try {
      const nearest = store.search(keywordVector('sqlite vec macos semantic search'), 3, provider.model)
      expect(nearest.length).toBeGreaterThan(0)
      expect(nearest.every((row) => row.mode === 'sqlite-vec')).toBe(true)
      expect(nearest[0]?.bookmarkId).toBe('b-sqlite-vec')
    } finally {
      store.close()
    }
  })

  realSqliteVecIt('normalizes sqlite-vec limit values before binding integer parameters', () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    const store = openVectorStore({ dbPath })
    try {
      const activeModel = 'active-limit-normalization-model'
      store.upsert({ bookmarkId: 'b-xurl', model: activeModel, vector: [1, 0, 0] })
      store.upsert({ bookmarkId: 'b-openai-local', model: activeModel, vector: [0.9, 0.1, 0] })
      store.upsert({ bookmarkId: 'b-obsidian', model: activeModel, vector: [0, 1, 0] })

      const nearest = store.search([1, 0, 0], '1.9' as unknown as number, activeModel)
      expect(nearest).toHaveLength(1)
      expect(nearest[0]).toMatchObject({ bookmarkId: 'b-xurl', mode: 'sqlite-vec' })
      expect(nearest.every((row) => row.mode === 'sqlite-vec')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('scopes brute-force vector search to the active model and skips mixed dimensions', () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    const store = openVectorStore({ dbPath, forceFallback: true })
    try {
      store.upsert({ bookmarkId: 'b-xurl', model: 'old-two-dimensional-model', vector: [1, 0] })
      store.upsert({ bookmarkId: 'b-sqlite-vec', model: 'active-three-dimensional-model', vector: [0.8, 0.6, 0] })
      store.upsert({ bookmarkId: 'b-openai-local', model: 'active-three-dimensional-model', vector: [0, 1, 0] })

      const nearest = store.search([1, 0, 0], 3, 'active-three-dimensional-model')
      const nearestIds = nearest.map((row) => row.bookmarkId)

      expect(nearestIds).toContain('b-sqlite-vec')
      expect(nearest[0]?.bookmarkId).toBe('b-sqlite-vec')
      expect(nearestIds).not.toContain('b-xurl')
    } finally {
      store.close()
    }
  })

  it('returns each known-item tweet in the top 3 for the Phase 4 use-case A queries', async () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    await embedBookmarkCorpus({
      dbPath,
      provider,
      force: true,
      vecOptions: { forceFallback: true },
    })

    const cases = [
      ['xurl oauth bookmarks likes dedupe', 'tweet-xurl-oauth-dedupe'],
      ['sqlite vec macos hybrid FTS5 semantic search', 'tweet-sqlite-vec-hybrid-search'],
      ['OpenAI embedding provider local model swap', 'tweet-openai-embedding-provider-swap'],
    ] as const

    for (const [query, expectedTweetId] of cases) {
      const results = await hybridSearch({
        dbPath,
        query,
        provider,
        limit: 3,
        vecOptions: { forceFallback: true },
      })
      expect(results.map((row) => row.tweetId), query).toContain(expectedTweetId)
    }
  })

  it('keeps default hybrid search read-only instead of rebuilding FTS on every query', async () => {
    const { dir, dbPath } = createFixtureDb()
    cleanupDirs.push(dir)

    await embedBookmarkCorpus({
      dbPath,
      provider,
      force: true,
      vecOptions: { forceFallback: true },
    })

    const results = await hybridSearch({
      dbPath,
      query: 'sqlite vec macos semantic search',
      provider,
      limit: 3,
      vecOptions: { forceFallback: true },
    })
    expect(results.map((row) => row.tweetId)).toContain('tweet-sqlite-vec-hybrid-search')

    const db = new Database(dbPath)
    try {
      const ftsTable = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookmark_search_fts'
      `).get()
      expect(ftsTable).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('requires non-OpenAI base URLs for local and OpenAI-compatible embedding providers', () => {
    expect(() => createEmbeddingProviderFromEnv({
      NODE_ENV: 'test',
      SIFTLY_EMBED_PROVIDER: 'local',
      SIFTLY_EMBED_MODEL: 'local-fixture-model',
    })).toThrow(/SIFTLY_EMBED_BASE_URL|base URL/i)

    expect(() => createEmbeddingProviderFromEnv({
      NODE_ENV: 'test',
      SIFTLY_EMBED_PROVIDER: 'openai-compatible',
      SIFTLY_EMBED_BASE_URL: 'https://api.openai.com/v1',
    })).toThrow(/default OpenAI|api\.openai\.com/i)

    expect(() => createEmbeddingProviderFromEnv({
      NODE_ENV: 'test',
      SIFTLY_EMBED_PROVIDER: 'local',
      SIFTLY_EMBED_BASE_URL: 'http://localhost:8000/v1',
      SIFTLY_EMBED_MODEL: 'local-fixture-model',
    })).not.toThrow()
  })
})

describe('buildEmbeddingInput media text inclusion', () => {
  const baseRow = {
    id: 'b1', tweetId: '123', text: 'a tweet', authorHandle: 'ace', authorName: 'Ace',
    semanticTags: null, entities: null, source: 'bookmark',
  }

  it('includes OCR text, vision caption, and video transcript from media imageTags', () => {
    const mediaImageTags = JSON.stringify({
      text_ocr: ['BUY THE DIP'],
      vision_caption: 'a red candlestick chart crashing',
      video_transcript: 'here is why the market moved today',
    })
    const out = buildEmbeddingInput({ ...baseRow, mediaImageTags })
    expect(out).toContain('media:')
    expect(out).toContain('BUY THE DIP')
    expect(out).toContain('red candlestick chart')
    expect(out).toContain('why the market moved')
  })

  it('omits the media line entirely when there is no media text', () => {
    expect(buildEmbeddingInput({ ...baseRow, mediaImageTags: null })).not.toContain('media:')
    expect(buildEmbeddingInput({ ...baseRow })).not.toContain('media:')
  })

  it('flattens multiple media blobs joined by the SQL group_concat separator', () => {
    const blobs = [
      JSON.stringify({ vision_caption: 'first image of a cat' }),
      JSON.stringify({ vision_caption: 'second image of a dog' }),
    ].join('\u0001')
    const out = buildMediaSearchText(blobs)
    expect(out).toContain('first image of a cat')
    expect(out).toContain('second image of a dog')
  })
})
