import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  buildPreferenceProfile,
  loadProfileRowsFromDatabase,
  writePreferenceArtifacts,
  type PreferenceProfileRow,
} from '../profile'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function row(overrides: Partial<PreferenceProfileRow> = {}): PreferenceProfileRow {
  return {
    id: overrides.id ?? `row-${overrides.tweetId ?? '1'}`,
    tweetId: overrides.tweetId ?? '1',
    text: overrides.text ?? 'fixture text',
    authorHandle: overrides.authorHandle ?? 'organic_author',
    authorName: overrides.authorName ?? overrides.authorHandle ?? 'Organic Author',
    source: overrides.source ?? 'bookmark',
    tweetCreatedAt: overrides.tweetCreatedAt ?? '2026-06-01T00:00:00.000Z',
    semanticTags: overrides.semanticTags ?? ['agent-workflows'],
    categoryNames: overrides.categoryNames ?? ['AI & Machine Learning'],
    categorySlugs: overrides.categorySlugs ?? ['ai-ml'],
    entities: overrides.entities ?? {
      hashtags: [],
      urls: [],
      mentions: [],
      tools: ['Hermes'],
      tweetType: 'thread',
      contextAnnotations: [
        { domain: { name: 'Unified Twitter Taxonomy' }, entity: { name: 'Artificial intelligence' } },
      ],
    },
    enrichmentMeta: overrides.enrichmentMeta ?? {
      segment: 'brief-relevant',
      topicTags: ['agent-workflows'],
      categories: ['ai-resources'],
      formatFlags: {
        format: 'thread',
        is_thread: true,
        has_code: true,
        is_launch: false,
        is_benchmark: false,
        has_image: false,
        has_video: false,
      },
    },
    embedding: overrides.embedding ?? [1, 0, 0, 0],
  }
}

describe('preference profile', () => {
  it('computes topic, source, format, negative, and disabled-novelty signals', () => {
    const profile = buildPreferenceProfile([
      row({ tweetId: 'bookmark-author', authorHandle: 'same_weighted_author', source: 'bookmark', embedding: [1, 0, 0, 0] }),
      row({ tweetId: 'like-author', authorHandle: 'like_weighted_author', source: 'like', embedding: [0.9, 0.1, 0, 0] }),
      row({
        tweetId: 'contrast',
        authorHandle: 'contrast_author',
        source: 'bookmark',
        semanticTags: ['contrast:low-context-meme'],
        categoryNames: [],
        categorySlugs: [],
        entities: { hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'single', contextAnnotations: [] },
        enrichmentMeta: {
          segment: 'everything-else',
          topicTags: ['negative:low-context-meme'],
          categories: [],
          formatFlags: { format: 'single', is_single: true, has_code: false },
        },
        embedding: [0, 1, 0, 0],
      }),
    ], { now: '2026-06-08T12:00:00.000Z' })

    expect(profile.corpus_size).toEqual({ bookmarks: 2, likes: 1 })
    expect(profile.updated_at).toBe('2026-06-08T12:00:00.000Z')
    expect(profile.top_topics.map((topic) => topic.name)).toEqual(expect.arrayContaining([
      'agent-workflows',
      // 'Artificial intelligence' context-annotation canonicalizes into the ai-ml family
      'ai-ml',
    ]))
    // embedding-cluster: labels are folded into their base topic, never kept as a parallel bucket
    expect(profile.top_topics.some((topic) => topic.name.startsWith('embedding-cluster:'))).toBe(false)
    expect(profile.favorite_formats).toEqual(expect.arrayContaining(['is_thread', 'has_code', 'format:thread']))
    expect(profile.downrank_patterns).toContain('low-context-meme')
    expect(profile.novelty_profile).toEqual({ evergreen_ratio: 0 })
    expect(profile.scoring_guidance).toMatch(/novelty calibration disabled/i)
    expect(profile.scoring_guidance).toMatch(/no why saved inference/i)
  })

  it('preserves the bookmark 1.0 vs like 0.3 source-weight ratio', () => {
    const profile = buildPreferenceProfile([
      row({ tweetId: 'bookmark-only', authorHandle: 'bookmark_only', source: 'bookmark' }),
      row({ tweetId: 'like-only', authorHandle: 'like_only', source: 'like' }),
    ], { now: '2026-06-08T12:00:00.000Z' })

    const bookmarkAuthor = profile.high_signal_authors.find((author) => author.handle === 'bookmark_only')
    const likeAuthor = profile.high_signal_authors.find((author) => author.handle === 'like_only')

    expect(bookmarkAuthor?.weight).toBe(1)
    expect(likeAuthor?.weight).toBe(0.3)
    expect((bookmarkAuthor?.weight ?? 0) / (likeAuthor?.weight ?? 1)).toBeCloseTo(1 / 0.3, 8)
  })

  it('excludes origin:brief-surfaced rows from topic and source affinity reinforcement', () => {
    const profile = buildPreferenceProfile([
      row({ tweetId: 'organic', authorHandle: 'organic_author', semanticTags: ['organic-ai'], embedding: [1, 0, 0, 0] }),
      row({
        tweetId: 'brief-surfaced',
        authorHandle: 'brief_author',
        semanticTags: ['origin:brief-surfaced', 'self-reinforcing-topic'],
        categoryNames: ['Self Reinforcing'],
        categorySlugs: ['self-reinforcing'],
        entities: { hashtags: ['SelfReinforcing'], urls: [], mentions: [], tools: [], tweetType: 'single', contextAnnotations: [] },
        enrichmentMeta: {
          segment: 'brief-relevant',
          topicTags: ['self-reinforcing-topic'],
          categories: ['self-reinforcing'],
          formatFlags: { format: 'single', is_single: true },
        },
        embedding: [0, 1, 0, 0],
      }),
    ], { now: '2026-06-08T12:00:00.000Z' })

    expect(profile.corpus_size).toEqual({ bookmarks: 2, likes: 0 })
    expect(profile.high_signal_authors.map((author) => author.handle)).not.toContain('brief_author')
    expect(profile.top_topics.map((topic) => topic.name)).not.toEqual(expect.arrayContaining([
      'self-reinforcing-topic',
      'self-reinforcing',
    ]))
  })

  it('emits the exact PRD v5 section 5.7 top-level JSON schema', () => {
    const profile = buildPreferenceProfile([row()], { now: '2026-06-08T12:00:00.000Z' })

    expect(Object.keys(profile)).toEqual([
      'updated_at',
      'corpus_size',
      'signal_basis',
      'top_topics',
      'high_signal_authors',
      'favorite_formats',
      'downrank_patterns',
      'novelty_profile',
      'scoring_guidance',
    ])
    expect(Object.keys(profile.corpus_size)).toEqual(['bookmarks', 'likes'])
    expect(profile.signal_basis).toEqual({ mode: 'whole-corpus', signal_rows: 1 })
    expect(Object.keys(profile.top_topics[0])).toEqual(['name', 'weight', 'segment'])
    expect(Object.keys(profile.high_signal_authors[0])).toEqual(['handle', 'saves', 'weight'])
    expect(Object.keys(profile.novelty_profile)).toEqual(['evergreen_ratio'])
  })

  it('briefRelevantOnly excludes everything-else rows from signal but keeps true corpus_size (pf de-contamination)', () => {
    const rows = [
      row({ tweetId: 'ai-1', authorHandle: 'ai_author', source: 'bookmark' }),
      // a politics row: counts in corpus, must NOT contribute to topics/authors
      row({
        tweetId: 'pol-1',
        authorHandle: 'politics_author',
        source: 'bookmark',
        semanticTags: ['politics'],
        categoryNames: ['Politics'],
        categorySlugs: ['politics'],
        entities: { hashtags: [], urls: [], mentions: [], tools: [], tweetType: 'single', contextAnnotations: [] },
        enrichmentMeta: {
          segment: 'everything-else',
          topicTags: ['politics'],
          categories: ['politics'],
          formatFlags: { format: 'single', is_single: true, has_code: false },
        },
        embedding: [0, 1, 0, 0],
      }),
    ]

    const whole = buildPreferenceProfile(rows, { now: '2026-06-08T12:00:00.000Z' })
    const briefOnly = buildPreferenceProfile(rows, { now: '2026-06-08T12:00:00.000Z', briefRelevantOnly: true })

    // corpus_size identical (true corpus preserved in both)
    expect(briefOnly.corpus_size).toEqual({ bookmarks: 2, likes: 0 })
    expect(whole.corpus_size).toEqual(briefOnly.corpus_size)

    // signal_basis provenance is stamped
    expect(whole.signal_basis).toEqual({ mode: 'whole-corpus', signal_rows: 2 })
    expect(briefOnly.signal_basis).toEqual({ mode: 'brief-relevant-only', signal_rows: 1 })

    // whole-corpus picks up the politics author; brief-only must not
    expect(whole.high_signal_authors.map((a) => a.handle)).toContain('politics_author')
    expect(briefOnly.high_signal_authors.map((a) => a.handle)).not.toContain('politics_author')
    expect(briefOnly.high_signal_authors.map((a) => a.handle)).toContain('ai_author')
  })

  it('writes both machine-readable JSON and human-readable Obsidian artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'siftly-profile-artifacts-'))
    const jsonPath = path.join(root, 'state', 'preference-profile.json')
    const obsidianDir = path.join(root, 'Content', 'X Bookmarks')
    const profile = buildPreferenceProfile([row()], { now: '2026-06-08T12:00:00.000Z' })

    try {
      const result = await writePreferenceArtifacts(profile, { jsonPath, obsidianDir })
      const json = JSON.parse(await readFile(result.jsonPath, 'utf8'))
      const markdown = await readFile(result.markdownPath, 'utf8')

      expect(json.updated_at).toBe('2026-06-08T12:00:00.000Z')
      expect(result.markdownPath).toBe(path.join(obsidianDir, 'Ace Bookmark Preference Profile.md'))
      expect(markdown).toContain('# Ace Bookmark Preference Profile')
      expect(markdown).toContain('No why-saved inference')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads the real prisma/dev.db corpus and writes both artifacts without mutating the DB', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'siftly-profile-realdb-'))
    const jsonPath = path.join(root, 'state', 'preference-profile.json')
    const obsidianDir = path.join(root, 'Content', 'X Bookmarks')
    const dbPath = path.join(repoRoot, 'prisma', 'dev.db')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const before = await stat(dbPath)
      const rows = loadProfileRowsFromDatabase(dbPath)
      const profile = buildPreferenceProfile(rows, { now: '2026-06-08T12:00:00.000Z' })
      const result = await writePreferenceArtifacts(profile, { jsonPath, obsidianDir })
      const after = await stat(dbPath)

      // Corpus grows with daily ingest, so assert structural invariants rather
      // than brittle exact counts: non-trivial corpus, and bookmarks+likes == rows.
      expect(rows.length).toBeGreaterThan(3000)
      expect(profile.corpus_size.bookmarks).toBeGreaterThan(0)
      expect(profile.corpus_size.likes).toBeGreaterThan(0)
      expect(profile.corpus_size.bookmarks + profile.corpus_size.likes).toBe(rows.length)
      await expect(readFile(result.jsonPath, 'utf8')).resolves.toContain('"corpus_size"')
      await expect(readFile(result.markdownPath, 'utf8')).resolves.toContain('Ace Bookmark Preference Profile')
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/novelty calibration disabled/i))
    } finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
