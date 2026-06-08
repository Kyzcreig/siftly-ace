import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { openVectorStore } from '../vec'
import { createEmbeddingProviderFromEnv, embedBookmarkCorpus, type EmbeddingProvider } from './embeddings'
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
