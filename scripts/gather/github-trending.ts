#!/usr/bin/env npx tsx
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SINCE = 'daily'
const GITHUB_TRENDING_BASE = 'https://github.com/trending'
const ENGAGEMENT_NORMALIZE_MODULE: string = '../lib/engagement-normalize'

type NormalizeEngagement = (source: string, raw: number, n: number) => number

type Logger = { warn: (message: string) => void }

type FetchResponse = {
  ok: boolean
  status: number
  text: () => Promise<string>
}

type FetchLike = (url: string) => Promise<FetchResponse>

export type GitHubTrendingCandidate = {
  title: string
  url: string
  summary: string
  source: 'github-trending'
  authorHandle: string | null
  engagement_raw: {
    stars: number
    forks: number
    starsToday: number
    normalized: number
  }
  created_at: string
}

export type GatherGitHubTrendingOptions = {
  language?: string
  since?: string
  fetchImpl?: FetchLike
  logger?: Logger
  now?: Date
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

function finiteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      } catch {
        return match
      }
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      } catch {
        return match
      }
    }
    return named[key] ?? match
  })
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function parseCount(value: string | undefined): number {
  if (!value) return 0
  const m = value.match(/([\d,.]+)\s*([kmb])?/i)
  if (!m) return 0
  const suffix = (m[2] ?? '').toLowerCase()
  const raw = suffix ? m[1].replace(/,/g, '') : m[1].replace(/[,.]/g, '')
  const base = Number(raw)
  if (!Number.isFinite(base)) return 0
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1
  const n = base * multiplier
  return Number.isFinite(n) ? Math.round(n) : 0
}

function buildTrendingUrl(language?: string, since = DEFAULT_SINCE): string {
  const suffix = language ? `/${encodeURIComponent(language)}` : ''
  return `${GITHUB_TRENDING_BASE}${suffix}?since=${encodeURIComponent(since)}`
}

function articleBlocks(html: string): string[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0])
}

function extractAnchor(block: string): { href: string; label: string } | null {
  const h2 = block.match(/<h2\b[\s\S]*?<\/h2>/i)?.[0] ?? block
  const anchor = h2.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
  if (!anchor) return null
  return { href: anchor[1], label: stripTags(anchor[2]) }
}

function repoParts(anchor: { href: string; label: string }): { owner: string; repo: string; url: string } | null {
  const fromLabel = anchor.label.replace(/\s+/g, '')
  const labelParts = fromLabel.split('/').filter(Boolean)
  const hrefPath = anchor.href.split(/[?#]/, 1)[0]
  const hrefParts = hrefPath.split('/').filter(Boolean)
  const owner = labelParts[0] ?? hrefParts[0]
  const repo = labelParts[1] ?? hrefParts[1]
  if (!owner || !repo) return null
  try {
    return { owner, repo, url: new URL(`/${owner}/${repo}`, 'https://github.com').href }
  } catch {
    return null
  }
}

function extractSummary(block: string): string {
  const paragraph = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
  return paragraph ? stripTags(paragraph).slice(0, 600) : ''
}

function extractLinkCount(block: string, suffix: 'stargazers' | 'forks'): number {
  const re = new RegExp(`<a\\b[^>]*href=["'][^"']*/${suffix}["'][^>]*>([\\s\\S]*?)<\\/a>`, 'i')
  return parseCount(stripTags(block.match(re)?.[1] ?? ''))
}

function parseArticle(block: string, createdAt: string, normalizeEngagement: NormalizeEngagement): GitHubTrendingCandidate | null {
  const anchor = extractAnchor(block)
  if (!anchor) return null
  const repo = repoParts(anchor)
  if (!repo) return null
  const stars = extractLinkCount(block, 'stargazers')
  const forks = extractLinkCount(block, 'forks')
  const starsToday = parseCount(stripTags(block).match(/[\d,.]+\s*[kmb]?\s+stars?\s+today/i)?.[0])
  const rawForNormalizer = starsToday || stars
  const sampleSize = Math.max(stars + forks, rawForNormalizer, 1)

  return {
    title: `${repo.owner}/${repo.repo}`,
    url: repo.url,
    summary: extractSummary(block),
    source: 'github-trending',
    authorHandle: repo.owner,
    engagement_raw: {
      stars,
      forks,
      starsToday,
      normalized: clamp01(normalizeEngagement('github-trending', rawForNormalizer, sampleSize)),
    },
    created_at: createdAt,
  }
}

export async function gatherGitHubTrending(options: GatherGitHubTrendingOptions = {}): Promise<GitHubTrendingCandidate[]> {
  const since = options.since ?? DEFAULT_SINCE
  const url = buildTrendingUrl(options.language, since)
  const fetchImpl: FetchLike = options.fetchImpl ?? ((target) => fetch(target))
  const logger = options.logger ?? { warn: (message: string) => console.error(message) }
  const normalizeEngagement = await loadNormalizeEngagement()

  let html: string
  try {
    const response = await fetchImpl(url)
    if (!response.ok) {
      try {
        await response.text()
      } catch {
        // Best-effort body drain so failed live fetches do not keep sockets open.
      }
      logger.warn(`github trending gather: HTTP ${response.status}; returning []`)
      return []
    }
    html = await response.text()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`github trending gather: unreachable or malformed source (${message}); returning []`)
    return []
  }

  const blocks = articleBlocks(html)
  if (blocks.length === 0) {
    logger.warn('github trending gather: empty HTML payload; returning []')
    return []
  }

  const createdAt = (options.now ?? new Date()).toISOString()
  const candidates: GitHubTrendingCandidate[] = []
  let malformed = 0
  for (const block of blocks) {
    let parsed: GitHubTrendingCandidate | null = null
    try {
      parsed = parseArticle(block, createdAt, normalizeEngagement)
    } catch {
      parsed = null
    }
    if (parsed) candidates.push(parsed)
    else malformed += 1
  }

  if (malformed > 0) logger.warn(`github trending gather: malformed article(s) ignored (${malformed})`)
  if (candidates.length === 0 && malformed === 0) {
    logger.warn('github trending gather: empty payload after filtering; returning []')
  }
  return candidates
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const candidates = await gatherGitHubTrending({
    language: flag('language'),
    since: flag('since') ?? DEFAULT_SINCE,
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

export { buildTrendingUrl }
