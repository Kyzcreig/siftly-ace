#!/usr/bin/env npx tsx
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SUBREDDITS = ['LocalLLaMA', 'MachineLearning']
const DEFAULT_LIMIT = 25
const USER_AGENT = 'siftly-ace reddit gatherer (https://github.com/Kyzcreig/siftly-ace)'
const ENGAGEMENT_NORMALIZE_MODULE: string = '../lib/engagement-normalize'

// --- Reddit discovery via PUBLIC RSS (Atom) ---------------------------------
// WHY RSS, not the API: Reddit's "Responsible Builder Policy" (Nov 2025) closed
// self-service API access (personal "script" apps don't qualify), and anonymous
// .json reads return HTTP 403 from datacenter/non-residential IPs (the Mac Studio
// host). But /r/<sub>/hot.rss returns HTTP 200 from the same IP. RSS gives exactly
// what a discovery gatherer needs (what's hot in N subs today). See
// docs/plans/PRD-reddit-rss-pivot.md.
//
// IMPORTANT BEHAVIORAL NOTE: Atom carries NO engagement metrics (score/upvotes/
// comments). Unlike the old JSON path, those fields are INTENTIONALLY honest-zero
// here, not fabricated. A zero-engagement reddit candidate is correct, not a bug.
const RSS_BASE = 'https://www.reddit.com'
// Politeness: Reddit per-IP rate-limits RSS hard (back-to-back probes -> 429; a
// single spaced request -> 200). Sequential + delay + bounded 429 retry. The
// delay is operator-tunable (measured live, recorded in the live-proof artifact),
// NOT a guessed default baked in as truth.
const DEFAULT_DELAY_MS = 2500
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BACKOFF_BASE_MS = 3000

type NormalizeEngagement = (source: string, raw: number, n: number) => number

type Logger = { warn: (message: string) => void }

type FetchResponse = {
  ok: boolean
  status: number
  text: () => Promise<string>
  headers?: { get(name: string): string | null }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponse>

type SleepLike = (ms: number) => Promise<void>

export type RedditCandidate = {
  title: string
  url: string
  summary: string
  source: 'reddit'
  authorHandle: string | null
  engagement_raw: {
    score: number
    upvotes: number
    comments: number
    normalized: number
  }
  created_at: string | null
}

export type GatherRedditOptions = {
  subreddits?: string[]
  limit?: number
  fetchImpl?: FetchLike
  logger?: Logger
  /** Delay between sequential per-sub fetches (politeness). Default DEFAULT_DELAY_MS. */
  delayMs?: number
  /** Max retries on HTTP 429. Default DEFAULT_MAX_RETRIES. */
  maxRetries?: number
  /** Exponential backoff base for 429 when no Retry-After header. Default DEFAULT_BACKOFF_BASE_MS. */
  backoffBaseMs?: number
  /** Injectable sleep so tests run without real timers. */
  sleepImpl?: SleepLike
}

let normalizeEngagementPromise: Promise<NormalizeEngagement> | null = null

function fallbackNormalizeEngagement(_source: string, raw: number, n: number): number {
  const positive = Math.max(0, finiteNumber(raw))
  const total = Math.max(positive, finiteNumber(n), 1)
  const p = Math.min(1, positive / total)
  const z = 1.96
  const denom = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return clamp01((centre - margin) / denom)
}

async function loadNormalizeEngagement(): Promise<NormalizeEngagement> {
  normalizeEngagementPromise ??= import(ENGAGEMENT_NORMALIZE_MODULE)
    .then((mod: Record<string, unknown>) => {
      const candidate = mod.normalizeEngagement
      if (typeof candidate !== 'function') return fallbackNormalizeEngagement
      const normalize = candidate as NormalizeEngagement
      return (source: string, raw: number, n: number) => {
        try {
          return clamp01(normalize(source, raw, n))
        } catch {
          return fallbackNormalizeEngagement(source, raw, n)
        }
      }
    })
    .catch(() => fallbackNormalizeEngagement)
  return normalizeEngagementPromise
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : match } catch { return match }
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : match } catch { return match }
    }
    return NAMED_ENTITIES[key] ?? match
  })
}

/** Strip tags + decode entities, collapse whitespace. RSS <content> is escaped HTML;
 *  this is the parse-side guard so no markup reaches the brief render. */
function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Remove <![CDATA[ ... ]]> wrappers, keeping the inner text. Some Atom feeds wrap
 *  title/content in CDATA; without this the literal ]]> leaks past stripTags. (B2) */
function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function cleanSummary(value: unknown): string {
  if (typeof value !== 'string') return ''
  // Atom <content> arrives entity-escaped (or CDATA-wrapped). Un-CDATA, decode the
  // escaped markup to real tags, then strip tags + decode text. (B2 + decode policy.)
  const unwrapped = stripCdata(value)
  const decodedOnce = decodeHtmlEntities(unwrapped)
  return stripTags(decodedOnce).slice(0, 600)
}

function redditUrl(value: string): string | null {
  try {
    return new URL(value, 'https://www.reddit.com').href
  } catch {
    return null
  }
}

function rssApiUrl(subreddit: string, limit: number): string {
  const safeSubreddit = subreddit.replace(/^r\//i, '').replace(/[^A-Za-z0-9_]/g, '')
  return `${RSS_BASE}/r/${safeSubreddit}/hot.rss?limit=${limit}`
}

/** Canonical author handle: u/<name>, no leading slash. Atom gives /u/<name> (or
 *  occasionally bare <name>); normalize to match the prior JSON bare-handle shape. */
function normalizeAuthorHandle(raw: string | null): string | null {
  const t = text(raw)
  if (!t) return null
  const name = t.replace(/^\/?u\//i, '').replace(/^\//, '').trim()
  return name ? `u/${name}` : null
}

function createdAtFromIso(value: string | null): string | null {
  const t = text(value)
  if (!t) return null
  const d = new Date(t)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function firstMatch(block: string, re: RegExp): string | null {
  const m = block.match(re)
  return m ? m[1] : null
}

/** Pick the post permalink from an entry's possibly-multiple <link> elements.
 *  Prefer rel="alternate"; then any href containing /comments/ (Reddit permalink);
 *  then the first href. Avoids grabbing a thumbnail/self/media link. (B1) */
function selectEntryLink(entry: string): string | null {
  const links = entry.match(/<link\b[^>]*>/gi) ?? []
  const hrefOf = (tag: string): string | null => {
    const m = tag.match(/\bhref=["']([^"']+)["']/i)
    return m ? m[1] : null
  }
  const alternate = links.find((l) => /\brel=["']alternate["']/i.test(l))
  if (alternate) { const h = hrefOf(alternate); if (h) return h }
  for (const l of links) {
    const h = hrefOf(l)
    if (h && /\/comments\//i.test(h)) return h
  }
  for (const l of links) { const h = hrefOf(l); if (h) return h }
  return null
}

/** Extract the post author from the entry's own <author> block only. Falls back to a
 *  top-level <name> that is NOT inside <category>/<source>. (B3) */
function extractEntryAuthor(entry: string): string | null {
  // Strip nested <source>...</source> so a crosspost's source author can't win.
  const withoutSource = entry.replace(/<source\b[\s\S]*?<\/source>/gi, '')
  const block = firstMatch(withoutSource, /<author\b[^>]*>([\s\S]*?)<\/author>/i)
  if (block) {
    const name = firstMatch(block, /<name>([\s\S]*?)<\/name>/i)
    if (name) return name
  }
  return null
}

/** Parse one Atom <entry> into a RedditCandidate. Defensive: missing required
 *  fields -> null (caller counts as malformed, never throws). */
function parseAtomEntry(
  entry: string,
  subreddit: string,
  normalizeEngagement: NormalizeEngagement,
): RedditCandidate | null {
  const title = text(decodeHtmlEntities(stripCdata(firstMatch(entry, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '')))
  const href = selectEntryLink(entry)
  const url = href ? redditUrl(href) : null
  if (!title || !url) return null

  // Anchor the author to the entry's OWN <author>...</author>, taking the FIRST <name>
  // inside it. Reject <name> that lives in <category>/<source> (crossposts). (B3)
  const authorHandle = normalizeAuthorHandle(extractEntryAuthor(entry))

  const published = firstMatch(entry, /<published>([\s\S]*?)<\/published>/i)
    ?? firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/i)
  const created_at = createdAtFromIso(published)

  const contentRaw = firstMatch(entry, /<content[^>]*>([\s\S]*?)<\/content>/i)
    ?? firstMatch(entry, /<summary[^>]*>([\s\S]*?)<\/summary>/i)
  const summary = cleanSummary(contentRaw) || `r/${subreddit}${authorHandle ? ` • ${authorHandle}` : ''}`

  // Atom carries NO engagement metrics -> honest zeros + neutral normalized.
  return {
    title,
    url,
    summary,
    source: 'reddit',
    authorHandle,
    engagement_raw: {
      score: 0,
      upvotes: 0,
      comments: 0,
      normalized: clamp01(normalizeEngagement('reddit', 0, 1)),
    },
    created_at,
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function parseRetryAfter(resp: FetchResponse): number | null {
  const h = resp.headers
  if (!h) return null
  const ra = h.get('retry-after') ?? h.get('x-ratelimit-reset')
  if (!ra) return null
  const secs = Number(ra)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  const when = Date.parse(ra)
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60_000))
  return null
}

/** Fetch with bounded 429 retry. Honors Retry-After/x-ratelimit-reset when present,
 *  else exponential backoff off backoffBaseMs. Returns the final response (caller
 *  decides on non-ok). Never throws for HTTP status; network throw bubbles to caller. */
async function fetchWithRetry(
  url: string,
  fetchImpl: FetchLike,
  sleepImpl: SleepLike,
  maxRetries: number,
  backoffBaseMs: number,
): Promise<FetchResponse> {
  let attempt = 0
  let resp = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } })
  while (resp.status === 429 && attempt < maxRetries) {
    const headerWait = parseRetryAfter(resp)
    const wait = headerWait ?? backoffBaseMs * Math.pow(2, attempt)
    await sleepImpl(wait)
    attempt += 1
    resp = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } })
  }
  return resp
}

export async function gatherRedditPosts(options: GatherRedditOptions = {}): Promise<RedditCandidate[]> {
  const subreddits = options.subreddits?.length ? options.subreddits : DEFAULT_SUBREDDITS
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? DEFAULT_LIMIT)))
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const logger = options.logger ?? { warn: (message: string) => console.error(message) }
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? DEFAULT_DELAY_MS))
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? DEFAULT_MAX_RETRIES))
  const backoffBaseMs = Math.max(0, Math.trunc(options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS))
  const sleepImpl: SleepLike = options.sleepImpl ?? defaultSleep
  const normalizeEngagement = await loadNormalizeEngagement()
  const candidates: RedditCandidate[] = []

  for (let i = 0; i < subreddits.length; i++) {
    const subreddit = subreddits[i]
    if (i > 0 && delayMs > 0) await sleepImpl(delayMs) // politeness gap (sequential)

    const url = rssApiUrl(subreddit, limit)
    let xml: string
    try {
      const response = await fetchWithRetry(url, fetchImpl, sleepImpl, maxRetries, backoffBaseMs)
      if (response.status === 429) {
        logger.warn(`reddit gather ${subreddit}: HTTP 429 after ${maxRetries} retries; returning [] for that source`)
        continue
      }
      if (!response.ok) {
        logger.warn(`reddit gather ${subreddit}: HTTP ${response.status}; returning [] for that source`)
        continue
      }
      xml = await response.text()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`reddit gather ${subreddit}: malformed or unreachable source (${message}); returning [] for that source`)
      continue
    }

    const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi)
    if (!entries || entries.length === 0) {
      // Distinguish a TRUNCATED response (an <entry open tag with no matching close —
      // realistic on a socket cut mid-stream) from a genuinely empty <feed>. (B6)
      if (/<entry\b/i.test(xml)) {
        logger.warn(`reddit gather ${subreddit}: malformed/truncated feed (unterminated entry); returning [] for that source`)
      } else {
        logger.warn(`reddit gather ${subreddit}: empty feed (0 entries); returning [] for that source`)
      }
      continue
    }

    let malformed = 0
    const before = candidates.length
    for (const entry of entries) {
      let parsed: RedditCandidate | null = null
      try {
        parsed = parseAtomEntry(entry, subreddit, normalizeEngagement)
      } catch {
        parsed = null
      }
      if (parsed) candidates.push(parsed)
      else malformed += 1
    }
    if (malformed > 0) logger.warn(`reddit gather ${subreddit}: malformed entr(y/ies) ignored (${malformed})`)
    if (candidates.length === before && malformed === 0) {
      logger.warn(`reddit gather ${subreddit}: empty feed after filtering; returning [] for that source`)
    }
  }

  return candidates
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function allFlags(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  }
  return out
}

function intOf(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

async function main(): Promise<number> {
  const subreddits = allFlags('subreddit')
  const limit = intOf(flag('limit'), DEFAULT_LIMIT)
  const delayMs = flag('delay-ms') !== undefined ? intOf(flag('delay-ms'), DEFAULT_DELAY_MS) : undefined
  const candidates = await gatherRedditPosts({
    subreddits: subreddits.length ? subreddits : DEFAULT_SUBREDDITS,
    limit,
    delayMs,
    logger: { warn: (message) => console.error(message) },
  })
  process.stdout.write(`${JSON.stringify({ candidates })}\n`)
  return 0
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  return Boolean(entry && import.meta.url === pathToFileURL(resolve(entry)).href)
}

if (isDirectRun()) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    })
}
