import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SURFACED_PROVENANCE_DIR,
  appendSurfacedProvenance,
  surfacedProvenancePath,
  sweepSurfacedProvenanceRetention,
} from '../lib/surfaced-provenance'

let tmp: string | undefined

afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true })
    tmp = undefined
  }
})

describe('surfaced item provenance logger', () => {
  it('uses a PT-day repo-local log path under docs/eval/surfaced-items', () => {
    expect(DEFAULT_SURFACED_PROVENANCE_DIR).toBe(path.join(process.cwd(), 'docs', 'eval', 'surfaced-items'))
    expect(surfacedProvenancePath(new Date('2026-06-14T06:30:00.000Z'))).toBe(
      path.join(DEFAULT_SURFACED_PROVENANCE_DIR, 'surfaced-items-2026-06-13.jsonl'),
    )
  })

  it('writes dated saw-didnt-save pending records that mature no earlier than 14 days', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'siftly-surfaced-prov-'))
    const now = new Date('2026-06-13T10:20:30.000Z')

    const result = await appendSurfacedProvenance(
      [
        {
          id: 'tweet-123',
          url: 'https://x.com/example/status/123',
          text: 'example surfaced item',
          source: 'x-feed-brief',
          rank: 4,
          scores: { keyword: 0.8, mean_cosine: 0.9 },
        },
      ],
      { brief: 'x-feed-brief', logDir: tmp, now },
    )

    expect(result.count).toBe(1)
    expect(result.path).toBe(path.join(tmp, 'surfaced-items-2026-06-13.jsonl'))

    const lines = (await readFile(result.path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])

    expect(record).toMatchObject({
      id: 'tweet-123',
      brief: 'x-feed-brief',
      provenance_kind: 'brief-surfaced',
      outcome: 'saw_didnt_save_pending',
      surfaced_at: '2026-06-13T10:20:30.000Z',
      matures_at: '2026-06-27T10:20:30.000Z',
      maturity_days: 14,
      rank: 4,
      scores: { keyword: 0.8, mean_cosine: 0.9 },
    })
    expect(new Date(record.matures_at).getTime() - new Date(record.surfaced_at).getTime()).toBeGreaterThanOrEqual(
      14 * 24 * 60 * 60 * 1000,
    )
  })

  it('sweeps old dated provenance files while preserving recent and unrelated files', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'siftly-surfaced-prov-'))
    const oldPath = path.join(tmp, 'surfaced-items-2026-03-01.jsonl')
    const recentPath = path.join(tmp, 'surfaced-items-2026-06-12.jsonl')
    const unrelatedPath = path.join(tmp, 'README.txt')
    await writeFile(oldPath, '{}\n', 'utf8')
    await writeFile(recentPath, '{}\n', 'utf8')
    await writeFile(unrelatedPath, 'keep\n', 'utf8')

    const result = await sweepSurfacedProvenanceRetention(tmp, {
      now: new Date('2026-06-13T12:00:00.000Z'),
      retentionDays: 30,
    })

    expect(result.deleted).toEqual([oldPath])
    await expect(access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(recentPath)).resolves.toBeUndefined()
    await expect(access(unrelatedPath)).resolves.toBeUndefined()
  })
})
