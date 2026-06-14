import OpenAI from 'openai'
import Database from 'better-sqlite3'

import { buildImageContext } from '../../../lib/image-context'
import { ensureEmbeddingTable, l2NormalizeVector, openVectorStore, type VecOptions, type VecStatus } from '../vec'

export interface EmbeddingProvider {
  readonly model: string
  readonly dimensions?: number
  embed(texts: string[]): Promise<number[][]>
}

export interface EmbedBookmarkCorpusOptions {
  dbPath: string
  provider?: EmbeddingProvider
  batchSize?: number
  limit?: number
  force?: boolean
  vecOptions?: Omit<VecOptions, 'dbPath'>
}

export interface EmbedBookmarkCorpusResult {
  selected: number
  embedded: number
  skipped: number
  model: string
  dimensions: number | null
  vecMode: 'sqlite-vec' | 'bruteforce'
  vecStatus: VecStatus
}

interface BookmarkEmbeddingRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  semanticTags: string | null
  entities: string | null
  source: string
  mediaImageTags?: string | null
}

interface OpenAIEmbeddingProviderOptions {
  apiKey?: string
  baseURL?: string
  model?: string
  dimensions?: number
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions?: number
  private readonly client: OpenAI

  constructor(options: OpenAIEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL
    this.dimensions = options.dimensions
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseURL,
    })
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    })

    return response.data.map((item) => l2NormalizeVector(item.embedding.map((value) => Number(value))))
  }
}

export function createEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = (env.SIFTLY_EMBED_PROVIDER ?? 'openai').toLowerCase()
  if (provider !== 'openai' && provider !== 'openai-compatible' && provider !== 'local') {
    throw new Error(`Unsupported SIFTLY_EMBED_PROVIDER: ${provider}`)
  }

  const baseURL = env.SIFTLY_EMBED_BASE_URL ?? env.OPENAI_BASE_URL
  if (provider === 'local' || provider === 'openai-compatible') {
    if (!baseURL) {
      throw new Error(`${provider} embeddings require SIFTLY_EMBED_BASE_URL or OPENAI_BASE_URL; refusing to fall back to the default OpenAI endpoint`)
    }
    if (isDefaultOpenAIBaseUrl(baseURL)) {
      throw new Error(`${provider} embeddings require a non-OpenAI base URL; received default OpenAI endpoint ${baseURL}`)
    }
  }

  const dimensions = parseOptionalPositiveInt(env.SIFTLY_EMBED_DIMENSIONS, 'SIFTLY_EMBED_DIMENSIONS')
  return new OpenAIEmbeddingProvider({
    apiKey: env.SIFTLY_EMBED_API_KEY ?? env.OPENAI_API_KEY ?? (provider === 'openai' ? undefined : 'local'),
    baseURL,
    model: env.SIFTLY_EMBED_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    dimensions,
  })
}

export async function embedBookmarkCorpus(options: EmbedBookmarkCorpusOptions): Promise<EmbedBookmarkCorpusResult> {
  const provider = options.provider ?? createEmbeddingProviderFromEnv()
  const batchSize = normalizeBatchSize(options.batchSize)
  const db = new Database(options.dbPath)
  const store = openVectorStore({ dbPath: options.dbPath, ...options.vecOptions })
  let selected = 0
  let embedded = 0
  let dimensions: number | null = null

  try {
    ensureEmbeddingTable(db)
    const rows = selectRowsForEmbedding(db, provider.model, options)
    selected = rows.length

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      const inputs = batch.map(buildEmbeddingInput)
      const vectors = await provider.embed(inputs)
      if (vectors.length !== batch.length) {
        throw new Error(`embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`)
      }

      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j]
        dimensions = vector.length
        store.upsert({ bookmarkId: batch[j].id, vector, model: provider.model })
        embedded++
      }
    }

    return {
      selected,
      embedded,
      skipped: Math.max(0, selected - embedded),
      model: provider.model,
      dimensions,
      vecMode: store.mode,
      vecStatus: store.status,
    }
  } finally {
    store.close()
    db.close()
  }
}

export function buildEmbeddingInput(row: BookmarkEmbeddingRow): string {
  const mediaText = buildMediaSearchText(row.mediaImageTags)
  return [
    `tweet_id: ${row.tweetId}`,
    `source: ${row.source}`,
    `author: @${row.authorHandle} (${row.authorName})`,
    `text: ${row.text}`,
    row.semanticTags ? `semantic_tags: ${jsonToSearchText(row.semanticTags)}` : '',
    row.entities ? `entities: ${jsonToSearchText(row.entities)}` : '',
    mediaText ? `media: ${mediaText}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Flatten one or more media imageTags JSON blobs (joined by the SQL group_concat
 * separator) into human-readable search text covering OCR, vision captions, and
 * video transcripts. Empty when no media or no extractable text.
 */
export function buildMediaSearchText(rawMediaImageTags: string | null | undefined): string {
  if (!rawMediaImageTags) return ''
  return rawMediaImageTags
    .split('\u0001')
    .map((blob) => buildImageContext(blob.trim() || undefined))
    .filter(Boolean)
    .join(' | ')
}

function selectRowsForEmbedding(
  db: Database.Database,
  model: string,
  options: EmbedBookmarkCorpusOptions,
): BookmarkEmbeddingRow[] {
  const limit = normalizeLimit(options.limit)
  const limitSql = limit === null ? '' : 'LIMIT @limit'
  const params = { model, limit }

  const whereSql = options.force
    ? ''
    : `WHERE NOT EXISTS (
        SELECT 1 FROM bookmark_embeddings e
        WHERE e.bookmark_id = b.id AND e.model = @model
      )`

  return db.prepare(`
    SELECT
      b.id AS id,
      b.tweetId AS tweetId,
      b.text AS text,
      b.authorHandle AS authorHandle,
      b.authorName AS authorName,
      b.semanticTags AS semanticTags,
      b.entities AS entities,
      b.source AS source,
      (
        SELECT group_concat(imageTags, char(1)) FROM (
          SELECT m.imageTags AS imageTags
          FROM MediaItem m
          WHERE m.bookmarkId = b.id AND m.imageTags IS NOT NULL AND m.imageTags != '' AND m.imageTags != '{}'
          ORDER BY m.id
        )
      ) AS mediaImageTags
    FROM Bookmark b
    ${whereSql}
    ORDER BY COALESCE(b.tweetCreatedAt, b.importedAt) DESC, b.id ASC
    ${limitSql}
  `).all(params) as BookmarkEmbeddingRow[]
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (!batchSize || !Number.isFinite(batchSize) || batchSize <= 0) return 64
  return Math.min(256, Math.floor(batchSize))
}

function normalizeLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive integer')
  return Math.floor(limit)
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function isDefaultOpenAIBaseUrl(baseURL: string): boolean {
  const value = baseURL.trim().toLowerCase()
  if (!value) return false
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`)
    return parsed.hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return value.includes('api.openai.com')
  }
}

function jsonToSearchText(raw: string): string {
  try {
    return flattenJson(JSON.parse(raw)).join(' ')
  } catch {
    return raw
  }
}

function flattenJson(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(flattenJson)
  if (typeof value === 'object') return Object.values(value).flatMap(flattenJson)
  return []
}
