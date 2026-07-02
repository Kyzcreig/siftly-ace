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
  enrichBookmarkRows,
  generateImageCaption,
  isCaptionCandidate,
  isTerminalTranscriptionFailure,
  mergeCaptionImageTags,
  readVideoQueueState,
  resolveParakeetBackends,
  runCaptionForMediaItems,
  runLocalOcr,
  runOcrForMediaItems,
  transcribeWithParakeet,
  type EnrichBookmarkInput,
  type EnrichDb,
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

  it('densifies tags from X context_annotations when keyword rules find nothing', () => {
    // A tweet whose text has no taggable keywords, but X's own context
    // annotations classify it as crypto + finance. Should still get tagged.
    const bookmark: EnrichBookmarkInput = {
      id: 'bookmark-ctx',
      tweetId: '777',
      text: 'wild times out there lol',
      authorHandle: 'someone',
      rawJson: JSON.stringify({
        tweet: {
          id: '777',
          context_annotations: [
            { domain: { name: 'Unified Twitter Taxonomy' }, entity: { name: 'Cryptocurrencies' } },
            { domain: { name: 'Interests and Hobbies Vertical' }, entity: { name: 'Business & finance' } },
            { domain: { name: 'Unified Twitter Taxonomy' }, entity: { name: 'Politics' } },
          ],
        },
      }),
      entities: null,
      semanticTags: null,
      enrichmentMeta: null,
      mediaItems: [],
      categories: [],
    }

    const enrichment = extractFactualEnrichment(bookmark)

    expect(enrichment.topicTags).toEqual(expect.arrayContaining(['crypto-web3', 'finance', 'politics']))
    expect(enrichment.categorySlugs).toEqual(expect.arrayContaining(['finance-crypto', 'finance-investing', 'politics']))
    // context annotations are still preserved on entities for downstream use
    expect(enrichment.entities.contextAnnotations.length).toBe(3)
  })

  it('batches bookmark enrichment updates and category assignment writes', async () => {
    const calls = { transactions: 0, categoryLookups: 0, createMany: 0, upserts: 0 }
    let categoryRows: Array<{ bookmarkId: string; categoryId: string; confidence: number }> = []
    const bookmarks: EnrichBookmarkInput[] = [
      {
        id: 'bookmark-ai',
        tweetId: '101',
        text: 'Claude FastAPI benchmark launch with code on GitHub',
        authorHandle: 'builder',
        rawJson: '{}',
        entities: null,
        semanticTags: null,
        enrichmentMeta: null,
        mediaItems: [],
        categories: [],
      },
      {
        id: 'bookmark-finance',
        tweetId: '102',
        text: 'Bitcoin market update for startup founders',
        authorHandle: 'analyst',
        rawJson: '{}',
        entities: null,
        semanticTags: null,
        enrichmentMeta: null,
        mediaItems: [],
        categories: [],
      },
    ]
    const db: EnrichDb = {
      bookmark: {
        update: async () => ({}),
      },
      $transaction: async (ops) => {
        calls.transactions++
        return Promise.all(ops)
      },
      category: {
        findMany: async () => {
          calls.categoryLookups++
          return [
            { id: 'cat-ai', slug: 'ai-resources' },
            { id: 'cat-dev', slug: 'dev-tools' },
            { id: 'cat-crypto', slug: 'finance-crypto' },
            { id: 'cat-startup', slug: 'startups-business' },
          ]
        },
      },
      bookmarkCategory: {
        upsert: async () => {
          calls.upserts++
          return {}
        },
        createMany: async ({ data, ...rest }: { data: any[]; skipDuplicates?: boolean }) => {
          // Prisma 7's SQLite connector rejects unknown args like
          // `skipDuplicates`; mirror that so the bug can't stay green here.
          const extraKeys = Object.keys(rest)
          if (extraKeys.length > 0) {
            throw new Error(`Unknown argument \`${extraKeys[0]}\`. Available options are marked with ?.`)
          }
          calls.createMany++
          categoryRows = data
          return { count: data.length }
        },
      },
    }

    const result = await enrichBookmarkRows(db, bookmarks, new Date('2026-06-07T12:00:00Z'))

    expect(result.enriched).toBe(2)
    expect(calls.transactions).toBe(1)
    expect(calls.categoryLookups).toBe(1)
    expect(calls.createMany).toBe(1)
    expect(calls.upserts).toBe(0)
    expect(categoryRows).toEqual(expect.arrayContaining([
      { bookmarkId: 'bookmark-ai', categoryId: 'cat-ai', confidence: 0.8 },
      { bookmarkId: 'bookmark-ai', categoryId: 'cat-dev', confidence: 0.8 },
      { bookmarkId: 'bookmark-finance', categoryId: 'cat-crypto', confidence: 0.8 },
    ]))
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

  it('continues the OCR batch when a single image hard-fails (404/timeout/decode)', async () => {
    // A good image AFTER a broken one must still be processed: one bad item
    // must not abort the run and lose progress on every later candidate.
    const goodPath = path.join(tmp, 'ocr-resilient-good.png')
    await createTextImage(goodPath, 'SURVIVES')
    const badPath = path.join(tmp, 'does-not-exist-ocr-input.png') // no file -> tesseract throws

    const db = new MemoryVideoDb(['bad-media', 'good-media'])

    const result = await runOcrForMediaItems(
      db,
      [
        { id: 'bad-media', type: 'photo', url: badPath, thumbnailUrl: null, imageTags: null },
        { id: 'good-media', type: 'photo', url: goodPath, thumbnailUrl: null, imageTags: null },
      ],
      30_000,
    )

    expect(result.attempted).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(1)
    // The good item AFTER the failure was still written.
    const parsed = JSON.parse(db.mediaItems.get('good-media')!.imageTags!) as { text_ocr?: string[] }
    expect(normalize((parsed.text_ocr ?? []).join(' '))).toContain('survives')
    // The failed item was left untouched (no partial/garbage write).
    expect(db.mediaItems.get('bad-media')!.imageTags).toBeNull()
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

  it('parses Siftly-specific Parakeet backend lists with de-dupe and whitespace trimming', () => {
    expect(resolveParakeetBackends({
      SIFTLY_PARAKEET_BACKENDS: ' http://a:8923 , http://b:8923/, http://a:8923 ',
      YTNB_ASR_BACKENDS: 'http://ignored:8923',
    })).toEqual(['http://a:8923', 'http://b:8923'])
  })

  it('parks no-audio and empty-speech videos immediately instead of re-downloading them three times', async () => {
    const queuePath = path.join(tmp, 'video-queue-terminal-no-audio.jsonl')
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
      throw new Error('Command failed: yt-dlp -x --audio-format wav\nPostprocessing: WARNING: unable to obtain file audio codec with ffprobe')
    })

    const result = await drainVideoQueue({ db: new MemoryVideoDb(['video-media-1']), queuePath, transcribe, maxAttempts: 3, now: new Date('2026-06-07T12:00:01Z') })

    expect(result).toMatchObject({ processed: 1, failed: 1 })
    expect(isTerminalTranscriptionFailure('empty transcript')).toBe(true)
    expect(isTerminalTranscriptionFailure('Postprocessing: WARNING: unable to obtain file audio codec with ffprobe')).toBe(true)
    const state = await readVideoQueueState(queuePath)
    expect(state.get('video-media-1')).toMatchObject({ status: 'error', attempts: 3 })
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('fans real Parakeet drain workers across configured backend URLs via PARAKEET_URL', async () => {
    const queuePath = path.join(tmp, 'video-queue-backend-fanout.jsonl')
    const scriptPath = path.join(tmp, 'fake-parakeet-backend-fanout.sh')
    const envLog = path.join(tmp, 'fake-parakeet-backend-fanout.log')
    await writeFile(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "\${PARAKEET_URL:-missing}" >> ${JSON.stringify(envLog)}\nsleep 0.05\nprintf 'transcript from %s\\n' "\${PARAKEET_URL:-missing}"\n`, 'utf8')

    const bookmarks = ['1', '2', '3'].map((n) => videoBookmark(
      { id: `bookmark-video-${n}`, tweetId: `900${n}` },
      { id: `video-media-${n}`, url: `https://video.twimg.com/ext_tw_video/demo-${n}.mp4` },
    ))
    const db = new MemoryVideoDb(['video-media-1', 'video-media-2', 'video-media-3'])
    await enqueueVideoItems(bookmarks, { queuePath, now: new Date('2026-06-07T12:00:00Z') })

    const result = await drainVideoQueue({
      db,
      queuePath,
      limit: 3,
      workers: 3,
      scriptPath,
      backendUrls: ['http://backend-a:8923', 'http://backend-b:8923', 'http://backend-c:8924'],
      now: new Date('2026-06-07T12:00:01Z'),
    })

    expect(result).toMatchObject({ processed: 3, transcribed: 3, failed: 0 })
    const used = (await readFile(envLog, 'utf8')).trim().split(/\r?\n/).sort()
    expect(used).toEqual(['http://backend-a:8923', 'http://backend-b:8923', 'http://backend-c:8924'])
    const transcripts = [...db.mediaItems.values()].map((row) => JSON.parse(row.imageTags ?? '{}') as { video_transcript?: string })
    expect(transcripts.map((row) => row.video_transcript).sort()).toEqual([
      'transcript from http://backend-a:8923',
      'transcript from http://backend-b:8923',
      'transcript from http://backend-c:8924',
    ])
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

  it('reclaims stale queue locks but errors on live locks within a bounded time', async () => {
    const staleQueuePath = path.join(tmp, 'video-queue-stale-lock.jsonl')
    const staleLockPath = `${staleQueuePath}.lock`
    await mkdir(staleLockPath)
    await writeFile(path.join(staleLockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' })}\n`, 'utf8')

    const staleEnqueue = enqueueVideoItems([videoBookmark()], {
      queuePath: staleQueuePath,
      now: new Date('2026-06-07T12:00:00Z'),
      lockTimeoutMs: 500,
      lockStaleMs: 1,
    })
    const staleOutcome = await Promise.race([
      staleEnqueue.then(() => 'resolved' as const, (err) => err as Error),
      delay(500).then(() => 'hung' as const),
    ])
    if (staleOutcome === 'hung') {
      await rm(staleLockPath, { recursive: true, force: true })
      await staleEnqueue.catch(() => undefined)
    }
    expect(staleOutcome).toBe('resolved')
    const staleState = await readVideoQueueState(staleQueuePath)
    expect(staleState.get('video-media-1')).toMatchObject({ status: 'pending' })

    const liveQueuePath = path.join(tmp, 'video-queue-live-lock-timeout.jsonl')
    const liveLockPath = `${liveQueuePath}.lock`
    await mkdir(liveLockPath)
    await writeFile(path.join(liveLockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8')

    const startedAt = Date.now()
    const liveEnqueue = enqueueVideoItems([videoBookmark()], {
      queuePath: liveQueuePath,
      now: new Date('2026-06-07T12:00:00Z'),
      lockTimeoutMs: 75,
      lockStaleMs: 60_000,
    })
    let liveOutcome: 'resolved' | 'hung' | Error
    try {
      liveOutcome = await Promise.race([
        liveEnqueue.then(() => 'resolved' as const, (err) => err as Error),
        delay(500).then(() => 'hung' as const),
      ])
    } finally {
      await rm(liveLockPath, { recursive: true, force: true })
      await liveEnqueue.catch(() => undefined)
    }

    expect(liveOutcome).toBeInstanceOf(Error)
    expect((liveOutcome as Error).message).toMatch(/timed out acquiring video queue lock/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
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

describe('image captioning (vision tier for textless images)', () => {
  it('detects caption candidates only when no OCR text and no existing caption', () => {
    const base = { id: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', thumbnailUrl: null }
    expect(isCaptionCandidate({ ...base, imageTags: null })).toBe(true)
    expect(isCaptionCandidate({ ...base, imageTags: '{}' })).toBe(true)
    expect(isCaptionCandidate({ ...base, imageTags: JSON.stringify({ text_ocr: [] }) })).toBe(true)
    expect(isCaptionCandidate({ ...base, imageTags: JSON.stringify({ text_ocr: ['BUY NOW'] }) })).toBe(false)
    expect(isCaptionCandidate({ ...base, imageTags: JSON.stringify({ vision_caption: 'a cat' }) })).toBe(false)
    expect(isCaptionCandidate({ ...base, type: 'tweet' as unknown as string, imageTags: null })).toBe(false)
  })

  it('merges a caption without clobbering existing OCR/transcript tags', () => {
    const existing = JSON.stringify({ text_ocr: ['keep me'], video_transcript: 'spoken words' })
    const merged = JSON.parse(mergeCaptionImageTags(existing, 'two people on a stage'))
    expect(merged.text_ocr).toEqual(['keep me'])
    expect(merged.video_transcript).toBe('spoken words')
    expect(merged.vision_caption).toBe('two people on a stage')
    expect(merged.caption_backend).toBe('gpt-4o-mini')
  })

  it('rejects caption image URLs outside the twimg allowlist before any network call', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('should not be called') }) as unknown as typeof fetch
    await expect(generateImageCaption('https://evil.example/x.jpg', { apiKey: 'k', fetchFn })).rejects.toThrow(/allowlist/i)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('captions a candidate via an injected model client and persists vision_caption', async () => {
    const db = new MemoryVideoDb(['video-media-1'])
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'A line chart trending upward.' } }] }), { status: 200 })) as unknown as typeof fetch
    const result = await runCaptionForMediaItems(
      db,
      [{ id: 'video-media-1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', thumbnailUrl: null }],
      { apiKey: 'k', fetchFn },
    )
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 })
    const tags = JSON.parse(db.mediaItems.get('video-media-1')!.imageTags!)
    expect(tags.vision_caption).toBe('A line chart trending upward.')
  })

  it('counts a failure (and does not throw) when the model returns an empty caption', async () => {
    const db = new MemoryVideoDb(['video-media-1'])
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })) as unknown as typeof fetch
    const result = await runCaptionForMediaItems(
      db,
      [{ id: 'video-media-1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', thumbnailUrl: null }],
      { apiKey: 'k', fetchFn },
    )
    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1 })
    expect(db.mediaItems.get('video-media-1')!.imageTags).toBeNull()
  })
})

describe('caption cost gate + auth fail-fast', () => {
  it('blocks a large caption backfill without --confirm (same gate as vision)', () => {
    const estimate = estimateVisionCost({ imageCount: 200, videoThumbnailCount: 0 })
    expect(estimate.requiresConfirmation).toBe(true)
    expect(() => enforceVisionCostGate(estimate, { confirm: false })).toThrow(/requires approval/i)
    expect(enforceVisionCostGate(estimate, { confirm: true })).toBe(true)
  })

  it('aborts the whole batch on an auth (401) error instead of burning paid calls per item', async () => {
    const db = new MemoryVideoDb(['m1', 'm2', 'm3'])
    let calls = 0
    const fetchFn = vi.fn(async () => { calls++; return new Response('unauthorized', { status: 401 }) }) as unknown as typeof fetch
    await expect(
      runCaptionForMediaItems(
        db,
        [
          { id: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', thumbnailUrl: null },
          { id: 'm2', type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg', thumbnailUrl: null },
          { id: 'm3', type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg', thumbnailUrl: null },
        ],
        { apiKey: 'bad', fetchFn },
      ),
    ).rejects.toThrow(/auth/i)
    expect(calls).toBe(1)
  })
})
