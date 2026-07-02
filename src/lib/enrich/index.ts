import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type Segment = 'brief-relevant' | 'everything-else'
export type TweetFormat = 'thread' | 'single' | 'quote' | 'reply'
export type QueueStatus = 'pending' | 'leasing' | 'done' | 'error'
export const DEFAULT_VIDEO_MAX_ATTEMPTS = 3

export interface EnrichMediaItemInput {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  imageTags?: string | null
}

export interface EnrichBookmarkInput {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  rawJson: string | null
  entities: string | null
  semanticTags: string | null
  enrichmentMeta: string | null
  mediaItems: EnrichMediaItemInput[]
  categories: Array<{ category?: { slug?: string | null } | null; slug?: string | null }>
}

export interface EnrichmentEntities {
  hashtags: string[]
  urls: string[]
  mentions: string[]
  tools: string[]
  tweetType: TweetFormat
  contextAnnotations: unknown[]
}

export interface FormatFlags {
  format: TweetFormat
  is_thread: boolean
  is_single: boolean
  is_quote: boolean
  is_reply: boolean
  has_code: boolean
  is_launch: boolean
  is_benchmark: boolean
  has_image: boolean
  has_video: boolean
  has_gif: boolean
  media_types: string[]
  link_domains: string[]
}

export interface FactualEnrichment {
  entities: EnrichmentEntities
  topicTags: string[]
  categorySlugs: string[]
  formatFlags: FormatFlags
  segment: Segment
}

export interface VisionCostEstimate {
  imageCount: number
  videoThumbnailCount: number
  totalItems: number
  estimatedUsd: number
  requiresConfirmation: boolean
  summary: string
}

export interface EnrichDb {
  bookmark: {
    findMany?: (args: Record<string, unknown>) => Promise<EnrichBookmarkInput[]>
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
  }
  $transaction?: (ops: Promise<unknown>[]) => Promise<unknown[]>
  category?: {
    findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; slug: string }>>
  }
  bookmarkCategory?: {
    upsert: (args: Record<string, unknown>) => Promise<unknown>
    createMany?: (args: { data: Array<{ bookmarkId: string; categoryId: string; confidence: number }>; skipDuplicates?: boolean }) => Promise<unknown>
  }
}

export interface VideoEnrichDb {
  mediaItem: {
    findUnique: (args: { where: { id: string }; select: { imageTags: true } }) => Promise<{ imageTags: string | null } | null>
    update: (args: { where: { id: string }; data: { imageTags: string } }) => Promise<unknown>
  }
  $executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown>
}

export interface VideoQueueRecord {
  key: string
  status: QueueStatus
  bookmarkId: string
  tweetId: string
  mediaItemId: string
  sourceUrl: string
  attempts: number
  enqueuedAt: string
  updatedAt?: string
  transcriptChars?: number
  error?: string
  owner?: string
  leasedAt?: string
}

interface RawTweetShape {
  tweet?: Record<string, unknown>
  includes?: { media?: Array<Record<string, unknown>> }
  contextAnnotations?: unknown[]
}

const TOPIC_RULES: Array<{ tag: string; category: string; pattern: RegExp }> = [
  { tag: 'ai-ml', category: 'ai-resources', pattern: /\b(ai|llm|gpt|claude|openai|anthropic|gemini|mistral|llama|agent|rag|embedding|machine learning|neural|model|evals?)\b/i },
  { tag: 'developer-tools', category: 'dev-tools', pattern: /github|\bapi\b|typescript|javascript|python|fastapi|react|next\.js|node\.js|docker|kubernetes|terminal|cli|repo|code|developer|framework|library|sdk/i },
  { tag: 'crypto-web3', category: 'finance-crypto', pattern: /\b(crypto|bitcoin|btc|eth|ethereum|solana|defi|nft|web3|wallet|blockchain|token|airdrop|memecoin)\b/i },
  { tag: 'startups-business', category: 'startups-business', pattern: /startup|founder|fundrais|revenue|saas|yc\b|business|company|launch|customer/i },
  { tag: 'security', category: 'security-privacy', pattern: /security|privacy|exploit|vulnerability|malware|phishing|encryption|auth|opsec|breach/i },
  { tag: 'productivity', category: 'productivity', pattern: /productivity|workflow|automation|habit|focus|obsidian|notion|pkm|second brain|calendar/i },
  { tag: 'finance', category: 'finance-investing', pattern: /stocks?|options|market|macro|invest|portfolio|inflation|federal reserve|rates?|earnings|trading/i },
  { tag: 'design-product', category: 'design', pattern: /design|figma|ui\b|ux\b|typography|prototype|product|wireframe/i },
  { tag: 'health', category: 'health-wellness', pattern: /health|fitness|sleep|longevity|nutrition|workout|biohack|supplement/i },
  { tag: 'meme-humor', category: 'funny-memes', pattern: /meme|funny|lol|joke|humor|shitpost|satire|hilarious|comed/i },
  { tag: 'news', category: 'news', pattern: /breaking|news|report|election|regulation|policy|lawsuit|geopolitic/i },
]

// X's own context_annotations (Unified Twitter Taxonomy, Business Taxonomy,
// Interests & Hobbies, Brand, Person, etc.) are a free, high-coverage signal
// already present in the tweet payload. Map their entity names onto our tag
// vocabulary so items the keyword tagger misses still get classified.
// Substring match is case-insensitive against the annotation entity name.
const CONTEXT_ANNOTATION_RULES: Array<{ tag: string; category: string; match: RegExp }> = [
  { tag: 'ai-ml', category: 'ai-resources', match: /artificial intelligence|machine learning|\bai\b|generative ai|openai|anthropic|large language/i },
  { tag: 'developer-tools', category: 'dev-tools', match: /computer programming|software|developer|programming languages?|web development|technology business/i },
  { tag: 'crypto-web3', category: 'finance-crypto', match: /crypto|bitcoin|cryptocurren|digital assets|blockchain|cryptocoins|web3|ethereum/i },
  { tag: 'finance', category: 'finance-investing', match: /financial services|business & finance|investing|stock market|economy|markets?\b|banking/i },
  { tag: 'startups-business', category: 'startups-business', match: /business personalities|entrepreneur|leadership|startup|venture capital|business taxonomy|small business/i },
  { tag: 'politics', category: 'politics', match: /politic|election|government|president|congress|policy|political figures|geopolitic/i },
  { tag: 'tech-industry', category: 'tech-industry', match: /tech personalities|technology\b|gadgets|consumer electronics|big tech/i },
  { tag: 'gaming', category: 'gaming', match: /gaming|video game|esports|game business/i },
  { tag: 'sports', category: 'sports', match: /sports?\b|fitness business|athlete|football|basketball|soccer|nba|nfl/i },
  { tag: 'automotive', category: 'automotive', match: /automotive|automobile|electric vehicle|\btesla\b|\bcars?\b|aircraft/i },
  { tag: 'food-drink', category: 'food-drink', match: /food & beverage|food and beverage|restaurant|drinks?\b|cooking|cuisine/i },
  { tag: 'entertainment', category: 'entertainment', match: /entertainment|movies?|television|music\b|celebrities|streaming|leisure business/i },
  { tag: 'science', category: 'science', match: /science\b|space|astronomy|physics|biology|research\b|nasa|spacex/i },
  { tag: 'health', category: 'health-wellness', match: /health|wellness|medicine|fitness\b|nutrition|mental health/i },
  { tag: 'news', category: 'news', match: /\bnews\b|journalism|current events|breaking/i },
]

function tagsFromContextAnnotations(
  contextAnnotations: unknown[],
): { topicTags: string[]; categorySlugs: string[] } {
  const topicTags: string[] = []
  const categorySlugs: string[] = []
  for (const raw of contextAnnotations) {
    const ca = raw as { entity?: { name?: unknown } }
    const name = typeof ca?.entity?.name === 'string' ? ca.entity.name : null
    if (!name) continue
    for (const rule of CONTEXT_ANNOTATION_RULES) {
      if (rule.match.test(name)) {
        topicTags.push(rule.tag)
        categorySlugs.push(rule.category)
      }
    }
  }
  return { topicTags: uniquePreserveCase(topicTags), categorySlugs: uniquePreserveCase(categorySlugs) }
}

const TOOL_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI', pattern: /\bopenai\b|\bgpt[- ]?\d*\b/i },
  { name: 'Claude', pattern: /\bclaude\b|\banthropic\b/i },
  { name: 'GitHub', pattern: /github\.com|\bgithub\b/i },
  { name: 'FastAPI', pattern: /\bfastapi\b/i },
  { name: 'TypeScript', pattern: /\btypescript\b|\bts\b/i },
  { name: 'JavaScript', pattern: /\bjavascript\b|\bnode\.js\b/i },
  { name: 'Python', pattern: /\bpython\b/i },
  { name: 'React', pattern: /\breact\b/i },
  { name: 'Next.js', pattern: /\bnext\.js\b|\bnextjs\b/i },
  { name: 'Docker', pattern: /\bdocker\b/i },
  { name: 'Kubernetes', pattern: /\bkubernetes\b|\bk8s\b/i },
  { name: 'Vercel', pattern: /\bvercel\b/i },
  { name: 'Cursor', pattern: /\bcursor\b/i },
  { name: 'Obsidian', pattern: /\bobsidian\b/i },
]

const BRIEF_RELEVANT_CATEGORIES = new Set([
  'ai-resources',
  'dev-tools',
  'finance-crypto',
  'startups-business',
  'security-privacy',
  'productivity',
  'finance-investing',
])

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rawTweetShape(rawJson: string | null): RawTweetShape {
  const parsed = parseJson<Record<string, unknown>>(rawJson, {})
  const tweet = (parsed.tweet ?? parsed.data ?? parsed) as Record<string, unknown>
  const includes = (parsed.includes ?? {}) as RawTweetShape['includes']
  return { tweet, includes, contextAnnotations: (tweet.context_annotations ?? parsed.context_annotations ?? []) as unknown[] }
}

function uniquePreserveCase(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

function arrayFromUnknown(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function extractTextHashtags(text: string): string[] {
  return [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1])
}

function extractTextMentions(text: string): string[] {
  return [...text.matchAll(/@([A-Za-z0-9_]{1,20})/g)].map((m) => m[1])
}

function extractTextUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)\]}>,]+/g)].map((m) => m[0])
}

function urlDomain(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return null
  }
}

function existingCategorySlugs(bookmark: EnrichBookmarkInput): string[] {
  return bookmark.categories
    .map((entry) => entry.slug ?? entry.category?.slug ?? '')
    .filter((slug): slug is string => Boolean(slug))
}

function referencedTypes(tweet: Record<string, unknown>): string[] {
  return arrayFromUnknown(tweet.referenced_tweets).map((ref) => String(ref.type ?? ''))
}

function mediaTypes(bookmark: EnrichBookmarkInput, raw: RawTweetShape): string[] {
  const fromRows = bookmark.mediaItems.map((m) => m.type)
  const fromRaw = (raw.includes?.media ?? []).map((m) => String(m.type ?? ''))
  return uniquePreserveCase([...fromRows, ...fromRaw]).map((type) => type === 'animated_gif' ? 'gif' : type)
}

function detectTools(searchText: string): string[] {
  return TOOL_RULES.filter((rule) => rule.pattern.test(searchText)).map((rule) => rule.name)
}

function detectTopicTagsAndCategories(searchText: string, flags: Pick<FormatFlags, 'is_launch' | 'is_benchmark' | 'has_code'>): { topicTags: string[]; categorySlugs: string[] } {
  const topicTags: string[] = []
  const categorySlugs: string[] = []
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(searchText)) {
      topicTags.push(rule.tag)
      categorySlugs.push(rule.category)
    }
  }
  if (flags.is_launch) topicTags.push('launch')
  if (flags.is_benchmark) topicTags.push('benchmark')
  if (flags.has_code && !topicTags.includes('developer-tools')) {
    topicTags.push('developer-tools')
    categorySlugs.push('dev-tools')
  }
  return { topicTags: uniquePreserveCase(topicTags), categorySlugs: uniquePreserveCase(categorySlugs) }
}

function computeFormat(bookmark: EnrichBookmarkInput, tweet: Record<string, unknown>): TweetFormat {
  const refs = referencedTypes(tweet)
  const conversationId = typeof tweet.conversation_id === 'string' ? tweet.conversation_id : undefined
  const tweetId = typeof tweet.id === 'string' ? tweet.id : bookmark.tweetId
  const isReply = refs.includes('replied_to')
  const isQuote = refs.includes('quoted')
  const isThread = Boolean(
    (conversationId && conversationId !== tweetId) ||
      /(^|\s)(thread|🧵)($|\s|:)/i.test(bookmark.text) ||
      /(^|\s)\d{1,2}\s*\/\s*\d{1,2}($|\s)/.test(bookmark.text),
  )

  if (isThread) return 'thread'
  if (isQuote) return 'quote'
  if (isReply) return 'reply'
  return 'single'
}

export function extractFactualEnrichment(bookmark: EnrichBookmarkInput): FactualEnrichment {
  const raw = rawTweetShape(bookmark.rawJson)
  const tweet = raw.tweet ?? {}
  const tweetEntities = (tweet.entities ?? {}) as Record<string, unknown>
  const existing = parseJson<Partial<EnrichmentEntities> & { urls?: string[] }>(bookmark.entities, {})

  const hashtags = uniquePreserveCase([
    ...(existing.hashtags ?? []),
    ...arrayFromUnknown(tweetEntities.hashtags).map((tag) => String(tag.tag ?? '')),
    ...extractTextHashtags(bookmark.text),
  ])
  const mentions = uniquePreserveCase([
    ...(existing.mentions ?? []),
    ...arrayFromUnknown(tweetEntities.mentions).map((mention) => String(mention.username ?? '')),
    ...extractTextMentions(bookmark.text),
  ])
  const urls = uniquePreserveCase([
    ...(existing.urls ?? []),
    ...arrayFromUnknown(tweetEntities.urls).map((url) => String(url.expanded_url ?? url.unwound_url ?? url.url ?? '')),
    ...extractTextUrls(bookmark.text),
  ])
  const domains = uniquePreserveCase(urls.map(urlDomain).filter((domain): domain is string => Boolean(domain)))
  const allMediaTypes = mediaTypes(bookmark, raw)
  const hasImage = allMediaTypes.includes('photo') || allMediaTypes.includes('image')
  const hasVideo = allMediaTypes.includes('video')
  const hasGif = allMediaTypes.includes('gif') || allMediaTypes.includes('animated_gif')
  const refs = referencedTypes(tweet)
  const format = computeFormat(bookmark, tweet)
  const searchText = [bookmark.text, urls.join(' '), domains.join(' '), hashtags.join(' ')].join(' ')
  const hasCode = /```|`[^`]+`|github\.com|\b(api|sdk|repo|code|typescript|javascript|python|fastapi|react|next\.js|docker|terminal|cli)\b/i.test(searchText)
  const isLaunch = /\b(launching|launched|introducing|announcing|we built|shipping|released|new product|now live)\b/i.test(searchText)
  const isBenchmark = /\b(benchmark|benchmarks|eval|evals|leaderboard|performance|latency|throughput|score|results?)\b/i.test(searchText)

  const flags: FormatFlags = {
    format,
    is_thread: format === 'thread',
    is_single: format === 'single',
    is_quote: refs.includes('quoted'),
    is_reply: refs.includes('replied_to'),
    has_code: hasCode,
    is_launch: isLaunch,
    is_benchmark: isBenchmark,
    has_image: hasImage,
    has_video: hasVideo,
    has_gif: hasGif,
    media_types: allMediaTypes,
    link_domains: domains,
  }
  const detected = detectTopicTagsAndCategories(searchText, flags)
  // Fold in X's own context_annotations to densify tags on items the keyword
  // rules miss (rescues ~1k untagged items in the live corpus).
  const fromContext = tagsFromContextAnnotations(raw.contextAnnotations ?? [])
  const topicTags = uniquePreserveCase([...detected.topicTags, ...fromContext.topicTags])
  const categorySlugs = uniquePreserveCase([...existingCategorySlugs(bookmark), ...detected.categorySlugs, ...fromContext.categorySlugs])
  const segment: Segment = categorySlugs.some((slug) => BRIEF_RELEVANT_CATEGORIES.has(slug)) || flags.is_launch || flags.is_benchmark || flags.has_code
    ? 'brief-relevant'
    : 'everything-else'

  return {
    entities: {
      hashtags,
      urls,
      mentions,
      tools: uniquePreserveCase([...(existing.tools ?? []), ...detectTools(searchText)]),
      tweetType: format,
      contextAnnotations: raw.contextAnnotations ?? [],
    },
    topicTags,
    categorySlugs,
    formatFlags: flags,
    segment,
  }
}

function mergeJsonObject(raw: string | null | undefined, patch: Record<string, unknown>): string {
  const existing = parseJson<Record<string, unknown>>(raw, {})
  return JSON.stringify({ ...existing, ...patch })
}

function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, [])
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
}

export function buildEnrichmentUpdate(bookmark: EnrichBookmarkInput, enrichment: FactualEnrichment, now = new Date()): Record<string, unknown> {
  return {
    entities: JSON.stringify(enrichment.entities),
    semanticTags: JSON.stringify(uniquePreserveCase([...parseStringArray(bookmark.semanticTags), ...enrichment.topicTags, ...enrichment.categorySlugs])),
    enrichmentMeta: mergeJsonObject(bookmark.enrichmentMeta, {
      version: 'phase3-factual-v1',
      segment: enrichment.segment,
      topicTags: enrichment.topicTags,
      categories: enrichment.categorySlugs,
      formatFlags: enrichment.formatFlags,
      mediaPresent: {
        image: enrichment.formatFlags.has_image,
        video: enrichment.formatFlags.has_video,
        gif: enrichment.formatFlags.has_gif,
      },
    }),
    enrichedAt: now,
  }
}

async function runEnrichTransaction(db: EnrichDb, ops: Promise<unknown>[]): Promise<void> {
  if (ops.length === 0) return
  if (db.$transaction) {
    await db.$transaction(ops)
    return
  }
  await Promise.all(ops)
}

async function runEnrichChunkedTransactions(db: EnrichDb, ops: Promise<unknown>[], chunkSize = 50): Promise<void> {
  for (let i = 0; i < ops.length; i += chunkSize) {
    await runEnrichTransaction(db, ops.slice(i, i + chunkSize))
  }
}

async function writeCategoryAssignmentsBatch(
  db: EnrichDb,
  assignments: Array<{ bookmarkId: string; slugs: string[] }>,
): Promise<void> {
  if (!db.category || !db.bookmarkCategory) return
  const slugs = uniquePreserveCase(assignments.flatMap((assignment) => assignment.slugs))
  if (slugs.length === 0) return
  const categories = await db.category.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } })
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category.id]))
  const data: Array<{ bookmarkId: string; categoryId: string; confidence: number }> = []
  for (const assignment of assignments) {
    for (const slug of assignment.slugs) {
      const categoryId = categoryBySlug.get(slug)
      if (!categoryId) continue
      data.push({ bookmarkId: assignment.bookmarkId, categoryId, confidence: 0.8 })
    }
  }
  if (data.length === 0) return
  if (db.bookmarkCategory.createMany) {
    await db.bookmarkCategory.createMany({ data, skipDuplicates: true })
    return
  }
  const ops = data.map((row) => db.bookmarkCategory!.upsert({
    where: { bookmarkId_categoryId: { bookmarkId: row.bookmarkId, categoryId: row.categoryId } },
    update: { confidence: row.confidence },
    create: row,
  }))
  await runEnrichChunkedTransactions(db, ops)
}

export async function enrichBookmarkRows(db: EnrichDb, bookmarks: EnrichBookmarkInput[], now = new Date()): Promise<{ enriched: number }> {
  const updateOps: Promise<unknown>[] = []
  const assignments: Array<{ bookmarkId: string; slugs: string[] }> = []
  for (const bookmark of bookmarks) {
    const enrichment = extractFactualEnrichment(bookmark)
    updateOps.push(db.bookmark.update({ where: { id: bookmark.id }, data: buildEnrichmentUpdate(bookmark, enrichment, now) }))
    assignments.push({ bookmarkId: bookmark.id, slugs: enrichment.categorySlugs })
  }
  await runEnrichChunkedTransactions(db, updateOps)
  await writeCategoryAssignmentsBatch(db, assignments)
  return { enriched: bookmarks.length }
}

export async function enrichBookmarks(options: {
  db: EnrichDb
  bookmarks?: EnrichBookmarkInput[]
  limit?: number
  force?: boolean
  now?: Date
}): Promise<{ enriched: number }> {
  if (options.bookmarks) return enrichBookmarkRows(options.db, options.bookmarks, options.now)
  if (!options.db.bookmark.findMany) throw new Error('db.bookmark.findMany is required when bookmarks are not supplied')
  const rows = await options.db.bookmark.findMany({
    where: options.force ? {} : { enrichedAt: null },
    orderBy: { importedAt: 'asc' },
    take: options.limit ?? 100,
    select: ENRICH_BOOKMARK_SELECT,
  })
  return enrichBookmarkRows(options.db, rows, options.now)
}

export const ENRICH_BOOKMARK_SELECT = {
  id: true,
  tweetId: true,
  text: true,
  authorHandle: true,
  rawJson: true,
  entities: true,
  semanticTags: true,
  enrichmentMeta: true,
  mediaItems: { select: { id: true, type: true, url: true, thumbnailUrl: true, imageTags: true } },
  categories: { include: { category: { select: { slug: true } } } },
} as const

export function estimateVisionCost(input: { imageCount: number; videoThumbnailCount: number; costPerItemUsd?: number; freeItemLimit?: number }): VisionCostEstimate {
  const imageCount = Math.max(0, input.imageCount)
  const videoThumbnailCount = Math.max(0, input.videoThumbnailCount)
  const totalItems = imageCount + videoThumbnailCount
  const costPerItemUsd = input.costPerItemUsd ?? 0.003
  const freeItemLimit = input.freeItemLimit ?? 5
  const estimatedUsd = totalItems * costPerItemUsd
  const requiresConfirmation = totalItems > freeItemLimit
  const summary = `${totalItems} items, ${imageCount} with images, ${videoThumbnailCount} video thumbnails, est. $${estimatedUsd.toFixed(2)}`
  return { imageCount, videoThumbnailCount, totalItems, estimatedUsd, requiresConfirmation, summary }
}

function envConfirmed(env: Record<string, string | undefined>): boolean {
  return env.SIFTLY_ENRICH_CONFIRM_VISION === '1' || env.SIFTLY_ENRICH_CONFIRM_VISION?.toLowerCase() === 'true'
}

export function enforceVisionCostGate(estimate: VisionCostEstimate, options: { confirm?: boolean; dryRun?: boolean; env?: Record<string, string | undefined> }): boolean {
  if (estimate.totalItems === 0) return false
  if (options.dryRun) return false
  if (!estimate.requiresConfirmation) return true
  if (options.confirm || envConfirmed(options.env ?? process.env)) return true
  throw new Error(`vision/OCR backfill requires approval: ${estimate.summary}. Re-run with --confirm or SIFTLY_ENRICH_CONFIRM_VISION=1.`)
}

function hostInTwimgAllowlist(hostname: string): boolean {
  return hostname.endsWith('.twimg.com')
}

function hostInVideoSourceAllowlist(hostname: string): boolean {
  return hostname === 'x.com' || hostname === 'twitter.com' || hostInTwimgAllowlist(hostname)
}

function hostInOcrAllowlist(hostname: string): boolean {
  return hostname === 'pbs.twimg.com' || hostname === 'video.twimg.com'
}

function validateHttpsUrl(rawUrl: string, context: string, allowed: (hostname: string) => boolean, allowlistDescription: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed.startsWith('-')) throw new Error(`${context} must not start with '-'`)

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${context} must be a valid https URL in allowlist ${allowlistDescription}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || !allowed(hostname)) {
    throw new Error(`${context} host must be in allowlist ${allowlistDescription}: ${hostname}`)
  }
  return parsed.toString()
}

export function validateVideoSourceUrl(rawUrl: string): string {
  return validateHttpsUrl(normalizeXUrl(rawUrl), 'video source URL', hostInVideoSourceAllowlist, 'x.com, twitter.com, *.twimg.com')
}

function validateOcrImageUrl(rawUrl: string): string {
  return validateHttpsUrl(rawUrl, 'OCR image URL', hostInOcrAllowlist, 'pbs.twimg.com, video.twimg.com')
}

async function fetchOcrImage(rawUrl: string, timeoutMs: number): Promise<Response> {
  let currentUrl = validateOcrImageUrl(rawUrl)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers.get('location')
    if (!location) throw new Error(`image fetch redirect missing Location: HTTP ${response.status}`)
    currentUrl = validateOcrImageUrl(new URL(location, currentUrl).toString())
  }
  throw new Error('image fetch redirected too many times')
}

export async function runLocalOcr(options: { url: string; timeoutMs?: number }): Promise<{ text: string; backend: 'tesseract' }> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const isRemote = /^https?:\/\//i.test(options.url)
  let inputPath = options.url
  let tempDir: string | null = null

  try {
    if (isRemote) {
      const response = await fetchOcrImage(options.url, timeoutMs)
      if (!response.ok) throw new Error(`image fetch failed: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > 6_000_000) throw new Error(`image too large for OCR: ${bytes.byteLength} bytes`)
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'siftly-ocr-'))
      inputPath = path.join(tempDir, 'image')
      await writeFile(inputPath, bytes)
    }

    const { stdout } = await execFileAsync('tesseract', [inputPath, 'stdout', '--psm', '6'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { text: stdout.trim(), backend: 'tesseract' }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}

export function mergeOcrImageTags(existing: string | null | undefined, ocrText: string): string {
  const parsed = parseJson<Record<string, unknown>>(existing, {})
  const current = Array.isArray(parsed.text_ocr) ? (parsed.text_ocr as unknown[]).map(String) : []
  return JSON.stringify({
    ...parsed,
    text_ocr: uniquePreserveCase([...current, ocrText]),
    ocr_backend: 'tesseract',
  })
}

async function freshMediaImageTags(db: VideoEnrichDb, mediaItemId: string): Promise<string | null> {
  const findUnique = db.mediaItem.findUnique
  if (typeof findUnique !== 'function') {
    throw new Error('db.mediaItem.findUnique is required to merge imageTags without dropping existing OCR or video transcript data')
  }
  const existing = await findUnique({ where: { id: mediaItemId }, select: { imageTags: true } })
  if (!existing) throw new Error(`media item ${mediaItemId} not found while merging imageTags`)
  return existing.imageTags
}

export async function runOcrForMediaItems(db: VideoEnrichDb, mediaItems: EnrichMediaItemInput[], timeoutMs = 30_000): Promise<{ attempted: number; succeeded: number; failed: number }> {
  let attempted = 0
  let succeeded = 0
  let failed = 0
  for (const item of mediaItems) {
    const target = item.type === 'video' ? (item.thumbnailUrl ?? item.url) : item.url
    if (!target) continue
    attempted++
    try {
      const result = await runLocalOcr({ url: target, timeoutMs })
      const existingImageTags = await freshMediaImageTags(db, item.id)
      const imageTags = mergeOcrImageTags(existingImageTags, result.text)
      await db.mediaItem.update({ where: { id: item.id }, data: { imageTags } })
      if (result.text) succeeded++
    } catch (err) {
      // A single bad image (404/timeout/oversized/decode failure) must not abort the
      // whole batch and lose progress on every later item. Log, count, continue.
      failed++
      console.warn(`OCR failed for media ${item.id}: ${(err as Error).message}`)
    }
  }
  return { attempted, succeeded, failed }
}

const DEFAULT_CAPTION_MODEL = 'gpt-4o-mini'
const CAPTION_PROMPT =
  'Describe this image in one factual sentence (max 30 words) for a search index. ' +
  'State concrete visible content: subjects, setting, notable objects, any chart/diagram type. ' +
  'No preamble, no opinions, no "this image shows".'

export interface CaptionResult {
  caption: string
}

/**
 * Generate a one-sentence factual caption for a purely-visual image (no readable text)
 * using a cheap multimodal model. Used to make image-only posts content-searchable.
 * The image URL is allowlist-validated (same hosts as OCR) before being sent to the model.
 */
export async function generateImageCaption(
  rawUrl: string,
  options: {
    apiKey?: string
    baseUrl?: string
    model?: string
    timeoutMs?: number
    detail?: 'low' | 'high'
    fetchFn?: typeof fetch
  } = {},
): Promise<CaptionResult> {
  const url = validateOcrImageUrl(rawUrl)
  const apiKey = options.apiKey ?? process.env.SIFTLY_CAPTION_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('image caption requires OPENAI_API_KEY (or SIFTLY_CAPTION_API_KEY)')
  const baseUrl = (options.baseUrl ?? process.env.SIFTLY_CAPTION_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = options.model ?? process.env.SIFTLY_CAPTION_MODEL ?? DEFAULT_CAPTION_MODEL
  const timeoutMs = options.timeoutMs ?? 30_000
  const doFetch = options.fetchFn ?? fetch

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      max_tokens: 80,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: CAPTION_PROMPT },
            { type: 'image_url', image_url: { url, detail: options.detail ?? 'low' } },
          ],
        },
      ],
    }),
  })
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403
    throw new Error(`caption request failed: HTTP ${response.status}${authFailure ? ' (auth)' : ''}`)
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const caption = payload.choices?.[0]?.message?.content?.trim() ?? ''
  return { caption }
}

export function mergeCaptionImageTags(existing: string | null | undefined, caption: string): string {
  const parsed = parseJson<Record<string, unknown>>(existing, {})
  return JSON.stringify({ ...parsed, vision_caption: caption, caption_backend: DEFAULT_CAPTION_MODEL })
}

/** True for image/video media that has no readable OCR text yet (caption candidates). */
export function isCaptionCandidate(media: EnrichMediaItemInput): boolean {
  if (media.type !== 'photo' && media.type !== 'gif' && media.type !== 'video') return false
  const tags = parseJson<Record<string, unknown>>(media.imageTags, {})
  if (typeof tags.vision_caption === 'string' && (tags.vision_caption as string).trim()) return false
  const ocr = Array.isArray(tags.text_ocr) ? (tags.text_ocr as unknown[]).map(String).filter((s) => s.trim()) : []
  return ocr.length === 0
}

export async function runCaptionForMediaItems(
  db: VideoEnrichDb,
  mediaItems: EnrichMediaItemInput[],
  options: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  let attempted = 0
  let succeeded = 0
  let failed = 0
  for (const item of mediaItems) {
    const target = item.type === 'video' ? (item.thumbnailUrl ?? item.url) : item.url
    if (!target) continue
    attempted++
    try {
      const { caption } = await generateImageCaption(target, options)
      if (!caption) {
        failed++
        continue
      }
      const existingImageTags = await freshMediaImageTags(db, item.id)
      const imageTags = mergeCaptionImageTags(existingImageTags, caption)
      await db.mediaItem.update({ where: { id: item.id }, data: { imageTags } })
      succeeded++
    } catch (err) {
      failed++
      const message = (err as Error).message
      console.warn(`caption failed for media ${item.id}: ${message}`)
      // Fail fast on auth errors so a bad key doesn't burn through the whole candidate set as paid calls.
      if (message.includes('(auth)')) throw err
    }
  }
  return { attempted, succeeded, failed }
}

function profileBaseHome(env: Record<string, string | undefined> = process.env): string {
  const hermesHome = env.HERMES_HOME
  const marker = '/.hermes/profiles/'
  const markerAt = hermesHome?.indexOf(marker) ?? -1
  if (hermesHome && markerAt > 0) return hermesHome.slice(0, markerAt)
  return os.homedir()
}

function defaultQueuePath(env: Record<string, string | undefined> = process.env): string {
  return env.SIFTLY_VIDEO_QUEUE_PATH ?? path.join(profileBaseHome(env), '.hermes', 'state', 'x-bookmarks', 'video-enrich-queue.jsonl')
}

export function resolveVideoQueuePath(queuePath?: string, env: Record<string, string | undefined> = process.env): string {
  const resolved = expandHome(queuePath ?? defaultQueuePath(env), env)
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved)
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
}

const VIDEO_QUEUE_LOCK_RETRY_MS = 25
const VIDEO_QUEUE_LOCK_TIMEOUT_MS = 30_000
const VIDEO_QUEUE_LOCK_STALE_MS = 10 * 60_000

interface VideoQueueLockOptions {
  timeoutMs?: number
  staleMs?: number
}

interface VideoQueueLockOwner {
  pid?: number
  createdAt?: string
}

interface VideoQueueLockIdentity {
  dev: number
  ino: number
  mtimeMs: number
}

function videoQueueLockPath(queuePath: string): string {
  return `${queuePath}.lock`
}

function videoQueueLockOwnerPath(lockPath: string): string {
  return path.join(lockPath, 'owner.json')
}

function normalizeMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

async function readVideoQueueLockOwner(lockPath: string): Promise<VideoQueueLockOwner | null> {
  try {
    const parsed = parseJson<Record<string, unknown>>(await readFile(videoQueueLockOwnerPath(lockPath), 'utf8'), {})
    const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid)
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function staleVideoQueueLockReason(owner: VideoQueueLockOwner | null, staleMs: number, nowMs: number): string | null {
  if (!owner || owner.pid === undefined || !owner.createdAt) return null
  const createdAtMs = Date.parse(owner.createdAt)
  if (!Number.isFinite(createdAtMs)) return null
  if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > staleMs) {
    return `owner createdAt ${owner.createdAt} is older than ${staleMs}ms`
  }
  if (owner.pid !== undefined && !isPidAlive(owner.pid)) {
    return `owner pid ${owner.pid} is not alive`
  }
  return null
}

function describeVideoQueueLockOwner(owner: VideoQueueLockOwner | null): string {
  if (!owner) return 'owner unknown'
  return `owner pid=${owner.pid ?? 'unknown'} createdAt=${owner.createdAt ?? 'unknown'}`
}

async function videoQueueLockIdentity(lockPath: string): Promise<VideoQueueLockIdentity | null> {
  try {
    const lockStat = await stat(lockPath)
    if (!lockStat.isDirectory()) return null
    return { dev: lockStat.dev, ino: lockStat.ino, mtimeMs: lockStat.mtimeMs }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function sameVideoQueueLockIdentity(a: VideoQueueLockIdentity | null, b: VideoQueueLockIdentity | null): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs)
}

async function reclaimStaleVideoQueueLock(lockPath: string, staleMs: number): Promise<boolean> {
  const observedIdentity = await videoQueueLockIdentity(lockPath)
  if (!observedIdentity) return false
  const owner = await readVideoQueueLockOwner(lockPath)
  const reason = staleVideoQueueLockReason(owner, staleMs, Date.now())
  if (!reason) return false

  const preRenameIdentity = await videoQueueLockIdentity(lockPath)
  if (!sameVideoQueueLockIdentity(observedIdentity, preRenameIdentity)) return false

  const reclaimPath = `${lockPath}.reclaiming-${process.pid}-${Date.now()}`
  try {
    await rename(lockPath, reclaimPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }

  const reclaimedIdentity = await videoQueueLockIdentity(reclaimPath)
  if (!sameVideoQueueLockIdentity(observedIdentity, reclaimedIdentity)) {
    try {
      await rename(reclaimPath, lockPath)
    } catch (err) {
      // Best effort only: never delete a directory whose identity no longer
      // matches the stale lock we observed. Surface the orphaned reclaim path
      // so a leaked `.reclaiming-*` directory is operationally visible.
      console.warn(
        `video queue lock reclaim rollback failed; orphaned ${reclaimPath}: ${(err as Error).message}`,
      )
    }
    return false
  }

  await rm(reclaimPath, { recursive: true, force: true })
  return true
}

async function acquireVideoQueueLock(queuePath: string, options: VideoQueueLockOptions = {}): Promise<() => Promise<void>> {
  const lockPath = videoQueueLockPath(queuePath)
  const timeoutMs = normalizeMs(options.timeoutMs, VIDEO_QUEUE_LOCK_TIMEOUT_MS)
  const staleMs = normalizeMs(options.staleMs, VIDEO_QUEUE_LOCK_STALE_MS)
  const startedAt = Date.now()
  let attemptedStaleReclaim = false
  await ensureParent(queuePath)

  while (true) {
    try {
      await mkdir(lockPath)
      try {
        await writeFile(videoQueueLockOwnerPath(lockPath), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8')
      } catch (err) {
        await rm(lockPath, { recursive: true, force: true })
        throw err
      }
      return async () => {
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (!attemptedStaleReclaim && await reclaimStaleVideoQueueLock(lockPath, staleMs)) {
        attemptedStaleReclaim = true
        continue
      }
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs >= timeoutMs) {
        const owner = await readVideoQueueLockOwner(lockPath)
        throw new Error(`timed out acquiring video queue lock ${lockPath} after ${timeoutMs}ms; ${describeVideoQueueLockOwner(owner)}`)
      }
      await delay(Math.min(VIDEO_QUEUE_LOCK_RETRY_MS, Math.max(0, timeoutMs - elapsedMs)))
    }
  }
}

async function withVideoQueueLock<T>(queuePath: string, fn: () => Promise<T>, options: VideoQueueLockOptions = {}): Promise<T> {
  const release = await acquireVideoQueueLock(queuePath, options)
  try {
    return await fn()
  } finally {
    await release()
  }
}

interface VideoQueueSqlRow {
  id: number
  key: string
  status: QueueStatus
  bookmarkId: string
  tweetId: string
  mediaItemId: string
  sourceUrl: string
  attempts: number
  enqueuedAt: string
  updatedAt: string | null
  transcriptChars: number | null
  error: string | null
  owner: string | null
  leasedAt: string | null
}

interface LeasedVideoQueueRecord extends VideoQueueRecord {
  id: number
  owner: string
  leasedAt: string
}

const VIDEO_QUEUE_LEASE_TTL_MS = 15 * 60_000
const DEFAULT_VIDEO_DRAIN_WORKERS = 2
const MAX_VIDEO_DRAIN_WORKERS = 3

function resolveVideoQueueSqlitePath(queuePath: string): string {
  return /\.(db|sqlite|sqlite3)$/i.test(queuePath) ? queuePath : `${queuePath}.sqlite`
}

function ensureVideoQueueSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leasing', 'done', 'error')),
      bookmarkId TEXT NOT NULL,
      tweetId TEXT NOT NULL,
      mediaItemId TEXT NOT NULL,
      sourceUrl TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      enqueuedAt TEXT NOT NULL,
      updatedAt TEXT,
      transcriptChars INTEGER,
      error TEXT,
      owner TEXT,
      leasedAt TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS queue_tweet_id_unique ON queue(tweetId);
    CREATE INDEX IF NOT EXISTS queue_status_id_idx ON queue(status, id);
    CREATE INDEX IF NOT EXISTS queue_lease_idx ON queue(status, leasedAt);
  `)
}

function rowToVideoQueueRecord(row: VideoQueueSqlRow): VideoQueueRecord {
  return {
    key: row.key,
    status: row.status,
    bookmarkId: row.bookmarkId,
    tweetId: row.tweetId,
    mediaItemId: row.mediaItemId,
    sourceUrl: row.sourceUrl,
    attempts: row.attempts,
    enqueuedAt: row.enqueuedAt,
    updatedAt: row.updatedAt ?? undefined,
    transcriptChars: row.transcriptChars ?? undefined,
    error: row.error ?? undefined,
    owner: row.owner ?? undefined,
    leasedAt: row.leasedAt ?? undefined,
  }
}

function rowToLeasedRecord(row: VideoQueueSqlRow): LeasedVideoQueueRecord {
  return {
    ...rowToVideoQueueRecord(row),
    id: row.id,
    owner: row.owner ?? '',
    leasedAt: row.leasedAt ?? '',
  }
}

function normalizeQueueStatus(value: unknown): QueueStatus {
  return value === 'pending' || value === 'leasing' || value === 'done' || value === 'error' ? value : 'pending'
}

function normalizeVideoQueueRecord(value: unknown): VideoQueueRecord | null {
  const parsed = value as Partial<VideoQueueRecord> | null
  if (!parsed || typeof parsed.key !== 'string' || typeof parsed.bookmarkId !== 'string' || typeof parsed.tweetId !== 'string' || typeof parsed.mediaItemId !== 'string' || typeof parsed.sourceUrl !== 'string') return null
  const attempts = Number(parsed.attempts)
  return {
    key: parsed.key,
    status: normalizeQueueStatus(parsed.status),
    bookmarkId: parsed.bookmarkId,
    tweetId: parsed.tweetId,
    mediaItemId: parsed.mediaItemId,
    sourceUrl: parsed.sourceUrl,
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1,
    enqueuedAt: typeof parsed.enqueuedAt === 'string' ? parsed.enqueuedAt : new Date(0).toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    transcriptChars: typeof parsed.transcriptChars === 'number' ? parsed.transcriptChars : undefined,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
    owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
    leasedAt: typeof parsed.leasedAt === 'string' ? parsed.leasedAt : undefined,
  }
}

function queueRecordParams(record: VideoQueueRecord): Record<string, unknown> {
  return {
    key: record.key,
    status: record.status,
    bookmarkId: record.bookmarkId,
    tweetId: record.tweetId,
    mediaItemId: record.mediaItemId,
    sourceUrl: record.sourceUrl,
    attempts: record.attempts,
    enqueuedAt: record.enqueuedAt,
    updatedAt: record.updatedAt ?? null,
    transcriptChars: record.transcriptChars ?? null,
    error: record.error ?? null,
    owner: record.owner ?? null,
    leasedAt: record.leasedAt ?? null,
  }
}

const UPSERT_VIDEO_QUEUE_RECORD_SQL = `
  INSERT INTO queue (key, status, bookmarkId, tweetId, mediaItemId, sourceUrl, attempts, enqueuedAt, updatedAt, transcriptChars, error, owner, leasedAt)
  VALUES (@key, @status, @bookmarkId, @tweetId, @mediaItemId, @sourceUrl, @attempts, @enqueuedAt, @updatedAt, @transcriptChars, @error, @owner, @leasedAt)
  ON CONFLICT(tweetId) DO UPDATE SET
    key = excluded.key,
    status = excluded.status,
    bookmarkId = excluded.bookmarkId,
    mediaItemId = excluded.mediaItemId,
    sourceUrl = excluded.sourceUrl,
    attempts = excluded.attempts,
    enqueuedAt = excluded.enqueuedAt,
    updatedAt = excluded.updatedAt,
    transcriptChars = excluded.transcriptChars,
    error = excluded.error,
    owner = excluded.owner,
    leasedAt = excluded.leasedAt
`

async function syncVideoQueueMirror(queuePath: string, db: Database.Database): Promise<void> {
  const sqlitePath = resolveVideoQueueSqlitePath(queuePath)
  if (path.resolve(sqlitePath) === path.resolve(queuePath)) return
  const rows = db.prepare(`
    SELECT id, key, status, bookmarkId, tweetId, mediaItemId, sourceUrl, attempts, enqueuedAt, updatedAt, transcriptChars, error, owner, leasedAt
    FROM queue
    ORDER BY enqueuedAt ASC, id ASC
  `).all() as VideoQueueSqlRow[]
  const records = rows.map(rowToVideoQueueRecord)
  await ensureParent(queuePath)
  const content = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : ''
  const tmpPath = `${queuePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, queuePath)
}

async function migrateLegacyVideoQueue(queuePath: string, db: Database.Database): Promise<void> {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM queue').get() as { count: number }
  if (existing.count > 0) return

  let content = ''
  try {
    content = await readFile(queuePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (!content.trim().startsWith('{')) return

  const compacted = new Map<string, VideoQueueRecord>()
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const record = normalizeVideoQueueRecord(parseJson<unknown>(line, null))
    if (!record) continue
    compacted.set(record.tweetId, record)
  }
  if (compacted.size === 0) return

  const insert = db.prepare(UPSERT_VIDEO_QUEUE_RECORD_SQL)
  const txn = db.transaction((records: VideoQueueRecord[]) => {
    for (const record of records) insert.run(queueRecordParams(record))
  })
  txn([...compacted.values()])
  await syncVideoQueueMirror(queuePath, db)
}

async function openVideoQueueDb(queuePath: string): Promise<Database.Database> {
  const sqlitePath = resolveVideoQueueSqlitePath(queuePath)
  await ensureParent(sqlitePath)
  const db = new Database(sqlitePath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  ensureVideoQueueSchema(db)
  await migrateLegacyVideoQueue(queuePath, db)
  return db
}

export async function readVideoQueueState(queuePath = defaultQueuePath()): Promise<Map<string, VideoQueueRecord>> {
  const resolvedQueuePath = resolveVideoQueuePath(queuePath)
  const db = await openVideoQueueDb(resolvedQueuePath)
  try {
    const rows = db.prepare(`
      SELECT id, key, status, bookmarkId, tweetId, mediaItemId, sourceUrl, attempts, enqueuedAt, updatedAt, transcriptChars, error, owner, leasedAt
      FROM queue
      ORDER BY enqueuedAt ASC, id ASC
    `).all() as VideoQueueSqlRow[]
    const records = new Map<string, VideoQueueRecord>()
    for (const row of rows) records.set(row.key, rowToVideoQueueRecord(row))
    return records
  } finally {
    db.close()
  }
}

function videoTranscriptChars(imageTags: string | null | undefined): number | null {
  const parsed = parseJson<Record<string, unknown>>(imageTags, {})
  const transcript = parsed.video_transcript
  return typeof transcript === 'string' && transcript.trim().length > 0 ? transcript.length : null
}

export function hasVideoTranscript(imageTags: string | null | undefined): boolean {
  return videoTranscriptChars(imageTags) !== null
}

function isLikelyStaticPreview(url: string): boolean {
  return /pbs\.twimg\.com|\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)
}

function normalizeXUrl(url: string): string {
  return url.replace(/^https:\/\/x\.com\//i, 'https://twitter.com/')
}

function validateAuthorHandle(authorHandle: string): string {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(authorHandle)) {
    throw new Error(`authorHandle is invalid for video status URL: ${authorHandle}`)
  }
  return authorHandle
}

function videoSourceUrl(bookmark: EnrichBookmarkInput, media: EnrichMediaItemInput): string {
  if (media.url && (!/^https?:\/\//i.test(media.url) || !isLikelyStaticPreview(media.url))) return validateVideoSourceUrl(media.url)
  const authorHandle = validateAuthorHandle(bookmark.authorHandle)
  return validateVideoSourceUrl(`https://x.com/${authorHandle}/status/${bookmark.tweetId}`)
}

function findVideoQueueRecord(db: Database.Database, tweetId: string, key: string): VideoQueueRecord | null {
  const row = db.prepare(`
    SELECT id, key, status, bookmarkId, tweetId, mediaItemId, sourceUrl, attempts, enqueuedAt, updatedAt, transcriptChars, error, owner, leasedAt
    FROM queue
    WHERE tweetId = @tweetId OR key = @key
    ORDER BY CASE WHEN tweetId = @tweetId THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get({ tweetId, key }) as VideoQueueSqlRow | undefined
  return row ? rowToVideoQueueRecord(row) : null
}

export async function enqueueVideoItems(bookmarks: EnrichBookmarkInput[], options: { queuePath?: string; now?: Date; maxAttempts?: number; lockTimeoutMs?: number; lockStaleMs?: number } = {}): Promise<{ enqueued: number; skipped: number }> {
  const queuePath = resolveVideoQueuePath(options.queuePath)
  return withVideoQueueLock(queuePath, async () => {
    const db = await openVideoQueueDb(queuePath)
    try {
      const insert = db.prepare(UPSERT_VIDEO_QUEUE_RECORD_SQL)
      const now = (options.now ?? new Date()).toISOString()
      const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_VIDEO_MAX_ATTEMPTS)
      let enqueued = 0
      let skipped = 0

      for (const bookmark of bookmarks) {
        for (const media of bookmark.mediaItems) {
          if (media.type !== 'video') continue
          const current = findVideoQueueRecord(db, bookmark.tweetId, media.id)
          if (
            hasVideoTranscript(media.imageTags) ||
            current?.status === 'pending' ||
            current?.status === 'leasing' ||
            current?.status === 'done' ||
            (current?.status === 'error' && current.attempts >= maxAttempts)
          ) {
            skipped++
            continue
          }
          const attempts = (current?.attempts ?? 0) + 1
          const record: VideoQueueRecord = {
            key: media.id,
            status: 'pending',
            bookmarkId: bookmark.id,
            tweetId: bookmark.tweetId,
            mediaItemId: media.id,
            sourceUrl: videoSourceUrl(bookmark, media),
            attempts,
            enqueuedAt: current?.enqueuedAt ?? now,
            updatedAt: now,
          }
          insert.run(queueRecordParams(record))
          enqueued++
        }
      }

      if (enqueued > 0 || skipped > 0) await syncVideoQueueMirror(queuePath, db)
      return { enqueued, skipped }
    } finally {
      db.close()
    }
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs })
}

function expandHome(filePath: string, env: Record<string, string | undefined> = process.env): string {
  return filePath.startsWith('~/') ? path.join(profileBaseHome(env), filePath.slice(2)) : filePath
}

export function resolveParakeetScript(env: Record<string, string | undefined> = process.env): string | null {
  const profile = env.HERMES_PROFILE ?? 'daedalus'
  const profileRoot = env.HERMES_HOME
  const baseHome = profileBaseHome(env)
  const candidates = [
    env.PARAKEET_TRANSCRIBE_SCRIPT,
    profileRoot ? path.join(profileRoot, 'skills', 'media', 'parakeet-transcribe', 'scripts', 'parakeet-transcribe.sh') : undefined,
    path.join(baseHome, '.hermes', 'profiles', profile, 'skills', 'media', 'parakeet-transcribe', 'scripts', 'parakeet-transcribe.sh'),
    path.join(baseHome, '.hermes', 'profiles', 'daedalus', 'skills', 'media', 'parakeet-transcribe', 'scripts', 'parakeet-transcribe.sh'),
    path.join(baseHome, '.hermes', 'profiles', 'default', 'skills', 'media', 'parakeet-transcribe', 'scripts', 'parakeet-transcribe.sh'),
    '~/.hermes/skills/media/parakeet-transcribe/scripts/parakeet-transcribe.sh',
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    const resolved = expandHome(candidate, env)
    if (existsSync(resolved)) return resolved
  }
  return null
}

const DEFAULT_PARAKEET_BACKENDS = 'http://192.168.1.216:8923,http://192.168.1.78:8923,http://127.0.0.1:8924'

type ParakeetEnv = Record<string, string | undefined>

function parakeetProcessEnv(overrides: ParakeetEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  if (!env.PARAKEET_URL && !env.YTNB_ASR_BACKENDS) env.YTNB_ASR_BACKENDS = DEFAULT_PARAKEET_BACKENDS
  return env
}

/**
 * Parse the configured Parakeet backend pool (comma-separated URLs). The bash
 * wrapper only honors a single PARAKEET_URL per call, so the drain — not the
 * wrapper — is responsible for fanning records across the fleet GPUs. Source of
 * truth precedence: SIFTLY_PARAKEET_BACKENDS, then YTNB_ASR_BACKENDS (shared
 * fleet var), then the 3-card default (ACE-AI Blackwell, ACE-MEDIA 5090, Mac MLX).
 */
export function resolveParakeetBackends(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.SIFTLY_PARAKEET_BACKENDS ?? env.YTNB_ASR_BACKENDS ?? DEFAULT_PARAKEET_BACKENDS
  const seen = new Set<string>()
  const backends: string[] = []
  for (const part of raw.split(',')) {
    const url = part.trim().replace(/\/+$/, '')
    if (url && !seen.has(url)) {
      seen.add(url)
      backends.push(url)
    }
  }
  return backends
}

async function isBackendHealthy(url: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('curl', ['-sf', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), `${url}/health`], {
      encoding: 'utf8',
      timeout: timeoutMs + 2000,
    })
    return /"status"\s*:\s*"ok"|model_loaded/i.test(stdout)
  } catch {
    return false
  }
}

/**
 * Health-filter the backend pool so the drain only pins live GPUs. Preserves
 * config order (primary first). If every health check fails (e.g. transient LAN
 * blip), returns the first configured backend so a single attempt still happens
 * and fails through the normal transient-retry path rather than no-op'ing.
 */
export async function resolveHealthyParakeetBackends(env: Record<string, string | undefined> = process.env, timeoutMs = 6000): Promise<string[]> {
  const all = resolveParakeetBackends(env)
  if (all.length === 0) return []
  const checks = await Promise.all(all.map(async (url) => [url, await isBackendHealthy(url, timeoutMs)] as const))
  const healthy = checks.filter(([, ok]) => ok).map(([url]) => url)
  return healthy.length > 0 ? healthy : all.slice(0, 1)
}

export async function transcribeWithParakeet(input: string, options: { scriptPath?: string; timeoutMs?: number; env?: ParakeetEnv; backendUrl?: string } = {}): Promise<string> {
  const scriptPath = options.scriptPath ?? resolveParakeetScript()
  if (!scriptPath) throw new Error('parakeet-transcribe skill script not found; set PARAKEET_TRANSCRIBE_SCRIPT')
  const sourceUrl = validateVideoSourceUrl(input)
  const env = parakeetProcessEnv(options.env)
  if (options.backendUrl) env.PARAKEET_URL = options.backendUrl
  const { stdout } = await execFileAsync('bash', [scriptPath, '--text', '--no-timestamps', '--', sourceUrl], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env,
  })
  return stdout.trim()
}

/**
 * A "terminal" transcription failure is one that re-running cannot fix: the
 * media has no decodable audio (no-audio stream → ffprobe/yt-dlp postprocess
 * error) or has audio but no speech (empty transcript). These must NOT consume
 * the 3x retry budget — each retry re-downloads a multi-MB video for nothing —
 * so they park immediately. Everything else (backend unreachable, timeout,
 * network) is transient and retried.
 */
const TERMINAL_TRANSCRIPTION_FAILURE_PATTERNS: RegExp[] = [
  /empty transcript/i,
  /\bmedia_error\b/i,
  /no decodable audio/i,
  /unable to obtain file audio codec/i,
  /\bno[_\s-]?audio\b/i,
]

export function isTerminalTranscriptionFailure(message: string): boolean {
  return TERMINAL_TRANSCRIPTION_FAILURE_PATTERNS.some((re) => re.test(message))
}

export function mergeVideoTranscriptImageTags(existing: string | null | undefined, transcript: string): string {
  const parsed = parseJson<Record<string, unknown>>(existing, {})
  return JSON.stringify({ ...parsed, video_transcript: transcript })
}

interface DrainVideoQueueOptions {
  db: VideoEnrichDb
  queuePath?: string
  limit?: number
  workers?: number
  scriptPath?: string
  timeoutMs?: number
  transcribe?: (sourceUrl: string) => Promise<string>
  backendUrls?: string[]
  now?: Date
  maxAttempts?: number
  leaseTtlMs?: number
  lockTimeoutMs?: number
  lockStaleMs?: number
}

function normalizeDrainLimit(limit: number | undefined): number {
  if (limit === undefined) return 5
  if (!Number.isFinite(limit)) return 0
  return Math.max(0, Math.floor(limit))
}

function normalizeDrainWorkers(workers: number | undefined, limit: number): number {
  const fallback = Math.min(DEFAULT_VIDEO_DRAIN_WORKERS, Math.max(1, limit))
  const parsed = workers === undefined ? fallback : Math.floor(workers)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_VIDEO_DRAIN_WORKERS, parsed))
}

function reclaimStaleVideoLeases(db: Database.Database, now: Date, leaseTtlMs: number): number {
  const cutoff = new Date(now.getTime() - leaseTtlMs).toISOString()
  const updatedAt = now.toISOString()
  const result = db.prepare(`
    UPDATE queue
    SET status='pending', owner=NULL, leasedAt=NULL, updatedAt=@updatedAt
    WHERE status='leasing' AND leasedAt IS NOT NULL AND leasedAt < @cutoff
  `).run({ updatedAt, cutoff })
  return result.changes
}

function claimVideoQueueLeases(db: Database.Database, limit: number, owner: string, leasedAt: string): LeasedVideoQueueRecord[] {
  if (limit <= 0) return []
  // Single atomic claim statement. SQLite's grammar requires RETURNING before
  // ORDER BY/LIMIT, so this is the supported form of the required
  // UPDATE queue SET status='leasing' ... WHERE status='pending' ORDER BY id LIMIT N RETURNING id primitive.
  const rows = db.prepare(`
    UPDATE queue
    SET status='leasing', owner=@owner, leasedAt=@leasedAt, updatedAt=@leasedAt
    WHERE status='pending'
    RETURNING id, key, status, bookmarkId, tweetId, mediaItemId, sourceUrl, attempts, enqueuedAt, updatedAt, transcriptChars, error, owner, leasedAt
    ORDER BY id LIMIT @limit
  `).all({ owner, leasedAt, limit }) as VideoQueueSqlRow[]
  return rows.map(rowToLeasedRecord)
}

function releaseVideoLeaseDone(db: Database.Database, record: LeasedVideoQueueRecord, transcriptChars: number, updatedAt: string): void {
  db.prepare(`
    UPDATE queue
    SET status='done', owner=NULL, leasedAt=NULL, updatedAt=@updatedAt, transcriptChars=@transcriptChars, error=NULL
    WHERE id=@id AND owner=@owner
  `).run({ id: record.id, owner: record.owner, updatedAt, transcriptChars })
}

function releaseVideoLeaseFailed(db: Database.Database, record: LeasedVideoQueueRecord, maxAttempts: number, updatedAt: string, error: string): void {
  const attempts = Math.max(1, record.attempts)
  // Terminal failures (no decodable audio / no speech) can never succeed on
  // re-run and each retry re-downloads the whole video — park immediately at
  // status=error regardless of remaining attempt budget. Transient failures
  // (backend down, timeout, network) keep the existing retry semantics.
  const terminal = isTerminalTranscriptionFailure(error)
  const canRetry = !terminal && attempts < maxAttempts
  db.prepare(`
    UPDATE queue
    SET status=@status, owner=NULL, leasedAt=NULL, updatedAt=@updatedAt, attempts=@attempts, error=@error
    WHERE id=@id AND owner=@owner
  `).run({
    id: record.id,
    owner: record.owner,
    status: canRetry ? 'pending' : 'error',
    attempts: canRetry ? attempts + 1 : (terminal ? maxAttempts : attempts),
    updatedAt,
    error,
  })
}

async function updateTranscriptFtsKeyed(db: VideoEnrichDb, record: LeasedVideoQueueRecord, mergedImageTags: string): Promise<void> {
  if (!db.$executeRawUnsafe) return
  try {
    await db.$executeRawUnsafe('UPDATE bookmark_fts SET image_tags = ? WHERE bookmark_id = ?', mergedImageTags, record.bookmarkId)
  } catch {
    // The drain's durable source of truth is MediaItem.imageTags. FTS may not
    // exist yet; finalizer/rebuildFts will rebuild it. Never INSERT a second FTS row here.
  }
}

async function processLeasedVideoRecord(options: DrainVideoQueueOptions, queueDb: Database.Database, record: LeasedVideoQueueRecord, maxAttempts: number, backendUrl?: string): Promise<'existing' | 'transcribed' | 'failed'> {
  const updatedAt = (options.now ?? new Date()).toISOString()
  try {
    const sourceUrl = validateVideoSourceUrl(record.sourceUrl)
    const existingBeforeTranscribe = await freshMediaImageTags(options.db, record.mediaItemId)
    const existingTranscriptChars = videoTranscriptChars(existingBeforeTranscribe)
    if (existingTranscriptChars !== null) {
      releaseVideoLeaseDone(queueDb, record, existingTranscriptChars, updatedAt)
      return 'existing'
    }

    const transcript = (options.transcribe ?? ((url: string) => transcribeWithParakeet(url, { scriptPath: options.scriptPath, timeoutMs: options.timeoutMs, backendUrl })))(sourceUrl)
    const text = (await transcript).trim()
    if (!text) throw new Error('empty transcript')
    const existingImageTags = await freshMediaImageTags(options.db, record.mediaItemId)
    const mergedImageTags = mergeVideoTranscriptImageTags(existingImageTags, text)
    await options.db.mediaItem.update({
      where: { id: record.mediaItemId },
      data: { imageTags: mergedImageTags },
    })
    await updateTranscriptFtsKeyed(options.db, record, mergedImageTags)
    releaseVideoLeaseDone(queueDb, record, text.length, updatedAt)
    return 'transcribed'
  } catch (err) {
    releaseVideoLeaseFailed(queueDb, record, maxAttempts, updatedAt, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500))
    return 'failed'
  }
}

async function processLeasedVideoRecords(options: DrainVideoQueueOptions, queueDb: Database.Database, records: LeasedVideoQueueRecord[], workers: number, maxAttempts: number, backends: string[]): Promise<{ processed: number; transcribed: number; failed: number }> {
  let next = 0
  let processed = 0
  let transcribed = 0
  let failed = 0
  const workerCount = Math.min(workers, Math.max(1, records.length))

  // Pin each worker to a distinct healthy backend (round-robin). This is the
  // actual fleet fan-out: the bash wrapper only honors a single PARAKEET_URL,
  // so parallelism across GPUs has to come from running N workers each pinned
  // to a different backend URL. When a custom transcribe override is injected
  // (tests), backends are unused.
  await Promise.all(Array.from({ length: workerCount }, async (_unused, workerIndex) => {
    const backendUrl = backends.length > 0 ? backends[workerIndex % backends.length] : undefined
    while (next < records.length) {
      const record = records[next++]
      processed++
      const outcome = await processLeasedVideoRecord(options, queueDb, record, maxAttempts, backendUrl)
      if (outcome === 'transcribed') transcribed++
      if (outcome === 'failed') failed++
    }
  }))

  return { processed, transcribed, failed }
}

export async function drainVideoQueue(options: DrainVideoQueueOptions): Promise<{ processed: number; transcribed: number; failed: number }> {
  const queuePath = resolveVideoQueuePath(options.queuePath)
  const limit = normalizeDrainLimit(options.limit)
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_VIDEO_MAX_ATTEMPTS)
  const leaseTtlMs = normalizeMs(options.leaseTtlMs ?? options.lockStaleMs, VIDEO_QUEUE_LEASE_TTL_MS)
  const now = options.now ?? new Date()
  const owner = `${os.hostname()}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  // Discover the live backend pool ONCE per drain. With a custom transcribe
  // override (tests) we skip health discovery entirely and keep the legacy
  // single-worker default. Otherwise worker count scales to the number of
  // healthy GPUs (bounded by MAX_VIDEO_DRAIN_WORKERS) so all cards stay busy.
  const injectedBackends = options.backendUrls?.map((url) => url.trim().replace(/\/+$/, '')).filter(Boolean) ?? null
  const backends = options.transcribe ? [] : (injectedBackends ?? await resolveHealthyParakeetBackends())
  const desiredWorkers = options.workers ?? (backends.length > 0 ? backends.length : undefined)
  const workers = normalizeDrainWorkers(desiredWorkers, limit)
  const queueDb = await openVideoQueueDb(queuePath)

  try {
    const reclaimed = reclaimStaleVideoLeases(queueDb, now, leaseTtlMs)
    const claimed = claimVideoQueueLeases(queueDb, limit, owner, now.toISOString())
    if (claimed.length === 0) {
      if (reclaimed > 0) await syncVideoQueueMirror(queuePath, queueDb)
      return { processed: 0, transcribed: 0, failed: 0 }
    }

    const result = await processLeasedVideoRecords(options, queueDb, claimed, workers, maxAttempts, backends)
    await syncVideoQueueMirror(queuePath, queueDb)
    return result
  } finally {
    queueDb.close()
  }
}
