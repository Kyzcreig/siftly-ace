'use server'

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getTweet } from 'react-tweet/api'
import type { Tweet } from 'react-tweet/api'
import prisma from '@/lib/db'

const DEFAULT_CACHE_PATH = '.local/tweet-cache.db'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const TWEET_ID_RE = /^[0-9]+$/

type CacheRow = {
  json: string
  fetched_at: number
}

type RawTweetLike = {
  tweet?: unknown
  referenced_tweets?: Array<{ type?: string; id?: string }>
  entities?: unknown
}

type EntitiesLike = {
  tweetType?: string
  urls?: Array<{ expanded_url?: string; unwound_url?: string; url?: string }>
}

type CachedQuotedTweet = {
  quotedTweetId: string
  tweet: Tweet | null
}

const dbByPath = new Map<string, Database.Database>()

function cachePath(): string {
  return process.env.SIFTLY_TWEET_CACHE_PATH
    ? resolve(process.env.SIFTLY_TWEET_CACHE_PATH)
    : resolve(process.cwd(), DEFAULT_CACHE_PATH)
}

function db(): Database.Database {
  const path = cachePath()
  const cached = dbByPath.get(path)
  if (cached) return cached

  mkdirSync(dirname(path), { recursive: true })
  const instance = new Database(path)
  instance.exec(`
    CREATE TABLE IF NOT EXISTS tweet_syndication_cache (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `)
  dbByPath.set(path, instance)
  return instance
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function entitiesFrom(value: unknown): EntitiesLike | null {
  const parsed = parseMaybeJson(value)
  return isObject(parsed) ? parsed as EntitiesLike : null
}

function quotedIdFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const match = url.match(/(?:twitter\.com|x\.com)\/(?:i\/web\/status|[^/]+\/status)\/(\d+)/i)
  return match?.[1] ?? null
}

function quotedIdFromEntities(value: unknown): string | null {
  const entities = entitiesFrom(value)
  if (!entities || entities.tweetType !== 'quote') return null

  for (const url of entities.urls ?? []) {
    const quotedId = quotedIdFromUrl(url.expanded_url) ?? quotedIdFromUrl(url.unwound_url) ?? quotedIdFromUrl(url.url)
    if (quotedId) return quotedId
  }
  return null
}

function quotedIdFromRawJson(rawJson: unknown, entities?: unknown): string | null {
  const raw = parseMaybeJson(rawJson)
  if (!isObject(raw)) return quotedIdFromEntities(entities)

  const tweet = isObject((raw as RawTweetLike).tweet) ? (raw as RawTweetLike).tweet as RawTweetLike : raw as RawTweetLike
  const refs = tweet.referenced_tweets ?? []
  const quotedRef = refs.find((ref) => ref?.type === 'quoted' && typeof ref.id === 'string' && TWEET_ID_RE.test(ref.id))
  if (quotedRef?.id) return quotedRef.id

  return quotedIdFromEntities(tweet.entities) ?? quotedIdFromEntities((raw as RawTweetLike).entities) ?? quotedIdFromEntities(entities)
}

function readFreshCachedTweet(id: string, now: number): Tweet | null | undefined {
  const row = db().prepare('SELECT json, fetched_at FROM tweet_syndication_cache WHERE id = ?').get(id) as CacheRow | undefined
  if (!row) return undefined

  if (now - row.fetched_at >= THIRTY_DAYS_MS) {
    db().prepare('DELETE FROM tweet_syndication_cache WHERE id = ?').run(id)
    return undefined
  }

  try {
    return JSON.parse(row.json) as Tweet
  } catch {
    db().prepare('DELETE FROM tweet_syndication_cache WHERE id = ?').run(id)
    return undefined
  }
}

async function fetchPublicTweet(id: string): Promise<Tweet | null> {
  try {
    const tweet = await getTweet(id)
    if (!tweet || tweet.__typename !== 'Tweet') return null
    return tweet
  } catch {
    return null
  }
}

async function getCachedTweet(id: string): Promise<Tweet | null> {
  if (!TWEET_ID_RE.test(id)) return null

  const now = Date.now()
  const cached = readFreshCachedTweet(id, now)
  if (cached !== undefined) return cached

  const tweet = await fetchPublicTweet(id)
  if (!tweet) return null

  // Public syndication JSON only. No auth headers, tokens, or user-context data are fetched or stored.
  db().prepare(`
    INSERT INTO tweet_syndication_cache (id, json, fetched_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at
  `).run(id, JSON.stringify(tweet), now)

  return tweet
}

async function resolveQuotedTweetId(parentTweetId: string, rawJson?: unknown, entities?: unknown): Promise<string | null> {
  const fromProps = quotedIdFromRawJson(rawJson, entities)
  if (fromProps) return fromProps

  try {
    const row = await prisma.bookmark.findUnique({
      where: { tweetId: parentTweetId },
      select: { rawJson: true, entities: true },
    })
    return quotedIdFromRawJson(row?.rawJson ?? null, row?.entities ?? null)
  } catch {
    return null
  }
}

export async function getCachedQuotedTweet(parentTweetId: string, rawJson?: unknown, entities?: unknown): Promise<CachedQuotedTweet | null> {
  const quotedTweetId = await resolveQuotedTweetId(parentTweetId, rawJson, entities)
  if (!quotedTweetId) return null

  const tweet = await getCachedTweet(quotedTweetId)
  return { quotedTweetId, tweet }
}

export async function getCachedTweetById(id: string): Promise<Tweet | null> {
  return getCachedTweet(id)
}

export async function getCachedTweetForTests(id: string): Promise<Tweet | null> {
  return getCachedTweet(id)
}

export async function clearTweetCacheForTests(): Promise<void> {
  db().prepare('DELETE FROM tweet_syndication_cache').run()
}

export async function closeTweetCacheForTests(): Promise<void> {
  for (const instance of dbByPath.values()) instance.close()
  dbByPath.clear()
}
