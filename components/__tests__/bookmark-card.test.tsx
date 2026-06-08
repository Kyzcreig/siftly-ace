import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import BookmarkCard, { QuotedTweetFrame, extractQuotedTweetIdFromBookmark } from '../bookmark-card'
import { clearTweetCacheForTests, getCachedQuotedTweet } from '../../lib/tweet-cache'
import { getTweet } from 'react-tweet/api'
import type { BookmarkWithMedia } from '../../lib/types'
import type { Tweet } from 'react-tweet/api'

vi.mock('react-tweet', () => ({
  EmbeddedTweet: ({ tweet }: { tweet: Tweet }) => (
    <div data-testid="embedded-tweet">quoted child {tweet.id_str}</div>
  ),
}))

vi.mock('react-tweet/api', () => ({
  getTweet: vi.fn(),
}))

const DAVID_TWEET_ID = '2063705880684581305'
const STEIPETE_TWEET_ID = '2063697162748260627'

const davidRawJson = JSON.stringify({
  source: 'bookmark',
  tweet: {
    id: DAVID_TWEET_ID,
    text: 'David Ondrej quote tweet',
    referenced_tweets: [{ type: 'quoted', id: STEIPETE_TWEET_ID }],
    entities: { tweetType: 'quote' },
  },
})

const davidEntities = JSON.stringify({ tweetType: 'quote' })

const steipeteTweet = {
  __typename: 'Tweet',
  id_str: STEIPETE_TWEET_ID,
  text: 'quoted steipete child',
} as unknown as Tweet

function bookmark(overrides: Partial<BookmarkWithMedia> & { rawJson?: string | null; entities?: string | null } = {}) {
  return {
    id: 'bookmark-1',
    tweetId: DAVID_TWEET_ID,
    text: 'David Ondrej quote tweet https://t.co/quote',
    authorHandle: 'davidondrej1',
    authorName: 'David Ondrej',
    tweetCreatedAt: '2026-06-08T00:00:00.000Z',
    importedAt: '2026-06-08T00:00:00.000Z',
    mediaItems: [],
    categories: [],
    ...overrides,
  } as BookmarkWithMedia & { rawJson?: string | null; entities?: string | null }
}

describe('quote tweet unfurl', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'siftly-tweet-cache-'))
    process.env.SIFTLY_TWEET_CACHE_PATH = join(cacheDir, 'tweet-cache.db')
    vi.clearAllMocks()
    await clearTweetCacheForTests()
  })

  afterEach(() => {
    delete process.env.SIFTLY_TWEET_CACHE_PATH
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('extracts the David Ondrej quoted ref and renders the quoted child inside the dark frame', async () => {
    vi.mocked(getTweet).mockResolvedValueOnce(steipeteTweet)

    const quotedId = extractQuotedTweetIdFromBookmark(bookmark({ rawJson: davidRawJson, entities: davidEntities }))
    expect(quotedId).toBe(STEIPETE_TWEET_ID)

    const result = await getCachedQuotedTweet(DAVID_TWEET_ID, davidRawJson, davidEntities)
    expect(result?.quotedTweetId).toBe(STEIPETE_TWEET_ID)
    expect(result?.tweet?.id_str).toBe(STEIPETE_TWEET_ID)

    const html = renderToStaticMarkup(
      <QuotedTweetFrame quotedTweetId={result!.quotedTweetId} tweet={result!.tweet} />,
    )
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain(`quoted child ${STEIPETE_TWEET_ID}`)
  })

  it('serves the second quoted child load from the isolated SQLite cache', async () => {
    vi.mocked(getTweet).mockResolvedValueOnce(steipeteTweet)

    await expect(getCachedQuotedTweet(DAVID_TWEET_ID, davidRawJson, davidEntities)).resolves.toMatchObject({
      quotedTweetId: STEIPETE_TWEET_ID,
    })
    await expect(getCachedQuotedTweet(DAVID_TWEET_ID, davidRawJson, davidEntities)).resolves.toMatchObject({
      quotedTweetId: STEIPETE_TWEET_ID,
    })

    expect(getTweet).toHaveBeenCalledTimes(1)
    expect(getTweet).toHaveBeenCalledWith(STEIPETE_TWEET_ID)
  })

  it('falls back to the View on X card for a deleted or unavailable quoted child', async () => {
    vi.mocked(getTweet).mockResolvedValueOnce(undefined)
    const rawJson = JSON.stringify({
      referenced_tweets: [{ type: 'quoted', id: '999999999999999999' }],
      entities: { tweetType: 'quote' },
    })

    const result = await getCachedQuotedTweet('parent-deleted', rawJson, JSON.stringify({ tweetType: 'quote' }))
    expect(result?.quotedTweetId).toBe('999999999999999999')
    expect(result?.tweet).toBeNull()

    const html = renderToStaticMarkup(
      <QuotedTweetFrame quotedTweetId="999999999999999999" tweet={null} />,
    )
    expect(html).toContain('View quoted post on X')
    expect(html).toContain('https://twitter.com/i/web/status/999999999999999999')
  })

  it('places a dark quote shell inside BookmarkCard when rawJson marks a quote', () => {
    const html = renderToStaticMarkup(
      <BookmarkCard bookmark={bookmark({ rawJson: davidRawJson, entities: davidEntities })} />,
    )
    expect(html).toContain('data-testid="quoted-tweet-loading"')
    expect(html).toContain('data-theme="dark"')
  })
})
