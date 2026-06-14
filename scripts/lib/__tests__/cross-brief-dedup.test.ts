import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CrossBriefDedupStore,
  canonicalizeCrossBriefUrl,
  resolveCrossBriefDedupDbPath,
} from '../cross-brief-dedup'

const PT_DAY = '2026-06-13'

describe('cross-brief dedup store', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cross-brief-dedup-'))
    dbPath = path.join(dir, 'cross-brief-seen.db')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('defaults to its own x-bookmarks sqlite file, not prisma/dev.db', () => {
    expect(resolveCrossBriefDedupDbPath('/tmp/hermes-home')).toBe(
      path.join('/tmp/hermes-home', '.hermes', 'state', 'x-bookmarks', 'cross-brief-seen.db'),
    )
  })

  it('dedupes same-day URL variants after precise canonicalization', () => {
    expect(canonicalizeCrossBriefUrl('http://www.Example.com/story/?utm_source=x&gclid=abc#frag')).toBe(
      'https://example.com/story',
    )
    expect(canonicalizeCrossBriefUrl('https://x.com/angalexg/status/123?s=20&utm_campaign=brief')).toBe(
      'https://x.com/angalexg/status/123',
    )

    const store = new CrossBriefDedupStore({ dbPath })
    try {
      const first = store.checkAndRemember({
        brief: 'morning-digest',
        ptDay: PT_DAY,
        title: 'OpenAI releases a local coding agent for Mac developers',
        url: 'http://www.Example.com/story/?utm_source=x&gclid=abc#frag',
      })
      const second = store.checkAndRemember({
        brief: 'x-feed-brief',
        ptDay: PT_DAY,
        title: 'Different title should still dedupe by canonical URL',
        url: 'https://example.com/story?ref=twitter&utm_medium=social',
      })

      expect(first.duplicate).toBe(false)
      expect(second).toMatchObject({ duplicate: true, reason: 'url', matchedBrief: 'morning-digest' })
    } finally {
      store.close()
    }
  })

  it('folds X/Twitter host variants and share tracking params to one canonical URL', () => {
    const expected = 'https://x.com/angalexg/status/123'
    for (const rawUrl of [
      'https://x.com/angalexg/status/123?s=20&utm_campaign=brief&igshid=abc&mc_cid=news&mc_eid=user',
      'https://twitter.com/angalexg/status/123?s=09',
      'https://www.twitter.com/angalexg/status/123?S=20&ref_src=twsrc',
      'https://mobile.twitter.com/angalexg/status/123?mc_cid=news',
      'https://m.twitter.com/angalexg/status/123?mc_eid=user',
    ]) {
      expect(canonicalizeCrossBriefUrl(rawUrl)).toBe(expected)
    }

    const store = new CrossBriefDedupStore({ dbPath })
    try {
      const first = store.checkAndRemember({
        brief: 'morning-digest',
        ptDay: PT_DAY,
        title: 'Tweet surfaced in the morning brief',
        url: 'https://x.com/angalexg/status/123?s=20',
      })
      const second = store.checkAndRemember({
        brief: 'x-feed-brief',
        ptDay: PT_DAY,
        title: 'Same tweet surfaced from mobile Twitter',
        url: 'https://mobile.twitter.com/angalexg/status/123?mc_cid=news',
      })

      expect(first.duplicate).toBe(false)
      expect(second).toMatchObject({ duplicate: true, reason: 'url', matchedBrief: 'morning-digest' })
    } finally {
      store.close()
    }
  })

  it('dedupes same-day reworded-title near duplicates by MinHash similarity', () => {
    const store = new CrossBriefDedupStore({ dbPath, titleSimilarityThreshold: 0.7 })
    try {
      const first = store.checkAndRemember({
        brief: 'morning-digest',
        ptDay: PT_DAY,
        title: 'OpenAI releases new local coding agent for Mac developers',
        url: 'https://example.com/openai-local-coding-agent',
      })
      const second = store.checkAndRemember({
        brief: 'x-feed-brief',
        ptDay: PT_DAY,
        title: 'OpenAI releases new local coding assistant for Mac developers',
        url: 'https://another.example.com/openai-local-coding-assistant',
      })

      expect(first.duplicate).toBe(false)
      expect(second).toMatchObject({ duplicate: true, reason: 'title', matchedBrief: 'morning-digest' })
      expect(second.titleSimilarity).toBeGreaterThanOrEqual(0.7)
      expect(second.titleSimilarity).toBeLessThanOrEqual(0.85)
    } finally {
      store.close()
    }
  })

  it('lets the second brief connection read the first brief same-day write', () => {
    const morning = new CrossBriefDedupStore({ dbPath })
    const xfeed = new CrossBriefDedupStore({ dbPath })
    try {
      const first = morning.checkAndRemember({
        brief: 'morning-digest',
        ptDay: PT_DAY,
        title: 'Shared story already selected by the morning brief',
        url: 'https://example.com/shared-story?utm_source=morning',
      })
      const readFromSecondConnection = xfeed.check({
        brief: 'x-feed-brief',
        ptDay: PT_DAY,
        title: 'Shared story already selected by the morning brief',
        url: 'https://www.example.com/shared-story',
      })

      expect(first.duplicate).toBe(false)
      expect(readFromSecondConnection).toMatchObject({
        duplicate: true,
        reason: 'url',
        matchedBrief: 'morning-digest',
        advisory: true,
      })
    } finally {
      morning.close()
      xfeed.close()
    }
  })

  it('evicts the boundary day so ttlDays retains exactly 3 PT days', () => {
    const store = new CrossBriefDedupStore({ dbPath, ttlDays: 3 })
    try {
      store.remember({
        brief: 'morning-digest',
        ptDay: '2026-06-10',
        title: 'Boundary surfaced story that should age out',
        url: 'https://example.com/boundary-story',
        surfacedAt: '2026-06-10T16:00:00.000Z',
      })
      store.remember({
        brief: 'morning-digest',
        ptDay: '2026-06-11',
        title: 'Still within the three-day TTL window',
        url: 'https://example.com/recent-story',
        surfacedAt: '2026-06-11T16:00:00.000Z',
      })

      store.checkAndRemember({
        brief: 'x-feed-brief',
        ptDay: PT_DAY,
        title: 'Current day story triggers TTL pruning',
        url: 'https://example.com/current-story',
      })
    } finally {
      store.close()
    }

    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db.prepare('SELECT pt_day AS ptDay, brief FROM cross_brief_seen ORDER BY pt_day').all() as Array<{ ptDay: string; brief: string }>
      expect(rows.map((row) => row.ptDay)).toEqual(['2026-06-11', PT_DAY])
    } finally {
      db.close()
    }
  })
})
