import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'

import {
  OpenAIEmbeddingProvider,
  type EmbeddingProvider,
} from '../src/lib/search/embeddings'
import { openVectorStore, type VecOptions } from '../src/lib/vec'
import type {
  EnrichBookmarkInput,
  EnrichDb,
  EnrichMediaItemInput,
  VideoEnrichDb,
} from '../src/lib/enrich'
import { type ObsidianSavedTweet } from '../src/lib/obsidian/export'

const execFileAsync = promisify(execFile)

export const RECORDED_EMBEDDING_TERMS = [
  'hermes', 'language', 'model', 'release', 'agent', 'workflow',
  'sqlite', 'vec', 'migration', 'shadow', 'table', 'hybrid', 'search',
  'xurl', 'oauth', 'bookmark', 'ingestion', 'dedupe',
  'meme', 'ocr', 'obsidian', 'export', 'caption',
  'typescript', 'code', 'snippet', 'video', 'transcript', 'drain', 'local',
] as const

export const DIMENSION_A_TERMS = ['sqlite', 'vec', 'xurl', 'oauth', 'meme', 'video'] as const
export const DIMENSION_B_TERMS = [
  'hermes', 'release', 'sqlite', 'vec', 'migration', 'shadow', 'hybrid', 'search',
  'obsidian', 'ocr', 'meme', 'video', 'transcript', 'typescript', 'oauth', 'bookmark',
] as const

export class RecordedEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number

  constructor(
    readonly model = 'e2e-recorded-keyword-v1',
    private readonly terms: readonly string[] = RECORDED_EMBEDDING_TERMS,
  ) {
    this.dimensions = terms.length
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => keywordVector(text, this.terms))
  }
}

export function createRecordedProvider(model?: string, terms?: readonly string[]): RecordedEmbeddingProvider {
  return new RecordedEmbeddingProvider(model, terms)
}

export function createE2EEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  if (env.SIFTLY_E2E_LIVE_EMBED === '1') {
    const apiKey = env.SIFTLY_EMBED_API_KEY ?? env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('SIFTLY_E2E_LIVE_EMBED=1 requires SIFTLY_EMBED_API_KEY or OPENAI_API_KEY; refusing to silently use recorded embeddings')
    }
    console.info(`E2E embeddings mode=live-openai model=${env.SIFTLY_EMBED_MODEL ?? 'text-embedding-3-small'}`)
    return new OpenAIEmbeddingProvider({
      apiKey,
      baseURL: env.SIFTLY_EMBED_BASE_URL ?? env.OPENAI_BASE_URL,
      model: env.SIFTLY_EMBED_MODEL,
      dimensions: env.SIFTLY_EMBED_DIMENSIONS ? Number(env.SIFTLY_EMBED_DIMENSIONS) : undefined,
    })
  }

  console.info('E2E embeddings mode=recorded deterministic keyword vectors')
  return new RecordedEmbeddingProvider()
}

export function keywordVector(text: string, terms: readonly string[] = RECORDED_EMBEDDING_TERMS): number[] {
  const normalized = text.toLowerCase().replace(/sqlite-vec/g, 'sqlite vec')
  const tokens = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean))
  return terms.map((term) => (tokens.has(term) ? 1 : 0))
}

const configuredVecExtensionPath = process.env.SIFTLY_SQLITE_VEC_EXTENSION_PATH?.trim()
  || process.env.SQLITE_VEC_EXTENSION_PATH?.trim()
  || ''

if (!configuredVecExtensionPath) {
  console.warn('VEC0 E2E SKIPPED — set SIFTLY_SQLITE_VEC_EXTENSION_PATH to enforce')
}

export const realVecIt = configuredVecExtensionPath ? it : it.skip

export function requireVec0ExtensionPath(): string {
  if (!configuredVecExtensionPath) {
    throw new Error('VEC0 E2E requires SIFTLY_SQLITE_VEC_EXTENSION_PATH; this should only run inside realVecIt')
  }
  return path.resolve(configuredVecExtensionPath)
}

export function realVecOptions(): Omit<VecOptions, 'dbPath'> {
  return { extensionPath: requireVec0ExtensionPath() }
}

export function assertRealVecStore(dbPath: string, label: string): void {
  const store = openVectorStore({ dbPath, ...realVecOptions() })
  try {
    console.info(`VEC0 E2E ${label} mode=${store.mode} reason=${store.status.reason}`)
    if (store.mode !== 'sqlite-vec') {
      throw new Error(`VEC0 E2E hard-fail: expected sqlite-vec for ${label}, got ${store.mode}; reason=${store.status.reason}; error=${store.status.error ?? 'none'}`)
    }
  } finally {
    store.close()
  }
}

export interface E2EFixture {
  dir: string
  dbPath: string
  exportDir: string
  memeImagePath: string
  queuePath: string
}

export async function createE2EFixture(): Promise<E2EFixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'siftly-pipeline-e2e-'))
  const memeImagePath = path.join(dir, 'pineapple-meme.png')
  await createTextImage(memeImagePath, 'PINEAPPLE MEME')

  const dbPath = path.join(dir, 'siftly-e2e.db')
  const db = new Database(dbPath)
  try {
    createSchema(db)
    seedDatabase(db, memeImagePath)
  } finally {
    db.close()
  }

  return {
    dir,
    dbPath,
    exportDir: path.join(dir, 'obsidian-export'),
    memeImagePath,
    queuePath: path.join(dir, 'video-queue.jsonl'),
  }
}

export async function cleanupE2EFixture(fixture: E2EFixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true })
}

async function createTextImage(outputPath: string, text: string): Promise<void> {
  await execFileAsync('magick', [
    '-size', '1000x360',
    'xc:white',
    '-fill', 'black',
    '-gravity', 'center',
    '-pointsize', '76',
    '-annotate', '0', text,
    outputPath,
  ], { timeout: 30_000 })
}

function createSchema(db: Database.Database): void {
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
    CREATE TABLE Category (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      description TEXT,
      isAiGenerated INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE BookmarkCategory (
      bookmarkId TEXT NOT NULL,
      categoryId TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (bookmarkId, categoryId)
    );
  `)
}

interface SeedBookmark {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string
  source: 'bookmark' | 'like'
  hashtags?: string[]
  urls?: string[]
  mentions?: string[]
  categorySlugs: string[]
  media?: Array<{ id: string; type: string; url: string; thumbnailUrl: string | null; imageTags?: string | null }>
}

const categories = [
  { id: 'cat-ai', name: 'AI/ML', slug: 'ai-resources', color: '#22c55e' },
  { id: 'cat-dev', name: 'Developer Tools', slug: 'dev-tools', color: '#3b82f6' },
  { id: 'cat-productivity', name: 'Productivity', slug: 'productivity', color: '#a855f7' },
  { id: 'cat-memes', name: 'Memes', slug: 'funny-memes', color: '#f97316' },
] as const

function seedDatabase(db: Database.Database, memeImagePath: string): void {
  const insertCategory = db.prepare(`
    INSERT INTO Category (id, name, slug, color) VALUES (@id, @name, @slug, @color)
  `)
  for (const category of categories) insertCategory.run(category)

  const bookmarks: SeedBookmark[] = [
    {
      id: 'b-hermes-release',
      tweetId: '100000000001',
      text: 'Hermes v0.16.0 is out now: a language model release for agent workflows with better local memory.',
      authorHandle: 'Teknium1',
      authorName: 'Teknium',
      tweetCreatedAt: '2026-06-01T12:00:00.000Z',
      source: 'bookmark',
      hashtags: ['AI'],
      urls: ['https://nousresearch.com/hermes-release'],
      categorySlugs: ['ai-resources'],
    },
    {
      id: 'b-sqlite-vec-migration',
      tweetId: '100000000002',
      text: 'sqlite-vec migration note: drop the legacy shadow table before vector writes so hybrid search stays on vec0.',
      authorHandle: 'sqlitevec',
      authorName: 'SQLite Vec',
      tweetCreatedAt: '2026-06-02T12:00:00.000Z',
      source: 'bookmark',
      hashtags: ['SQLite'],
      urls: ['https://github.com/asg017/sqlite-vec'],
      categorySlugs: ['dev-tools'],
    },
    {
      id: 'b-xurl-oauth-ingest',
      tweetId: '100000000003',
      text: 'xurl OAuth bookmark ingestion handles likes, pagination, and bookmark-wins dedupe without saved_at timestamps.',
      authorHandle: 'angalexg',
      authorName: 'Ace',
      tweetCreatedAt: '2026-06-03T12:00:00.000Z',
      source: 'bookmark',
      hashtags: ['OAuth2'],
      mentions: ['xdev'],
      categorySlugs: ['dev-tools'],
    },
    {
      id: 'b-obsidian-ocr-meme',
      tweetId: '100000000004',
      text: 'Obsidian export should preserve the OCR caption from this agent workflow meme image.',
      authorHandle: 'memeacct',
      authorName: 'Meme Account',
      tweetCreatedAt: '2026-06-04T12:00:00.000Z',
      source: 'like',
      hashtags: ['meme'],
      categorySlugs: ['funny-memes'],
      media: [{ id: 'media-meme', type: 'photo', url: memeImagePath, thumbnailUrl: null, imageTags: null }],
    },
    {
      id: 'b-typescript-code-search',
      tweetId: '100000000005',
      text: 'TypeScript code snippet: const hybridSearch = async () => run sqlite vec and FTS together.',
      authorHandle: 'devtoolsdaily',
      authorName: 'Dev Tools Daily',
      tweetCreatedAt: '2026-06-05T12:00:00.000Z',
      source: 'bookmark',
      hashtags: ['TypeScript'],
      urls: ['https://github.com/example/hybrid-search'],
      categorySlugs: ['dev-tools'],
    },
    {
      id: 'b-video-transcript-drain',
      tweetId: '100000000006',
      text: 'Local video transcript drain keeps spoken demos searchable without blocking the main enrichment budget.',
      authorHandle: 'videodev',
      authorName: 'Video Dev',
      tweetCreatedAt: '2026-06-06T12:00:00.000Z',
      source: 'bookmark',
      hashtags: ['video'],
      categorySlugs: ['ai-resources'],
      media: [{
        id: 'media-video',
        type: 'video',
        url: 'https://video.twimg.com/ext_tw_video/100000000006/pu/vid/720x720/demo.mp4',
        thumbnailUrl: null,
        imageTags: JSON.stringify({ text_ocr: ['VIDEO OCR SHOULD STAY'], ocr_backend: 'tesseract' }),
      }],
    },
  ]

  const insertBookmark = db.prepare(`
    INSERT INTO Bookmark (
      id, tweetId, text, authorHandle, authorName, tweetCreatedAt, importedAt,
      rawJson, semanticTags, entities, enrichmentMeta, source
    ) VALUES (
      @id, @tweetId, @text, @authorHandle, @authorName, @tweetCreatedAt, @importedAt,
      @rawJson, @semanticTags, @entities, NULL, @source
    )
  `)
  const insertMedia = db.prepare(`
    INSERT INTO MediaItem (id, bookmarkId, type, url, thumbnailUrl, localPath, imageTags)
    VALUES (@id, @bookmarkId, @type, @url, @thumbnailUrl, NULL, @imageTags)
  `)
  const insertBookmarkCategory = db.prepare(`
    INSERT INTO BookmarkCategory (bookmarkId, categoryId, confidence)
    VALUES (@bookmarkId, @categoryId, 1.0)
  `)

  const categoryBySlug = new Map<string, (typeof categories)[number]>(categories.map((category) => [category.slug, category]))
  for (const bookmark of bookmarks) {
    const rawJson = JSON.stringify({
      tweet: {
        id: bookmark.tweetId,
        text: bookmark.text,
        created_at: bookmark.tweetCreatedAt,
        author_id: `author-${bookmark.authorHandle}`,
        conversation_id: bookmark.tweetId,
        entities: {
          hashtags: (bookmark.hashtags ?? []).map((tag) => ({ tag })),
          mentions: (bookmark.mentions ?? []).map((username) => ({ username })),
          urls: (bookmark.urls ?? []).map((url) => ({ expanded_url: url })),
        },
        attachments: bookmark.media?.length ? { media_keys: bookmark.media.map((item) => item.id) } : undefined,
      },
      includes: {
        media: (bookmark.media ?? []).map((item) => ({ media_key: item.id, type: item.type, url: item.url })),
      },
    })
    insertBookmark.run({
      ...bookmark,
      importedAt: bookmark.tweetCreatedAt,
      rawJson,
      semanticTags: null,
      entities: null,
    })
    for (const media of bookmark.media ?? []) {
      insertMedia.run({ bookmarkId: bookmark.id, imageTags: null, ...media })
    }
    for (const slug of bookmark.categorySlugs) {
      const category = categoryBySlug.get(slug)
      if (!category) throw new Error(`missing test category ${slug}`)
      insertBookmarkCategory.run({ bookmarkId: bookmark.id, categoryId: category.id })
    }
  }
}

interface BookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string | null
  importedAt: string
  rawJson: string
  semanticTags: string | null
  entities: string | null
  enrichmentMeta: string | null
  source: 'bookmark' | 'like'
}

interface MediaRow {
  id: string
  bookmarkId: string
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
  imageTags: string | null
}

interface CategoryRow {
  id: string
  name: string
  slug: string
  color: string
}

export function selectEnrichBookmarks(db: Database.Database): EnrichBookmarkInput[] {
  const rows = db.prepare(`
    SELECT id, tweetId, text, authorHandle, rawJson, entities, semanticTags, enrichmentMeta
    FROM Bookmark ORDER BY importedAt ASC
  `).all() as Array<Omit<BookmarkRow, 'authorName' | 'tweetCreatedAt' | 'importedAt' | 'source'>>

  return rows.map((row) => ({
    ...row,
    mediaItems: selectMediaItems(db, row.id),
    categories: selectCategories(db, row.id).map((category) => ({ category: { slug: category.slug } })),
  }))
}

export function selectMediaItems(db: Database.Database, bookmarkId?: string): EnrichMediaItemInput[] {
  const where = bookmarkId ? 'WHERE bookmarkId = @bookmarkId' : ''
  return db.prepare(`
    SELECT id, type, url, thumbnailUrl, imageTags FROM MediaItem ${where} ORDER BY id ASC
  `).all({ bookmarkId }) as EnrichMediaItemInput[]
}

export function selectMediaForOcr(db: Database.Database): EnrichMediaItemInput[] {
  return db.prepare(`
    SELECT id, type, url, thumbnailUrl, imageTags
    FROM MediaItem
    WHERE type IN ('photo', 'gif')
    ORDER BY id ASC
  `).all() as EnrichMediaItemInput[]
}

function selectCategories(db: Database.Database, bookmarkId: string): CategoryRow[] {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, c.color
    FROM BookmarkCategory bc
    JOIN Category c ON c.id = bc.categoryId
    WHERE bc.bookmarkId = ?
    ORDER BY c.slug ASC
  `).all(bookmarkId) as CategoryRow[]
}

export function selectObsidianBookmarks(db: Database.Database): ObsidianSavedTweet[] {
  const rows = db.prepare(`
    SELECT id, tweetId, text, authorHandle, authorName, tweetCreatedAt, importedAt,
      rawJson, semanticTags, entities, enrichmentMeta, source
    FROM Bookmark ORDER BY importedAt ASC
  `).all() as BookmarkRow[]

  return rows.map((row) => ({
    id: row.id,
    tweetId: row.tweetId,
    text: row.text,
    authorHandle: row.authorHandle,
    authorName: row.authorName,
    tweetCreatedAt: row.tweetCreatedAt,
    importedAt: row.importedAt,
    rawJson: row.rawJson,
    semanticTags: row.semanticTags,
    entities: row.entities,
    enrichmentMeta: row.enrichmentMeta,
    source: row.source,
    mediaItems: selectObsidianMediaItems(db, row.id),
    categories: selectCategories(db, row.id).map((category) => ({ category })),
  }))
}

function selectObsidianMediaItems(db: Database.Database, bookmarkId: string): ObsidianSavedTweet['mediaItems'] {
  return db.prepare(`
    SELECT id, type, url, thumbnailUrl, localPath, imageTags
    FROM MediaItem
    WHERE bookmarkId = ?
    ORDER BY id ASC
  `).all(bookmarkId) as ObsidianSavedTweet['mediaItems']
}

export function mediaImageTags(db: Database.Database, mediaItemId: string): string | null {
  const row = db.prepare('SELECT imageTags FROM MediaItem WHERE id = ?').get(mediaItemId) as { imageTags: string | null } | undefined
  return row?.imageTags ?? null
}

export class SqliteE2EDb implements EnrichDb, VideoEnrichDb {
  constructor(private readonly db: Database.Database) {}

  bookmark = {
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      updateById(this.db, 'Bookmark', where.id, data)
      return { id: where.id, ...data }
    },
  }

  category = {
    findMany: async (args: Record<string, unknown>) => {
      const slugs = extractSlugIn(args)
      if (slugs.length === 0) return []
      const placeholders = slugs.map(() => '?').join(', ')
      return this.db.prepare(`
        SELECT id, slug FROM Category WHERE slug IN (${placeholders}) ORDER BY slug ASC
      `).all(...slugs) as Array<{ id: string; slug: string }>
    },
  }

  bookmarkCategory = {
    upsert: async (args: Record<string, unknown>) => {
      const payload = args as {
        where?: { bookmarkId_categoryId?: { bookmarkId?: string; categoryId?: string } }
        update?: { confidence?: number }
        create?: { bookmarkId?: string; categoryId?: string; confidence?: number }
      }
      const bookmarkId = payload.where?.bookmarkId_categoryId?.bookmarkId ?? payload.create?.bookmarkId
      const categoryId = payload.where?.bookmarkId_categoryId?.categoryId ?? payload.create?.categoryId
      if (!bookmarkId || !categoryId) throw new Error('bookmarkCategory.upsert requires bookmarkId and categoryId')
      const confidence = payload.update?.confidence ?? payload.create?.confidence ?? 1
      this.db.prepare(`
        INSERT INTO BookmarkCategory (bookmarkId, categoryId, confidence)
        VALUES (@bookmarkId, @categoryId, @confidence)
        ON CONFLICT(bookmarkId, categoryId) DO UPDATE SET confidence = excluded.confidence
      `).run({ bookmarkId, categoryId, confidence })
      return { bookmarkId, categoryId, confidence }
    },
  }

  mediaItem = {
    findUnique: async ({ where }: { where: { id: string }; select: { imageTags: true } }) => {
      const row = this.db.prepare('SELECT imageTags FROM MediaItem WHERE id = ?').get(where.id) as { imageTags: string | null } | undefined
      return row ? { imageTags: row.imageTags } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: { imageTags: string } }) => {
      this.db.prepare('UPDATE MediaItem SET imageTags = @imageTags WHERE id = @id').run({ id: where.id, imageTags: data.imageTags })
      return { id: where.id, imageTags: data.imageTags }
    },
  }
}

function extractSlugIn(args: Record<string, unknown>): string[] {
  const where = args.where as { slug?: { in?: unknown } } | undefined
  const raw = where?.slug?.in
  return Array.isArray(raw) ? raw.map(String) : []
}

function updateById(db: Database.Database, table: string, id: string, data: Record<string, unknown>): void {
  const entries = Object.entries(data)
  if (entries.length === 0) return
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ')
  const params: Record<string, unknown> = { id }
  for (const [key, value] of entries) params[key] = toSqlValue(value)
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = @id`).run(params)
}

function toSqlValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  return value
}

export function parseImageTags(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8')
}
