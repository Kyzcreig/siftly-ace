import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  drainVideoQueue,
  enforceVisionCostGate,
  enqueueVideoItems,
  estimateVisionCost,
  extractFactualEnrichment,
  readVideoQueueState,
  runLocalOcr,
  runOcrForMediaItems,
  transcribeWithParakeet,
  type EnrichBookmarkInput,
  type VideoEnrichDb,
} from './index'

const execFileAsync = promisify(execFile)

class MemoryVideoDb implements VideoEnrichDb {
  mediaItems = new Map<string, { imageTags: string | null }>()

  constructor(mediaIds: string[]) {
    for (const id of mediaIds) this.mediaItems.set(id, { imageTags: null })
  }

  mediaItem = {
    findUnique: async ({ where }: { where: { id: string }; select: { imageTags: true } }) => {
      const row = this.mediaItems.get(where.id)
      return row ? { imageTags: row.imageTags } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: { imageTags: string } }) => {
      const row = this.mediaItems.get(where.id)
      if (!row) throw new Error(`missing media item ${where.id}`)
      row.imageTags = data.imageTags
      return { id: where.id, imageTags: row.imageTags }
    },
  }
}

async function createTextImage(outputPath: string, text: string): Promise<void> {
  await execFileAsync('magick', [
    '-size', '900x320',
    'xc:white',
    '-fill', 'black',
    '-gravity', 'center',
    '-pointsize', '72',
    '-annotate', '0', text,
    outputPath,
  ])
}

async function createSpeechAudio(outputPath: string, text: string): Promise<void> {
  await execFileAsync('/usr/bin/say', ['-v', 'Samantha', '-o', outputPath, text], { timeout: 30_000 })
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
}

function videoBookmark(overrides: Partial<EnrichBookmarkInput> = {}, mediaOverrides: Partial<EnrichBookmarkInput['mediaItems'][number]> = {}): EnrichBookmarkInput {
  return {
    id: 'bookmark-video',
    tweetId: '9001',
    text: 'Bookmarked demo video',
    authorHandle: 'ace',
    rawJson: '{}',
    entities: null,
    semanticTags: null,
    enrichmentMeta: null,
    mediaItems: [{ id: 'video-media-1', type: 'video', url: 'https://video.twimg.com/ext_tw_video/demo.mp4', thumbnailUrl: null, imageTags: null, ...mediaOverrides }],
    categories: [],
    ...overrides,
  }
}

describe('Phase 3 enrichment', () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'siftly-enrich-'))
  })

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('extracts factual entities, format flags, categories, and segment without why-saved inference', () => {
    const bookmark: EnrichBookmarkInput = {
      id: 'bookmark-42',
      tweetId: '42',
      text: 'Launching a FastAPI eval benchmark for Claude agents #AI with @OpenAI https://github.com/acme/demo',
      authorHandle: 'builder',
      rawJson: JSON.stringify({
        tweet: {
          id: '42',
          conversation_id: 'thread-root',
          referenced_tweets: [{ type: 'quoted', id: '41' }],
          entities: {
            hashtags: [{ tag: 'AI' }],
            mentions: [{ username: 'OpenAI' }],
            urls: [{ expanded_url: 'https://github.com/acme/demo' }],
          },
        },
        includes: { media: [{ media_key: 'm1', type: 'video' }] },
      }),
      entities: null,
      semanticTags: null,
      enrichmentMeta: null,
      mediaItems: [{ id: 'm1', type: 'video', url: 'https://video.twimg.com/demo.mp4', thumbnailUrl: 'https://pbs.twimg.com/thumb.jpg', imageTags: null }],
      categories: [],
    }

    const enrichment = extractFactualEnrichment(bookmark)

    expect(enrichment.entities.hashtags).toContain('AI')
    expect(enrichment.entities.mentions).toContain('OpenAI')
    expect(enrichment.entities.urls).toContain('https://github.com/acme/demo')
    expect(enrichment.entities.tools).toEqual(expect.arrayContaining(['Claude', 'FastAPI', 'GitHub']))
    expect(enrichment.formatFlags.format).toBe('thread')
    expect(enrichment.formatFlags.is_quote).toBe(true)
    expect(enrichment.formatFlags.has_video).toBe(true)
    expect(enrichment.formatFlags.has_code).toBe(true)
    expect(enrichment.categorySlugs).toEqual(expect.arrayContaining(['ai-resources', 'dev-tools']))
    expect(enrichment.topicTags).toEqual(expect.arrayContaining(['ai-ml', 'developer-tools', 'launch', 'benchmark']))
    expect(enrichment.segment).toBe('brief-relevant')
    expect(JSON.stringify(enrichment)).not.toMatch(/why|intent|reason/i)
  })

  it('keeps vision/OCR behind a cost-estimate confirmation gate', () => {
    const large = estimateVisionCost({ imageCount: 200, videoThumbnailCount: 10 })
    expect(large.totalItems).toBe(210)
    expect(large.requiresConfirmation).toBe(true)
    expect(large.summary).toContain('est. $')

    expect(() => enforceVisionCostGate(large, { confirm: false, dryRun: false, env: {} })).toThrow(/--confirm|SIFTLY_ENRICH_CONFIRM_VISION/)
    expect(enforceVisionCostGate(large, { confirm: true, dryRun: false, env: {} })).toBe(true)
    expect(enforceVisionCostGate(large, { confirm: false, dryRun: false, env: { SIFTLY_ENRICH_CONFIRM_VISION: '1' } })).toBe(true)
    expect(enforceVisionCostGate(large, { confirm: false, dryRun: true, env: {} })).toBe(false)

    const small = estimateVisionCost({ imageCount: 2, videoThumbnailCount: 0 })
    expect(small.requiresConfirmation).toBe(false)
    expect(enforceVisionCostGate(small, { confirm: false, dryRun: false, env: {} })).toBe(true)
  })

  it('runs real local OCR on a meme image and captures visible text', async () => {
    const imagePath = path.join(tmp, 'meme.png')
    await createTextImage(imagePath, 'PINEAPPLE MEME')

    const result = await runLocalOcr({ url: imagePath, timeoutMs: 30_000 })
    const ocrText = normalize(result.text)

    expect(result.backend).toBe('tesseract')
    expect(ocrText).toContain('pineapple')
    expect(ocrText).toContain('meme')
  }, 60_000)

  it('queues video out-of-band, transcribes via the injected worker, and makes spoken words FTS-searchable', async () => {
    const queuePath = path.join(tmp, 'video-queue.jsonl')
    const db = new MemoryVideoDb(['video-media-1'])
    const bookmark = videoBookmark()

    const enqueued = await enqueueVideoItems([bookmark], { queuePath, now: new Date('2026-06-07T12:00:00Z') })
    expect(enqueued.enqueued).toBe(1)
    expect(db.mediaItems.get('video-media-1')?.imageTags).toBeNull()

    const queued = await readVideoQueueState(queuePath)
    expect([...queued.values()].filter((item) => item.status === 'pending')).toHaveLength(1)

    const drained = await drainVideoQueue({
      db,
      queuePath,
      limit: 1,
      transcribe: async () => 'pineapple archive video transcript',
    })
    expect(drained.transcribed).toBe(1)

    const imageTags = db.mediaItems.get('video-media-1')?.imageTags
    expect(imageTags).toBeTruthy()
    const parsed = JSON.parse(imageTags!) as { video_transcript?: string }
    expect(normalize(parsed.video_transcript ?? '')).toContain('pineapple')

    const sql = new Database(':memory:')
    sql.exec("CREATE VIRTUAL TABLE bookmark_fts USING fts5(bookmark_id UNINDEXED, image_tags, tokenize='porter unicode61')")
    sql.prepare('INSERT INTO bookmark_fts(bookmark_id, image_tags) VALUES (?, ?)').run('bookmark-video', imageTags)
    const row = sql.prepare("SELECT bookmark_id FROM bookmark_fts WHERE bookmark_fts MATCH 'pineapple'").get() as { bookmark_id: string } | undefined
    sql.close()

    expect(row?.bookmark_id).toBe('bookmark-video')
  }, 180_000)

  it('preserves existing OCR tags when adding a video transcript', async () => {
    const queuePath = path.join(tmp, 'video-queue-ocr-first.jsonl')
    const db = new MemoryVideoDb(['video-media-1'])
    db.mediaItems.set('video-media-1', { imageTags: JSON.stringify({ text_ocr: ['VISIBLE OCR'], ocr_backend: 'tesseract' }) })

    await enqueueVideoItems([videoBookmark()], { queuePath, now: new Date('2026-06-07T12:00:00Z') })
    const drained = await drainVideoQueue({
      db,
      queuePath,
      limit: 1,
      transcribe: async () => 'spoken transcript',
    })

    expect(drained.transcribed).toBe(1)
    const parsed = JSON.parse(db.mediaItems.get('video-media-1')!.imageTags!) as { text_ocr?: string[]; video_transcript?: string }
    expect(parsed.text_ocr).toContain('VISIBLE OCR')
    expect(parsed.video_transcript).toBe('spoken transcript')
  })

  it('requires findUnique when merging video transcripts so stale updates cannot drop OCR', async () => {
    const queuePath = path.join(tmp, 'video-queue-findunique-required.jsonl')
    const db = new MemoryVideoDb(['video-media-1'])
    await enqueueVideoItems([videoBookmark()], { queuePath, now: new Date('2026-06-07T12:00:00Z') })

    const dbWithoutFindUnique = {
      mediaItem: {
        update: db.mediaItem.update,
      },
    } as unknown as VideoEnrichDb

    const drained = await drainVideoQueue({
      db: dbWithoutFindUnique,
      queuePath,
      limit: 1,
      transcribe: async () => 'spoken transcript',
    })

    expect(drained.transcribed).toBe(0)
    expect(drained.failed).toBe(1)

    const state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')?.error).toMatch(/findUnique is required/)
  })

  it('preserves existing video transcripts when OCR writes fresh image tags', async () => {
    const imagePath = path.join(tmp, 'ocr-after-transcript.png')
    await createTextImage(imagePath, 'VISIBLE OCR')
    const db = new MemoryVideoDb(['image-media-1'])
    db.mediaItems.set('image-media-1', { imageTags: JSON.stringify({ video_transcript: 'spoken transcript' }) })

    const result = await runOcrForMediaItems(
      db,
      [{ id: 'image-media-1', type: 'photo', url: imagePath, thumbnailUrl: null, imageTags: null }],
      30_000,
    )

    expect(result.succeeded).toBe(1)
    const parsed = JSON.parse(db.mediaItems.get('image-media-1')!.imageTags!) as { text_ocr?: string[]; video_transcript?: string }
    expect(normalize((parsed.text_ocr ?? []).join(' '))).toContain('visible')
    expect(parsed.video_transcript).toBe('spoken transcript')
  }, 60_000)

  it('validates video source URLs before queueing and before transcription', async () => {
    const queuePath = path.join(tmp, 'video-queue-invalid-url.jsonl')
    await expect(enqueueVideoItems([videoBookmark({}, { url: 'https://evil.example/video.mp4' })], { queuePath })).rejects.toThrow(/allowlist/i)
    await expect(enqueueVideoItems([videoBookmark({ authorHandle: 'bad/handle' }, { url: 'https://pbs.twimg.com/thumb.jpg' })], { queuePath })).rejects.toThrow(/authorHandle/i)

    const badQueuePath = path.join(tmp, 'video-queue-bad-transcribe-url.jsonl')
    await writeFile(badQueuePath, `${JSON.stringify({
      key: 'video-media-1',
      status: 'pending',
      bookmarkId: 'bookmark-video',
      tweetId: '9001',
      mediaItemId: 'video-media-1',
      sourceUrl: 'https://evil.example/video.mp4',
      attempts: 1,
      enqueuedAt: '2026-06-07T12:00:00.000Z',
    })}\n`, 'utf8')
    const transcribe = vi.fn(async () => 'SHOULD_NOT_RUN')
    const drained = await drainVideoQueue({ db: new MemoryVideoDb(['video-media-1']), queuePath: badQueuePath, transcribe })
    expect(drained.failed).toBe(1)
    expect(transcribe).not.toHaveBeenCalled()
    const state = await readVideoQueueState(badQueuePath)
    expect(state.get('video-media-1')?.error).toMatch(/allowlist/i)

    const fakeScript = path.join(tmp, 'fake-parakeet.sh')
    await writeFile(fakeScript, '#!/usr/bin/env bash\necho SHOULD_NOT_RUN\n', 'utf8')
    await expect(transcribeWithParakeet('https://evil.example/video.mp4', { scriptPath: fakeScript, timeoutMs: 1_000 })).rejects.toThrow(/allowlist/i)
  })

  it('caps failed video retries and compacts the queue to the latest record per media item', async () => {
    const queuePath = path.join(tmp, 'video-queue-retry-cap.jsonl')
    const first = {
      key: 'video-media-1',
      status: 'error' as const,
      bookmarkId: 'bookmark-video',
      tweetId: '9001',
      mediaItemId: 'video-media-1',
      sourceUrl: 'https://video.twimg.com/ext_tw_video/demo.mp4',
      attempts: 1,
      enqueuedAt: '2026-06-07T12:00:00.000Z',
      updatedAt: '2026-06-07T12:00:01.000Z',
      error: 'first failure',
    }
    const exhausted = { ...first, attempts: 3, updatedAt: '2026-06-07T12:00:02.000Z', error: 'third failure' }
    await writeFile(queuePath, `${JSON.stringify(first)}\n${JSON.stringify(exhausted)}\n`, 'utf8')

    const result = await enqueueVideoItems([videoBookmark()], { queuePath, now: new Date('2026-06-07T12:00:03Z'), maxAttempts: 3 })

    expect(result.enqueued).toBe(0)
    expect(result.skipped).toBe(1)
    const lines = (await readFile(queuePath, 'utf8')).trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    const latest = JSON.parse(lines[0]) as { status: string; attempts: number; error?: string }
    expect(latest.status).toBe('error')
    expect(latest.attempts).toBe(3)
    expect(latest.error).toBe('third failure')
  })

  it('retries transient drain failures up to maxAttempts before marking terminal error', async () => {
    const queuePath = path.join(tmp, 'video-queue-drain-retries.jsonl')
    const record = {
      key: 'video-media-1',
      status: 'pending' as const,
      bookmarkId: 'bookmark-video',
      tweetId: '9001',
      mediaItemId: 'video-media-1',
      sourceUrl: 'https://video.twimg.com/ext_tw_video/demo.mp4',
      attempts: 1,
      enqueuedAt: '2026-06-07T12:00:00.000Z',
    }
    await writeFile(queuePath, `${JSON.stringify(record)}\n`, 'utf8')
    const transcribe = vi.fn(async () => {
      throw new Error('temporary network timeout')
    })

    await expect(drainVideoQueue({ db: new MemoryVideoDb(['video-media-1']), queuePath, transcribe, maxAttempts: 3, now: new Date('2026-06-07T12:00:01Z') })).resolves.toMatchObject({ processed: 1, failed: 1 })
    let state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')).toMatchObject({ status: 'pending', attempts: 2, error: 'temporary network timeout' })

    await drainVideoQueue({ db: new MemoryVideoDb(['video-media-1']), queuePath, transcribe, maxAttempts: 3, now: new Date('2026-06-07T12:00:02Z') })
    state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')).toMatchObject({ status: 'pending', attempts: 3 })

    await drainVideoQueue({ db: new MemoryVideoDb(['video-media-1']), queuePath, transcribe, maxAttempts: 3, now: new Date('2026-06-07T12:00:03Z') })
    state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')).toMatchObject({ status: 'error', attempts: 3, error: 'temporary network timeout' })
    expect(transcribe).toHaveBeenCalledTimes(3)
  })

  it('does not re-transcribe when a prior crash already wrote a video transcript but left the queue pending', async () => {
    const queuePath = path.join(tmp, 'video-queue-crash-after-db-update.jsonl')
    const db = new MemoryVideoDb(['video-media-1'])
    db.mediaItems.set('video-media-1', { imageTags: JSON.stringify({ video_transcript: 'already persisted transcript' }) })
    const record = {
      key: 'video-media-1',
      status: 'pending' as const,
      bookmarkId: 'bookmark-video',
      tweetId: '9001',
      mediaItemId: 'video-media-1',
      sourceUrl: 'https://video.twimg.com/ext_tw_video/demo.mp4',
      attempts: 1,
      enqueuedAt: '2026-06-07T12:00:00.000Z',
    }
    await writeFile(queuePath, `${JSON.stringify(record)}\n`, 'utf8')
    const transcribe = vi.fn(async () => 'SHOULD_NOT_RUN')

    const result = await drainVideoQueue({ db, queuePath, transcribe, now: new Date('2026-06-07T12:00:01Z') })

    expect(result).toEqual({ processed: 1, transcribed: 0, failed: 0 })
    expect(transcribe).not.toHaveBeenCalled()
    const state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')).toMatchObject({ status: 'done', attempts: 1, transcriptChars: 'already persisted transcript'.length })
  })

  it('serializes queue mutations with an advisory queue lock', async () => {
    const queuePath = path.join(tmp, 'video-queue-lock.jsonl')
    const lockPath = `${queuePath}.lock`
    await mkdir(lockPath)
    let settled = false

    const enqueue = enqueueVideoItems([videoBookmark()], { queuePath, now: new Date('2026-06-07T12:00:00Z') }).finally(() => {
      settled = true
    })
    await delay(50)
    expect(settled).toBe(false)

    await rm(lockPath, { recursive: true, force: true })
    await expect(enqueue).resolves.toEqual({ enqueued: 1, skipped: 0 })
    expect(settled).toBe(true)
  })

  it('rejects remote OCR URLs outside the twimg allowlist before fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch should not be called'))
    try {
      await expect(runLocalOcr({ url: 'https://example.com/image.png', timeoutMs: 1_000 })).rejects.toThrow(/allowlist/i)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
