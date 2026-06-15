import { describe, expect, it, vi } from 'vitest'
import {
  ingestXurlSources,
  type KnownTweetIdsLookup,
  type XurlIngestDb,
  type XurlSource,
  type XurlTweetPage,
} from '@/lib/xurl-ingest'

// ── Shared mock helpers (mirrors xurl-ingest-402.test.ts) ──

function tweet(id: string) {
  return { id, text: `tweet ${id}`, author_id: `author-${id}`, created_at: '2026-06-08T12:00:00.000Z' }
}

function page(ids: string[], nextToken?: string): XurlTweetPage {
  return {
    data: ids.map((id) => tweet(id)),
    includes: {
      users: ids.map((id) => ({ id: `author-${id}`, username: `user${id}`, name: `User ${id}` })),
      media: [],
    },
    meta: { result_count: ids.length, ...(nextToken ? { next_token: nextToken } : {}) },
  }
}

function paginationToken(endpoint: string): string | null {
  return new URL(endpoint, 'https://x.example').searchParams.get('pagination_token')
}

type MemoryBookmark = {
  id: string
  tweetId: string
  text: string
  rawJson: string
  entities: string | null
  source: XurlSource
  mediaItems: { id: string; type: string; url: string; thumbnailUrl: string | null }[]
}

class MemoryIngestDb implements XurlIngestDb {
  rows = new Map<string, MemoryBookmark>()
  settings = new Map<string, string>()

  seedRows(ids: string[], source: XurlSource = 'bookmark') {
    for (const id of ids) {
      this.rows.set(id, {
        id: `bookmark-${id}`,
        tweetId: id,
        text: `tweet ${id}`,
        rawJson: JSON.stringify({ seeded: true, id }),
        entities: null,
        source,
        mediaItems: [],
      })
    }
  }

  bookmark = {
    findUnique: async ({ where }: { where: { tweetId: string } }) => this.rows.get(where.tweetId) ?? null,
    create: async ({ data }: { data: Record<string, any> }) => {
      const row: MemoryBookmark = {
        id: `bookmark-${data.tweetId}`,
        tweetId: data.tweetId,
        text: data.text,
        rawJson: data.rawJson,
        entities: data.entities ?? null,
        source: data.source,
        mediaItems: [],
      }
      this.rows.set(data.tweetId, row)
      return row
    },
    update: async ({ where, data }: { where: { tweetId: string }; data: Record<string, any> }) => {
      const existing = this.rows.get(where.tweetId)
      if (!existing) throw new Error(`missing row ${where.tweetId}`)
      const row = { ...existing, text: data.text ?? existing.text, source: data.source ?? existing.source }
      this.rows.set(where.tweetId, row)
      return row
    },
  }

  setting = {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = this.settings.get(where.key)
      return value === undefined ? null : { value }
    },
    upsert: async ({ where, update, create }: { where: { key: string }; update: any; create: any }) => {
      const value = this.settings.has(where.key) ? update.value : create.value
      this.settings.set(where.key, value)
      return { key: where.key, value }
    },
  }
}

/** A real-shaped known-IDs probe over the in-memory corpus (what scripts/ingest.ts wires to Prisma). */
function probeFor(db: MemoryIngestDb): KnownTweetIdsLookup {
  return async (ids) => new Set(ids.filter((id) => db.rows.has(id)))
}

describe('xurl ingest — incremental early-stop (D-1, K consecutive known)', () => {
  // ── I1: no new-item loss above the contiguous known frontier ──
  it('test_early_stop_fetches_all_new_above_frontier: keeps all new above a K-run, stops before the next page', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3', 'old1', 'old2']) // corpus already has these
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      // page 1: all-new ; page 2: [new, new, KNOWN×3] → frontier passed ; page 3: must never fire
      if (!token) return page(['n1', 'n2', 'n3'], 'p2')
      if (token === 'p2') return page(['n4', 'n5', 'k1', 'k2', 'k3'], 'p3')
      if (token === 'p3') return page(['old1', 'old2']) // would be re-fetched without early-stop
      throw new Error(`page 3 must not be fetched (token ${token})`)
    })

    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })

    // all 5 genuinely-new items created; page 3 never requested
    expect(runXurl).toHaveBeenCalledTimes(2)
    expect(['n1', 'n2', 'n3', 'n4', 'n5'].every((id) => db.rows.has(id))).toBe(true)
    expect(result.created).toBe(5)
    expect(result.perSource.bookmark.pages).toBe(2)
    expect(result.earlyStopped?.bookmark).toBe(true)
  })

  it('test_early_stop_stops_before_next_page: a K-run on page 1 means page 2 is never fetched', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['a', 'b', 'c'])
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['new', 'a', 'b', 'c'], 'p2')
      throw new Error(`page 2 must not be fetched (token ${token})`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(1)
    expect(result.earlyStopped?.bookmark).toBe(true)
    expect(db.rows.has('new')).toBe(true)
  })

  it('test_consecutive_known_resets_on_new: a lone known item between new ones does NOT stop at K=3', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['known'])
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      // streak: new(0) known(1) new(0) new(0)… never reaches 3 → no early-stop on page 1
      if (!token) return page(['n1', 'known', 'n2', 'n3'], 'p2')
      if (token === 'p2') return page(['n4']) // natural end (no next_token)
      throw new Error(`unexpected token ${token}`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(2) // did NOT early-stop on page 1
    expect(result.earlyStopped?.bookmark).toBeUndefined()
    expect(['n1', 'n2', 'n3', 'n4'].every((id) => db.rows.has(id))).toBe(true)
  })

  it('test_streak_spans_page_boundary: a K-run split across two pages still stops', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3'])
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['n1', 'k1'], 'p2') // streak ends page 1 at 1
      if (token === 'p2') return page(['k2', 'k3', 'n-below'], 'p3') // streak → 3 mid-page
      throw new Error(`page 3 must not be fetched (token ${token})`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(2)
    expect(result.earlyStopped?.bookmark).toBe(true)
  })

  // ── I5 / RQ-2: per-source independence + counter scoping ──
  it('test_early_stop_per_source_independent: bookmarks stop early, likes walk full', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['b1', 'b2', 'b3'], 'bookmark') // bookmark frontier on page 1
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      const isLike = endpoint.includes('liked')
      if (isLike) {
        if (!token) return page(['L1', 'L2'], 'lp2') // all new
        if (token === 'lp2') return page(['L3', 'L4']) // all new, natural end
        throw new Error(`unexpected like token ${token}`)
      }
      // bookmark
      if (!token) return page(['bn', 'b1', 'b2', 'b3'], 'bp2')
      throw new Error(`bookmark page 2 must not fetch (token ${token})`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark', 'like'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(result.earlyStopped?.bookmark).toBe(true)
    expect(result.perSource.bookmark.pages).toBe(1)
    expect(result.earlyStopped?.like).toBeUndefined()
    expect(result.perSource.like.pages).toBe(2) // likes walked their full natural pagination
  })

  it('test_consecutive_known_streak_is_per_source: a bookmark known-run does not bleed into the likes streak', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3'], 'bookmark') // ends bookmark with a K-run
    // likes are ALL NEW; if the streak counter leaked across sources, likes would wrongly stop
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const isLike = endpoint.includes('liked')
      const token = paginationToken(endpoint)
      if (isLike) {
        if (!token) return page(['L1', 'L2', 'L3'], 'lp2')
        if (token === 'lp2') return page(['L4', 'L5']) // natural end, all new
        throw new Error(`unexpected like token ${token}`)
      }
      if (!token) return page(['k1', 'k2', 'k3'], 'bp2') // immediate K-run, stop
      throw new Error(`bookmark must stop before page 2 (token ${token})`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark', 'like'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(result.earlyStopped?.bookmark).toBe(true)
    expect(result.earlyStopped?.like).toBeUndefined() // streak reset between sources
    expect(['L1', 'L2', 'L3', 'L4', 'L5'].every((id) => db.rows.has(id))).toBe(true)
  })

  // ── B-2: likes positively early-stop (guards a silently-broken like probe) ──
  it('test_like_source_positively_early_stops: a likes page overlapping seeded like rows stops', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['lk1', 'lk2', 'lk3'], 'like')
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['Lnew', 'lk1', 'lk2', 'lk3'], 'lp2')
      throw new Error(`likes page 2 must not fetch (token ${token})`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['like'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(1)
    expect(result.earlyStopped?.like).toBe(true)
    expect(db.rows.has('Lnew')).toBe(true)
  })

  // ── I2: backfill never early-stops ──
  it('test_backfill_ignores_early_stop: resumeFromCursor:true walks full pages even with the probe present', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3'])
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['k1', 'k2', 'k3'], 'p2') // immediate K-run
      if (token === 'p2') return page(['deep1', 'deep2']) // backfill MUST still reach this
      throw new Error(`unexpected token ${token}`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: true, // BACKFILL
      knownTweetIds: probeFor(db), earlyStopK: 3, // provided but must be ignored
    })
    expect(runXurl).toHaveBeenCalledTimes(2) // walked to natural end, no early-stop
    expect(result.earlyStopped).toBeUndefined()
    expect(['deep1', 'deep2'].every((id) => db.rows.has(id))).toBe(true)
  })

  // ── I3 + I7: observable fail-open ──
  it('test_known_ids_throw_sets_error_flag_and_warns: probe failure → full walk + earlyStopError + WARN', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwingProbe: KnownTweetIdsLookup = async () => {
      throw new Error('db probe exploded')
    }
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['k1', 'k2', 'k3'], 'p2') // would early-stop if probe worked
      if (token === 'p2') return page(['deep']) // full walk reaches it on fail-open
      throw new Error(`unexpected token ${token}`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: throwingProbe, earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(2) // fell back to full walk, no loss
    expect(result.earlyStopped?.bookmark).toBeUndefined()
    expect(result.earlyStopError?.bookmark).toMatch(/db probe exploded/)
    expect(db.rows.has('deep')).toBe(true)
    warn.mockRestore()
  })

  // ── default behavior: no seam → today's full walk (additive contract, I4) ──
  it('no knownTweetIds seam → behaves exactly as today (full walk to maxPages)', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['k1', 'k2', 'k3'])
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['k1', 'k2', 'k3'], 'p2')
      if (token === 'p2') return page(['deep'])
      throw new Error(`unexpected token ${token}`)
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      // no knownTweetIds
    })
    expect(runXurl).toHaveBeenCalledTimes(2)
    expect(result.earlyStopped).toBeUndefined()
  })

  // ── empty page guard ──
  it('test_empty_page_ids_no_crash: an empty page does not crash the probe and the natural break fires', async () => {
    const db = new MemoryIngestDb()
    const runXurl = vi.fn(async (): Promise<XurlTweetPage> => page([])) // empty, no next_token
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(runXurl).toHaveBeenCalledTimes(1)
    expect(result.created).toBe(0)
    expect(result.earlyStopped).toBeUndefined()
  })

  // ── AC1/AC6 cost-regression: a normal day fetches exactly 1 page per source ──
  it('test_normal_day_fetches_one_page_per_source: dense corpus ⇒ both sources stop on page 1', async () => {
    const db = new MemoryIngestDb()
    // corpus already contains the top of both lists (the normal daily reality)
    db.seedRows(['b1', 'b2', 'b3', 'b4'], 'bookmark')
    db.seedRows(['l1', 'l2', 'l3', 'l4'], 'like')
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const isLike = endpoint.includes('liked')
      const token = paginationToken(endpoint)
      if (token) throw new Error(`page 2 must not be fetched for ${isLike ? 'like' : 'bookmark'} (token ${token})`)
      // page 1 = one new item then a K-run of known ⇒ early-stop after page 1
      return isLike
        ? page(['lnew', 'l1', 'l2', 'l3'], 'lp2')
        : page(['bnew', 'b1', 'b2', 'b3'], 'bp2')
    })
    const result = await ingestXurlSources({
      db, runXurl, sources: ['bookmark', 'like'], maxPages: 5, resumeFromCursor: false,
      knownTweetIds: probeFor(db), earlyStopK: 3,
    })
    expect(result.perSource.bookmark.pages).toBe(1)
    expect(result.perSource.like.pages).toBe(1)
    expect(result.pagesFetched).toBe(2) // total — was 10 (5+5) at the old fixed ceiling
    expect(result.earlyStopped).toEqual({ bookmark: true, like: true })
    expect(['bnew', 'lnew'].every((id) => db.rows.has(id))).toBe(true) // new items still captured
  })
})
