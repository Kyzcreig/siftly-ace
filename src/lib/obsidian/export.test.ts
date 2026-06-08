import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportSavedTweetsToObsidian,
  noteFilename,
  type ObsidianSavedTweet,
} from './export'

const baseTweet = {
  id: 'row-1',
  authorName: 'Andrej Karpathy',
  importedAt: new Date('2026-06-08T01:02:03.000Z'),
  rawJson: '{}',
  semanticTags: JSON.stringify(['agent workflows', 'llm evals']),
  enrichmentMeta: JSON.stringify({ sentiment: 'positive' }),
  mediaItems: [],
} satisfies Partial<ObsidianSavedTweet>

const tempDirs: string[] = []

async function makeOutputDir(): Promise<string> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'siftly-obsidian-export-'))
  tempDirs.push(outputDir)
  return outputDir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('Obsidian saved tweet export', () => {
  it('exports sample tweet notes with required frontmatter, backlinks, and MOC indexes', async () => {
    const outputDir = await makeOutputDir()
    const tweet = {
      ...baseTweet,
      tweetId: '1234567890',
      text: 'Claude Code benchmark thread with GitHub repo https://github.com/example/project',
      authorHandle: 'karpathy',
      tweetCreatedAt: new Date('2026-06-07T12:34:56.000Z'),
      source: 'bookmark',
      entities: JSON.stringify({
        hashtags: ['AI'],
        urls: ['https://github.com/example/project'],
        mentions: ['sama'],
        tools: ['GitHub'],
        tweetType: 'thread',
      }),
      categories: [{ category: { name: 'AI/ML', slug: 'ai-ml', color: '#22c55e' } }],
    } satisfies ObsidianSavedTweet

    const result = await exportSavedTweetsToObsidian({ outputDir, bookmarks: [tweet] })

    const filename = noteFilename(tweet)
    const note = await readFile(path.join(outputDir, filename), 'utf8')
    expect(result.written).toBe(1)
    expect(result.errors).toEqual([])
    expect(filename).toBe('2026-06-07 - @karpathy - 1234567890.md')
    expect(note).toContain('tweetId: "1234567890"')
    expect(note).toContain('author: "karpathy"')
    expect(note).toContain('url: "https://x.com/karpathy/status/1234567890"')
    expect(note).toContain('source: "bookmark"')
    expect(note).toContain('weight: 1')
    expect(note).toContain('segment: "brief-relevant"')
    expect(note).toContain('created_at: "2026-06-07T12:34:56.000Z"')
    expect(note).toContain('tags: ["agent workflows", "llm evals", "AI/ML", "AI", "GitHub"]')
    expect(note).toContain('Author: [[_index/Authors#karpathy|@karpathy]]')
    expect(note).toContain('Category: [[_index/Categories#ai-ml|AI/ML]]')
    expect(note).toContain('Segment: [[_index/Segments#brief-relevant|brief-relevant]]')
    expect(note).toContain('Tool: [[_index/Tools#github|GitHub]]')

    const moc = await readFile(path.join(outputDir, '_index', 'MOC.md'), 'utf8')
    const authors = await readFile(path.join(outputDir, '_index', 'Authors.md'), 'utf8')
    const categories = await readFile(path.join(outputDir, '_index', 'Categories.md'), 'utf8')
    const tools = await readFile(path.join(outputDir, '_index', 'Tools.md'), 'utf8')
    const segments = await readFile(path.join(outputDir, '_index', 'Segments.md'), 'utf8')
    await stat(path.join(outputDir, 'README.md'))
    expect(moc).toContain('[[Authors]]')
    expect(moc).toContain('[[Categories]]')
    expect(moc).toContain('[[Tools]]')
    expect(moc).toContain('[[Segments]]')
    expect(authors).toContain(`[[${filename.replace(/\.md$/, '')}]]`)
    expect(categories).toContain('## ai-ml')
    expect(tools).toContain('## github')
    expect(segments).toContain('## brief-relevant')
  })

  it('exports meme OCR captions on media notes when image analysis is present', async () => {
    const outputDir = await makeOutputDir()
    const meme = {
      ...baseTweet,
      id: 'row-2',
      tweetId: '9876543210',
      text: 'this one got me',
      authorHandle: 'memeacct',
      authorName: 'Meme Account',
      tweetCreatedAt: new Date('2026-05-01T00:00:00.000Z'),
      source: 'like',
      semanticTags: JSON.stringify(['reaction meme']),
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [{ category: { name: 'Memes', slug: 'memes', color: '#f97316' } }],
      mediaItems: [
        {
          id: 'media-1',
          type: 'photo',
          url: 'https://example.com/meme.jpg',
          thumbnailUrl: null,
          localPath: null,
          imageTags: JSON.stringify({
            style: 'meme',
            meme_template: 'Drakeposting',
            text_ocr: ['OLD WAY', 'NEW WAY'],
            tags: ['drake meme'],
          }),
        },
      ],
    } satisfies ObsidianSavedTweet

    await exportSavedTweetsToObsidian({ outputDir, bookmarks: [meme] })

    const note = await readFile(path.join(outputDir, noteFilename(meme)), 'utf8')
    expect(note).toContain('source: "like"')
    expect(note).toContain('weight: 0.3')
    expect(note).toContain('segment: "everything-else"')
    expect(note).toContain('![photo](https://example.com/meme.jpg)')
    expect(note).toContain('OCR caption: Drakeposting — OLD WAY | NEW WAY')
  })

  it('refreshes changed note content without rewriting unchanged notes when overwrite is false', async () => {
    const outputDir = await makeOutputDir()
    const original = {
      ...baseTweet,
      id: 'row-refresh',
      tweetId: '1111111111',
      text: 'fresh eval writeup',
      authorHandle: 'evalsacct',
      authorName: 'Eval Account',
      tweetCreatedAt: new Date('2026-06-07T00:00:00.000Z'),
      source: 'bookmark',
      semanticTags: JSON.stringify(['evals']),
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [],
    } satisfies ObsidianSavedTweet
    const unchanged = {
      ...baseTweet,
      id: 'row-unchanged',
      tweetId: '2222222222',
      text: 'already current note',
      authorHandle: 'stableacct',
      authorName: 'Stable Account',
      tweetCreatedAt: new Date('2026-06-06T00:00:00.000Z'),
      source: 'like',
      semanticTags: JSON.stringify(['stable']),
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [],
    } satisfies ObsidianSavedTweet

    await exportSavedTweetsToObsidian({ outputDir, bookmarks: [original, unchanged] })
    const originalPath = path.join(outputDir, noteFilename(original))
    const unchangedPath = path.join(outputDir, noteFilename(unchanged))
    const unchangedMtime = new Date('2024-01-02T03:04:05.000Z')
    await utimes(unchangedPath, unchangedMtime, unchangedMtime)

    const reEnriched = {
      ...original,
      semanticTags: JSON.stringify(['evals', 'fresh enrichment']),
      categories: [{ category: { name: 'AI/ML', slug: 'ai-ml', color: '#22c55e' } }],
    } satisfies ObsidianSavedTweet

    const rerun = await exportSavedTweetsToObsidian({ outputDir, bookmarks: [reEnriched, unchanged] })

    const refreshedNote = await readFile(originalPath, 'utf8')
    const unchangedStats = await stat(unchangedPath)
    expect(rerun.written).toBe(1)
    expect(rerun.skipped).toBe(1)
    expect(rerun.errors).toEqual([])
    expect(refreshedNote).toContain('fresh enrichment')
    expect(refreshedNote).toContain('Category: [[_index/Categories#ai-ml|AI/ML]]')
    expect(unchangedStats.mtime.getTime()).toBe(unchangedMtime.getTime())
  })

  it('hardens note filenames by trimming dot wrappers and falling back to bookmark id', () => {
    const tweet = {
      ...baseTweet,
      id: 'row-fallback',
      tweetId: '../..',
      text: 'path-ish tweet id should not become the filename stem',
      authorHandle: '...dotty...',
      authorName: 'Dotty Account',
      tweetCreatedAt: new Date('2026-06-07T00:00:00.000Z'),
      source: 'bookmark',
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [],
    } satisfies ObsidianSavedTweet

    expect(noteFilename(tweet)).toBe('2026-06-07 - @dotty - row-fallback.md')
  })

  it('disambiguates fallback filenames when tweet id and bookmark id sanitize empty', async () => {
    const first = {
      ...baseTweet,
      id: '::::',
      tweetId: '../..',
      text: 'first invalid id bookmark',
      authorHandle: '???',
      authorName: 'Invalid Account',
      tweetCreatedAt: new Date('2026-06-07T00:00:00.000Z'),
      source: 'bookmark',
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [],
    } satisfies ObsidianSavedTweet
    const second = {
      ...first,
      id: '****',
      text: 'second invalid id bookmark',
    } satisfies ObsidianSavedTweet

    const filenames = [noteFilename(first), noteFilename(second)]
    expect(new Set(filenames).size).toBe(2)

    const outputDir = await makeOutputDir()
    const result = await exportSavedTweetsToObsidian({ outputDir, bookmarks: [first, second] })

    expect(result.written).toBe(2)
    expect(result.errors).toEqual([])
    expect(await readFile(path.join(outputDir, filenames[0]), 'utf8')).toContain('first invalid id bookmark')
    expect(await readFile(path.join(outputDir, filenames[1]), 'utf8')).toContain('second invalid id bookmark')
  })

  it('does not rewrite unchanged index files and counts only actual index writes', async () => {
    const outputDir = await makeOutputDir()
    const tweet = {
      ...baseTweet,
      id: 'row-index-idempotent',
      tweetId: '3333333333',
      text: 'unchanged index content',
      authorHandle: 'stableindex',
      authorName: 'Stable Index',
      tweetCreatedAt: new Date('2026-06-07T00:00:00.000Z'),
      source: 'bookmark',
      semanticTags: JSON.stringify(['stable']),
      entities: JSON.stringify({ hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'original' }),
      categories: [],
    } satisfies ObsidianSavedTweet

    const initial = await exportSavedTweetsToObsidian({ outputDir, bookmarks: [tweet] })
    expect(initial.indexesWritten).toBe(6)

    const indexPaths = [
      path.join(outputDir, 'README.md'),
      path.join(outputDir, '_index', 'MOC.md'),
      path.join(outputDir, '_index', 'Authors.md'),
      path.join(outputDir, '_index', 'Categories.md'),
      path.join(outputDir, '_index', 'Tools.md'),
      path.join(outputDir, '_index', 'Segments.md'),
    ]
    const unchangedMtime = new Date('2024-02-03T04:05:06.000Z')
    await Promise.all(indexPaths.map((filePath) => utimes(filePath, unchangedMtime, unchangedMtime)))

    const rerun = await exportSavedTweetsToObsidian({ outputDir, bookmarks: [tweet] })
    const stats = await Promise.all(indexPaths.map((filePath) => stat(filePath)))

    expect(rerun.indexesWritten).toBe(0)
    expect(stats.map((fileStat) => fileStat.mtime.getTime())).toEqual(indexPaths.map(() => unchangedMtime.getTime()))
  })
})
