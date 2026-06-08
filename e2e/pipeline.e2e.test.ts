import Database from 'better-sqlite3'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  drainVideoQueue,
  enrichBookmarks,
  enqueueVideoItems,
  readVideoQueueState,
  runOcrForMediaItems,
  transcribeWithParakeet,
  type EnrichBookmarkInput,
} from '../src/lib/enrich'
import { exportSavedTweetsToObsidian, noteFilename } from '../src/lib/obsidian/export'
import { embedBookmarkCorpus } from '../src/lib/search/embeddings'
import { hybridSearch } from '../src/lib/search'
import {
  assertRealVecStore,
  cleanupE2EFixture,
  createE2EEmbeddingProvider,
  createE2EFixture,
  createRecordedProvider,
  mediaImageTags,
  normalizeText,
  parseImageTags,
  readUtf8,
  realVecIt,
  realVecOptions,
  selectEnrichBookmarks,
  selectMediaForOcr,
  selectObsidianBookmarks,
  SqliteE2EDb,
  type E2EFixture,
} from './helpers'

const fixtures: E2EFixture[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => cleanupE2EFixture(fixture)))
})

async function newFixture(): Promise<E2EFixture> {
  const fixture = await createE2EFixture()
  fixtures.push(fixture)
  return fixture
}

function queueSqlitePath(queuePath: string): string {
  return /\.(db|sqlite|sqlite3)$/i.test(queuePath) ? queuePath : `${queuePath}.sqlite`
}

function seedLeaseVideoBookmark(db: Database.Database, base: EnrichBookmarkInput, suffix: number): EnrichBookmarkInput {
  const bookmarkId = `b-video-lease-${suffix}`
  const tweetId = `10000000010${suffix}`
  const mediaId = `media-video-lease-${suffix}`
  const sourceUrl = `https://video.twimg.com/ext_tw_video/lease-${suffix}/pu/vid/720x720/demo.mp4`
  db.prepare(`
    INSERT INTO Bookmark (id, tweetId, text, authorHandle, authorName, tweetCreatedAt, rawJson, source)
    VALUES (@id, @tweetId, @text, @authorHandle, @authorName, @tweetCreatedAt, @rawJson, @source)
  `).run({
    id: bookmarkId,
    tweetId,
    text: `Parallel video drain fixture ${suffix}`,
    authorHandle: base.authorHandle,
    authorName: `Fixture ${suffix}`,
    tweetCreatedAt: `2026-06-08T00:0${suffix}:00.000Z`,
    rawJson: JSON.stringify({ tweet: { id: tweetId, text: `Parallel video drain fixture ${suffix}` } }),
    source: 'bookmark',
  })
  db.prepare(`
    INSERT INTO MediaItem (id, bookmarkId, type, url, thumbnailUrl, imageTags)
    VALUES (@id, @bookmarkId, 'video', @url, NULL, NULL)
  `).run({ id: mediaId, bookmarkId, url: sourceUrl })

  return {
    ...base,
    id: bookmarkId,
    tweetId,
    text: `Parallel video drain fixture ${suffix}`,
    rawJson: JSON.stringify({ tweet: { id: tweetId, text: `Parallel video drain fixture ${suffix}` } }),
    mediaItems: [{ id: mediaId, type: 'video', url: sourceUrl, thumbnailUrl: null, imageTags: null }],
  }
}

describe('siftly-ace pipeline e2e', () => {
  realVecIt('fresh DB runs ingest-shaped rows through enrich, recorded/live embed, real sqlite-vec, hybrid search, and Obsidian export', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)
    const provider = createE2EEmbeddingProvider()

    try {
      const enrichResult = await enrichBookmarks({
        db: adapter,
        bookmarks: selectEnrichBookmarks(db),
        now: new Date('2026-06-08T00:00:00.000Z'),
      })
      expect(enrichResult).toEqual({ enriched: 6 })

      const ocrResult = await runOcrForMediaItems(adapter, selectMediaForOcr(db), 30_000)
      expect(ocrResult).toEqual({ attempted: 1, succeeded: 1, failed: 0 })
      const memeTags = parseImageTags(mediaImageTags(db, 'media-meme'))
      expect(normalizeText(String((memeTags.text_ocr as string[]).join(' ')))).toContain('pineapple meme')

      const embedResult = await embedBookmarkCorpus({
        dbPath: fixture.dbPath,
        provider,
        force: true,
        vecOptions: realVecOptions(),
      })
      console.info(`VEC0 E2E fresh pipeline embed mode=${embedResult.vecMode} reason=${embedResult.vecStatus.reason}`)
      expect(embedResult).toMatchObject({ selected: 6, embedded: 6, vecMode: 'sqlite-vec' })
      assertRealVecStore(fixture.dbPath, 'fresh pipeline')

      const cases = [
        ['Hermes language model new release', '100000000001'],
        ['sqlite vec migration shadow table', '100000000002'],
        ['Obsidian export OCR meme caption', '100000000004'],
      ] as const
      for (const [query, expectedTweetId] of cases) {
        const results = await hybridSearch({
          dbPath: fixture.dbPath,
          query,
          provider,
          limit: 3,
          rebuildFts: true,
          vecOptions: realVecOptions(),
        })
        expect(results.map((row) => row.tweetId), query).toContain(expectedTweetId)
      }

      const bookmarks = selectObsidianBookmarks(db)
      const exported = await exportSavedTweetsToObsidian({ outputDir: fixture.exportDir, bookmarks })
      expect(exported).toMatchObject({ written: 6, skipped: 0, errors: [], indexesWritten: 6 })

      const meme = bookmarks.find((bookmark) => bookmark.id === 'b-obsidian-ocr-meme')
      expect(meme).toBeTruthy()
      const memeNote = await readUtf8(path.join(fixture.exportDir, noteFilename(meme!)))
      expect(memeNote).toContain('type: "x-bookmark"')
      expect(memeNote).toContain('tweetId: "100000000004"')
      expect(memeNote).toContain('source: "like"')
      expect(memeNote).toContain('OCR caption: PINEAPPLE MEME')

      const exportedAgain = await exportSavedTweetsToObsidian({ outputDir: fixture.exportDir, bookmarks })
      expect(exportedAgain).toMatchObject({ written: 0, skipped: 6, errors: [], indexesWritten: 0 })
    } finally {
      db.close()
    }
  }, 120_000)

  it('hard-fails live embedding mode when the key is missing instead of falling back to recorded vectors', () => {
    expect(() => createE2EEmbeddingProvider({ SIFTLY_E2E_LIVE_EMBED: '1' } as unknown as NodeJS.ProcessEnv)).toThrow(/requires SIFTLY_EMBED_API_KEY or OPENAI_API_KEY/)
  })

  it('survives a hard-failing image mid-OCR-batch and still processes the good media after it', async () => {
    // Regression guard for the silent-batch-abort bug: runOcrForMediaItems
    // used to throw on a single bad image (404/decode/timeout), losing OCR on
    // every later item. A broken image before the good meme must not stop the
    // good meme from being OCR'd, embedded, and exported.
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)
    try {
      // Insert a broken image item that sorts BEFORE the real meme media id.
      db.prepare(
        `INSERT INTO MediaItem (id, bookmarkId, type, url, thumbnailUrl, localPath, imageTags)
         VALUES (@id, @bookmarkId, @type, @url, @thumbnailUrl, NULL, @imageTags)`,
      ).run({
        id: 'media-aaa-broken',
        bookmarkId: 'b-obsidian-ocr-meme',
        type: 'photo',
        url: '/nonexistent/path/does-not-exist.png', // tesseract can't read -> throws
        thumbnailUrl: null,
        imageTags: null,
      })

      const ocrResult = await runOcrForMediaItems(adapter, selectMediaForOcr(db), 30_000)

      // Batch did not abort: both attempted, one failed (broken), one succeeded (meme).
      expect(ocrResult.attempted).toBe(2)
      expect(ocrResult.failed).toBe(1)
      expect(ocrResult.succeeded).toBe(1)

      // The good meme AFTER the failure was still OCR'd.
      const memeTags = parseImageTags(mediaImageTags(db, 'media-meme'))
      expect(normalizeText(String((memeTags.text_ocr as string[]).join(' ')))).toContain('pineapple meme')
      // The broken item was left untouched (no partial/garbage write).
      expect(mediaImageTags(db, 'media-aaa-broken')).toBeNull()
    } finally {
      db.close()
    }
  }, 120_000)

  it('keeps brute-force fallback correct and model-scoped when sqlite-vec is intentionally disabled', async () => {
    const fixture = await newFixture()
    const provider = createRecordedProvider()

    const embedResult = await embedBookmarkCorpus({
      dbPath: fixture.dbPath,
      provider,
      force: true,
      vecOptions: { forceFallback: true },
    })
    expect(embedResult.vecMode).toBe('bruteforce')

    const cases = [
      ['xurl oauth bookmark ingestion dedupe', '100000000003'],
      ['typescript code hybrid search snippet', '100000000005'],
      ['video transcript drain local', '100000000006'],
    ] as const
    for (const [query, expectedTweetId] of cases) {
      const results = await hybridSearch({
        dbPath: fixture.dbPath,
        query,
        provider,
        limit: 3,
        rebuildFts: true,
        vecOptions: { forceFallback: true },
      })
      expect(results.map((row) => row.tweetId), query).toContain(expectedTweetId)
    }
  })

  it('drains video out-of-band with injected transcript, preserves OCR, compacts queue state, and reclaims stale locks quickly', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)

    try {
      const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
      const enqueued = await enqueueVideoItems([videoBookmark], {
        queuePath: fixture.queuePath,
        now: new Date('2026-06-08T00:00:00.000Z'),
      })
      expect(enqueued).toEqual({ enqueued: 1, skipped: 0 })

      const currentQueueLine = await readFile(fixture.queuePath, 'utf8')
      const staleDuplicate = {
        key: 'media-video',
        status: 'error',
        bookmarkId: 'b-video-transcript-drain',
        tweetId: '100000000006',
        mediaItemId: 'media-video',
        sourceUrl: 'https://video.twimg.com/ext_tw_video/100000000006/pu/vid/720x720/demo.mp4',
        attempts: 1,
        enqueuedAt: '2026-06-07T00:00:00.000Z',
        updatedAt: '2026-06-07T00:01:00.000Z',
        error: 'older duplicate that drain should compact away',
      }
      await writeFile(fixture.queuePath, `${JSON.stringify(staleDuplicate)}\n${currentQueueLine}`, 'utf8')

      const drained = await drainVideoQueue({
        db: adapter,
        queuePath: fixture.queuePath,
        limit: 1,
        transcribe: async () => 'spoken pineapple transcript for the local video drain',
        now: new Date('2026-06-08T00:01:00.000Z'),
      })
      expect(drained).toEqual({ processed: 1, transcribed: 1, failed: 0 })

      const tags = parseImageTags(mediaImageTags(db, 'media-video'))
      expect(tags.text_ocr).toEqual(['VIDEO OCR SHOULD STAY'])
      expect(tags.video_transcript).toBe('spoken pineapple transcript for the local video drain')

      const state = await readVideoQueueState(fixture.queuePath)
      expect([...state.values()]).toHaveLength(1)
      expect(state.get('media-video')).toMatchObject({ status: 'done', transcriptChars: 'spoken pineapple transcript for the local video drain'.length })
      const queueLines = (await readFile(fixture.queuePath, 'utf8')).trim().split(/\r?\n/)
      expect(queueLines).toHaveLength(1)

      const staleQueuePath = path.join(fixture.dir, 'stale-video-queue.jsonl')
      const staleLockPath = `${staleQueuePath}.lock`
      await mkdir(staleLockPath, { recursive: true })
      await writeFile(path.join(staleLockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' })}\n`, 'utf8')

      const staleOutcome = await Promise.race([
        enqueueVideoItems([videoBookmark], {
          queuePath: staleQueuePath,
          now: new Date('2026-06-08T00:02:00.000Z'),
          lockTimeoutMs: 500,
          lockStaleMs: 1,
        }).then((result) => ({ status: 'resolved' as const, result }), (error: Error) => ({ status: 'rejected' as const, error })),
        delay(1_000).then(() => ({ status: 'hung' as const })),
      ])
      expect(staleOutcome.status).toBe('resolved')
    } finally {
      db.close()
    }
  }, 120_000)

  it('leases video queue items atomically so concurrent drain workers process disjoint tweetIds', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)

    try {
      const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
      const bookmarks = [
        videoBookmark,
        seedLeaseVideoBookmark(db, videoBookmark, 1),
        seedLeaseVideoBookmark(db, videoBookmark, 2),
      ]
      await expect(enqueueVideoItems(bookmarks, {
        queuePath: fixture.queuePath,
        now: new Date('2026-06-08T00:04:00.000Z'),
      })).resolves.toEqual({ enqueued: 3, skipped: 0 })

      const transcribedUrls: string[] = []
      const transcribe = vi.fn(async (sourceUrl: string) => {
        transcribedUrls.push(sourceUrl)
        await delay(50)
        return `parallel transcript for ${sourceUrl}`
      })

      const [left, right] = await Promise.all([
        drainVideoQueue({
          db: adapter,
          queuePath: fixture.queuePath,
          limit: 2,
          workers: 2,
          transcribe,
          now: new Date('2026-06-08T00:05:00.000Z'),
        }),
        drainVideoQueue({
          db: adapter,
          queuePath: fixture.queuePath,
          limit: 2,
          workers: 2,
          transcribe,
          now: new Date('2026-06-08T00:05:00.000Z'),
        }),
      ])

      expect(left.processed + right.processed).toBe(3)
      expect(left.transcribed + right.transcribed).toBe(3)
      expect(left.failed + right.failed).toBe(0)
      expect(transcribe).toHaveBeenCalledTimes(3)
      expect(new Set(transcribedUrls).size).toBe(3)

      const state = await readVideoQueueState(fixture.queuePath)
      expect([...state.values()].filter((record) => record.status === 'done')).toHaveLength(3)
      const queueDb = new Database(queueSqlitePath(fixture.queuePath), { readonly: true })
      try {
        const rows = queueDb.prepare('SELECT tweetId, status, owner, leasedAt FROM queue ORDER BY tweetId').all() as Array<{ tweetId: string; status: string; owner: string | null; leasedAt: string | null }>
        expect(rows).toHaveLength(3)
        expect(new Set(rows.map((row) => row.tweetId)).size).toBe(3)
        expect(rows.every((row) => row.status === 'done' && row.owner === null && row.leasedAt === null)).toBe(true)
      } finally {
        queueDb.close()
      }
    } finally {
      db.close()
    }
  }, 120_000)

  it('reclaims a stale per-item lease and reprocesses it exactly once', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)

    try {
      const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
      await enqueueVideoItems([videoBookmark], {
        queuePath: fixture.queuePath,
        now: new Date('2026-06-08T00:06:00.000Z'),
      })
      const queueDb = new Database(queueSqlitePath(fixture.queuePath))
      try {
        queueDb.prepare("UPDATE queue SET status='leasing', owner='dead-worker', leasedAt='2026-06-08T00:00:00.000Z' WHERE tweetId = ?").run(videoBookmark.tweetId)
      } finally {
        queueDb.close()
      }

      const transcribe = vi.fn(async () => 'stale lease recovered transcript')
      const result = await drainVideoQueue({
        db: adapter,
        queuePath: fixture.queuePath,
        limit: 1,
        workers: 2,
        leaseTtlMs: 1,
        transcribe,
        now: new Date('2026-06-08T00:20:00.000Z'),
      })

      expect(result).toEqual({ processed: 1, transcribed: 1, failed: 0 })
      expect(transcribe).toHaveBeenCalledTimes(1)
      const state = await readVideoQueueState(fixture.queuePath)
      expect(state.get('media-video')).toMatchObject({ status: 'done', transcriptChars: 'stale lease recovered transcript'.length })
    } finally {
      db.close()
    }
  })

  it('does not duplicate transcript FTS rows when a stale owner already wrote the transcript before dying', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const adapter = new SqliteE2EDb(db)

    try {
      const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
      await enqueueVideoItems([videoBookmark], {
        queuePath: fixture.queuePath,
        now: new Date('2026-06-08T00:21:00.000Z'),
      })
      const persistedTags = JSON.stringify({ video_transcript: 'persisted before lease release' })
      db.prepare('UPDATE MediaItem SET imageTags = ? WHERE id = ?').run(persistedTags, 'media-video')
      db.exec('CREATE TABLE transcript_fts (tweetId TEXT PRIMARY KEY, image_tags TEXT NOT NULL)')
      db.prepare('INSERT INTO transcript_fts(tweetId, image_tags) VALUES (?, ?) ON CONFLICT(tweetId) DO NOTHING').run(videoBookmark.tweetId, persistedTags)

      const queueDb = new Database(queueSqlitePath(fixture.queuePath))
      try {
        queueDb.prepare("UPDATE queue SET status='leasing', owner='dead-after-write', leasedAt='2026-06-08T00:00:00.000Z' WHERE tweetId = ?").run(videoBookmark.tweetId)
      } finally {
        queueDb.close()
      }

      const transcribe = vi.fn(async () => 'SHOULD NOT RUN')
      const result = await drainVideoQueue({
        db: adapter,
        queuePath: fixture.queuePath,
        limit: 1,
        workers: 2,
        leaseTtlMs: 1,
        transcribe,
        now: new Date('2026-06-08T00:22:00.000Z'),
      })

      expect(result).toEqual({ processed: 1, transcribed: 0, failed: 0 })
      expect(transcribe).not.toHaveBeenCalled()
      expect(db.prepare('SELECT COUNT(*) AS count FROM transcript_fts WHERE tweetId = ?').get(videoBookmark.tweetId)).toEqual({ count: 1 })
      const state = await readVideoQueueState(fixture.queuePath)
      expect(state.get('media-video')).toMatchObject({ status: 'done', transcriptChars: 'persisted before lease release'.length })
    } finally {
      db.close()
    }
  })

  it('passes pinned and pooled Parakeet routing env through to the existing dispatcher script', async () => {
    const fixture = await newFixture()
    const fakeScript = path.join(fixture.dir, 'fake-parakeet.sh')
    await writeFile(fakeScript, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'test "${PARAKEET_URL:-}" = "http://127.0.0.1:8924"',
      'test "${YTNB_ASR_BACKENDS:-}" = "http://down.invalid:8923,http://127.0.0.1:8924"',
      'printf "pooled dispatcher transcript"',
    ].join('\n'), 'utf8')

    await expect(transcribeWithParakeet('https://video.twimg.com/ext_tw_video/demo.mp4', {
      scriptPath: fakeScript,
      timeoutMs: 1_000,
      env: {
        PARAKEET_URL: 'http://127.0.0.1:8924',
        YTNB_ASR_BACKENDS: 'http://down.invalid:8923,http://127.0.0.1:8924',
      },
    })).resolves.toBe('pooled dispatcher transcript')
  })

  it('reclaims a fresh lock whose owner pid is dead without waiting for TTL expiry', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
    db.close()

    const lockPath = `${fixture.queuePath}.lock`
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 99_999_999, createdAt: new Date().toISOString() })}\n`, 'utf8')

    const startedAt = Date.now()
    const result = await enqueueVideoItems([videoBookmark], {
      queuePath: fixture.queuePath,
      now: new Date('2026-06-08T00:03:00.000Z'),
      lockTimeoutMs: 750,
      lockStaleMs: 60 * 60_000,
    })

    expect(result).toEqual({ enqueued: 1, skipped: 0 })
    expect(Date.now() - startedAt).toBeLessThan(750)
  })

  it('does not reclaim partial owner.json locks even when createdAt is old', async () => {
    const fixture = await newFixture()
    const db = new Database(fixture.dbPath)
    const [videoBookmark] = selectEnrichBookmarks(db).filter((bookmark) => bookmark.id === 'b-video-transcript-drain')
    db.close()

    const lockPath = `${fixture.queuePath}.lock`
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ createdAt: '2000-01-01T00:00:00.000Z' })}\n`, 'utf8')

    await expect(enqueueVideoItems([videoBookmark], {
      queuePath: fixture.queuePath,
      lockTimeoutMs: 75,
      lockStaleMs: 1,
    })).rejects.toThrow(/timed out acquiring video queue lock/)

    await rm(lockPath, { recursive: true, force: true })
  })
})
