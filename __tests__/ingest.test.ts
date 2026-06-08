import { describe, expect, it, vi } from 'vitest'
import {
  dedupeXurlTweets,
  ingestXurlSources,
  type XurlIngestDb,
  type XurlSource,
  type XurlTweetPage,
} from '@/lib/xurl-ingest'

function tweet(id: string, authorId = `author-${id}`) {
  return {
    id,
    text: `tweet ${id}`,
    author_id: authorId,
    created_at: '2026-06-07T12:00:00.000Z',
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

function mediaPage(id: string): XurlTweetPage {
  return {
    data: [
      {
        ...tweet(id),
        attachments: { media_keys: [`media-${id}`] },
      },
    ],
    includes: {
      users: [{ id: `author-${id}`, username: `user${id}`, name: `User ${id}` }],
      media: [
        {
          media_key: `media-${id}`,
          type: 'photo',
          url: `https://example.com/${id}.jpg`,
          preview_image_url: `https://example.com/${id}-thumb.jpg`,
        },
      ],
    },
    meta: { result_count: 1 },
  }
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
  states = new Map<string, { source: string; lastCursor: string | null; runCount: number }>()
  private nextMediaId = 1

  private createMediaItems(tweetId: string, mediaRows: Record<string, any>[] = []): MemoryMediaItem[] {
    return mediaRows.map((media) => ({
      id: `media-${tweetId}-${this.nextMediaId++}`,
      type: media.type,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl ?? null,
    }))
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
        mediaItems: this.createMediaItems(data.tweetId, data.mediaItems?.create ?? []),
      }
      this.rows.set(data.tweetId, row)
      return row
    },
    update: async ({ where, data }: { where: { tweetId: string }; data: Record<string, any> }) => {
      const existing = this.rows.get(where.tweetId)
      if (!existing) throw new Error(`missing row ${where.tweetId}`)

      let mediaItems = existing.mediaItems
      if (data.mediaItems) {
        mediaItems = data.mediaItems.deleteMany ? [] : mediaItems
        mediaItems = [
          ...mediaItems,
          ...this.createMediaItems(where.tweetId, data.mediaItems.create ?? []),
        ]
      }

      const row = {
        ...existing,
        text: data.text ?? existing.text,
        rawJson: data.rawJson ?? existing.rawJson,
        entities: data.entities ?? existing.entities,
        source: data.source ?? existing.source,
        mediaItems,
      }
      this.rows.set(where.tweetId, row)
      return row
    },
  }

  ingestState = {
    upsert: async ({ where, update, create }: { where: { source: string }; update: any; create: any }) => {
      const current = this.states.get(where.source)
      const next = current
        ? {
            source: where.source,
            lastCursor: update.lastCursor ?? null,
            runCount: current.runCount + (update.runCount?.increment ?? 0),
          }
        : { source: create.source, lastCursor: create.lastCursor ?? null, runCount: create.runCount }
      this.states.set(where.source, next)
      return next
    },
  }
}

describe('xurl ingest', () => {
  it('dedupes bookmark over like regardless of source order', () => {
    const bookmarkRows = [{ source: 'bookmark' as const, page: page(['42']) }]
    const likeRows = [{ source: 'like' as const, page: page(['42']) }]

    for (const sourcePages of [[...bookmarkRows, ...likeRows], [...likeRows, ...bookmarkRows]]) {
      const rows = dedupeXurlTweets(sourcePages)

      expect(rows).toHaveLength(1)
      expect(rows[0].tweetId).toBe('42')
      expect(rows[0].source).toBe('bookmark')
    }
  })

  it('paginates through next_token and persists source state', async () => {
    const db = new MemoryIngestDb()
    const calls: string[] = []
    const runXurl = async (endpoint: string): Promise<XurlTweetPage> => {
      calls.push(endpoint)
      return endpoint.includes('pagination_token=second') ? page(['2']) : page(['1'], 'second')
    }

    const result = await ingestXurlSources({
      db,
      runXurl,
      sources: ['bookmark'],
      maxPages: 5,
      pageSize: 100,
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('pagination_token=second')
    expect(result.created).toBe(2)
    expect(result.rowsFetched).toBe(2)
    expect(db.rows).toHaveLength(2)
    expect(db.states.get('bookmark')?.runCount).toBe(1)
  })

  it('skips an identical second run without churning media rows', async () => {
    const db = new MemoryIngestDb()
    const runXurl = async (): Promise<XurlTweetPage> => mediaPage('42')

    const first = await ingestXurlSources({ db, runXurl, sources: ['bookmark'], maxPages: 1 })
    const originalMedia = db.rows.get('42')?.mediaItems[0]
    const second = await ingestXurlSources({ db, runXurl, sources: ['bookmark'], maxPages: 1 })
    const finalMedia = db.rows.get('42')?.mediaItems[0]

    expect(first.created).toBe(1)
    expect(second.created).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(1)
    expect(db.rows.get('42')?.mediaItems).toHaveLength(1)
    expect(finalMedia?.id).toBe(originalMedia?.id)
  })

  it('promotes an existing like row to bookmark on a bookmark re-sighting', async () => {
    const db = new MemoryIngestDb()
    const runXurl = async (): Promise<XurlTweetPage> => page(['42'])

    const first = await ingestXurlSources({ db, runXurl, sources: ['like'], maxPages: 1 })
    const second = await ingestXurlSources({ db, runXurl, sources: ['bookmark'], maxPages: 1 })

    expect(first.created).toBe(1)
    expect(second.updated).toBe(1)
    expect(db.rows.get('42')?.source).toBe('bookmark')
  })

  it('ingests usable page data when X returns partial errors', async () => {
    const db = new MemoryIngestDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runXurl = async (): Promise<XurlTweetPage> => ({
      ...page(['42']),
      errors: [{ title: 'Referenced tweet not found', detail: 'A referenced tweet is unavailable' }],
    })

    try {
      const result = await ingestXurlSources({ db, runXurl, sources: ['bookmark'], maxPages: 1 })

      expect(result.created).toBe(1)
      expect(db.rows.get('42')?.tweetId).toBe('42')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 partial xurl error'))
    } finally {
      warn.mockRestore()
    }
  })
})
