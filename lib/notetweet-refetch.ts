import { tweetBodyText, type XurlTweet } from './xurl-ingest'

/**
 * Pure helpers for scripts/refetch-notetweet.ts: rows ingested before note_tweet was requested
 * (pre siftly-ace#9) stored only the 280-char preview of long-form posts.
 */

/** Candidates: ~280-char text whose stored payload has no note_tweet (an upper bound). */
export const CANDIDATE_SQL = `SELECT id, tweetId, text, rawJson FROM Bookmark
  WHERE length(text) BETWEEN 270 AND 290 AND instr(rawJson, 'note_tweet') = 0
  ORDER BY tweetId`

export interface CandidateRow { id: string; tweetId: string; text: string; rawJson: string }
export interface RowUpdate { id: string; tweetId: string; text: string; rawJson: string }

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The update for one row given its re-fetched tweet, or null when the post is not long-form
 * (no note_tweet: a short post that merely happens to be ~280 chars) or nothing would change.
 * Merges note_tweet into rawJson's wrapped `{source, tweet}` payload (or a bare tweet object).
 */
export function planRowUpdate(row: CandidateRow, fetched: XurlTweet | undefined): RowUpdate | null {
  if (!fetched?.note_tweet?.text?.trim()) return null
  const text = tweetBodyText(fetched)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(row.rawJson) as Record<string, unknown>
  } catch {
    return null
  }
  const target = (raw.tweet && typeof raw.tweet === 'object' ? raw.tweet : raw) as Record<string, unknown>
  target.note_tweet = fetched.note_tweet
  const rawJson = JSON.stringify(raw)
  if (text === row.text && rawJson === row.rawJson) return null
  return { id: row.id, tweetId: row.tweetId, text, rawJson }
}
