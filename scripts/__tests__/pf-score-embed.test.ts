import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { realVecIt, realVecOptions, requireVec0ExtensionPath } from '../../e2e/helpers'
import { createEmbeddingProviderFromEnv } from '../../src/lib/search/embeddings'
import { l2DistanceToScore, l2NormalizeVector, openVectorStore } from '../../src/lib/vec'
import { SIFTLY_VEC_METRIC } from '../../src/lib/vec-metric'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(__dirname, '..', '..')
const PF_SCORE = path.join(ROOT, 'scripts', 'pf-score.py')
const PF_AUDIT = path.join(ROOT, 'scripts', 'pf-audit.py')
const MODEL = 'pf-score-recorded-keyword-v1'
const TERMS = ['agent', 'workflow', 'sqlite', 'other'] as const

describe('pf-score embedding affinity', () => {
  it('records the explicit sqlite-vec metric choice', () => {
    expect(SIFTLY_VEC_METRIC).toBe('l2norm')
  })

  it('normalizes vectors and maps larger L2 distances to lower scores', () => {
    expect(l2NormalizeVector([3, 4])).toEqual([0.6, 0.8])

    const distances = [0, 0.25, 1, 4]
    const scores = distances.map(l2DistanceToScore)
    expect(scores[0]).toBe(1)
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1])
    }
  })

  it('normalizes vectors returned by the env-created embedding provider', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        model: 'fake-embedding-model',
        data: [{ object: 'embedding', index: 0, embedding: Buffer.from(new Float32Array([3, 4]).buffer).toString('base64') }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const provider = createEmbeddingProviderFromEnv({
        NODE_ENV: 'test',
        SIFTLY_EMBED_PROVIDER: 'openai-compatible',
        SIFTLY_EMBED_BASE_URL: `http://127.0.0.1:${port}/v1`,
        SIFTLY_EMBED_MODEL: 'fake-embedding-model',
        SIFTLY_EMBED_API_KEY: 'local-test-key',
      })
      const [vector] = await provider.embed(['normalize me'])
      expect(vector).toEqual([0.6, 0.8])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })

  realVecIt('normalizes vectors before sqlite-vec upsert and query', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'siftly-pf-score-normalize-'))
    try {
      const dbPath = path.join(dir, 'pf-score-normalize.db')
      const store = openVectorStore({ dbPath, ...realVecOptions() })
      try {
        expect(store.mode).toBe('sqlite-vec')
        store.upsert({ bookmarkId: 'unit-vector', model: 'normalize-model', vector: [3, 4] })

        const db = new Database(dbPath)
        try {
          const row = db.prepare('SELECT vector_json AS vectorJson FROM bookmark_embeddings WHERE bookmark_id = ?').get('unit-vector') as { vectorJson: string }
          expect(JSON.parse(row.vectorJson)).toEqual([0.6, 0.8])
        } finally {
          db.close()
        }

        const [hit] = store.search([6, 8], 1, 'normalize-model')
        expect(hit).toMatchObject({ bookmarkId: 'unit-vector', mode: 'sqlite-vec' })
        expect(hit.distance).toBeCloseTo(0, 6)
        expect(hit.score).toBe(1)
      } finally {
        store.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  realVecIt('takes the embed path against real sqlite-vec when provisioned', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'siftly-pf-score-'))
    try {
      const dbPath = path.join(dir, 'pf-score.db')
      const db = new Database(dbPath)
      try {
        db.exec('CREATE TABLE Bookmark (id TEXT PRIMARY KEY, source TEXT NOT NULL)')
        const insert = db.prepare('INSERT INTO Bookmark (id, source) VALUES (?, ?)')
        insert.run('positive-bookmark', 'bookmark')
        insert.run('positive-like', 'like')
        insert.run('other-bookmark', 'bookmark')
      } finally {
        db.close()
      }

      const store = openVectorStore({ dbPath, ...realVecOptions() })
      try {
        expect(store.mode).toBe('sqlite-vec')
        store.upsert({ bookmarkId: 'positive-bookmark', model: MODEL, vector: vectorFor('agent workflow sqlite') })
        store.upsert({ bookmarkId: 'positive-like', model: MODEL, vector: vectorFor('agent workflow') })
        store.upsert({ bookmarkId: 'other-bookmark', model: MODEL, vector: vectorFor('other') })
      } finally {
        store.close()
      }

      const profilePath = path.join(dir, 'profile.json')
      const candidatesPath = path.join(dir, 'candidates.json')
      await writeFile(profilePath, JSON.stringify({ top_topics: [], high_signal_authors: [], favorite_formats: [], downrank_patterns: [] }), 'utf8')
      await writeFile(candidatesPath, JSON.stringify({
        candidates: [{ id: 'candidate-1', source: 'web', title: 'agent workflow sqlite for local vector search' }],
      }), 'utf8')

      const commonEnv = {
        ...process.env,
        DATABASE_URL: `file:${dbPath}`,
        PF_EMBED_AFFINITY_TEST_PROVIDER: 'keyword',
        PF_EMBED_AFFINITY_TEST_TERMS: TERMS.join(','),
        PF_WEIGHT: '30',
        PF_BASELINE: '0.18',
        SIFTLY_EMBED_MODEL: MODEL,
        SIFTLY_SQLITE_VEC_EXTENSION_PATH: requireVec0ExtensionPath(),
      }

      const { stdout: embedStdout } = await execFileAsync('python3', [PF_SCORE, candidatesPath, '--profile', profilePath], {
        cwd: ROOT,
        env: { ...commonEnv, PF_AFFINITY_MODE: 'embed' },
        timeout: 30_000,
      })
      const parsed = JSON.parse(embedStdout)
      expect(parsed.ok).toBe(true)
      expect(parsed.affinity_source).toBe('embed')
      expect(parsed.vec_metric).toBe('l2norm')
      expect(parsed.items[0].affinity_source).toBe('embed')
      expect(parsed.items[0].personal_fit_delta).toBeGreaterThan(0)

      const { stdout: keywordStdout } = await execFileAsync('python3', [PF_SCORE, candidatesPath, '--profile', profilePath], {
        cwd: ROOT,
        env: { ...commonEnv, PF_AFFINITY_MODE: 'keyword' },
        timeout: 30_000,
      })
      const keyword = JSON.parse(keywordStdout)
      const { stdout: shadowStdout } = await execFileAsync('python3', [PF_SCORE, candidatesPath, '--profile', profilePath], {
        cwd: ROOT,
        env: { ...commonEnv, PF_AFFINITY_MODE: 'shadow' },
        timeout: 30_000,
      })
      const shadow = JSON.parse(shadowStdout)
      expect(shadow.affinity_source).not.toBe('embed')
      expect(shadow.affinity_source).toBe(keyword.affinity_source)
      expect(shadow.items[0].personal_fit_delta).toBe(keyword.items[0].personal_fit_delta)
      expect(shadow.items[0].personal_fit_raw).toBe(keyword.items[0].personal_fit_raw)
      expect(Object.keys(shadow.items[0]).sort()).toEqual(Object.keys(keyword.items[0]).sort())
      expect(shadow.items[0]).toEqual(keyword.items[0])
      expect(shadow.items[0]).not.toHaveProperty('shadow_personal_fit_delta')
      expect(shadow.items[0]).not.toHaveProperty('embedding_affinity')
      expect(shadow).not.toHaveProperty('affinity_audit')

      const auditDir = path.join(dir, 'pf-audit')
      const { stdout: auditStdout } = await execFileAsync('python3', [PF_AUDIT, candidatesPath, '--brief', 'x-feed-brief', '--profile', profilePath, '--audit-dir', auditDir], {
        cwd: ROOT,
        env: { ...commonEnv, PF_AFFINITY_MODE: 'shadow' },
        timeout: 30_000,
      })
      const emittedBrief = JSON.parse(auditStdout)
      expect(emittedBrief.affinity_source).toBe(keyword.affinity_source)
      expect(emittedBrief.items[0]).toEqual(keyword.items[0])
      expect(emittedBrief).not.toHaveProperty('affinity_audit')
      const [artifactName] = (await readdir(auditDir)).filter((name) => name.endsWith('.json'))
      const audit = JSON.parse(await readFile(path.join(auditDir, artifactName), 'utf8'))
      expect(audit.affinity_source).toBe(keyword.affinity_source)
      expect(audit.vec_metric).toBe('l2norm')
      expect(audit.items[0].personal_fit_delta).toBe(keyword.items[0].personal_fit_delta)
      expect(audit.items[0].affinity_source).toBe(keyword.items[0].affinity_source)
      expect(audit.items[0].shadow_personal_fit_delta).toBeGreaterThan(0)
      expect(audit.items[0].embedding_affinity).toBeGreaterThan(0)

      // --- FUSED mode (Ace-approved 2026-06-20): two candidates so the pool-mean
      // centering is non-trivial. fused_delta = (kw_delta + (embed_delta - mean_embed))/2
      // computed over the WHOLE pool. Assert affinity_source + the exact formula.
      const fusedCandidatesPath = path.join(dir, 'fused-candidates.json')
      await writeFile(fusedCandidatesPath, JSON.stringify({
        candidates: [
          { id: 'fused-1', source: 'web', title: 'agent workflow sqlite for local vector search' },
          { id: 'fused-2', source: 'web', title: 'completely unrelated cooking recipe' },
        ],
      }), 'utf8')
      const runMode = async (mode: string) => JSON.parse((await execFileAsync(
        'python3', [PF_SCORE, fusedCandidatesPath, '--profile', profilePath],
        { cwd: ROOT, env: { ...commonEnv, PF_AFFINITY_MODE: mode }, timeout: 30_000 },
      )).stdout)
      const fKeyword = await runMode('keyword')
      const fEmbed = await runMode('embed')
      const fFused = await runMode('fused')
      expect(fFused.ok).toBe(true)
      expect(fFused.affinity_source).toBe('fused')
      expect(fFused.affinity_mode).toBe('fused')
      const embedDeltas = fEmbed.items.map((it: any) => Number(it.personal_fit_delta))
      const meanEmbed = embedDeltas.reduce((a: number, b: number) => a + b, 0) / embedDeltas.length
      for (let i = 0; i < fFused.items.length; i++) {
        const kw = Number(fKeyword.items[i].personal_fit_delta)
        const em = Number(fEmbed.items[i].personal_fit_delta)
        const expected = Math.round(((kw + (em - meanEmbed)) / 2) * 100) / 100
        expect(fFused.items[i].affinity_source).toBe('fused')
        expect(Number(fFused.items[i].personal_fit_delta)).toBeCloseTo(expected, 1)
        expect(Number(fFused.items[i].keyword_personal_fit_delta)).toBe(kw)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

function vectorFor(text: string): number[] {
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  return TERMS.map((term) => (tokens.has(term) ? 1 : 0))
}
