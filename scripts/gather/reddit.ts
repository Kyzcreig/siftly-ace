#!/usr/bin/env npx tsx
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SUBREDDITS = ['LocalLLaMA', 'MachineLearning']
// Curated AI sub set (PRD-brief-live-wiring §5.2, OQ-1 LOCKED). All 9 live-verified
// HTTP 200 (2026-06-14). Builder/technically-literate niches; marketing-heavy subs
// excluded. Used by the day-seeded rotation selector below.
const CURATED_AI_SUBREDDITS = [
  'LocalLLaMA', 'MachineLearning', 'artificial', 'singularity', 'OpenAI',
  'AI_Agents', 'LLMDevs', 'ChatGPTCoding', 'StableDiffusion',
] as const
// Per-run rotation size: ~5 of 9 keeps a single run inside the measured per-IP RSS
// budget (D-10) while covering all 9 over a <=2-day rotation.
const DEFAULT_ROTATION_SIZE = 5
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
// Politeness: Reddit per-IP rate-limits RSS hard. LIVE-MEASURED 2026-06-14: 9 subs
// across 2 lanes (~4-5 fetches/IP) mass-429 at 2.5-3s gaps; reliable 200s needed
// ~45-60s spacing per IP. So the default per-lane gap is raised, AND the rotation
// selector caps a run at ~5 subs (D-10) so the same-lane spacing x subs-per-lane
// stays inside the per-source Reddit time box. Sequential per-lane + bounded 429
// retry; lanes run CONCURRENTLY (each its own IP budget).
const DEFAULT_DELAY_MS = 45_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BACKOFF_BASE_MS = 3000
// D-11: bounded per-fetch timeout so a black-hole lane (connects, never responds)
// fails THAT fetch within the box instead of hanging the brief. Applies to both
// the curl (SOCKS) transport and native fetch.
const DEFAULT_FETCH_TIMEOUT_MS = 8000
// D-10: hard wall-clock cap on the whole Reddit step, independent of the brief's
// global 20-min (1200s) AbortController, so a slow/throttled Reddit never starves the
// rest of the pipeline. LIVE-MEASURED 2026-06-14: a 5-sub/2-lane/45s-spacing run with
// one 429 retry took ~203s, so the box is 240s (still ~20% of the cron budget, leaving
// ~960s for enrich/embed/export/score). The estimate before measurement was 180s.
const DEFAULT_STEP_BUDGET_MS = 240_000

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
  /** Hard wall-clock cap (ms) on the whole Reddit step (D-10), independent of any
   *  outer brief timeout. Default DEFAULT_STEP_BUDGET_MS. 0 disables. */
  stepBudgetMs?: number
  /** Egress lanes to round-robin subreddits across. Each entry is '' (direct/native
   *  fetch, the Mac Studio's own residential WAN) or a SOCKS proxy URL like
   *  'socks5://192.168.1.217:1080' (Starlink). Independent residential IPs each get
   *  their own Reddit per-IP RSS budget, so spreading subs lifts the 1-fetch/window
   *  limit. Default ['']. Ignored when `fetchImpl` is injected (tests). */
  lanes?: string[]
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

/** Dep-free SOCKS-capable fetch transport via curl. Node's built-in fetch can't do
 *  SOCKS without an npm dep (which the no-new-dep invariant forbids), so a proxied
 *  lane shells out to curl --socks5-hostname (the exact call proven live). Returns a
 *  FetchResponse-shaped object. Used only for the DEFAULT lane fetchers; tests inject
 *  their own fetchImpl and never hit this. */
function curlFetch(proxyUrl: string, timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): FetchLike {
  return async (url: string): Promise<FetchResponse> => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    // D-11: --connect-timeout + --max-time bound a black-hole proxy (connects, never
    // responds) so curl returns within the box instead of hanging the brief.
    const maxTime = Math.max(1, Math.ceil(timeoutMs / 1000))
    const args = [
      '-s', '-S',
      '--connect-timeout', String(maxTime),
      '--max-time', String(maxTime),
      '--socks5-hostname', proxyUrl.replace(/^socks5:\/\//i, ''),
      '-A', USER_AGENT,
      '-w', '\n%{http_code}',
      url,
    ]
    try {
      const { stdout } = await run('curl', args, { maxBuffer: 8 * 1024 * 1024 })
      const nl = stdout.lastIndexOf('\n')
      const body = nl >= 0 ? stdout.slice(0, nl) : stdout
      const status = nl >= 0 ? Number(stdout.slice(nl + 1).trim()) : 0
      return {
        ok: status >= 200 && status < 300,
        status: Number.isFinite(status) ? status : 0,
        text: async () => body,
        headers: { get: () => null }, // curl -w doesn't surface response headers here
      }
    } catch (err) {
      // curl process failure (proxy down, timeout) -> surface as a thrown network error
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}

function nativeFetch(url: string, init?: RequestInit): Promise<FetchResponse> {
  // D-11: bound the direct-WAN fetch too, so a stalled connection can't hang the step.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DEFAULT_FETCH_TIMEOUT_MS)
  return (fetch(url, { ...init, signal: ac.signal }) as unknown as Promise<FetchResponse>)
    .finally(() => clearTimeout(timer))
}

/** Build one FetchLike per lane: '' -> native fetch (direct WAN), a socks5:// url ->
 *  curl transport. */
function laneFetchers(lanes: string[]): FetchLike[] {
  return lanes.map((lane) => (lane ? curlFetch(lane) : nativeFetch))
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

/** D-6 cosmetic: a curl/execFile failure's `.message` includes the full argv
 *  (proxy host, UA, url). Strip it to a short, log-safe reason. */
function sanitizeFetchError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // execFile errors look like: "Command failed: curl -s -S ... \n<stderr>". Prefer
  // the curl stderr tail (after the last newline) if present; else a generic label.
  const nl = raw.lastIndexOf('\n')
  const tail = nl >= 0 ? raw.slice(nl + 1).trim() : ''
  if (tail && !/^curl\b/i.test(tail) && !tail.includes('--socks5')) return tail
  if (/timed out|timeout|max-time|operation too slow/i.test(raw)) return 'timed out'
  if (/could not resolve|couldn'?t resolve|resolve host/i.test(raw)) return 'dns failure'
  if (/connection refused|couldn'?t connect|failed to connect/i.test(raw)) return 'connection refused'
  if (/socks/i.test(raw)) return 'proxy unreachable'
  return 'unreachable'
}

/** D-10: deterministic day-seeded rotation. Given the full sub list and a day index
 *  (day-of-year), returns a stable rotating window of `size` subs such that, advancing
 *  the day by 1 each run, every sub is covered over ceil(N/size) days. Pure + testable. */
export function rotateSubreddits(all: readonly string[], dayIndex: number, size: number): string[] {
  const n = all.length
  if (n === 0 || size <= 0) return []
  const k = Math.min(size, n)
  const start = ((Math.trunc(dayIndex) % n) + n) % n
  const out: string[] = []
  for (let i = 0; i < k; i++) out.push(all[(start + i) % n])
  return out
}

/** Day-of-year (UTC), 0-based — the rotation seed. */
export function dayOfYearUTC(d: Date = new Date()): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.floor((now - start) / 86_400_000)
}

export async function gatherRedditPosts(options: GatherRedditOptions = {}): Promise<RedditCandidate[]> {
  const subreddits = options.subreddits?.length ? options.subreddits : DEFAULT_SUBREDDITS
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? DEFAULT_LIMIT)))
  const logger = options.logger ?? { warn: (message: string) => console.error(message) }
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? DEFAULT_DELAY_MS))
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? DEFAULT_MAX_RETRIES))
  const backoffBaseMs = Math.max(0, Math.trunc(options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS))
  const sleepImpl: SleepLike = options.sleepImpl ?? defaultSleep
  const stepBudgetMs = Math.max(0, Math.trunc(options.stepBudgetMs ?? DEFAULT_STEP_BUDGET_MS))
  const deadline = stepBudgetMs > 0 ? Date.now() + stepBudgetMs : Infinity
  const normalizeEngagement = await loadNormalizeEngagement()

  // Lanes run CONCURRENTLY (D-10): each lane is an independent residential IP with its
  // own per-IP RSS budget, so there is no reason to serialize across lanes. WITHIN a
  // lane, subs are sequential with the politeness delay (same-IP cadence). An injected
  // fetchImpl (tests) collapses to a single lane.
  const lanes = options.lanes?.length ? options.lanes : ['']
  const fetchers: FetchLike[] = options.fetchImpl ? [options.fetchImpl] : laneFetchers(lanes)

  // Assign subs to lanes round-robin (sub i -> lane i % L), preserving the historical
  // distribution, but now grouped per lane so each lane can run as its own sequence.
  const perLane: string[][] = fetchers.map(() => [])
  for (let i = 0; i < subreddits.length; i++) perLane[i % fetchers.length].push(subreddits[i])

  // Parse one fetched feed into candidates (shared by every lane worker).
  const parseFeed = (xml: string, subreddit: string, sink: RedditCandidate[]): void => {
    const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi)
    if (!entries || entries.length === 0) {
      if (/<entry\b/i.test(xml)) {
        logger.warn(`reddit gather ${subreddit}: malformed/truncated feed (unterminated entry); returning [] for that source`)
      } else {
        logger.warn(`reddit gather ${subreddit}: empty feed (0 entries); returning [] for that source`)
      }
      return
    }
    let malformed = 0
    const before = sink.length
    for (const entry of entries) {
      let parsed: RedditCandidate | null = null
      try {
        parsed = parseAtomEntry(entry, subreddit, normalizeEngagement)
      } catch {
        parsed = null
      }
      if (parsed) sink.push(parsed)
      else malformed += 1
    }
    if (malformed > 0) logger.warn(`reddit gather ${subreddit}: malformed entr(y/ies) ignored (${malformed})`)
    if (sink.length === before && malformed === 0) {
      logger.warn(`reddit gather ${subreddit}: empty feed after filtering; returning [] for that source`)
    }
  }

  // One worker per lane. A network throw (down/black-hole lane caught by the per-fetch
  // timeout, D-11) marks THIS lane down for the rest of the run: its remaining subs are
  // skipped (no point re-paying the timeout per sub). The first real fetch IS the health
  // signal (D-4) — no separate preflight.
  const laneWorker = async (laneIdx: number): Promise<RedditCandidate[]> => {
    const fetchImpl = fetchers[laneIdx]
    const subs = perLane[laneIdx]
    const out: RedditCandidate[] = []
    let laneDown = false
    for (let j = 0; j < subs.length; j++) {
      if (Date.now() >= deadline) {
        logger.warn(`reddit gather: step budget (${stepBudgetMs}ms) exceeded; ${subs.length - j} sub(s) on lane ${laneIdx} skipped`)
        break
      }
      if (laneDown) break
      const subreddit = subs[j]
      if (delayMs > 0 && j > 0) await sleepImpl(delayMs) // same-IP cadence
      const url = rssApiUrl(subreddit, limit)
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
        parseFeed(await response.text(), subreddit, out)
      } catch (err) {
        // Network throw = lane transport failure (proxy down / black-hole timeout).
        // Mark the lane down so we don't re-pay the timeout for every remaining sub.
        const reason = sanitizeFetchError(err)
        const lane = lanes[laneIdx] ?? ''
        logger.warn(`reddit gather ${subreddit} via ${lane || 'direct'}: lane unreachable (${reason}); marking lane down, ${subs.length - j - 1} remaining sub(s) skipped`)
        laneDown = true
      }
    }
    return out
  }

  const laneResults = await Promise.all(fetchers.map((_, idx) => laneWorker(idx)))
  return laneResults.flat()
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
  const explicitSubs = allFlags('subreddit')
  const limit = intOf(flag('limit'), DEFAULT_LIMIT)
  const delayMs = flag('delay-ms') !== undefined ? intOf(flag('delay-ms'), DEFAULT_DELAY_MS) : undefined
  const stepBudgetMs = flag('step-budget-ms') !== undefined ? intOf(flag('step-budget-ms'), DEFAULT_STEP_BUDGET_MS) : undefined
  // --lane '' (direct) and/or --lane socks5://host:port (e.g. Starlink). Repeatable;
  // subreddits round-robin across them. Default: direct WAN only.
  const lanes = allFlags('lane')
  // --rotate [size] selects a day-seeded rotating subset of the curated AI set (D-10),
  // so a single run stays inside the per-IP RSS budget and all 9 subs are covered over
  // a <=2-day rotation. Explicit --subreddit flags override rotation. --rotate-day lets
  // a test/operator pin the day index deterministically.
  const wantRotate = process.argv.includes('--rotate')
  const rotateSize = intOf(flag('rotate'), DEFAULT_ROTATION_SIZE)
  const rotateDay = flag('rotate-day') !== undefined ? Number(flag('rotate-day')) : dayOfYearUTC()
  let subreddits: string[]
  if (explicitSubs.length) {
    subreddits = explicitSubs
  } else if (wantRotate) {
    subreddits = rotateSubreddits(CURATED_AI_SUBREDDITS, rotateDay, rotateSize)
  } else {
    subreddits = [...DEFAULT_SUBREDDITS]
  }
  const candidates = await gatherRedditPosts({
    subreddits,
    limit,
    delayMs,
    stepBudgetMs,
    lanes: lanes.length ? lanes : undefined,
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
