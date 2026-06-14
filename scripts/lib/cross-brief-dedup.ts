import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type CrossBriefDedupReason = 'url' | 'title'

export interface CrossBriefSeenInput {
  brief: string
  title: string
  url: string
  ptDay?: string
  surfacedAt?: Date | string
}

export interface CrossBriefDedupStoreOptions {
  dbPath?: string
  homeDir?: string
  ttlDays?: number
  titleSimilarityThreshold?: number
}

export interface CrossBriefDedupResult {
  duplicate: boolean
  reason?: CrossBriefDedupReason
  matchedBrief?: string
  matchedUrlCanonHash?: string
  titleSimilarity?: number
  advisory?: true
  ptDay: string
  canonicalUrl: string
  urlCanonHash: string
  titleMinhash: string
}

interface NormalizedCrossBriefSeenInput {
  brief: string
  ptDay: string
  canonicalUrl: string
  urlCanonHash: string
  titleMinhash: string
  surfacedAt: string
}

interface SeenRow {
  brief: string
  urlCanonHash: string
  titleMinhash: string
}

const DEFAULT_TTL_DAYS = 3
const DEFAULT_TITLE_SIMILARITY_THRESHOLD = 0.7
const MINHASH_SIZE = 128
const MIGRATION_PATH = fileURLToPath(new URL('./cross-brief-dedup.migration.sql', import.meta.url))
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src'])

export function resolveCrossBriefDedupDbPath(homeDir = homedir()): string {
  return path.join(homeDir, '.hermes', 'state', 'x-bookmarks', 'cross-brief-seen.db')
}

export function canonicalizeCrossBriefUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('cross-brief dedup URL is empty')

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(withScheme)
  const hostname = normalizeCrossBriefHostname(parsed.hostname)

  const isXHostFamily = hostname === 'x.com'
  const queryPairs = Array.from(parsed.searchParams.entries())
    .filter(([key]) => {
      const lowerKey = key.toLowerCase()
      if (lowerKey.startsWith('utm_')) return false
      if (TRACKING_PARAMS.has(lowerKey)) return false
      if (isXHostFamily && lowerKey === 's') return false
      return true
    })
    .sort(([aKey, aValue], [bKey, bValue]) => {
      const keyCmp = aKey.localeCompare(bKey)
      if (keyCmp !== 0) return keyCmp
      return aValue.localeCompare(bValue)
    })

  const pathname = parsed.pathname.replace(/\/+$/, '')
  const port = parsed.port ? `:${parsed.port}` : ''
  const query = queryPairs.length > 0 ? `?${new URLSearchParams(queryPairs).toString()}` : ''
  return `https://${hostname}${port}${pathname}${query}`
}

function normalizeCrossBriefHostname(rawHostname: string): string {
  let hostname = rawHostname.toLowerCase()
  if (hostname.startsWith('www.')) hostname = hostname.slice(4)

  // Only X/Twitter mobile host equivalence is folded; generic m./mobile. hosts can be distinct sites.
  const xFamilyHost = hostname.replace(/^(m|mobile)\./, '')
  if (xFamilyHost === 'x.com' || xFamilyHost === 'twitter.com') return 'x.com'
  return hostname
}

export function hashCanonicalUrl(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex')
}

export function computeTitleMinHash(title: string): string {
  const tokens = tokenizeTitle(title)
  if (tokens.length === 0) return ''

  const signature: string[] = []
  for (let seed = 0; seed < MINHASH_SIZE; seed += 1) {
    let min = 0xffffffff
    for (const token of tokens) {
      const hashed = fnv1a32(`${seed}:${token}`)
      if (hashed < min) min = hashed
    }
    signature.push(min.toString(36).padStart(7, '0'))
  }
  return signature.join('.')
}

export function titleMinHashSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const size = Math.min(leftParts.length, rightParts.length)
  if (size === 0) return 0

  let matches = 0
  for (let i = 0; i < size; i += 1) {
    if (leftParts[i] === rightParts[i]) matches += 1
  }
  return matches / size
}

export function ptDayForDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) throw new Error('failed to format PT day')
  return `${year}-${month}-${day}`
}

export class CrossBriefDedupStore {
  private readonly db: Database.Database
  private readonly ttlDays: number
  private readonly titleSimilarityThreshold: number

  constructor(options: CrossBriefDedupStoreOptions = {}) {
    const dbPath = options.dbPath ?? resolveCrossBriefDedupDbPath(options.homeDir)
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS
    this.titleSimilarityThreshold = options.titleSimilarityThreshold ?? DEFAULT_TITLE_SIMILARITY_THRESHOLD
    this.ensureSchema()
  }

  /**
   * Advisory read only. Use checkAndRemember() for the concurrency-safe dedup path;
   * a split check()+remember() can double-insert title-only duplicates.
   */
  check(input: CrossBriefSeenInput): CrossBriefDedupResult {
    const normalized = normalizeInput(input)
    return { ...this.checkNormalized(normalized), advisory: true }
  }

  remember(input: CrossBriefSeenInput): CrossBriefDedupResult {
    const normalized = normalizeInput(input)
    this.withImmediateTransaction(() => {
      this.evictExpiredUnsafe(normalized.ptDay)
      this.upsertNormalized(normalized)
    })
    return this.freshResult(normalized)
  }

  /** The only concurrency-safe check+write path. */
  checkAndRemember(input: CrossBriefSeenInput): CrossBriefDedupResult {
    const normalized = normalizeInput(input)
    return this.withImmediateTransaction(() => {
      this.evictExpiredUnsafe(normalized.ptDay)
      const seen = this.checkNormalized(normalized)
      if (!seen.duplicate) this.upsertNormalized(normalized)
      return seen
    })
  }

  evictExpired(currentPtDay: string): number {
    assertPtDay(currentPtDay)
    return this.withImmediateTransaction(() => this.evictExpiredUnsafe(currentPtDay))
  }

  close(): void {
    this.db.close()
  }

  private ensureSchema(): void {
    this.db.exec(readFileSync(MIGRATION_PATH, 'utf8'))
  }

  private checkNormalized(input: NormalizedCrossBriefSeenInput): CrossBriefDedupResult {
    const exact = this.db.prepare(`
      SELECT brief, url_canon_hash AS urlCanonHash, title_minhash AS titleMinhash
      FROM cross_brief_seen
      WHERE pt_day = ? AND url_canon_hash = ?
    `).get(input.ptDay, input.urlCanonHash) as SeenRow | undefined

    if (exact) {
      return {
        ...this.freshResult(input),
        duplicate: true,
        reason: 'url',
        matchedBrief: exact.brief,
        matchedUrlCanonHash: exact.urlCanonHash,
      }
    }

    const titleMatch = this.findTitleMatch(input.ptDay, input.titleMinhash)
    if (titleMatch) {
      return {
        ...this.freshResult(input),
        duplicate: true,
        reason: 'title',
        matchedBrief: titleMatch.brief,
        matchedUrlCanonHash: titleMatch.urlCanonHash,
        titleSimilarity: titleMatch.similarity,
      }
    }

    return this.freshResult(input)
  }

  private findTitleMatch(ptDay: string, titleMinhash: string): (SeenRow & { similarity: number }) | undefined {
    if (!titleMinhash) return undefined
    const rows = this.db.prepare(`
      SELECT brief, url_canon_hash AS urlCanonHash, title_minhash AS titleMinhash
      FROM cross_brief_seen
      WHERE pt_day = ?
    `).all(ptDay) as SeenRow[]

    let best: (SeenRow & { similarity: number }) | undefined
    for (const row of rows) {
      const similarity = titleMinHashSimilarity(titleMinhash, row.titleMinhash)
      if (similarity < this.titleSimilarityThreshold) continue
      if (!best || similarity > best.similarity) best = { ...row, similarity }
    }
    return best
  }

  private upsertNormalized(input: NormalizedCrossBriefSeenInput): void {
    this.db.prepare(`
      INSERT INTO cross_brief_seen (pt_day, url_canon_hash, title_minhash, brief, surfaced_at)
      VALUES (@ptDay, @urlCanonHash, @titleMinhash, @brief, @surfacedAt)
      ON CONFLICT(pt_day, url_canon_hash) DO UPDATE SET
        title_minhash = excluded.title_minhash,
        brief = excluded.brief,
        surfaced_at = excluded.surfaced_at
    `).run(input)
  }

  private evictExpiredUnsafe(currentPtDay: string): number {
    const cutoff = shiftPtDay(currentPtDay, -this.ttlDays)
    const info = this.db.prepare('DELETE FROM cross_brief_seen WHERE pt_day <= ?').run(cutoff)
    return info.changes
  }

  private freshResult(input: NormalizedCrossBriefSeenInput): CrossBriefDedupResult {
    return {
      duplicate: false,
      ptDay: input.ptDay,
      canonicalUrl: input.canonicalUrl,
      urlCanonHash: input.urlCanonHash,
      titleMinhash: input.titleMinhash,
    }
  }

  private withImmediateTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      throw err
    }
  }
}

function normalizeInput(input: CrossBriefSeenInput): NormalizedCrossBriefSeenInput {
  const brief = input.brief.trim()
  if (!brief) throw new Error('cross-brief dedup brief is empty')

  const surfacedAt = normalizeSurfacedAt(input.surfacedAt)
  const ptDay = input.ptDay ?? ptDayForDate(new Date(surfacedAt))
  assertPtDay(ptDay)
  const canonicalUrl = canonicalizeCrossBriefUrl(input.url)
  return {
    brief,
    ptDay,
    canonicalUrl,
    urlCanonHash: hashCanonicalUrl(canonicalUrl),
    titleMinhash: computeTitleMinHash(input.title),
    surfacedAt,
  }
}

function normalizeSurfacedAt(input: Date | string | undefined): string {
  const date = input instanceof Date ? input : new Date(input ?? Date.now())
  return date.toISOString()
}

function assertPtDay(ptDay: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ptDay)) throw new Error(`invalid PT day: ${ptDay}`)
}

function shiftPtDay(ptDay: string, days: number): string {
  assertPtDay(ptDay)
  const [year, month, day] = ptDay.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function tokenizeTitle(title: string): string[] {
  return Array.from(new Set(title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .match(/[a-z0-9]+/g) ?? []))
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
