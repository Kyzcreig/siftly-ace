import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type XurlSource = 'bookmark' | 'like'

export interface XurlTweet {
  id: string
  text?: string
  author_id?: string
  created_at?: string
  lang?: string
  public_metrics?: Record<string, unknown>
  entities?: {
    hashtags?: { tag?: string }[]
    urls?: { expanded_url?: string; unwound_url?: string; url?: string }[]
    mentions?: { username?: string }[]
  }
  context_annotations?: unknown[]
  attachments?: { media_keys?: string[] }
  possibly_sensitive?: boolean
  conversation_id?: string
  referenced_tweets?: { type?: string; id?: string }[]
  [key: string]: unknown
}

export interface XurlUser {
  id: string
  username?: string
  name?: string
}

export interface XurlMedia {
  media_key: string
  type?: string
  url?: string
  preview_image_url?: string
  duration_ms?: number
  alt_text?: string
}

export interface XurlTweetPage {
  data?: XurlTweet[]
  includes?: {
    users?: XurlUser[]
    media?: XurlMedia[]
  }
  meta?: {
    result_count?: number
    next_token?: string
    [key: string]: unknown
  }
  errors?: unknown[]
  title?: string
  detail?: string
  status?: number
  [key: string]: unknown
}

export interface XurlSourcePage {
  source: XurlSource
  page: XurlTweetPage
}

export interface ParsedXurlTweet {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  rawJson: string
  entities: string
  source: XurlSource
  media: { type: 'photo' | 'video' | 'gif'; url: string; thumbnailUrl?: string }[]
}

interface ExistingMediaItemRow {
  type: string
  url: string
  thumbnailUrl?: string | null
}

interface ExistingBookmarkRow {
  id: string
  source?: string | null
  text?: string | null
  rawJson?: string | null
  entities?: string | null
  mediaItems?: ExistingMediaItemRow[]
}

type DbDelegateMethod<TResult = unknown> = (args: any) => Promise<TResult>

export interface XurlIngestDb {
  bookmark: {
    findUnique: DbDelegateMethod<ExistingBookmarkRow | null>
    create: DbDelegateMethod<{ id: string }>
    update: DbDelegateMethod<{ id: string }>
  }
  ingestState?: {
    findUnique?: DbDelegateMethod<{ lastCursor?: string | null } | null>
    upsert: DbDelegateMethod
  }
  setting?: {
    findUnique?: DbDelegateMethod<{ value: string } | null>
    upsert: DbDelegateMethod
  }
}

export type RunXurl = (endpoint: string) => Promise<XurlTweetPage>

export interface IngestOptions {
  db: XurlIngestDb
  runXurl?: RunXurl
  app?: string
  userId?: string
  sources?: XurlSource[]
  maxPages?: number
  pageSize?: number
  limit?: number
  dryRun?: boolean
  retryCount?: number
  retryBaseMs?: number
  onCreditsDepleted?: (event: XurlCreditsDepletedEvent) => void | Promise<void>
  // When true (default), each source resumes pagination from its persisted cursor
  // — correct for resuming an interrupted BACKFILL. The daily INCREMENTAL path must
  // pass false so it starts from the top of the list (X paginates newest→older;
  // a persisted next_token points DEEPER into history and would skip new items).
  resumeFromCursor?: boolean
}

export interface XurlCreditsDepletedEvent {
  source: XurlSource
  status: 402
  message: string
  savedCursor: string | null
  pagesFetched: number
  rowsFetched: number
}

export interface IngestResult {
  pagesFetched: number
  rowsFetched: number
  rowsDeduped: number
  created: number
  updated: number
  skipped: number
  perSource: Record<XurlSource, { pages: number; rows: number; nextCursor: string | null }>
  creditsDepleted?: XurlCreditsDepletedEvent
}

const DEFAULT_APP = 'siftly-ace'
const DEFAULT_USER_ID = '56282605'
const DEFAULT_MAX_PAGES = 50
const DEFAULT_PAGE_SIZE = 100
const TWEET_FIELDS = [
  'created_at',
  'author_id',
  'lang',
  'public_metrics',
  'entities',
  'context_annotations',
  'attachments',
  'possibly_sensitive',
  'conversation_id',
  'referenced_tweets',
].join(',')
const EXPANSIONS = ['author_id', 'attachments.media_keys'].join(',')
const MEDIA_FIELDS = ['type', 'url', 'preview_image_url', 'duration_ms', 'alt_text'].join(',')
const USER_FIELDS = ['username', 'name'].join(',')

export class XurlApiError extends Error {
  status?: number
  payload?: unknown

  constructor(message: string, status?: number, payload?: unknown) {
    super(message)
    this.name = 'XurlApiError'
    this.status = status
    this.payload = payload
  }
}

function endpointPath(source: XurlSource): string {
  return source === 'bookmark' ? 'bookmarks' : 'liked_tweets'
}

export function buildXurlEndpoint(params: {
  source: XurlSource
  userId?: string
  pageSize?: number
  paginationToken?: string
}): string {
  const query = new URLSearchParams({
    max_results: String(clampPageSize(params.pageSize ?? DEFAULT_PAGE_SIZE)),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    'user.fields': USER_FIELDS,
  })

  if (params.paginationToken) query.set('pagination_token', params.paginationToken)

  return `/2/users/${params.userId ?? DEFAULT_USER_ID}/${endpointPath(params.source)}?${query.toString()}`
}

function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(100, Math.max(5, Math.floor(pageSize)))
}

async function defaultRunXurl(endpoint: string, app = DEFAULT_APP): Promise<XurlTweetPage> {
  try {
    const { stdout } = await execFileAsync('xurl', ['--app', app, endpoint], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return parseXurlStdout(stdout, endpoint)
  } catch (err) {
    const childErr = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const stdout = childErr.stdout ? String(childErr.stdout) : ''
    const stderr = childErr.stderr ? String(childErr.stderr) : ''
    const payload = tryParseJson(stdout)
    const status = payload ? payloadStatus(payload) : statusFromText(`${stdout}\n${stderr}`)
    const detail = payload ? payloadMessage(payload) : (stderr || childErr.message || 'xurl failed')
    throw new XurlApiError(`xurl ${endpoint} failed: ${detail}`, status, payload ?? undefined)
  }
}

function parseXurlStdout(stdout: string, endpoint: string): XurlTweetPage {
  const payload = tryParseJson(stdout)
  if (!payload) throw new XurlApiError(`xurl ${endpoint} returned invalid JSON`)
  return payload as XurlTweetPage
}

function tryParseJson(text: string): unknown | null {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function assertNoXurlErrors(payload: unknown, endpoint: string): void {
  const page = payload as XurlTweetPage
  const status = typeof page?.status === 'number' ? page.status : undefined
  const errors = Array.isArray(page?.errors) ? page.errors : []
  const title = page?.title
  const hasData = hasUsableData(payload)

  if (title || (status && status >= 400) || (errors.length > 0 && !hasData)) {
    throw new XurlApiError(`xurl ${endpoint} returned an API error: ${payloadMessage(payload)}`, status ?? payloadStatus(payload), payload)
  }

  if (errors.length > 0 && hasData) {
    console.warn(`xurl ${endpoint} returned ${errors.length} partial xurl error(s); continuing with usable data`)
  }
}

function hasUsableData(payload: unknown): boolean {
  const data = (payload as { data?: unknown })?.data
  if (Array.isArray(data)) return data.length > 0
  return data !== null && data !== undefined
}

function payloadStatus(payload: unknown): number | undefined {
  const obj = payload as Record<string, unknown>
  if (typeof obj?.status === 'number') return obj.status
  const errors = Array.isArray(obj?.errors) ? (obj.errors as Record<string, unknown>[]) : []
  for (const error of errors) {
    if (typeof error.status === 'number') return error.status
    if (typeof error.code === 'number') return error.code
  }
  return statusFromText(JSON.stringify(payload))
}

function statusFromText(text: string): number | undefined {
  if (/\b429\b|rate limit/i.test(text)) return 429
  if (/CreditsDepleted|\b402\b/i.test(text)) return 402
  if (/\b401\b/i.test(text)) return 401
  if (/\b403\b/i.test(text)) return 403
  return undefined
}

function payloadMessage(payload: unknown): string {
  const obj = payload as Record<string, unknown>
  if (typeof obj?.detail === 'string') return obj.detail
  if (typeof obj?.title === 'string') return obj.title
  const errors = Array.isArray(obj?.errors) ? obj.errors : []
  if (errors.length > 0) {
    return errors
      .map((error) => {
        if (typeof error === 'string') return error
        const errObj = error as Record<string, unknown>
        return String(errObj.message ?? errObj.detail ?? errObj.title ?? JSON.stringify(error))
      })
      .join('; ')
  }
  return JSON.stringify(payload).slice(0, 500)
}

function isRetryable429(err: unknown): boolean {
  return err instanceof XurlApiError && err.status === 429
}

function classifyXurlError(err: unknown): number | undefined {
  if (err instanceof XurlApiError) return err.status ?? statusFromText(err.message)
  return statusFromText(err instanceof Error ? err.message : String(err))
}

function isCreditsDepletedError(err: unknown): boolean {
  return classifyXurlError(err) === 402
}

function xurlErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  endpoint: string,
  runXurl: RunXurl,
  retryCount: number,
  retryBaseMs: number,
): Promise<XurlTweetPage> {
  for (let attempt = 0; ; attempt++) {
    try {
      const payload = await runXurl(endpoint)
      assertNoXurlErrors(payload, endpoint)
      return payload
    } catch (err) {
      if (!isRetryable429(err) || attempt >= retryCount) throw err
      await sleep(retryBaseMs * 2 ** attempt)
    }
  }
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function mediaType(type: string | undefined): 'photo' | 'video' | 'gif' {
  if (type === 'video') return 'video'
  if (type === 'animated_gif') return 'gif'
  return 'photo'
}

type ParsedMediaItem = { type: 'photo' | 'video' | 'gif'; url: string; thumbnailUrl?: string }

function parseMedia(tweet: XurlTweet, mediaByKey: Map<string, XurlMedia>): ParsedMediaItem[] {
  const mediaKeys = tweet.attachments?.media_keys ?? []
  return mediaKeys
    .map((key) => mediaByKey.get(key))
    .filter((media): media is XurlMedia => Boolean(media))
    .map((media): ParsedMediaItem | null => {
      const thumbnailUrl = media.preview_image_url ?? media.url ?? undefined
      const url = media.url ?? media.preview_image_url ?? ''
      if (!url) return null
      return thumbnailUrl
        ? { type: mediaType(media.type), url, thumbnailUrl }
        : { type: mediaType(media.type), url }
    })
    .filter((media): media is ParsedMediaItem => media !== null)
}

function parseEntities(tweet: XurlTweet): string {
  const hashtags = (tweet.entities?.hashtags ?? [])
    .map((tag) => tag.tag ?? '')
    .filter(Boolean)
  const urls = (tweet.entities?.urls ?? [])
    .map((url) => url.expanded_url ?? url.unwound_url ?? url.url ?? '')
    .filter(Boolean)
  const mentions = (tweet.entities?.mentions ?? [])
    .map((mention) => mention.username ?? '')
    .filter(Boolean)
  const tweetType = tweet.referenced_tweets?.[0]?.type ?? 'tweet'

  return JSON.stringify({
    hashtags,
    urls,
    mentions,
    tweetType,
    contextAnnotations: tweet.context_annotations ?? [],
  })
}

function parsePageTweets(sourcePage: XurlSourcePage): ParsedXurlTweet[] {
  const usersById = new Map(
    (sourcePage.page.includes?.users ?? []).map((user) => [user.id, user] as const),
  )
  const mediaByKey = new Map(
    (sourcePage.page.includes?.media ?? []).map((media) => [media.media_key, media] as const),
  )

  return (sourcePage.page.data ?? [])
    .filter((tweet) => Boolean(tweet.id))
    .map((tweet) => {
      const user = tweet.author_id ? usersById.get(tweet.author_id) : undefined
      const media = parseMedia(tweet, mediaByKey)
      return {
        tweetId: tweet.id,
        text: tweet.text ?? '',
        authorHandle: user?.username ?? 'unknown',
        authorName: user?.name ?? 'Unknown',
        tweetCreatedAt: parseDate(tweet.created_at),
        rawJson: JSON.stringify({ source: sourcePage.source, tweet, includes: { user, media } }),
        entities: parseEntities(tweet),
        source: sourcePage.source,
        media,
      }
    })
}

function sourcePriority(source: string | null | undefined): number {
  return source === 'bookmark' ? 2 : 1
}

function pickSource(existing: string | null | undefined, incoming: XurlSource): XurlSource {
  return sourcePriority(existing) >= sourcePriority(incoming) ? (existing as XurlSource) : incoming
}

export function dedupeXurlTweets(sourcePages: XurlSourcePage[]): ParsedXurlTweet[] {
  const byTweetId = new Map<string, ParsedXurlTweet>()

  for (const sourcePage of sourcePages) {
    for (const parsed of parsePageTweets(sourcePage)) {
      const existing = byTweetId.get(parsed.tweetId)
      if (!existing || sourcePriority(parsed.source) > sourcePriority(existing.source)) {
        byTweetId.set(parsed.tweetId, parsed)
      }
    }
  }

  return [...byTweetId.values()]
}

function mediaCreateRows(row: ParsedXurlTweet) {
  return row.media.map((media) => ({
    type: media.type,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl ?? null,
  }))
}

function normalizeExistingMedia(mediaItems: ExistingMediaItemRow[] | undefined) {
  return (mediaItems ?? []).map((media) => ({
    type: media.type,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl ?? null,
  }))
}

function sameMediaItems(existing: ExistingMediaItemRow[] | undefined, incoming: ParsedXurlTweet): boolean {
  return JSON.stringify(normalizeExistingMedia(existing)) === JSON.stringify(mediaCreateRows(incoming))
}

function sameMeaningfulContent(existing: ExistingBookmarkRow, incoming: ParsedXurlTweet): boolean {
  return (
    existing.text === incoming.text &&
    existing.rawJson === incoming.rawJson &&
    (existing.entities ?? null) === (incoming.entities ?? null) &&
    sameMediaItems(existing.mediaItems, incoming)
  )
}

function createBookmarkData(row: ParsedXurlTweet): Record<string, unknown> {
  const data: Record<string, unknown> = {
    tweetId: row.tweetId,
    text: row.text,
    authorHandle: row.authorHandle,
    authorName: row.authorName,
    tweetCreatedAt: row.tweetCreatedAt,
    rawJson: row.rawJson,
    entities: row.entities,
    source: row.source,
  }
  const media = mediaCreateRows(row)
  if (media.length > 0) data.mediaItems = { create: media }
  return data
}

function updateBookmarkData(row: ParsedXurlTweet, source: XurlSource, includeMedia: boolean): Record<string, unknown> {
  const media = mediaCreateRows(row)
  const data: Record<string, unknown> = {
    text: row.text,
    authorHandle: row.authorHandle,
    authorName: row.authorName,
    tweetCreatedAt: row.tweetCreatedAt,
    rawJson: row.rawJson,
    entities: row.entities,
    source,
  }

  if (includeMedia) {
    data.mediaItems = {
      deleteMany: {},
      create: media,
    }
  }

  return data
}

async function upsertRows(
  db: XurlIngestDb,
  rows: ParsedXurlTweet[],
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0
  let updated = 0
  let skipped = 0

  for (const row of rows) {
    const existing = await db.bookmark.findUnique({
      where: { tweetId: row.tweetId },
      select: {
        id: true,
        source: true,
        text: true,
        rawJson: true,
        entities: true,
        mediaItems: { select: { type: true, url: true, thumbnailUrl: true }, orderBy: { id: 'asc' } },
      },
    })

    if (!existing) {
      await db.bookmark.create({ data: createBookmarkData(row) })
      created++
      continue
    }

    const source = pickSource(existing.source, row.source)
    if (sourcePriority(existing.source) > sourcePriority(row.source)) {
      skipped++
      continue
    }

    const contentUnchanged = sameMeaningfulContent(existing, row)
    if (source === existing.source && contentUnchanged) {
      skipped++
      continue
    }

    const includeMedia = row.media.length > 0 && !sameMediaItems(existing.mediaItems, row)

    await db.bookmark.update({
      where: { tweetId: row.tweetId },
      data: updateBookmarkData(row, source, includeMedia),
    })
    updated++
  }

  return { created, updated, skipped }
}

async function persistState(
  db: XurlIngestDb,
  source: XurlSource,
  nextCursor: string | null,
): Promise<void> {
  const now = new Date()
  if (db.ingestState) {
    await db.ingestState.upsert({
      where: { source },
      update: { lastCursor: nextCursor, lastRunAt: now, runCount: { increment: 1 } },
      create: { source, lastCursor: nextCursor, lastRunAt: now, runCount: 1 },
    })
    return
  }

  if (db.setting) {
    const key = ingestStateSettingKey(source)
    let runCount = 1
    if (db.setting.findUnique) {
      const current = await db.setting.findUnique({ where: { key } })
      if (current?.value) {
        const parsed = tryParseJson(current.value) as { runCount?: number } | null
        runCount = (parsed?.runCount ?? 0) + 1
      }
    }
    await db.setting.upsert({
      where: { key },
      update: { value: JSON.stringify({ source, lastCursor: nextCursor, lastRunAt: now.toISOString(), runCount }) },
      create: { key, value: JSON.stringify({ source, lastCursor: nextCursor, lastRunAt: now.toISOString(), runCount }) },
    })
  }
}

function ingestStateSettingKey(source: XurlSource): string {
  return `xurl_ingest:${source}`
}

async function loadPersistedCursor(db: XurlIngestDb, source: XurlSource): Promise<string | null> {
  if (db.ingestState?.findUnique) {
    const state = await db.ingestState.findUnique({ where: { source } })
    if (state) return state.lastCursor ?? null
  }

  if (db.setting?.findUnique) {
    const current = await db.setting.findUnique({ where: { key: ingestStateSettingKey(source) } })
    if (current?.value) {
      const parsed = tryParseJson(current.value) as { lastCursor?: unknown } | null
      return typeof parsed?.lastCursor === 'string' ? parsed.lastCursor : null
    }
  }

  return null
}

async function fetchSourcePages(params: {
  source: XurlSource
  runXurl: RunXurl
  userId: string
  maxPages: number
  pageSize: number
  limit?: number
  retryCount: number
  retryBaseMs: number
  initialCursor?: string | null
}): Promise<{
  sourcePages: XurlSourcePage[]
  rows: number
  nextCursor: string | null
  creditsDepleted?: XurlCreditsDepletedEvent
}> {
  const sourcePages: XurlSourcePage[] = []
  let rows = 0
  let cursor: string | undefined = params.initialCursor ?? undefined
  let nextCursor: string | null = params.initialCursor ?? null

  for (let pageIndex = 0; pageIndex < params.maxPages; pageIndex++) {
    if (params.limit !== undefined && rows >= params.limit) break

    const remaining = params.limit === undefined ? undefined : params.limit - rows
    const pageSize = remaining === undefined ? params.pageSize : Math.min(params.pageSize, Math.max(5, remaining))
    const endpoint = buildXurlEndpoint({
      source: params.source,
      userId: params.userId,
      pageSize,
      paginationToken: cursor,
    })
    let page: XurlTweetPage
    try {
      page = await fetchWithRetry(endpoint, params.runXurl, params.retryCount, params.retryBaseMs)
    } catch (err) {
      if (!isCreditsDepletedError(err)) throw err
      return {
        sourcePages,
        rows,
        nextCursor,
        creditsDepleted: {
          source: params.source,
          status: 402,
          message: xurlErrorMessage(err),
          savedCursor: nextCursor,
          pagesFetched: sourcePages.length,
          rowsFetched: rows,
        },
      }
    }
    const pageRows = page.data ?? []
    const trimmedRows = remaining === undefined ? pageRows : pageRows.slice(0, remaining)
    const trimmedPage = pageRows.length === trimmedRows.length ? page : { ...page, data: trimmedRows }

    sourcePages.push({ source: params.source, page: trimmedPage })
    rows += trimmedRows.length
    // R3 defense-in-depth: if this page was trimmed (limit hit), its next_token points PAST
    // rows we never ingested. Never persist a cursor that would skip un-ingested rows. Today
    // --limit requires --dry (CLI guard) so persist is unreachable, but null-out keeps the
    // data-hole permanently dead even if that guard is ever relaxed.
    const wasTrimmed = trimmedRows.length !== pageRows.length
    nextCursor = wasTrimmed ? null : (page.meta?.next_token ?? null)

    if (!nextCursor || pageRows.length === 0) break
    cursor = nextCursor
  }

  return { sourcePages, rows, nextCursor }
}

export async function ingestXurlSources(options: IngestOptions): Promise<IngestResult> {
  const app = options.app ?? DEFAULT_APP
  const userId = options.userId ?? DEFAULT_USER_ID
  const sources = options.sources ?? ['bookmark', 'like']
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const pageSize = clampPageSize(options.pageSize ?? DEFAULT_PAGE_SIZE)
  const retryCount = options.retryCount ?? 2
  const retryBaseMs = options.retryBaseMs ?? 1_000
  const runXurl = options.runXurl ?? ((endpoint: string) => defaultRunXurl(endpoint, app))

  const allSourcePages: XurlSourcePage[] = []
  const fetchedSources: XurlSource[] = []
  let creditsDepleted: XurlCreditsDepletedEvent | undefined
  const perSource = {
    bookmark: { pages: 0, rows: 0, nextCursor: null as string | null },
    like: { pages: 0, rows: 0, nextCursor: null as string | null },
  }

  for (const source of sources) {
    const initialCursor = (options.resumeFromCursor ?? true)
      ? await loadPersistedCursor(options.db, source)
      : null
    const fetched = await fetchSourcePages({
      source,
      runXurl,
      userId,
      maxPages,
      pageSize,
      limit: options.limit,
      retryCount,
      retryBaseMs,
      initialCursor,
    })
    allSourcePages.push(...fetched.sourcePages)
    fetchedSources.push(source)
    perSource[source] = {
      pages: fetched.sourcePages.length,
      rows: fetched.rows,
      nextCursor: fetched.nextCursor,
    }

    if (fetched.creditsDepleted) {
      creditsDepleted = fetched.creditsDepleted
      break
    }
  }

  const rows = dedupeXurlTweets(allSourcePages)
  const counts = options.dryRun ? { created: 0, updated: 0, skipped: 0 } : await upsertRows(options.db, rows)

  if (!options.dryRun) {
    for (const source of fetchedSources) {
      await persistState(options.db, source, perSource[source].nextCursor)
    }
  }

  if (creditsDepleted && options.onCreditsDepleted) await options.onCreditsDepleted(creditsDepleted)

  return {
    pagesFetched: allSourcePages.length,
    rowsFetched: allSourcePages.reduce((sum, sourcePage) => sum + (sourcePage.page.data?.length ?? 0), 0),
    rowsDeduped: rows.length,
    ...counts,
    perSource,
    ...(creditsDepleted ? { creditsDepleted } : {}),
  }
}
