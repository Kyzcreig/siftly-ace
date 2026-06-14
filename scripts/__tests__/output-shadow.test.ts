import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CrossBriefDedupStore } from '../lib/cross-brief-dedup'
import {
  postedItems,
  runDedupShadow,
  runDiversityShadow,
  clipSnippet,
  authorKeyFor,
} from '../output_shadow'

describe('output_shadow harness', () => {
  describe('postedItems', () => {
    it('reconstructs x-feed posted set from selected_top_ids + quick_hits_ids', () => {
      const dump = {
        ts: '2026-06-13T10:00:00Z',
        selected_top_ids: ['t1', 't2'],
        quick_hits_ids: ['t3'],
        all_scored: [
          { id: 't1', tweet_text: 'one', authorHandle: 'a', final_score: 70, url: 'https://x.com/a/1' },
          { id: 't2', tweet_text: 'two', authorHandle: 'b', final_score: 65, url: 'https://x.com/b/2' },
          { id: 't3', tweet_text: 'three', authorHandle: 'c', final_score: 55, url: 'https://x.com/c/3' },
          { id: 't4', tweet_text: 'unposted', authorHandle: 'd', final_score: 40, url: 'https://x.com/d/4' },
        ],
      }
      const posted = postedItems('x-feed-brief', dump)
      expect(posted.map((p: { id: string }) => p.id)).toEqual(['t1', 't2', 't3'])
      expect(posted[0].score).toBe(70)
      expect(posted[0].authorKey).toBe('a')
    })

    it('ignores x-feed ids that are not present in all_scored', () => {
      const dump = {
        ts: '2026-06-13T10:00:00Z',
        selected_top_ids: ['t1', 'missing'],
        quick_hits_ids: [],
        all_scored: [{ id: 't1', tweet_text: 'one', authorHandle: 'a', final_score: 70, url: 'https://x.com/a/1' }],
      }
      const posted = postedItems('x-feed-brief', dump)
      expect(posted.map((p: { id: string }) => p.id)).toEqual(['t1'])
    })
  })

  describe('clipSnippet + authorKeyFor', () => {
    it('clips to 120 chars and prefers title', () => {
      const long = 'x'.repeat(200)
      expect(clipSnippet({ title: long }).length).toBeLessThanOrEqual(120)
      expect(clipSnippet({ tweet_text: 'hi' })).toBe('hi')
    })
    it('lowercases author key, null when empty', () => {
      expect(authorKeyFor({ authorHandle: 'ElonMusk' })).toBe('elonmusk')
      expect(authorKeyFor({})).toBeNull()
    })
  })

  describe('runDiversityShadow (author-cap floor)', () => {
    it('drops an over-concentrated author beyond the per-author cap', () => {
      const posted = [
        { id: 'p1', title: 't1', url: 'u1', snippet: 't1', authorKey: 'sameguy', source: 'X', score: 90 },
        { id: 'p2', title: 't2', url: 'u2', snippet: 't2', authorKey: 'sameguy', source: 'X', score: 85 },
        { id: 'p3', title: 't3', url: 'u3', snippet: 't3', authorKey: 'sameguy', source: 'X', score: 80 },
        { id: 'p4', title: 't4', url: 'u4', snippet: 't4', authorKey: 'other', source: 'X', score: 75 },
      ]
      const div = runDiversityShadow(posted)
      // cap=2 -> the 3rd 'sameguy' item is dropped
      expect(div.would_drop).toBe(1)
      expect(div.findings.some((f: { effect: string; id: string }) => f.effect === 'author_cap_drop' && f.id === 'p3')).toBe(true)
    })

    it('reports 0 drop / 0 reorder for an already-diverse, already-ordered set', () => {
      const posted = [
        { id: 'p1', title: 't1', url: 'u1', snippet: 't1', authorKey: 'a', source: 'X', score: 90 },
        { id: 'p2', title: 't2', url: 'u2', snippet: 't2', authorKey: 'b', source: 'X', score: 80 },
      ]
      const div = runDiversityShadow(posted)
      expect(div.would_drop).toBe(0)
      expect(div.would_reorder).toBe(0)
    })
  })

  describe('runDedupShadow (cross-brief)', () => {
    let dir: string
    let store: CrossBriefDedupStore
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'output-shadow-test-'))
      store = new CrossBriefDedupStore({ dbPath: path.join(dir, 'dedup.db'), ttlDays: 3 })
    })
    afterEach(async () => {
      store.close()
      await rm(dir, { recursive: true, force: true })
    })

    it('flags an item already surfaced by the other brief same PT-day', () => {
      const ptDay = '2026-06-13'
      // x-feed remembered this URL first
      store.remember({ brief: 'x-feed-brief', title: 'Shared Story', url: 'https://ex.com/a', ptDay })
      const posted = [
        { id: 'm1', title: 'Shared Story', url: 'https://ex.com/a', snippet: 'Shared', authorKey: 'z', source: 'HN', score: 90 },
        { id: 'm2', title: 'Unique', url: 'https://ex.com/b', snippet: 'Unique', authorKey: 'y', source: 'HN', score: 80 },
      ]
      const res = runDedupShadow(store, 'morning-digest', ptDay, posted)
      expect(res.would_suppress).toBe(1)
      expect(res.findings[0].id).toBe('m1')
      expect(res.findings[0].matchedBrief).toBe('x-feed-brief')
    })

    it('does not flag the brief against its own prior items', () => {
      const ptDay = '2026-06-13'
      const posted = [
        { id: 'm1', title: 'Solo', url: 'https://ex.com/solo', snippet: 'Solo', authorKey: 'z', source: 'HN', score: 90 },
      ]
      const res = runDedupShadow(store, 'morning-digest', ptDay, posted)
      expect(res.would_suppress).toBe(0)
    })
  })

  describe('idempotency claim (atomic, TOCTOU-safe)', () => {
    // These drive the REAL script as a subprocess with env-overridden artifact +
    // provenance dirs (hermetic — never touches ~/.hermes). They prove the atomic
    // O_EXCL claim: concurrent + repeated runs of the SAME run-ts write the durable
    // side-effects exactly once (a check-then-act statSync was TOCTOU-racy and
    // multi-logged provenance, inflating the saw-didn't-save count).
    let dir: string
    const repo = path.resolve(__dirname, '..', '..')
    const tsx = path.join(repo, 'node_modules/.bin/tsx')
    const script = path.join(repo, 'scripts/output_shadow.ts')

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'output-shadow-idem-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    function run(dumpPath: string): Promise<number> {
      return new Promise((resolve) => {
        const env = {
          ...process.env,
          OUTPUT_SHADOW_ARTIFACT_DIR: path.join(dir, 'artifacts'),
          OUTPUT_SHADOW_PROVENANCE_DIR: path.join(dir, 'provenance'),
        }
        const proc = spawn(tsx, [script, '--brief', 'x-feed-brief', '--in', dumpPath], { env })
        proc.on('close', (code) => resolve(code ?? -1))
      })
    }

    function writeDump(): string {
      const dump = {
        ts: '2026-06-13T10:00:00Z',
        selected_top_ids: ['t1', 't2'],
        quick_hits_ids: ['t3'],
        all_scored: [
          { id: 't1', tweet_text: 'one', authorHandle: 'a', final_score: 70, url: 'https://x.com/a/1' },
          { id: 't2', tweet_text: 'two', authorHandle: 'b', final_score: 65, url: 'https://x.com/b/2' },
          { id: 't3', tweet_text: 'three', authorHandle: 'c', final_score: 55, url: 'https://x.com/c/3' },
        ],
      }
      const p = path.join(dir, 'dump.json')
      writeFileSync(p, JSON.stringify(dump))
      return p
    }

    function provenanceLineCount(): number {
      const provDir = path.join(dir, 'provenance')
      if (!existsSync(provDir)) return 0
      let total = 0
      for (const f of readdirSync(provDir)) {
        if (!f.endsWith('.jsonl')) continue
        total += readFileSync(path.join(provDir, f), 'utf8').split('\n').filter((l) => l.trim()).length
      }
      return total
    }

    it('logs provenance exactly once across N CONCURRENT runs of the same run-ts', async () => {
      const dump = writeDump()
      await Promise.all([run(dump), run(dump), run(dump), run(dump)])
      // 3 posted items -> exactly one set of 3 provenance records, not 3*4=12.
      expect(provenanceLineCount()).toBe(3)
      // exactly one artifact (run-ts keyed) + one winner log line.
      const logPath = path.join(dir, 'artifacts', 'log.jsonl')
      expect(existsSync(logPath)).toBe(true)
      expect(readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).length).toBe(1)
    }, 30000)

    it('does not re-log provenance on a SEQUENTIAL re-run of the same run-ts', async () => {
      const dump = writeDump()
      await run(dump)
      await run(dump)
      expect(provenanceLineCount()).toBe(3)
    }, 30000)
  })

})
