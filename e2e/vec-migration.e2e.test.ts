import Database from 'better-sqlite3'
import { afterEach, describe, expect } from 'vitest'

import { embedBookmarkCorpus } from '../src/lib/search/embeddings'
import { hybridSearch } from '../src/lib/search'
import { openVectorStore } from '../src/lib/vec'
import {
  assertRealVecStore,
  cleanupE2EFixture,
  createE2EFixture,
  createRecordedProvider,
  DIMENSION_A_TERMS,
  DIMENSION_B_TERMS,
  realVecIt,
  realVecOptions,
  type E2EFixture,
} from './helpers'

const fixtures: E2EFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => cleanupE2EFixture(fixture)))
})

async function newFixture(): Promise<E2EFixture> {
  const fixture = await createE2EFixture()
  fixtures.push(fixture)
  return fixture
}

describe('sqlite-vec migration e2e', () => {
  realVecIt('self-heals the legacy bookmark_vec_rowids table and stays on sqlite-vec for KNN', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    try {
      db.exec('CREATE TABLE bookmark_vec_rowids (rowid INTEGER PRIMARY KEY, bookmark_id TEXT NOT NULL UNIQUE)')
    } finally {
      db.close()
    }

    const provider = createRecordedProvider()
    const embedResult = await embedBookmarkCorpus({
      dbPath: fixture.dbPath,
      provider,
      force: true,
      vecOptions: realVecOptions(),
    })
    console.info(`VEC0 E2E legacy-upgrade embed mode=${embedResult.vecMode} reason=${embedResult.vecStatus.reason}`)
    expect(embedResult.vecMode).toBe('sqlite-vec')
    assertRealVecStore(fixture.dbPath, 'legacy upgrade')

    const verifyDb = new Database(fixture.dbPath)
    try {
      const rowidColumns = verifyDb.prepare('PRAGMA table_info(bookmark_vec_rowids)').all() as Array<{ name: string }>
      expect(rowidColumns.map((column) => column.name)).not.toContain('bookmark_id')
      const idMapColumns = verifyDb.prepare('PRAGMA table_info(bookmark_vec_idmap)').all() as Array<{ name: string }>
      expect(idMapColumns.map((column) => column.name)).toContain('bookmark_id')
    } finally {
      verifyDb.close()
    }

    const store = openVectorStore({ dbPath: fixture.dbPath, ...realVecOptions() })
    try {
      const [queryVector] = await provider.embed(['sqlite vec migration shadow table'])
      const nearest = store.search(queryVector, 3, provider.model)
      expect(nearest.every((row) => row.mode === 'sqlite-vec')).toBe(true)
      expect(nearest.map((row) => row.bookmarkId)).toContain('b-sqlite-vec-migration')
    } finally {
      store.close()
    }
  }, 120_000)

  realVecIt('recreates vec0 tables on embedding provider dimension changes and keeps known-item search correct', async () => {
    const fixture = await newFixture()
    const providerA = createRecordedProvider('e2e-dim-a-model', DIMENSION_A_TERMS)
    const providerB = createRecordedProvider('e2e-dim-b-model', DIMENSION_B_TERMS)

    const first = await embedBookmarkCorpus({
      dbPath: fixture.dbPath,
      provider: providerA,
      force: true,
      vecOptions: realVecOptions(),
    })
    expect(first).toMatchObject({ embedded: 6, vecMode: 'sqlite-vec', dimensions: DIMENSION_A_TERMS.length })

    const second = await embedBookmarkCorpus({
      dbPath: fixture.dbPath,
      provider: providerB,
      force: true,
      vecOptions: realVecOptions(),
    })
    console.info(`VEC0 E2E dimension-change embed mode=${second.vecMode} dimensions=${second.dimensions}`)
    expect(second).toMatchObject({ embedded: 6, vecMode: 'sqlite-vec', dimensions: DIMENSION_B_TERMS.length })

    const db = new Database(fixture.dbPath)
    try {
      const vecOptions = realVecOptions()
      if (vecOptions.extensionPath) db.loadExtension(vecOptions.extensionPath)
      const meta = db.prepare('SELECT model, dimensions FROM bookmark_vec_meta WHERE key = ?').get('active')
      expect(meta).toEqual({ model: providerB.model, dimensions: DIMENSION_B_TERMS.length })
      const oldModelRows = db.prepare('SELECT COUNT(*) AS count FROM bookmark_embeddings WHERE model = ?').get(providerA.model) as { count: number }
      expect(oldModelRows.count).toBe(0)
      const activeRows = db.prepare('SELECT COUNT(*) AS count FROM bookmark_vec').get() as { count: number }
      expect(activeRows.count).toBe(6)
    } finally {
      db.close()
    }

    const cases = [
      ['hermes release language model', '100000000001'],
      ['sqlite vec migration shadow hybrid search', '100000000002'],
      ['obsidian ocr meme', '100000000004'],
    ] as const
    for (const [query, expectedTweetId] of cases) {
      const results = await hybridSearch({
        dbPath: fixture.dbPath,
        query,
        provider: providerB,
        limit: 3,
        rebuildFts: true,
        vecOptions: realVecOptions(),
      })
      expect(results.map((row) => row.tweetId), query).toContain(expectedTweetId)
    }
  }, 120_000)
})
