import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

export type VecMode = 'sqlite-vec' | 'bruteforce'

export interface VecStatus {
  checked: boolean
  reason: string
  extensionPath?: string
  error?: string
}

export interface VecOptions {
  dbPath: string
  extensionPath?: string
  forceFallback?: boolean
  env?: NodeJS.ProcessEnv
}

export interface VectorRecord {
  bookmarkId: string
  vector: number[]
  model: string
}

export interface VectorSearchResult {
  bookmarkId: string
  distance: number
  score: number
  mode: VecMode
}

export interface VectorStore {
  readonly mode: VecMode
  readonly status: VecStatus
  upsert(record: VectorRecord): void
  search(vector: number[], limit: number, model: string): VectorSearchResult[]
  close(): void
}

interface SqliteVecMeta {
  model: string
  dimensions: number
}

const EMBEDDING_TABLE = 'bookmark_embeddings'
const SQLITE_VEC_TABLE = 'bookmark_vec'
const SQLITE_VEC_ROWIDS_TABLE = 'bookmark_vec_idmap'
const SQLITE_VEC_META_TABLE = 'bookmark_vec_meta'
const SQLITE_VEC_META_KEY = 'active'

export function openVectorStore(options: VecOptions): VectorStore {
  return new BetterSqliteVectorStore(options)
}

export function ensureEmbeddingTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_TABLE} (
      bookmark_id TEXT PRIMARY KEY,
      vector_json TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bookmark_embeddings_model ON ${EMBEDDING_TABLE}(model);
  `)
}

export function resolveDatabasePath(databaseUrl: string | undefined, cwd = process.cwd()): string {
  if (!databaseUrl || databaseUrl.trim() === '') return `${cwd}/prisma/dev.db`
  if (!databaseUrl.startsWith('file:')) return databaseUrl

  const filePath = databaseUrl.slice('file:'.length)
  if (filePath.startsWith('/')) return filePath
  return `${cwd}/${filePath}`
}

class BetterSqliteVectorStore implements VectorStore {
  private readonly db: Database.Database
  private sqliteVecReady = false
  mode: VecMode
  status: VecStatus

  constructor(private readonly options: VecOptions) {
    this.db = new Database(options.dbPath)
    ensureEmbeddingTable(this.db)

    if (options.forceFallback) {
      this.mode = 'bruteforce'
      this.status = {
        checked: true,
        reason: 'sqlite-vec disabled by forceFallback; using brute-force cosine fallback',
      }
      return
    }

    const loadStatus = this.tryLoadSqliteVec(options)
    this.status = loadStatus
    this.mode = loadStatus.error ? 'bruteforce' : 'sqlite-vec'
    this.sqliteVecReady = this.mode === 'sqlite-vec'
  }

  upsert(record: VectorRecord): void {
    assertVector(record.vector)
    ensureEmbeddingTable(this.db)

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO ${EMBEDDING_TABLE} (bookmark_id, vector_json, model, dimensions, embedded_at)
        VALUES (@bookmarkId, @vectorJson, @model, @dimensions, CURRENT_TIMESTAMP)
        ON CONFLICT(bookmark_id) DO UPDATE SET
          vector_json = excluded.vector_json,
          model = excluded.model,
          dimensions = excluded.dimensions,
          embedded_at = excluded.embedded_at
      `).run({
        bookmarkId: record.bookmarkId,
        vectorJson: JSON.stringify(record.vector),
        model: record.model,
        dimensions: record.vector.length,
      })

      if (this.mode === 'sqlite-vec') {
        this.upsertSqliteVec(record)
      }
    })

    try {
      tx()
    } catch (err) {
      if (this.mode !== 'sqlite-vec') throw err
      this.demoteToFallback(`sqlite-vec write failed; using brute-force fallback`, err)
      this.db.prepare(`
        INSERT INTO ${EMBEDDING_TABLE} (bookmark_id, vector_json, model, dimensions, embedded_at)
        VALUES (@bookmarkId, @vectorJson, @model, @dimensions, CURRENT_TIMESTAMP)
        ON CONFLICT(bookmark_id) DO UPDATE SET
          vector_json = excluded.vector_json,
          model = excluded.model,
          dimensions = excluded.dimensions,
          embedded_at = excluded.embedded_at
      `).run({
        bookmarkId: record.bookmarkId,
        vectorJson: JSON.stringify(record.vector),
        model: record.model,
        dimensions: record.vector.length,
      })
    }
  }

  search(vector: number[], limit: number, model: string): VectorSearchResult[] {
    assertVector(vector)
    assertModel(model)
    const safeLimit = normalizeLimit(limit)

    if (this.mode === 'sqlite-vec' && this.sqliteVecReady) {
      try {
        if (this.sqliteVecTableMatches(model, vector.length)) {
          return this.searchSqliteVec(vector, safeLimit, model)
        }
      } catch (err) {
        this.demoteToFallback('sqlite-vec query failed; using brute-force fallback', err)
      }
    }

    return this.searchBruteForce(vector, safeLimit, model)
  }

  close(): void {
    this.db.close()
  }

  private tryLoadSqliteVec(options: VecOptions): VecStatus {
    try {
      this.db.prepare('SELECT vec_version() AS version').get()
      return { checked: true, reason: 'sqlite-vec already available in this SQLite connection' }
    } catch {
      // Extension is not preloaded. Try an explicit path next.
    }

    const extensionPath = sqliteVecExtensionPath(options)
    if (!extensionPath) {
      return {
        checked: true,
        reason: 'sqlite-vec extension path not configured; using brute-force cosine fallback',
        error: 'missing extension path',
      }
    }
    if (!existsSync(extensionPath)) {
      return {
        checked: true,
        reason: 'configured sqlite-vec extension path does not exist; using brute-force cosine fallback',
        extensionPath,
        error: 'extension path not found',
      }
    }

    try {
      this.db.loadExtension(extensionPath)
      this.db.prepare('SELECT vec_version() AS version').get()
      return { checked: true, reason: 'sqlite-vec extension loaded', extensionPath }
    } catch (err) {
      return {
        checked: true,
        reason: 'sqlite-vec extension failed to load; using brute-force cosine fallback',
        extensionPath,
        error: errorMessage(err),
      }
    }
  }

  private ensureSqliteVecTable(model: string, dimensions: number): void {
    if (!this.sqliteVecReady) return
    const currentMeta = this.readSqliteVecMeta()
    const needsRecreate = !currentMeta
      || currentMeta.model !== model
      || currentMeta.dimensions !== dimensions
      || !this.tableExists(SQLITE_VEC_TABLE)
      || !this.tableExists(SQLITE_VEC_ROWIDS_TABLE)

    if (needsRecreate) {
      this.recreateSqliteVecTables(model, dimensions)
    }
  }

  private recreateSqliteVecTables(model: string, dimensions: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SQLITE_VEC_META_TABLE} (
        key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      DROP TABLE IF EXISTS ${SQLITE_VEC_TABLE};
      DROP TABLE IF EXISTS ${SQLITE_VEC_ROWIDS_TABLE};
      CREATE TABLE ${SQLITE_VEC_ROWIDS_TABLE} (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        bookmark_id TEXT NOT NULL UNIQUE
      );
      CREATE VIRTUAL TABLE ${SQLITE_VEC_TABLE} USING vec0(
        embedding float[${dimensions}]
      );
    `)
    this.db.prepare(`
      INSERT INTO ${SQLITE_VEC_META_TABLE} (key, model, dimensions, updated_at)
      VALUES (@key, @model, @dimensions, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        updated_at = excluded.updated_at
    `).run({ key: SQLITE_VEC_META_KEY, model, dimensions })
    this.rebuildSqliteVecRows(model, dimensions)
  }

  private upsertSqliteVec(record: VectorRecord): void {
    this.ensureSqliteVecTable(record.model, record.vector.length)
    if (!this.sqliteVecReady) return
    this.insertSqliteVecRow(record.bookmarkId, record.vector)
  }

  private rebuildSqliteVecRows(model: string, dimensions: number): void {
    const rows = this.db.prepare(`
      SELECT bookmark_id AS bookmarkId, vector_json AS vectorJson
      FROM ${EMBEDDING_TABLE}
      WHERE model = @model AND dimensions = @dimensions
      ORDER BY bookmark_id ASC
    `).all({ model, dimensions }) as { bookmarkId: string; vectorJson: string }[]

    for (const row of rows) {
      const vector = parseVector(row.vectorJson)
      if (vector.length !== dimensions) continue
      this.insertSqliteVecRow(row.bookmarkId, vector)
    }
  }

  private insertSqliteVecRow(bookmarkId: string, vector: number[]): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO ${SQLITE_VEC_ROWIDS_TABLE} (bookmark_id)
      VALUES (?)
    `).run(bookmarkId)

    const row = this.db.prepare(`
      SELECT rowid FROM ${SQLITE_VEC_ROWIDS_TABLE} WHERE bookmark_id = ?
    `).get(bookmarkId) as { rowid: number } | undefined
    if (!row) throw new Error(`missing sqlite-vec rowid for bookmark ${bookmarkId}`)

    // sqlite-vec's vec0 virtual table requires a true INTEGER rowid. better-sqlite3
    // binds plain JS numbers as float64, which vec0 rejects ("Only integers are
    // allowed for primary key values"), silently demoting the store to brute-force.
    // Bind as BigInt so the value arrives as a SQLite integer.
    const rowid = BigInt(row.rowid)
    this.db.prepare(`DELETE FROM ${SQLITE_VEC_TABLE} WHERE rowid = ?`).run(rowid)
    this.db.prepare(`
      INSERT INTO ${SQLITE_VEC_TABLE} (rowid, embedding)
      VALUES (?, ?)
    `).run(rowid, JSON.stringify(vector))
  }

  private sqliteVecTableMatches(model: string, dimensions: number): boolean {
    const currentMeta = this.readSqliteVecMeta()
    return Boolean(
      currentMeta
      && currentMeta.model === model
      && currentMeta.dimensions === dimensions
      && this.tableExists(SQLITE_VEC_TABLE)
      && this.tableExists(SQLITE_VEC_ROWIDS_TABLE),
    )
  }

  private readSqliteVecMeta(): SqliteVecMeta | null {
    if (!this.tableExists(SQLITE_VEC_META_TABLE)) return null
    const row = this.db.prepare(`
      SELECT model, dimensions FROM ${SQLITE_VEC_META_TABLE} WHERE key = ?
    `).get(SQLITE_VEC_META_KEY) as { model: string; dimensions: number } | undefined
    if (!row) return null
    return { model: row.model, dimensions: Number(row.dimensions) }
  }

  private tableExists(tableName: string): boolean {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE name = ?
    `).get(tableName)
    return Boolean(row)
  }

  private searchSqliteVec(vector: number[], limit: number, model: string): VectorSearchResult[] {
    const vectorRows = this.sqliteVecRowCount()
    if (vectorRows <= 0) return []

    let candidateLimit = Math.min(vectorRows, Math.max(limit * 4, limit + 20))
    let rows = this.searchSqliteVecCandidates(vector, candidateLimit, limit, model)
    while (rows.length < limit && candidateLimit < vectorRows) {
      candidateLimit = Math.min(vectorRows, candidateLimit * 2)
      rows = this.searchSqliteVecCandidates(vector, candidateLimit, limit, model)
    }

    return rows.map((row) => ({
      bookmarkId: row.bookmarkId,
      distance: row.distance,
      score: 1 / (1 + Math.max(0, row.distance)),
      mode: 'sqlite-vec' as const,
    }))
  }

  private searchSqliteVecCandidates(
    vector: number[],
    candidateLimit: number,
    limit: number,
    model: string,
  ): { bookmarkId: string; distance: number }[] {
    return this.db.prepare(`
      SELECT m.bookmark_id AS bookmarkId, knn.distance AS distance
      FROM (
        SELECT rowid, distance
        FROM ${SQLITE_VEC_TABLE}
        WHERE embedding MATCH @embedding
          AND k = ${candidateLimit}
        ORDER BY distance
      ) knn
      JOIN ${SQLITE_VEC_ROWIDS_TABLE} m ON m.rowid = knn.rowid
      JOIN ${EMBEDDING_TABLE} e ON e.bookmark_id = m.bookmark_id
      WHERE e.model = @model
        AND e.dimensions = @dimensions
      ORDER BY knn.distance
      LIMIT @limit
    `).all({
      embedding: JSON.stringify(vector),
      model,
      dimensions: vector.length,
      limit,
    }) as { bookmarkId: string; distance: number }[]
  }

  private sqliteVecRowCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${SQLITE_VEC_TABLE}`).get() as { count: number | bigint } | undefined
    const vectorRows = Number(row?.count ?? 0)
    if (!Number.isFinite(vectorRows) || vectorRows <= 0) return 0
    return Math.floor(vectorRows)
  }

  private searchBruteForce(vector: number[], limit: number, model: string): VectorSearchResult[] {
    const rows = this.db.prepare(`
      SELECT bookmark_id AS bookmarkId, vector_json AS vectorJson, dimensions
      FROM ${EMBEDDING_TABLE}
      WHERE model = @model
    `).all({ model }) as { bookmarkId: string; vectorJson: string; dimensions: number }[]

    const results: VectorSearchResult[] = []
    for (const row of rows) {
      if (Number(row.dimensions) !== vector.length) continue
      const candidate = parseVector(row.vectorJson)
      if (candidate.length !== vector.length) continue
      const score = cosineSimilarity(vector, candidate)
      if (!Number.isFinite(score)) continue
      results.push({
        bookmarkId: row.bookmarkId,
        distance: 1 - score,
        score,
        mode: 'bruteforce',
      })
    }

    return results
      .sort((a, b) => b.score - a.score || a.bookmarkId.localeCompare(b.bookmarkId))
      .slice(0, limit)
  }

  private demoteToFallback(reason: string, err: unknown): void {
    this.mode = 'bruteforce'
    this.sqliteVecReady = false
    this.status = {
      checked: true,
      reason,
      error: errorMessage(err),
    }
  }
}

function sqliteVecExtensionPath(options: VecOptions): string | undefined {
  const env = options.env ?? process.env
  return options.extensionPath
    ?? env.SIFTLY_SQLITE_VEC_EXTENSION_PATH
    ?? env.SQLITE_VEC_EXTENSION_PATH
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 10
  return Math.min(200, Math.floor(limit))
}

function assertVector(vector: number[]): void {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('vector must be a non-empty number array')
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('vector contains a non-finite value')
  }
}

function assertModel(model: string): void {
  if (typeof model !== 'string' || model.trim() === '') throw new Error('model must be a non-empty string')
}

function parseVector(vectorJson: string): number[] {
  const parsed = JSON.parse(vectorJson) as unknown
  if (!Array.isArray(parsed)) throw new Error('stored vector is not an array')
  const vector = parsed.map((value) => Number(value))
  assertVector(vector)
  return vector
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.NaN
  const len = a.length

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
