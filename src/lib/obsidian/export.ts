import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_OBSIDIAN_EXPORT_DIR = '/Users/alexgierczyk/Obsidian/Ace Place/Content/X Bookmarks/'

export type SavedTweetSource = 'bookmark' | 'like'
export type ObsidianSegment = 'brief-relevant' | 'everything-else'

export interface ObsidianMediaItem {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
  imageTags: string | null
}

export interface ObsidianCategoryJoin {
  category: {
    name: string
    slug: string
    color: string
  }
}

export interface ObsidianSavedTweet {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | string | null
  importedAt: Date | string
  rawJson: string
  semanticTags: string | null
  entities: string | null
  enrichmentMeta: string | null
  source: SavedTweetSource
  mediaItems: ObsidianMediaItem[]
  categories: ObsidianCategoryJoin[]
}

export interface ObsidianExportResult {
  written: number
  skipped: number
  errors: Array<{ tweetId: string; error: string }>
  indexesWritten: number
}

export interface ObsidianExportOptions {
  outputDir: string
  bookmarks: ObsidianSavedTweet[]
  overwrite?: boolean
}

type JsonRecord = Record<string, unknown>

const BRIEF_RELEVANT_CATEGORY_SLUGS = new Set([
  'ai-ml',
  'ai',
  'ml',
  'dev-tools',
  'developer-tools',
  'crypto-web3',
  'crypto',
  'web3',
  'startups-business',
  'startups',
  'business',
  'security',
  'productivity',
  'finance',
])

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isoDate(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null
}

function dateOnly(value: Date | string | null | undefined): string | null {
  return isoDate(value)?.slice(0, 10) ?? null
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseJsonRecord(raw: string | null | undefined): JsonRecord {
  const parsed = parseJson(raw)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {}
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return []
  return unique(parsed.map(String))
}

function recordStringArray(record: JsonRecord, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return unique(value.map(String))
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function sanitizeFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\n\r]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
}

export function noteFilename(bookmark: ObsidianSavedTweet): string {
  const date = dateOnly(bookmark.tweetCreatedAt) ?? 'unknown-date'
  const author = sanitizeFilename(bookmark.authorHandle || 'unknown') || 'unknown'
  const tweetId = sanitizeFilename(bookmark.tweetId) || sanitizeFilename(bookmark.id) || 'unknown-id'
  return `${date} - @${author} - ${tweetId}.md`
}

function tweetUrl(bookmark: ObsidianSavedTweet): string {
  const handle = bookmark.authorHandle || 'unknown'
  return `https://x.com/${handle}/status/${bookmark.tweetId}`
}

function sourceWeight(source: SavedTweetSource): number {
  return source === 'bookmark' ? 1 : 0.3
}

function categoryNames(bookmark: ObsidianSavedTweet): string[] {
  return unique(bookmark.categories.map((join) => join.category.name))
}

function categorySlugs(bookmark: ObsidianSavedTweet): string[] {
  return unique(bookmark.categories.map((join) => join.category.slug || slug(join.category.name)))
}

function mediaTypes(bookmark: ObsidianSavedTweet): string[] {
  return unique(bookmark.mediaItems.map((item) => item.type))
}

function entityTools(entities: JsonRecord): string[] {
  const explicit = recordStringArray(entities, 'tools')
  const urls = recordStringArray(entities, 'urls')
  const inferred = urls.flatMap((url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      if (host === 'github.com' || host.endsWith('.github.com')) return ['GitHub']
      if (host === 'arxiv.org') return ['arxiv']
      if (host === 'huggingface.co') return ['HuggingFace']
      return []
    } catch {
      return []
    }
  })
  return unique([...explicit, ...inferred])
}

function formatFlags(bookmark: ObsidianSavedTweet, entities: JsonRecord, tools: string[]): string[] {
  const flags: string[] = []
  const text = bookmark.text.toLowerCase()
  if (String(entities.tweetType ?? '') === 'thread') flags.push('is_thread')
  if (/```|\b(function|const|class|import|export|npm install|pnpm|uv pip)\b/.test(text) || tools.includes('GitHub')) {
    flags.push('has_code')
  }
  if (/\b(launch|launched|launching|released|shipping|ship(ped)?|introducing)\b/.test(text)) flags.push('is_launch')
  if (/\b(benchmark|benchmarks|eval|evals|leaderboard|scorecard)\b/.test(text)) flags.push('is_benchmark')
  return unique(flags)
}

function segment(bookmark: ObsidianSavedTweet, flags: string[]): ObsidianSegment {
  const slugs = categorySlugs(bookmark)
  const names = categoryNames(bookmark).map(slug)
  const hasBriefCategory = [...slugs, ...names].some((value) => BRIEF_RELEVANT_CATEGORY_SLUGS.has(value))
  const hasBriefFlag = flags.some((flag) => flag === 'is_launch' || flag === 'is_benchmark' || flag === 'has_code')
  return hasBriefCategory || hasBriefFlag ? 'brief-relevant' : 'everything-else'
}

function tagsFor(bookmark: ObsidianSavedTweet, entities: JsonRecord, tools: string[]): string[] {
  return unique([
    ...parseJsonStringArray(bookmark.semanticTags),
    ...categoryNames(bookmark),
    ...recordStringArray(entities, 'hashtags'),
    ...tools,
  ])
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function yamlArray(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`
}

function yamlJson(value: unknown): string {
  return JSON.stringify(value)
}

function frontmatter(bookmark: ObsidianSavedTweet): string {
  const entities = parseJsonRecord(bookmark.entities)
  const tools = entityTools(entities)
  const flags = formatFlags(bookmark, entities, tools)
  const tagValues = tagsFor(bookmark, entities, tools)
  const tweetCreatedAt = isoDate(bookmark.tweetCreatedAt)
  const savedAt = isoDate(bookmark.importedAt)
  const lines = [
    '---',
    'type: "x-bookmark"',
    `tweetId: ${yamlString(bookmark.tweetId)}`,
    `tweet_id: ${yamlString(bookmark.tweetId)}`,
    `url: ${yamlString(tweetUrl(bookmark))}`,
    `author: ${yamlString(bookmark.authorHandle || 'unknown')}`,
    `author_name: ${yamlString(bookmark.authorName || bookmark.authorHandle || 'Unknown')}`,
    tweetCreatedAt ? `created_at: ${yamlString(tweetCreatedAt)}` : null,
    tweetCreatedAt ? `tweet_created_at: ${yamlString(tweetCreatedAt.slice(0, 10))}` : null,
    savedAt ? `saved_at: ${yamlString(savedAt)}` : null,
    `source: ${yamlString(bookmark.source)}`,
    `weight: ${sourceWeight(bookmark.source)}`,
    `segment: ${yamlString(segment(bookmark, flags))}`,
    `tags: ${yamlArray(tagValues)}`,
    `categories: ${yamlArray(categoryNames(bookmark))}`,
    `semantic_tags: ${yamlArray(parseJsonStringArray(bookmark.semanticTags))}`,
    `entities: ${yamlJson(entities)}`,
    `format_flags: ${yamlArray(flags)}`,
    `media_types: ${yamlArray(mediaTypes(bookmark))}`,
    '---',
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function mediaOcrCaption(item: ObsidianMediaItem): string | null {
  const parsed = parseJsonRecord(item.imageTags)
  const ocr = recordStringArray(parsed, 'text_ocr')
  if (ocr.length === 0) return null
  const template = typeof parsed.meme_template === 'string' && parsed.meme_template.trim()
    ? parsed.meme_template.trim()
    : null
  return template ? `${template} — ${ocr.join(' | ')}` : ocr.join(' | ')
}

function backlinks(bookmark: ObsidianSavedTweet): string[] {
  const entities = parseJsonRecord(bookmark.entities)
  const tools = entityTools(entities)
  const flags = formatFlags(bookmark, entities, tools)
  const computedSegment = segment(bookmark, flags)
  const links = [`- Author: [[_index/Authors#${slug(bookmark.authorHandle || 'unknown')}|@${bookmark.authorHandle || 'unknown'}]]`]

  for (const join of bookmark.categories) {
    const categorySlug = join.category.slug || slug(join.category.name)
    links.push(`- Category: [[_index/Categories#${categorySlug}|${join.category.name}]]`)
  }

  links.push(`- Segment: [[_index/Segments#${computedSegment}|${computedSegment}]]`)

  for (const tool of tools) {
    links.push(`- Tool: [[_index/Tools#${slug(tool)}|${tool}]]`)
  }

  return links
}

export function buildBookmarkNote(bookmark: ObsidianSavedTweet): string {
  const entities = parseJsonRecord(bookmark.entities)
  const tools = entityTools(entities)
  const lines = [
    frontmatter(bookmark),
    '',
    `# @${bookmark.authorHandle || 'unknown'} — ${bookmark.tweetId}`,
    '',
    bookmark.text.trim(),
  ]

  if (bookmark.mediaItems.length > 0) {
    lines.push('', '## Media', '')
    for (const item of bookmark.mediaItems) {
      const target = item.localPath || item.url
      if (item.type === 'photo' || item.type === 'gif') {
        lines.push(`![${item.type}](${target})`)
      } else {
        lines.push(`[${item.type}](${target})`)
      }
      const caption = mediaOcrCaption(item)
      if (caption) lines.push(`OCR caption: ${caption}`)
      lines.push('')
    }
  }

  lines.push('', '## Extracted signals', '')
  lines.push(`- Categories: ${categoryNames(bookmark).join(', ') || 'none'}`)
  lines.push(`- Tags: ${tagsFor(bookmark, entities, tools).join(', ') || 'none'}`)
  lines.push(`- Tools: ${tools.join(', ') || 'none'}`)
  lines.push(`- Media types: ${mediaTypes(bookmark).join(', ') || 'none'}`)

  lines.push('', '## Backlinks', '', ...backlinks(bookmark))
  lines.push('', '## Source', '', `[View on X](${tweetUrl(bookmark)})`)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

function noteStem(bookmark: ObsidianSavedTweet): string {
  return noteFilename(bookmark).replace(/\.md$/, '')
}

function groupBy<T>(items: T[], keyFn: (item: T) => string[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    for (const key of keyFn(item)) {
      if (!key) continue
      const existing = grouped.get(key) ?? []
      existing.push(item)
      grouped.set(key, existing)
    }
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function bookmarkLinks(bookmarks: ObsidianSavedTweet[]): string {
  return bookmarks
    .map((bookmark) => `- [[${noteStem(bookmark)}]] — @${bookmark.authorHandle || 'unknown'} — ${bookmark.text.slice(0, 100).replace(/\s+/g, ' ')}`)
    .join('\n')
}

function buildMoc(bookmarks: ObsidianSavedTweet[]): string {
  return [
    '---',
    'type: "x-bookmarks-moc"',
    `count: ${bookmarks.length}`,
    '---',
    '',
    '# X Bookmarks MOC',
    '',
    '- [[Authors]]',
    '- [[Categories]]',
    '- [[Tools]]',
    '- [[Segments]]',
    '',
    '## Recent notes',
    '',
    bookmarkLinks(bookmarks.slice(0, 50)),
    '',
  ].join('\n')
}

function buildReadme(bookmarks: ObsidianSavedTweet[]): string {
  return [
    '---',
    'type: "x-bookmarks-index"',
    `count: ${bookmarks.length}`,
    '---',
    '',
    '# Ace X Bookmarks',
    '',
    'Generated from Siftly saved X bookmarks/likes.',
    '',
    '- [[_index/MOC|Map of Content]]',
    '- [[_index/Authors|Authors]]',
    '- [[_index/Categories|Categories]]',
    '- [[_index/Tools|Tools]]',
    '- [[_index/Segments|Segments]]',
    '',
  ].join('\n')
}

function buildAuthorsIndex(bookmarks: ObsidianSavedTweet[]): string {
  const byAuthor = groupBy(bookmarks, (bookmark) => [slug(bookmark.authorHandle || 'unknown')])
  const sections = [...byAuthor.entries()].flatMap(([authorSlug, rows]) => [
    `## ${authorSlug}`,
    '',
    `@${rows[0].authorHandle || 'unknown'} (${rows.length})`,
    '',
    bookmarkLinks(rows),
    '',
  ])
  return ['# Authors', '', ...sections].join('\n')
}

function buildCategoriesIndex(bookmarks: ObsidianSavedTweet[]): string {
  const byCategory = groupBy(bookmarks, (bookmark) => categorySlugs(bookmark))
  const categoryNamesBySlug = new Map<string, string>()
  for (const bookmark of bookmarks) {
    for (const join of bookmark.categories) {
      categoryNamesBySlug.set(join.category.slug || slug(join.category.name), join.category.name)
    }
  }
  const sections = [...byCategory.entries()].flatMap(([categorySlug, rows]) => [
    `## ${categorySlug}`,
    '',
    `${categoryNamesBySlug.get(categorySlug) ?? categorySlug} (${rows.length})`,
    '',
    bookmarkLinks(rows),
    '',
  ])
  return ['# Categories', '', ...sections].join('\n')
}

function buildToolsIndex(bookmarks: ObsidianSavedTweet[]): string {
  const byTool = groupBy(bookmarks, (bookmark) => entityTools(parseJsonRecord(bookmark.entities)).map(slug))
  const toolNamesBySlug = new Map<string, string>()
  for (const bookmark of bookmarks) {
    for (const tool of entityTools(parseJsonRecord(bookmark.entities))) {
      toolNamesBySlug.set(slug(tool), tool)
    }
  }
  const sections = [...byTool.entries()].flatMap(([toolSlug, rows]) => [
    `## ${toolSlug}`,
    '',
    `${toolNamesBySlug.get(toolSlug) ?? toolSlug} (${rows.length})`,
    '',
    bookmarkLinks(rows),
    '',
  ])
  return ['# Tools', '', ...sections].join('\n')
}

function buildSegmentsIndex(bookmarks: ObsidianSavedTweet[]): string {
  const bySegment = groupBy(bookmarks, (bookmark) => {
    const entities = parseJsonRecord(bookmark.entities)
    const tools = entityTools(entities)
    return [segment(bookmark, formatFlags(bookmark, entities, tools))]
  })
  const sections = [...bySegment.entries()].flatMap(([segmentName, rows]) => [
    `## ${segmentName}`,
    '',
    `${rows.length} notes`,
    '',
    bookmarkLinks(rows),
    '',
  ])
  return ['# Segments', '', ...sections].join('\n')
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to write outside export root: ${resolvedTarget}`)
  }
}

async function writeExportFile(outputDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.resolve(outputDir, relativePath)
  assertInside(outputDir, filePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function contentMatches(filePath: string, content: string): Promise<boolean> {
  if (!await exists(filePath)) return false
  const current = await fs.readFile(filePath, 'utf8')
  return contentFingerprint(current) === contentFingerprint(content)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function exportSavedTweetsToObsidian(options: ObsidianExportOptions): Promise<ObsidianExportResult> {
  const outputDir = path.resolve(options.outputDir)
  const overwrite = options.overwrite ?? false
  const bookmarks = [...options.bookmarks].sort((a, b) => {
    const aDate = toDate(a.tweetCreatedAt)?.getTime() ?? 0
    const bDate = toDate(b.tweetCreatedAt)?.getTime() ?? 0
    return bDate - aDate
  })
  const result: ObsidianExportResult = { written: 0, skipped: 0, errors: [], indexesWritten: 0 }

  await fs.mkdir(path.join(outputDir, '_index'), { recursive: true })

  for (const bookmark of bookmarks) {
    const filename = noteFilename(bookmark)
    const filePath = path.resolve(outputDir, filename)
    assertInside(outputDir, filePath)

    try {
      const content = buildBookmarkNote(bookmark)
      if (!overwrite && await contentMatches(filePath, content)) {
        result.skipped++
        continue
      }

      await writeExportFile(outputDir, filename, content)
      result.written++
    } catch (error) {
      result.errors.push({ tweetId: bookmark.tweetId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const indexes = [
    ['README.md', buildReadme(bookmarks)],
    [path.join('_index', 'MOC.md'), buildMoc(bookmarks)],
    [path.join('_index', 'Authors.md'), buildAuthorsIndex(bookmarks)],
    [path.join('_index', 'Categories.md'), buildCategoriesIndex(bookmarks)],
    [path.join('_index', 'Tools.md'), buildToolsIndex(bookmarks)],
    [path.join('_index', 'Segments.md'), buildSegmentsIndex(bookmarks)],
  ] as const

  for (const [relativePath, content] of indexes) {
    await writeExportFile(outputDir, relativePath, content)
    result.indexesWritten++
  }

  return result
}
