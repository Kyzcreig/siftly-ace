#!/usr/bin/env npx tsx
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SUBREDDITS = ['LocalLLaMA', 'MachineLearning']
const DEFAULT_LIMIT = 25
const USER_AGENT = 'siftly-ace reddit gatherer (https://github.com/Kyzcreig/siftly-ace)'
const ENGAGEMENT_NORMALIZE_MODULE: string = '../lib/engagement-normalize'

// --- Reddit app-only OAuth (durable fix for the datacenter-IP 403 on anon .json reads) ---
// Reddit blocks UNAUTHENTICATED .json reads from datacenter / non-residential IPs (Mac Studio
// host returns 403 on every UA + egress lane; the access_token endpoint returns 401, i.e. the
// IP is fine for AUTH). With a free app-only token we read via oauth.reddit.com and bypass the
// block. Creds (optional): REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET. Absent -> anon fallback.
const OAUTH_BASE = 'https://oauth.reddit.com'
const ANON_BASE = 'https://www.reddit.com'
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const TOKEN_SKEW_MS = 60_000 // refresh 60s before expiry

type TokenState = { token: string; expiresAt: number }
let tokenCache: TokenState | null = null
let tokenInFlight: Promise<string | null> | null = null

function readEnv(name: string): string | null {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

async function fetchAppOnlyToken(fetchImpl: FetchLike, logger: Logger): Promise<string | null> {
  const id = readEnv('REDDIT_CLIENT_ID')
  const secret = readEnv('REDDIT_CLIENT_SECRET')
  if (!id || !secret) return null
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt - TOKEN_SKEW_MS > now) return tokenCache.token
  if (tokenInFlight) return tokenInFlight
  const basic =
    typeof btoa === 'function'
      ? btoa(id + ':' + secret)
      : Buffer.from(id + ':' + secret).toString('base64')
  tokenInFlight = (async () => {
    try {
      const resp = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: 'grant_type=client_credentials',
      } as RequestInit)
      if (!resp.ok) {
        await drainJson(resp)
        logger.warn('reddit oauth: token endpoint HTTP ' + resp.status + '; falling back to anon reads')
        return null
      }
      const body = asRecord(await resp.json())
      const token = body && typeof body.access_token === 'string' ? body.access_token : null
      const ttl = body && typeof body.expires_in === 'number' ? body.expires_in : 3600
      if (!token) {
        logger.warn('reddit oauth: token response missing access_token; falling back to anon reads')
        return null
      }
      tokenCache = { token, expiresAt: Date.now() + ttl * 1000 }
      return token
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('reddit oauth: token fetch failed (' + message + '); falling back to anon reads')
      return null
    } finally {
      tokenInFlight = null
    }
  })()
  return tokenInFlight
}

/** Test-only: clear the module-level token cache so unit tests are hermetic. */
export function __resetRedditTokenCacheForTests(): void {
  tokenCache = null
  tokenInFlight = null
}

type NormalizeEngagement = (source: string, raw: number, n: number) => number

type Logger = { warn: (message: string) => void }

type FetchResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponse>

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
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

function cleanSummary(value: unknown): string {
  return text(value)?.replace(/\s+/g, ' ').slice(0, 600) ?? ''
}

function redditUrl(value: string): string | null {
  try {
    return new URL(value, 'https://www.reddit.com').href
  } catch {
    return null
  }
}

function redditApiUrl(subreddit: string, limit: number, base: string): string {
  const safeSubreddit = subreddit.replace(/^r\//i, '').replace(/[^A-Za-z0-9_]/g, '')
  return `${base}/r/${safeSubreddit}/hot.json?limit=${limit}`
}

function createdAtFromUtc(value: unknown): string | null {
  const seconds = finiteNumber(value)
  if (seconds <= 0) return null
  const ms = seconds * 1000
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

async function drainJson(response: FetchResponse): Promise<void> {
  try {
    await response.json()
  } catch {
    // Best-effort body drain so failed live fetches do not keep sockets open.
  }
}

function parsePost(child: unknown, subreddit: string, normalizeEngagement: NormalizeEngagement): RedditCandidate | null {
  const wrapper = asRecord(child)
  const data = asRecord(wrapper?.data)
  if (!data) return null

  const title = text(data.title)
  const url = text(data.url) ? redditUrl(String(data.url)) : null
  const permalink = text(data.permalink) ? redditUrl(String(data.permalink)) : null
  if (!title || (!url && !permalink)) return null

  const score = Math.max(0, Math.trunc(finiteNumber(data.score)))
  const upvotes = Math.max(0, Math.trunc(finiteNumber(data.ups || data.score)))
  const comments = Math.max(0, Math.trunc(finiteNumber(data.num_comments)))
  const summary = cleanSummary(data.selftext) || `r/${subreddit} • ${score} upvotes • ${comments} comments`
  const rawForNormalizer = score || upvotes
  const sampleSize = Math.max(rawForNormalizer + comments, 1)
  const author = text(data.author)

  return {
    title,
    url: url ?? permalink ?? '',
    summary,
    source: 'reddit',
    authorHandle: author ? `u/${author}` : null,
    engagement_raw: {
      score,
      upvotes,
      comments,
      normalized: clamp01(normalizeEngagement('reddit', rawForNormalizer, sampleSize)),
    },
    created_at: createdAtFromUtc(data.created_utc),
  }
}

export async function gatherRedditPosts(options: GatherRedditOptions = {}): Promise<RedditCandidate[]> {
  const subreddits = options.subreddits?.length ? options.subreddits : DEFAULT_SUBREDDITS
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? DEFAULT_LIMIT)))
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const logger = options.logger ?? { warn: (message: string) => console.error(message) }
  const normalizeEngagement = await loadNormalizeEngagement()
  const candidates: RedditCandidate[] = []

  const token = await fetchAppOnlyToken(fetchImpl, logger)
  const base = token ? OAUTH_BASE : ANON_BASE
  const baseHeaders: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (token) baseHeaders.Authorization = 'Bearer ' + token

  for (const subreddit of subreddits) {
    const apiUrl = redditApiUrl(subreddit, limit, base)
    let payload: unknown
    try {
      const response = await fetchImpl(apiUrl, { headers: baseHeaders })
      if (!response.ok) {
        await drainJson(response)
        logger.warn(`reddit gather ${subreddit}: HTTP ${response.status}; returning [] for that source`)
        continue
      }
      payload = await response.json()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`reddit gather ${subreddit}: malformed or unreachable source (${message}); returning [] for that source`)
      continue
    }

    const root = asRecord(payload)
    const data = asRecord(root?.data)
    const children = data?.children
    if (!Array.isArray(children)) {
      logger.warn(`reddit gather ${subreddit}: malformed payload; returning [] for that source`)
      continue
    }
    if (children.length === 0) {
      logger.warn(`reddit gather ${subreddit}: empty payload; returning [] for that source`)
      continue
    }

    let malformed = 0
    const before = candidates.length
    for (const child of children) {
      let parsed: RedditCandidate | null = null
      try {
        parsed = parsePost(child, subreddit, normalizeEngagement)
      } catch {
        parsed = null
      }
      if (parsed) candidates.push(parsed)
      else malformed += 1
    }
    if (malformed > 0) logger.warn(`reddit gather ${subreddit}: malformed post(s) ignored (${malformed})`)
    if (candidates.length === before && malformed === 0) {
      logger.warn(`reddit gather ${subreddit}: empty payload after filtering; returning [] for that source`)
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
  const candidates = await gatherRedditPosts({
    subreddits: subreddits.length ? subreddits : DEFAULT_SUBREDDITS,
    limit,
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
