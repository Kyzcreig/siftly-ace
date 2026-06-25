#!/usr/bin/env npx tsx
/**
 * x-search-fetch — paid-read-minimizing interest-search fetcher for the x-feed-brief cron (Wave 5 RC2).
 *
 * Replaces the 3 inline `xurl … /2/tweets/search/recent?query=…` calls in the brief prompt
 * with a read-through cache (lib/x-search-cache.ts). First run of the PT day pays (~$0.30);
 * same-day reruns within the TTL cost ZERO reads. Editing the query set invalidates the
 * cache automatically (key = hash of the sorted queries), so reruns never serve stale
 * results for a different query.
 *
 * Output (stdout): JSON { status, queriesFetched, readsApprox, cacheFile, day, results:[{query,data,users}] }
 * The `data`/`users` arrays are the RAW X API shapes the brief already knows how to match
 * (author_id -> includes.users[].id, verbatim text preserved). Logs go to stderr.
 *
 * Flags / env:
 *   --query "..."          repeatable; overrides the default interest query set
 *   --force / X_FEED_FRESH=1   bypass cache read, fetch fresh (still writes cache)
 *   --no-cache             neither read nor write cache
 *   --ttl-min N / X_FEED_CACHE_TTL_MIN
 *   --page-size N          max_results per query (default 20; cost-estimate only)
 *   --app NAME             xurl app (default siftly-ace)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import {
  fetchInterestSearches,
  DEFAULT_TTL_MINUTES,
  DEFAULT_PAGE_SIZE,
} from '../lib/x-search-cache'

const execFileAsync = promisify(execFile)
const DEFAULT_APP = 'siftly-ace'

// The brief's standing interest queries (kept in sync with the prompt's Step 1).
const DEFAULT_QUERIES = [
  'AI agents framework launch',
  'AI coding tool release',
  'open source model release',
]

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
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function intOf(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

interface SearchApiResponse {
  data?: unknown[]
  includes?: { users?: unknown[] }
  status?: number
  title?: string
  detail?: string
  errors?: unknown[]
}

function buildEndpoint(query: string, pageSize: number): string {
  const q = new URLSearchParams({
    query,
    max_results: String(pageSize),
    'tweet.fields': 'created_at,public_metrics,note_tweet',
    expansions: 'author_id',
    'user.fields': 'username,name',
  })
  return `/2/tweets/search/recent?${q.toString()}`
}

async function realFetchQuery(
  query: string,
  app: string,
  pageSize: number,
): Promise<{ data: unknown[]; users: unknown[] }> {
  const endpoint = buildEndpoint(query, pageSize)
  let parsed: SearchApiResponse
  try {
    const { stdout } = await execFileAsync('xurl', ['--auth', 'app', '--app', app, endpoint], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    parsed = JSON.parse(stdout) as SearchApiResponse
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const out = e.stdout ? String(e.stdout) : ''
    try {
      if (out.trim()) parsed = JSON.parse(out) as SearchApiResponse
      else throw new Error(e.stderr || e.message || 'xurl failed')
    } catch {
      const msg = e.stderr || e.message || 'xurl failed'
      if (/CreditsDepleted|\b402\b/i.test(msg)) throw new Error(`402 CreditsDepleted (interest search "${query}"): ${msg}`)
      throw new Error(`interest search "${query}" failed: ${msg}`)
    }
  }
  // Surface API-level errors as throws so the cache is NOT poisoned with an error body.
  const status = typeof parsed.status === 'number' ? parsed.status : undefined
  if (parsed.title || (Array.isArray(parsed.errors) && parsed.errors.length && !parsed.data) || (status && status >= 400)) {
    const label = parsed.title ?? status ?? 'unknown'
    if (/CreditsDepleted|\b402\b/i.test(String(label))) throw new Error(`402 CreditsDepleted (interest search "${query}")`)
    throw new Error(`interest search "${query}" API error: ${label} ${parsed.detail ?? ''}`.trim())
  }
  return { data: parsed.data ?? [], users: parsed.includes?.users ?? [] }
}

async function main(): Promise<number> {
  const app = flag('app') ?? DEFAULT_APP
  const ttlMinutes = intOf(flag('ttl-min') ?? process.env.X_FEED_CACHE_TTL_MIN, DEFAULT_TTL_MINUTES)
  const pageSize = intOf(flag('page-size'), DEFAULT_PAGE_SIZE)
  const force = has('force') || process.env.X_FEED_FRESH === '1'
  const noCache = has('no-cache')
  const queries = allFlags('query')
  const finalQueries = queries.length > 0 ? queries : DEFAULT_QUERIES

  const outcome = await fetchInterestSearches({
    queries: finalQueries,
    ttlMinutes,
    pageSize,
    force,
    noCache,
    fetchQuery: (query) => realFetchQuery(query, app, pageSize),
    logger: { log: (...a) => console.error(...a), warn: (...a) => console.error(...a) },
  })

  process.stdout.write(
    `${JSON.stringify({
      status: outcome.status,
      queriesFetched: outcome.queriesFetched,
      readsApprox: outcome.readsApprox,
      cacheFile: outcome.cacheFile,
      day: outcome.day,
      results: outcome.results,
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

export { buildEndpoint, realFetchQuery, DEFAULT_QUERIES }
