#!/usr/bin/env npx tsx
/**
 * x-feed-fetch — paid-read-minimizing timeline fetcher for the x-feed-brief cron.
 *
 * Replaces the inline `xurl` pagination loop in the brief prompt with a read-through
 * cache (lib/x-feed-cache.ts). First run/day pays (~$6.50); same-day reruns within
 * the TTL cost ZERO reads; stale reruns do a cheap incremental top-up.
 *
 * Output (stdout): JSON { status, pagesFetched, newCount, tweetCount, since, candidates:[...] }
 * where candidates are {id, source:"x", text, authorHandle, url, public_metrics} so the
 * brief can score directly. Logs go to stderr so stdout stays parseable.
 *
 * Flags / env:
 *   --force / X_FEED_FRESH=1   bypass cache read, full fresh sweep (still writes cache)
 *   --no-cache                 neither read nor write cache
 *   --ttl-min N / X_FEED_CACHE_TTL_MIN
 *   --since-hours N
 *   --max-pages N
 *   --user-id ID
 *   --app NAME (xurl app, default siftly-ace)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import {
  fetchTimeline,
  type FeedPage,
  type FetchOutcome,
  DEFAULT_USER_ID,
  DEFAULT_SINCE_HOURS,
  DEFAULT_MAX_PAGES,
  DEFAULT_TTL_MINUTES,
} from '../lib/x-feed-cache'

const execFileAsync = promisify(execFile)
const DEFAULT_APP = 'siftly-ace'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function intOf(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function buildEndpoint(userId: string, paginationToken: string | undefined): string {
  const q = new URLSearchParams({
    max_results: '100',
    'tweet.fields': 'created_at,public_metrics,note_tweet',
    expansions: 'author_id',
    'user.fields': 'username,name',
  })
  if (paginationToken) q.set('pagination_token', paginationToken)
  return `/2/users/${userId}/timelines/reverse_chronological?${q.toString()}`
}

async function realFetchPage(userId: string, app: string, token: string | undefined): Promise<FeedPage> {
  const endpoint = buildEndpoint(userId, token)
  try {
    const { stdout } = await execFileAsync('xurl', ['--app', app, endpoint], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(stdout) as FeedPage
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const out = e.stdout ? String(e.stdout) : ''
    try {
      if (out.trim()) return JSON.parse(out) as FeedPage
    } catch { /* fall through */ }
    const msg = e.stderr || e.message || 'xurl failed'
    // 402 = out of credits (billing). Surface it clearly.
    if (/CreditsDepleted|\b402\b/i.test(msg)) {
      return { status: 402, title: 'CreditsDepleted', detail: msg }
    }
    return { status: 500, title: 'xurl-error', detail: msg }
  }
}

function toCandidates(outcome: FetchOutcome): unknown[] {
  const usersById = new Map(outcome.users.map((u) => [u.id, u]))
  return outcome.tweets.map((t) => {
    const u = t.author_id ? usersById.get(t.author_id) : undefined
    const handle = u?.username
    return {
      id: t.id,
      source: 'x',
      // Long ("note") tweets: v2 returns the FULL body in note_tweet.text (flat shape),
      // while top-level text is the ~280-char truncation. Prefer the full body.
      text: ((t.note_tweet as { text?: string } | undefined)?.text) || t.text || '',
      authorHandle: handle ?? null,
      authorName: u?.name ?? null,
      url: handle ? `https://x.com/${handle}/status/${t.id}` : null,
      created_at: t.created_at ?? null,
      public_metrics: t.public_metrics ?? {},
    }
  })
}

async function main(): Promise<number> {
  const userId = flag('user-id') ?? DEFAULT_USER_ID
  const app = flag('app') ?? DEFAULT_APP
  const ttlMinutes = intOf(flag('ttl-min') ?? process.env.X_FEED_CACHE_TTL_MIN, DEFAULT_TTL_MINUTES)
  const sinceHours = intOf(flag('since-hours'), DEFAULT_SINCE_HOURS)
  const maxPages = intOf(flag('max-pages'), DEFAULT_MAX_PAGES)
  const force = has('force') || process.env.X_FEED_FRESH === '1'
  const noCache = has('no-cache')

  const outcome = await fetchTimeline({
    userId,
    sinceHours,
    maxPages,
    ttlMinutes,
    force,
    noCache,
    fetchPage: (token) => realFetchPage(userId, app, token),
    logger: { log: (...a) => console.error(...a), warn: (...a) => console.error(...a) },
  })

  const candidates = toCandidates(outcome)
  process.stdout.write(
    `${JSON.stringify({
      status: outcome.status,
      pagesFetched: outcome.pagesFetched,
      newCount: outcome.newCount,
      tweetCount: outcome.tweets.length,
      since: outcome.meta.since,
      cacheFile: outcome.cacheFile,
      candidates,
    })}\n`,
  )
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

export { buildEndpoint, toCandidates }
