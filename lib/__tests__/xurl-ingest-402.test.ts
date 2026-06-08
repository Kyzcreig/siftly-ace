import { describe, expect, it, vi } from 'vitest'
import {
  ingestXurlSources,
  XurlApiError,
  type XurlIngestDb,
  type XurlSource,
  type XurlTweetPage,
} from '@/lib/xurl-ingest'

function tweet(id: string, authorId = `author-${id}`) {
  return {
    id,
    text: `tweet ${id}`,
    author_id: authorId,
    created_at: '2026-06-08T12:00:00.000Z',
  }
}

function page(ids: string[], nextToken?: string): XurlTweetPage {
  return {
    data: ids.map((id) => tweet(id)),
    includes: {
      users: ids.map((id) => ({ id: `author-${id}`, username: `user${id}`, name: `User ${id}` })),
      media: [],
    },
    meta: {
      result_count: ids.length,
      ...(nextToken ? { next_token: nextToken } : {}),
    },
  }
}

function paginationToken(endpoint: string): string | null {
  return new URL(endpoint, 'https://x.example').searchParams.get('pagination_token')
}

type MemoryMediaItem = {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
}

type MemoryBookmark = {
  id: string
  tweetId: string
  text: string
  rawJson: string
  entities: string | null
  source: XurlSource
  mediaItems: MemoryMediaItem[]
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
    findUnique: async ({ where }: { where: { tweetId: string } }) => {
      return this.rows.get(where.tweetId) ?? null
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      const row = {
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
      const row = {
        ...existing,
        text: data.text ?? existing.text,
        rawJson: data.rawJson ?? existing.rawJson,
        entities: data.entities ?? existing.entities,
        source: data.source ?? existing.source,
      }
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

describe('xurl ingest 402 handling', () => {
  it('stops on a mid-pagination 402 after saving the last good cursor and firing the callback once', async () => {
    const db = new MemoryIngestDb()
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['1'], 'after-1')
      if (token === 'after-1') return page(['2'], 'after-2')
      if (token === 'after-2') {
        throw new XurlApiError('CreditsDepleted: X API credits exhausted', 402, {
          title: 'CreditsDepleted',
          status: 402,
        })
      }
      throw new Error(`unexpected token ${token}`)
    })
    const onCreditsDepleted = vi.fn()

    const result = await ingestXurlSources({
      resumeFromCursor: true,
      db,
      runXurl,
      sources: ['bookmark'],
      maxPages: 5,
      onCreditsDepleted,
    })

    expect(runXurl).toHaveBeenCalledTimes(3)
    expect([...db.rows.keys()].sort()).toEqual(['1', '2'])
    expect(result.created).toBe(2)
    expect(result.pagesFetched).toBe(2)
    expect(result.rowsFetched).toBe(2)
    expect(result.perSource.bookmark.nextCursor).toBe('after-2')
    expect(result.creditsDepleted).toMatchObject({
      source: 'bookmark',
      status: 402,
      savedCursor: 'after-2',
      pagesFetched: 2,
      rowsFetched: 2,
    })
    expect(onCreditsDepleted).toHaveBeenCalledTimes(1)
    expect(onCreditsDepleted).toHaveBeenCalledWith(expect.objectContaining({
      source: 'bookmark',
      status: 402,
      savedCursor: 'after-2',
    }))

    const savedState = JSON.parse(db.settings.get('xurl_ingest:bookmark') ?? '{}')
    expect(savedState.lastCursor).toBe('after-2')
  })

  it('resumes from the saved cursor without re-reading duplicate tweet ids', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['1', '2'])
    db.settings.set('xurl_ingest:bookmark', JSON.stringify({
      source: 'bookmark',
      lastCursor: 'after-2',
      lastRunAt: '2026-06-08T12:00:00.000Z',
      runCount: 1,
    }))
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (token === 'after-2') return page(['3'])
      return page(['1'], 'after-1')
    })

    const result = await ingestXurlSources({
      resumeFromCursor: true,
      db,
      runXurl,
      sources: ['bookmark'],
      maxPages: 5,
    })

    expect(paginationToken(runXurl.mock.calls[0][0])).toBe('after-2')
    expect([...db.rows.keys()].sort()).toEqual(['1', '2', '3'])
    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.rowsFetched).toBe(1)
  })

  it('with resumeFromCursor=false (incremental path) starts from the TOP even when a cursor is persisted', async () => {
    const db = new MemoryIngestDb()
    db.seedRows(['1', '2'])
    // A deep cursor is persisted from a prior backfill — the incremental path must IGNORE it
    // (X paginates newest→older; resuming from 'after-2' would skip new top-of-list items).
    db.settings.set('xurl_ingest:bookmark', JSON.stringify({
      source: 'bookmark',
      lastCursor: 'after-2',
      lastRunAt: '2026-06-08T12:00:00.000Z',
      runCount: 1,
    }))
    const runXurl = vi.fn(async (endpoint: string): Promise<XurlTweetPage> => {
      const token = paginationToken(endpoint)
      if (!token) return page(['9']) // newest item at the top of the list
      throw new Error(`incremental path must not paginate from a persisted cursor (got ${token})`)
    })

    const result = await ingestXurlSources({
      db,
      runXurl,
      sources: ['bookmark'],
      maxPages: 5,
      resumeFromCursor: false,
    })

    // First (and only) call must start with NO pagination token — the top of the list.
    expect(paginationToken(runXurl.mock.calls[0][0])).toBeNull()
    expect(result.created).toBe(1)
    expect([...db.rows.keys()].sort()).toEqual(['1', '2', '9'])
  })

  it('keeps retrying 429s without treating them as credits-depleted aborts', async () => {
    const db = new MemoryIngestDb()
    const runXurl = vi.fn(async (): Promise<XurlTweetPage> => {
      if (runXurl.mock.calls.length === 1) {
        throw new XurlApiError('rate limit', 429, { status: 429, title: 'Too Many Requests' })
      }
      return page(['1'])
    })
    const onCreditsDepleted = vi.fn()

    const result = await ingestXurlSources({
      resumeFromCursor: true,
      db,
      runXurl,
      sources: ['bookmark'],
      maxPages: 1,
      retryCount: 1,
      retryBaseMs: 0,
      onCreditsDepleted,
    })

    expect(runXurl).toHaveBeenCalledTimes(2)
    expect(onCreditsDepleted).not.toHaveBeenCalled()
    expect(result.creditsDepleted).toBeUndefined()
    expect(result.created).toBe(1)
    expect([...db.rows.keys()]).toEqual(['1'])
  })
})
