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
export type QueueStatus = 'pending' | 'done' | 'error'
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
  category?: {
    findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; slug: string }>>
  }
  bookmarkCategory?: {
    upsert: (args: Record<string, unknown>) => Promise<unknown>
  }
}

export interface VideoEnrichDb {
  mediaItem: {
    findUnique: (args: { where: { id: string }; select: { imageTags: true } }) => Promise<{ imageTags: string | null } | null>
    update: (args: { where: { id: string }; data: { imageTags: string } }) => Promise<unknown>
  }
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
  const categorySlugs = uniquePreserveCase([...existingCategorySlugs(bookmark), ...detected.categorySlugs])
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
    topicTags: detected.topicTags,
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

async function writeCategoryAssignments(db: EnrichDb, bookmarkId: string, slugs: string[]): Promise<void> {
  if (!db.category || !db.bookmarkCategory || slugs.length === 0) return
  const categories = await db.category.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } })
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category.id]))
  for (const slug of slugs) {
    const categoryId = categoryBySlug.get(slug)
    if (!categoryId) continue
    await db.bookmarkCategory.upsert({
      where: { bookmarkId_categoryId: { bookmarkId, categoryId } },
      update: { confidence: 0.8 },
      create: { bookmarkId, categoryId, confidence: 0.8 },
    })
  }
}

export async function enrichBookmarkRows(db: EnrichDb, bookmarks: EnrichBookmarkInput[], now = new Date()): Promise<{ enriched: number }> {
  let enriched = 0
  for (const bookmark of bookmarks) {
    const enrichment = extractFactualEnrichment(bookmark)
    await db.bookmark.update({ where: { id: bookmark.id }, data: buildEnrichmentUpdate(bookmark, enrichment, now) })
    await writeCategoryAssignments(db, bookmark.id, enrichment.categorySlugs)
    enriched++
  }
  return { enriched }
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

async function writeVideoQueueState(queuePath: string, records: Map<string, VideoQueueRecord>): Promise<void> {
  await ensureParent(queuePath)
  const rows = [...records.values()].sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.key.localeCompare(b.key))
  const content = rows.length > 0 ? `${rows.map((record) => JSON.stringify(record)).join('\n')}\n` : ''
  const tmpPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, queuePath)
}

export async function readVideoQueueState(queuePath = defaultQueuePath()): Promise<Map<string, VideoQueueRecord>> {
  const records = new Map<string, VideoQueueRecord>()
  let content = ''
  try {
    content = await readFile(queuePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return records
    throw err
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parsed = parseJson<VideoQueueRecord | null>(line, null)
    if (!parsed?.key) continue
    records.set(parsed.key, parsed)
  }
  return records
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

export async function enqueueVideoItems(bookmarks: EnrichBookmarkInput[], options: { queuePath?: string; now?: Date; maxAttempts?: number; lockTimeoutMs?: number; lockStaleMs?: number } = {}): Promise<{ enqueued: number; skipped: number }> {
  const queuePath = resolveVideoQueuePath(options.queuePath)
  return withVideoQueueLock(queuePath, async () => {
    const state = await readVideoQueueState(queuePath)
    const now = (options.now ?? new Date()).toISOString()
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_VIDEO_MAX_ATTEMPTS)
    let enqueued = 0
    let skipped = 0

    for (const bookmark of bookmarks) {
      for (const media of bookmark.mediaItems) {
        if (media.type !== 'video') continue
        const current = state.get(media.id)
        if (
          hasVideoTranscript(media.imageTags) ||
          current?.status === 'pending' ||
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
        state.set(media.id, record)
        enqueued++
      }
    }

    if (state.size > 0 || enqueued > 0) await writeVideoQueueState(queuePath, state)
    return { enqueued, skipped }
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

export async function transcribeWithParakeet(input: string, options: { scriptPath?: string; timeoutMs?: number } = {}): Promise<string> {
  const scriptPath = options.scriptPath ?? resolveParakeetScript()
  if (!scriptPath) throw new Error('parakeet-transcribe skill script not found; set PARAKEET_TRANSCRIBE_SCRIPT')
  const sourceUrl = validateVideoSourceUrl(input)
  const { stdout } = await execFileAsync('bash', [scriptPath, '--text', '--no-timestamps', '--', sourceUrl], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

export function mergeVideoTranscriptImageTags(existing: string | null | undefined, transcript: string): string {
  const parsed = parseJson<Record<string, unknown>>(existing, {})
  return JSON.stringify({ ...parsed, video_transcript: transcript })
}

export async function drainVideoQueue(options: {
  db: VideoEnrichDb
  queuePath?: string
  limit?: number
  scriptPath?: string
  timeoutMs?: number
  transcribe?: (sourceUrl: string) => Promise<string>
  now?: Date
  maxAttempts?: number
  lockTimeoutMs?: number
  lockStaleMs?: number
}): Promise<{ processed: number; transcribed: number; failed: number }> {
  const queuePath = resolveVideoQueuePath(options.queuePath)
  return withVideoQueueLock(queuePath, async () => {
    const state = await readVideoQueueState(queuePath)
    const pending = [...state.values()]
      .filter((record) => record.status === 'pending')
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))
      .slice(0, options.limit ?? 5)
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_VIDEO_MAX_ATTEMPTS)
    let processed = 0
    let transcribed = 0
    let failed = 0

    for (const record of pending) {
      processed++
      const now = (options.now ?? new Date()).toISOString()
      try {
        const sourceUrl = validateVideoSourceUrl(record.sourceUrl)
        const existingBeforeTranscribe = await freshMediaImageTags(options.db, record.mediaItemId)
        const existingTranscriptChars = videoTranscriptChars(existingBeforeTranscribe)
        if (existingTranscriptChars !== null) {
          const done: VideoQueueRecord = {
            key: record.key,
            status: 'done',
            bookmarkId: record.bookmarkId,
            tweetId: record.tweetId,
            mediaItemId: record.mediaItemId,
            sourceUrl: record.sourceUrl,
            attempts: record.attempts,
            enqueuedAt: record.enqueuedAt,
            updatedAt: now,
            transcriptChars: existingTranscriptChars,
          }
          state.set(record.key, done)
          await writeVideoQueueState(queuePath, state)
          continue
        }

        const transcript = (options.transcribe ?? ((url: string) => transcribeWithParakeet(url, { scriptPath: options.scriptPath, timeoutMs: options.timeoutMs })))(sourceUrl)
        const text = (await transcript).trim()
        if (!text) throw new Error('empty transcript')
        const existingImageTags = await freshMediaImageTags(options.db, record.mediaItemId)
        await options.db.mediaItem.update({
          where: { id: record.mediaItemId },
          data: { imageTags: mergeVideoTranscriptImageTags(existingImageTags, text) },
        })
        const done: VideoQueueRecord = {
          key: record.key,
          status: 'done',
          bookmarkId: record.bookmarkId,
          tweetId: record.tweetId,
          mediaItemId: record.mediaItemId,
          sourceUrl: record.sourceUrl,
          attempts: record.attempts,
          enqueuedAt: record.enqueuedAt,
          updatedAt: now,
          transcriptChars: text.length,
        }
        state.set(record.key, done)
        await writeVideoQueueState(queuePath, state)
        transcribed++
      } catch (err) {
        const attempts = Math.max(1, record.attempts)
        const canRetry = attempts < maxAttempts
        const errored: VideoQueueRecord = {
          ...record,
          status: canRetry ? 'pending' : 'error',
          attempts: canRetry ? attempts + 1 : attempts,
          updatedAt: now,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        }
        state.set(record.key, errored)
        await writeVideoQueueState(queuePath, state)
        failed++
      }
    }

    return { processed, transcribed, failed }
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs })
}
