#!/usr/bin/env npx tsx
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import { userInfo } from 'node:os'
import path, { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDatabasePath } from '../src/lib/vec'

export type PreferenceSource = 'bookmark' | 'like'
export type PreferenceSegment = 'brief-relevant' | 'everything-else'

type JsonRecord = Record<string, unknown>

export interface PreferenceProfileRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: PreferenceSource | string
  tweetCreatedAt: string | null
  semanticTags: string[]
  categoryNames: string[]
  categorySlugs: string[]
  entities: JsonRecord
  enrichmentMeta: JsonRecord
  embedding?: number[]
}

export interface PreferenceProfileTopic {
  name: string
  weight: number
  segment: PreferenceSegment
}

export interface PreferenceProfileAuthor {
  handle: string
  saves: number
  weight: number
}

export interface PreferenceProfile {
  updated_at: string
  corpus_size: { bookmarks: number; likes: number }
  signal_basis?: { mode: 'whole-corpus' | 'brief-relevant-only'; signal_rows: number }
  top_topics: PreferenceProfileTopic[]
  high_signal_authors: PreferenceProfileAuthor[]
  favorite_formats: string[]
  downrank_patterns: string[]
  novelty_profile: { evergreen_ratio: number }
  scoring_guidance: string
}

export interface BuildPreferenceProfileOptions {
  now?: string | Date
  topTopicLimit?: number
  authorLimit?: number
  formatLimit?: number
  logger?: Pick<Console, 'warn'>
  // When true, only `brief-relevant` rows contribute to the topic/author/format
  // signal. This de-contaminates the personal-fit profile so it rewards
  // digest-taste (AI/dev/startups) instead of doom-scroll-taste (politics-heavy
  // whole-corpus saves). Calibration ground-truth (2026-06-11): every actionable
  // bookmark that missed TOP_GATE carried pf=-3 because the whole-corpus profile's
  // top author was @elonmusk (260 saves) + top topics included politics.
  briefRelevantOnly?: boolean
}

export interface PreferenceArtifactsOptions {
  jsonPath?: string
  obsidianDir?: string
  markdownPath?: string
}

export interface PreferenceArtifactsResult {
  jsonPath: string
  markdownPath: string
}

interface DbProfileRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  tweetCreatedAt: string | null
  semanticTags: string | null
  entities: string | null
  enrichmentMeta: string | null
  categoryNames: string | null
  categorySlugs: string | null
  vectorJson: string | null
}

interface RowSignals {
  row: PreferenceProfileRow
  weight: number
  source: PreferenceSource
  segment: PreferenceSegment
  circular: boolean
  topics: string[]
  formats: string[]
  negatives: string[]
}

interface WeightedBucket {
  weight: number
  count: number
  segmentWeights: Map<PreferenceSegment, number>
}

const TOPIC_LIMIT = 30
const AUTHOR_LIMIT = 30
const FORMAT_LIMIT = 20
const EMBEDDING_CLUSTER_LIMIT = 12
const EMBEDDING_CLUSTER_ITERATIONS = 6
const EMBEDDING_CLUSTER_DIMS = 32

export const DEFAULT_PROFILE_JSON_PATH = path.join(userInfo().homedir, '.hermes', 'state', 'x-bookmarks', 'preference-profile.json')
// Phase 3 gbrain cutover (2026-07-08): the preference-profile MARKDOWN is the
// human-readable taste doc Ace reads in Obsidian — it deliberately KEEPS its
// vault home even though the bookmark-note exporter (DEFAULT_OBSIDIAN_EXPORT_DIR
// in src/lib/obsidian/export.ts) moved to the gbrain brain repo. The constant is
// therefore split from DEFAULT_OBSIDIAN_EXPORT_DIR: this doc is a derived
// artifact rebuilt nightly (daily-ingest's soft `profile` stage), so it doesn't
// belong in the rebuildable-source brain repo, and gbrain ingests the vault copy
// anyway via brain/vault.
export const DEFAULT_PROFILE_OBSIDIAN_DIR = '/Users/alexgierczyk/Obsidian/Ace Place/Content/'
export const DEFAULT_PROFILE_MARKDOWN_FILENAME = 'Ace Bookmark Preference Profile.md'
export const NOVELTY_DISABLED_NOTE = 'Novelty calibration disabled: X API bookmark/like payloads do not expose saved_at or liked_at; importedAt is ingestion time, so evergreen_ratio is fixed at 0.'

const BRIEF_RELEVANT_CATEGORY_SLUGS = new Set([
  'ai-ml',
  'ai',
  'ml',
  'ai-resources',
  'dev-tools',
  'developer-tools',
  'crypto-web3',
  'crypto',
  'web3',
  'startups-business',
  'startups',
  'business',
  'security',
  'security-privacy',
  'productivity',
  'finance',
])

const FACTUAL_FORMAT_FLAGS = new Set([
  'is_thread',
  'is_single',
  'is_quote',
  'is_reply',
  'has_code',
  'is_launch',
  'is_benchmark',
  'has_image',
  'has_video',
  'has_gif',
])

const NEGATIVE_PREFIXES = ['contrast:', 'negative:', 'downrank:', 'discarded:', 'auto-zeroed:']

// Topic canonicalization: collapse semantically-identical labels that otherwise
// fragment weight across near-duplicate buckets (e.g. `developer-tools`,
// `dev-tools-and-engineering`, `embedding-cluster:dev-tools` all === `dev-tools`).
// The `embedding-cluster:` prefix is stripped so a semantic cluster folds into its
// base topic instead of forming a parallel inflated bucket.
const TOPIC_SYNONYMS: Record<string, string> = {
  'developer-tools': 'dev-tools',
  'dev-tools-and-engineering': 'dev-tools',
  'developer-tooling': 'dev-tools',
  'ai-and-machine-learning': 'ai-ml',
  'machine-learning': 'ai-ml',
  'artificial-intelligence': 'ai-ml',
  'ai-and-ml': 'ai-ml',
  'startups-and-business': 'startups-business',
  'startups-and-businesses': 'startups-business',
  'finance-and-investing': 'finance',
  'finance-investing': 'finance',
  'investing': 'finance',
  'technology-business': 'tech-industry',
  'tech-and-business': 'tech-industry',
}

export function canonicalizeTopic(value: string): string {
  let key = normalizeTopic(value)
  if (key.startsWith('embedding-cluster-')) key = key.slice('embedding-cluster-'.length)
  if (key.startsWith('embedding-cluster:')) key = key.slice('embedding-cluster:'.length)
  return TOPIC_SYNONYMS[key] ?? key
}

// Topics Ace has explicitly opted OUT of, regardless of corpus weight. These are
// dropped at aggregation time so they never enter top_topics / the taste vector,
// even though the underlying bookmarks still count toward the TRUE corpus_size.
// Crypto/web3: Ace stated "I don't care about crypto at all" (2026-06-14) — the
// corpus shows finance as #1 by weight, but the crypto-specific slice is excluded
// so a BNB/Binance/token post can't earn a personal-fit nudge. `finance` (markets,
// investing, money) is NOT excluded — only the crypto-tagged buckets.
const EXCLUDED_TOPICS = new Set<string>([
  'crypto', 'crypto-web3', 'crypto-and-web3', 'finance-crypto', 'web3',
  'blockchain', 'cryptocurrency', 'defi', 'nft', 'nfts',
])

export function isExcludedTopic(value: string): boolean {
  return EXCLUDED_TOPICS.has(canonicalizeTopic(value))
}

export function loadProfileRowsFromDatabase(dbPath: string): PreferenceProfileRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`
      SELECT
        b.id,
        b.tweetId,
        b.text,
        b.authorHandle,
        b.authorName,
        b.source,
        b.tweetCreatedAt,
        b.semanticTags,
        b.entities,
        b.enrichmentMeta,
        group_concat(DISTINCT c.name) AS categoryNames,
        group_concat(DISTINCT c.slug) AS categorySlugs,
        e.vector_json AS vectorJson
      FROM Bookmark b
      LEFT JOIN BookmarkCategory bc ON bc.bookmarkId = b.id
      LEFT JOIN Category c ON c.id = bc.categoryId
      LEFT JOIN bookmark_embeddings e ON e.bookmark_id = b.id
      GROUP BY b.id
      ORDER BY COALESCE(b.tweetCreatedAt, b.importedAt) DESC, b.id ASC
    `).all() as DbProfileRow[]

    return rows.map((row) => ({
      id: row.id,
      tweetId: row.tweetId,
      text: row.text,
      authorHandle: row.authorHandle,
      authorName: row.authorName,
      source: normalizeSource(row.source),
      tweetCreatedAt: row.tweetCreatedAt,
      semanticTags: parseJsonStringArray(row.semanticTags),
      categoryNames: splitGroupConcat(row.categoryNames),
      categorySlugs: splitGroupConcat(row.categorySlugs),
      entities: parseJsonRecord(row.entities),
      enrichmentMeta: parseJsonRecord(row.enrichmentMeta),
      embedding: parseVector(row.vectorJson),
    }))
  } finally {
    db.close()
  }
}

export function buildPreferenceProfile(rows: PreferenceProfileRow[], options: BuildPreferenceProfileOptions = {}): PreferenceProfile {
  const logger = options.logger ?? console
  logger.warn(NOVELTY_DISABLED_NOTE)

  const analyzedRows = rows.map(analyzeRow)
  const clusterTags = embeddingClusterTags(analyzedRows)
  const topicBuckets = new Map<string, WeightedBucket>()
  const authorBuckets = new Map<string, WeightedBucket>()
  const formatBuckets = new Map<string, WeightedBucket>()
  const negativeBuckets = new Map<string, WeightedBucket>()
  const corpusSize = { bookmarks: 0, likes: 0 }
  const briefRelevantOnly = options.briefRelevantOnly ?? false
  let signalRows = 0

  for (const signals of analyzedRows) {
    if (signals.source === 'bookmark') corpusSize.bookmarks += 1
    else corpusSize.likes += 1

    // (c) Personal-fit de-contamination: when briefRelevantOnly is set, skip
    // everything-else rows entirely so politics/memes/health do NOT shape the
    // taste vector. corpusSize above still reflects the TRUE corpus.
    if (briefRelevantOnly && signals.segment !== 'brief-relevant') continue
    signalRows += 1

    for (const format of signals.formats) {
      addWeighted(formatBuckets, format, signals.weight, signals.segment)
    }
    for (const negative of signals.negatives) {
      addWeighted(negativeBuckets, negative, signals.weight, signals.segment)
    }

    if (signals.circular) continue

    for (const topic of signals.topics) {
      const canon = canonicalizeTopic(topic)
      if (EXCLUDED_TOPICS.has(canon)) continue // opted-out topic (e.g. crypto) — never reinforce
      addWeighted(topicBuckets, canon, signals.weight, signals.segment)
    }
    const clusterTag = clusterTags.get(signals.row.id)
    if (clusterTag) {
      const canonCluster = canonicalizeTopic(clusterTag)
      if (!EXCLUDED_TOPICS.has(canonCluster)) addWeighted(topicBuckets, canonCluster, signals.weight, signals.segment)
    }

    const handle = normalizeHandle(signals.row.authorHandle)
    if (handle) addWeighted(authorBuckets, handle, signals.weight, signals.segment)
  }

  return {
    updated_at: isoNow(options.now),
    corpus_size: corpusSize,
    signal_basis: {
      mode: briefRelevantOnly ? 'brief-relevant-only' : 'whole-corpus',
      signal_rows: signalRows,
    },
    top_topics: sortedBuckets(topicBuckets)
      .slice(0, options.topTopicLimit ?? TOPIC_LIMIT)
      .map(([name, bucket]) => ({ name, weight: roundWeight(bucket.weight), segment: dominantSegment(bucket) })),
    high_signal_authors: sortedBuckets(authorBuckets)
      .slice(0, options.authorLimit ?? AUTHOR_LIMIT)
      .map(([handle, bucket]) => ({ handle, saves: bucket.count, weight: roundWeight(bucket.weight) })),
    favorite_formats: sortedBuckets(formatBuckets)
      .slice(0, options.formatLimit ?? FORMAT_LIMIT)
      .map(([format]) => format),
    downrank_patterns: sortedBuckets(negativeBuckets).map(([pattern]) => pattern),
    novelty_profile: { evergreen_ratio: 0 },
    scoring_guidance: [
      'Use source weights bookmark=1.0 and like=0.3.',
      'Use top_topics, high_signal_authors, and favorite_formats as additive personal-fit signals only.',
      'Apply circularity guard: rows tagged origin:brief-surfaced are excluded from topic/source affinity reinforcement.',
      'Novelty calibration disabled because saved_at/liked_at are unavailable; do not substitute importedAt.',
      'No why saved inference is emitted or consumed.',
    ].join(' '),
  }
}

export async function writePreferenceArtifacts(
  profile: PreferenceProfile,
  options: PreferenceArtifactsOptions = {},
): Promise<PreferenceArtifactsResult> {
  const jsonPath = options.jsonPath ?? DEFAULT_PROFILE_JSON_PATH
  const obsidianDir = options.obsidianDir ?? DEFAULT_PROFILE_OBSIDIAN_DIR
  const markdownPath = options.markdownPath ?? path.join(obsidianDir, DEFAULT_PROFILE_MARKDOWN_FILENAME)

  await fs.mkdir(path.dirname(jsonPath), { recursive: true })
  await fs.mkdir(path.dirname(markdownPath), { recursive: true })
  // (#1) Atomic JSON write: write to a temp sibling then rename, so a crash
  // mid-write can't leave a half-written profile that pf-score.py then parses.
  // The markdown artifact is non-load-bearing and stays a direct write.
  const jsonTmp = `${jsonPath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(jsonTmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  await fs.rename(jsonTmp, jsonPath)
  await fs.writeFile(markdownPath, buildPreferenceMarkdown(profile), 'utf8')
  return { jsonPath, markdownPath }
}

export async function runPreferenceProfile(options: { briefRelevantOnly?: boolean } = {}): Promise<PreferenceArtifactsResult & { rows: number; profile: PreferenceProfile }> {
  const dbPath = resolveDatabasePath(process.env.DATABASE_URL, process.cwd())
  const rows = loadProfileRowsFromDatabase(dbPath)
  const profile = buildPreferenceProfile(rows, { briefRelevantOnly: options.briefRelevantOnly })
  const artifacts = await writePreferenceArtifacts(profile)
  return { ...artifacts, rows: rows.length, profile }
}

function analyzeRow(row: PreferenceProfileRow): RowSignals {
  const source = normalizeSource(row.source)
  const weight = sourceWeight(source)
  const formats = extractFormatFlags(row)
  return {
    row,
    source,
    weight,
    formats,
    segment: resolveSegment(row, formats),
    circular: isBriefSurfaced(row),
    topics: extractTopicTags(row),
    negatives: extractNegativePatterns(row),
  }
}

function extractTopicTags(row: PreferenceProfileRow): string[] {
  const meta = row.enrichmentMeta
  const entities = row.entities
  const candidates = [
    ...row.semanticTags,
    ...row.categoryNames,
    ...row.categorySlugs,
    ...recordStringArray(meta, 'topicTags'),
    ...recordStringArray(meta, 'categories'),
    ...recordStringArray(entities, 'hashtags'),
    ...recordStringArray(entities, 'tools'),
    ...contextAnnotationTags(entities),
  ]
  const topics = new Set<string>()
  for (const value of candidates) {
    if (isOriginBriefSurfaced(value) || negativePattern(value)) continue
    const normalized = normalizeTopic(value)
    if (normalized) topics.add(normalized)
  }
  return [...topics]
}

function extractNegativePatterns(row: PreferenceProfileRow): string[] {
  const candidates = [
    ...row.semanticTags,
    ...recordStringArray(row.enrichmentMeta, 'topicTags'),
    ...recordStringArray(row.enrichmentMeta, 'categories'),
    ...recordStringArray(row.enrichmentMeta, 'negativePatterns'),
    ...recordStringArray(row.enrichmentMeta, 'downrankPatterns'),
  ]
  const patterns = new Set<string>()
  for (const value of candidates) {
    const pattern = negativePattern(value)
    if (pattern) patterns.add(pattern)
  }
  return [...patterns]
}

function extractFormatFlags(row: PreferenceProfileRow): string[] {
  const formats = new Set<string>()
  const formatFlags = jsonRecord(row.enrichmentMeta.formatFlags)
  const explicitFormat = stringValue(formatFlags.format)
  if (explicitFormat) formats.add(`format:${normalizeTopic(explicitFormat)}`)

  for (const [key, value] of Object.entries(formatFlags)) {
    if (FACTUAL_FORMAT_FLAGS.has(key) && value === true) formats.add(key)
  }

  for (const mediaType of recordStringArray(formatFlags, 'media_types')) {
    const normalized = normalizeTopic(mediaType)
    if (normalized) formats.add(`media:${normalized}`)
  }

  const tweetType = stringValue(row.entities.tweetType)
  if (tweetType) {
    const normalized = normalizeTopic(tweetType)
    if (normalized) formats.add(`format:${normalized}`)
    if (normalized === 'thread') formats.add('is_thread')
    if (normalized === 'quote') formats.add('is_quote')
    if (normalized === 'single') formats.add('is_single')
    if (normalized === 'reply') formats.add('is_reply')
  }

  return [...formats]
}

function embeddingClusterTags(rows: RowSignals[]): Map<string, string> {
  const candidates = rows.filter((signals) => !signals.circular && signals.row.embedding && signals.row.embedding.length > 0)
  const result = new Map<string, string>()
  if (candidates.length < 2) return result

  const k = Math.min(
    EMBEDDING_CLUSTER_LIMIT,
    candidates.length,
    Math.max(2, Math.round(Math.sqrt(candidates.length / 24))),
  )
  const featureRows = candidates.map((signals) => ({ signals, features: vectorFeatures(signals.row.embedding ?? []) }))
  let centroids = initializeCentroids(featureRows.map((row) => row.features), k)
  let assignments = new Array<number>(featureRows.length).fill(0)

  for (let iteration = 0; iteration < EMBEDDING_CLUSTER_ITERATIONS; iteration++) {
    assignments = featureRows.map((row) => nearestCentroid(row.features, centroids))
    centroids = recomputeCentroids(featureRows.map((row) => row.features), assignments, centroids)
  }

  const labels = new Map<number, string>()
  for (let cluster = 0; cluster < k; cluster++) {
    const tagWeights = new Map<string, number>()
    for (let index = 0; index < assignments.length; index++) {
      if (assignments[index] !== cluster) continue
      for (const topic of featureRows[index].signals.topics) {
        addNumber(tagWeights, topic, featureRows[index].signals.weight)
      }
    }
    const topTag = [...tagWeights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
    labels.set(cluster, `embedding-cluster:${topTag ?? `cluster-${cluster + 1}`}`)
  }

  for (let index = 0; index < assignments.length; index++) {
    const label = labels.get(assignments[index])
    if (label) result.set(featureRows[index].signals.row.id, label)
  }
  return result
}

function vectorFeatures(vector: number[]): number[] {
  if (vector.length <= EMBEDDING_CLUSTER_DIMS) return vector.map(safeNumber)
  const features: number[] = []
  for (let i = 0; i < EMBEDDING_CLUSTER_DIMS; i++) {
    const index = Math.floor(i * (vector.length - 1) / (EMBEDDING_CLUSTER_DIMS - 1))
    features.push(safeNumber(vector[index]))
  }
  return features
}

function initializeCentroids(vectors: number[][], k: number): number[][] {
  const centroids: number[][] = []
  for (let i = 0; i < k; i++) {
    const index = Math.floor(i * (vectors.length - 1) / Math.max(1, k - 1))
    centroids.push([...vectors[index]])
  }
  return centroids
}

function nearestCentroid(vector: number[], centroids: number[][]): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < centroids.length; i++) {
    const distance = squaredDistance(vector, centroids[i])
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

function recomputeCentroids(vectors: number[][], assignments: number[], previous: number[][]): number[][] {
  const sums = previous.map((centroid) => new Array<number>(centroid.length).fill(0))
  const counts = previous.map(() => 0)
  for (let i = 0; i < vectors.length; i++) {
    const cluster = assignments[i]
    counts[cluster] += 1
    for (let dim = 0; dim < vectors[i].length; dim++) {
      sums[cluster][dim] += vectors[i][dim]
    }
  }
  return sums.map((sum, cluster) => {
    const count = counts[cluster]
    if (count === 0) return previous[cluster]
    return sum.map((value) => value / count)
  })
}

function squaredDistance(left: number[], right: number[]): number {
  let distance = 0
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const delta = left[i] - right[i]
    distance += delta * delta
  }
  return distance
}

function resolveSegment(row: PreferenceProfileRow, formats: string[]): PreferenceSegment {
  const metaSegment = stringValue(row.enrichmentMeta.segment)
  if (metaSegment === 'brief-relevant' || metaSegment === 'everything-else') return metaSegment

  const categorySignals = [...row.categorySlugs, ...row.categoryNames.map(normalizeTopic)]
  const hasBriefCategory = categorySignals.some((value) => BRIEF_RELEVANT_CATEGORY_SLUGS.has(value))
  const hasBriefFormat = formats.some((format) => format === 'is_launch' || format === 'is_benchmark' || format === 'has_code')
  return hasBriefCategory || hasBriefFormat ? 'brief-relevant' : 'everything-else'
}

function isBriefSurfaced(row: PreferenceProfileRow): boolean {
  const values = [
    ...row.semanticTags,
    ...row.categoryNames,
    ...row.categorySlugs,
    ...recordStringArray(row.enrichmentMeta, 'topicTags'),
    ...recordStringArray(row.enrichmentMeta, 'categories'),
    ...recordStringArray(row.entities, 'hashtags'),
    stringValue(row.enrichmentMeta.origin),
    stringValue(row.entities.origin),
  ]
  return values.some(isOriginBriefSurfaced)
}

function isOriginBriefSurfaced(value: string): boolean {
  return value.trim().toLowerCase().replace(/\s+/g, '') === 'origin:brief-surfaced'
    || normalizeTopic(value) === 'origin-brief-surfaced'
}

function negativePattern(value: string): string | null {
  const lower = value.trim().toLowerCase()
  for (const prefix of NEGATIVE_PREFIXES) {
    if (!lower.startsWith(prefix)) continue
    const pattern = normalizeTopic(value.slice(prefix.length))
    return pattern || null
  }
  return null
}

function contextAnnotationTags(entities: JsonRecord): string[] {
  const raw = entities.contextAnnotations
  if (!Array.isArray(raw)) return []
  const tags: string[] = []
  for (const item of raw) {
    const record = jsonRecord(item)
    const entity = jsonRecord(record.entity)
    const name = stringValue(entity.name)
    if (name) tags.push(name)
  }
  return tags
}

function addWeighted(buckets: Map<string, WeightedBucket>, key: string, weight: number, segment: PreferenceSegment): void {
  const existing = buckets.get(key) ?? { weight: 0, count: 0, segmentWeights: new Map<PreferenceSegment, number>() }
  existing.weight += weight
  existing.count += 1
  addNumber(existing.segmentWeights, segment, weight)
  buckets.set(key, existing)
}

function addNumber(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value)
}

function sortedBuckets(buckets: Map<string, WeightedBucket>): Array<[string, WeightedBucket]> {
  return [...buckets.entries()].sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
}

function dominantSegment(bucket: WeightedBucket): PreferenceSegment {
  const segments = [...bucket.segmentWeights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return segments[0]?.[0] ?? 'everything-else'
}

function normalizeSource(value: string): PreferenceSource {
  return value === 'bookmark' ? 'bookmark' : 'like'
}

function sourceWeight(source: PreferenceSource): number {
  return source === 'bookmark' ? 1 : 0.3
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, '')
}

function normalizeTopic(value: string): string {
  return value
    .trim()
    .replace(/^#/, '')
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function recordStringArray(record: JsonRecord, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.map(String))
}

function parseJsonStringArray(raw: string | null): string[] {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return []
  return uniqueStrings(parsed.map(String))
}

function parseJsonRecord(raw: string | null): JsonRecord {
  return jsonRecord(parseJson(raw))
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function parseVector(raw: string | null): number[] | undefined {
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return undefined
  const vector = parsed.map(safeNumber).filter((value) => Number.isFinite(value))
  return vector.length > 0 ? vector : undefined
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function splitGroupConcat(value: string | null): string[] {
  if (!value) return []
  return uniqueStrings(value.split(',').map((item) => item.trim()))
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function safeNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function roundWeight(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function isoNow(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  return new Date().toISOString()
}

function buildPreferenceMarkdown(profile: PreferenceProfile): string {
  return [
    '---',
    'type: "x-bookmark-preference-profile"',
    `updated_at: "${profile.updated_at}"`,
    `bookmarks: ${profile.corpus_size.bookmarks}`,
    `likes: ${profile.corpus_size.likes}`,
    '---',
    '',
    '# Ace Bookmark Preference Profile',
    '',
    `Generated from ${profile.corpus_size.bookmarks} bookmarks and ${profile.corpus_size.likes} likes.`,
    '',
    '## Scoring guidance',
    '',
    profile.scoring_guidance,
    '',
    'Novelty calibration is disabled because the X API does not expose saved_at / liked_at. importedAt is ingestion time, not save time.',
    '',
    'No why-saved inference is included; all signals below are factual/observable.',
    '',
    '## Top topics',
    '',
    markdownRows(profile.top_topics.map((topic) => `- ${topic.name} (${topic.weight}, ${topic.segment})`)),
    '',
    '## High-signal authors',
    '',
    markdownRows(profile.high_signal_authors.map((author) => `- @${author.handle} (${author.weight} weighted saves, ${author.saves} rows)`)),
    '',
    '## Favorite formats',
    '',
    markdownRows(profile.favorite_formats.map((format) => `- ${format}`)),
    '',
    '## Downrank / contrast patterns',
    '',
    markdownRows(profile.downrank_patterns.map((pattern) => `- ${pattern}`)),
    '',
  ].join('\n')
}

function markdownRows(rows: string[]): string {
  return rows.length > 0 ? rows.join('\n') : '- none from explicit data'
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/profile.ts',
    '',
    `Reads ${resolveDatabasePath(process.env.DATABASE_URL, process.cwd())}`,
    `Writes ${DEFAULT_PROFILE_JSON_PATH}`,
    `Writes ${path.join(DEFAULT_PROFILE_OBSIDIAN_DIR, DEFAULT_PROFILE_MARKDOWN_FILENAME)}`,
  ].join('\n')
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1]
  return Boolean(entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href)
}

if (isDirectRun()) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage())
  } else {
    const briefRelevantOnly = process.argv.includes('--brief-relevant-only')
    runPreferenceProfile({ briefRelevantOnly })
      .then((result) => {
        console.log([
          'preference-profile complete',
          `rows=${result.rows}`,
          `signal_basis=${result.profile.signal_basis?.mode ?? 'whole-corpus'}`,
          `signal_rows=${result.profile.signal_basis?.signal_rows ?? result.rows}`,
          `bookmarks=${result.profile.corpus_size.bookmarks}`,
          `likes=${result.profile.corpus_size.likes}`,
          `json=${result.jsonPath}`,
          `markdown=${result.markdownPath}`,
        ].join(' '))
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      })
  }
}
