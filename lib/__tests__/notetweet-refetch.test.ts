import { describe, expect, it } from 'vitest'
import { chunk, planRowUpdate } from '../notetweet-refetch'

const row = {
  id: 'b1',
  tweetId: '2098985979067724192',
  text: 'These 20 things are still missing\n- Custom 404 page',
  rawJson: JSON.stringify({ source: 'bookmark', tweet: { id: '2098985979067724192', text: 'preview' } }),
}

describe('planRowUpdate', () => {
  it('replaces the truncated text with the decoded note_tweet body and merges it into rawJson', () => {
    const u = planRowUpdate(row, {
      id: row.tweetId,
      text: 'preview',
      note_tweet: { text: 'These 20 things are still missing\n- Custom 404 page\n- Compressed images &amp; more' },
    })
    expect(u?.text).toContain('- Compressed images & more')
    const raw = JSON.parse(u!.rawJson)
    expect(raw.source).toBe('bookmark')
    expect(raw.tweet.note_tweet.text).toContain('Compressed images')
    expect(u!.rawJson).toContain('note_tweet') // drops out of CANDIDATE_SQL: idempotent
  })

  it('leaves short posts (no note_tweet), unavailable posts, and unparseable rawJson untouched', () => {
    expect(planRowUpdate(row, { id: row.tweetId, text: row.text })).toBeNull()
    expect(planRowUpdate(row, { id: row.tweetId, text: 'x', note_tweet: { text: ' ' } })).toBeNull()
    expect(planRowUpdate(row, undefined)).toBeNull()
    expect(planRowUpdate({ ...row, rawJson: '{' }, { id: row.tweetId, note_tweet: { text: 'long' } })).toBeNull()
  })

  it('is a no-op on an already-applied row', () => {
    const fetched = { id: row.tweetId, note_tweet: { text: 'full body' } }
    const first = planRowUpdate(row, fetched)!
    expect(planRowUpdate({ ...row, text: first.text, rawJson: first.rawJson }, fetched)).toBeNull()
  })
})

describe('chunk', () => {
  it('splits 548 ids into 6 calls of <=100', () => {
    const c = chunk(Array.from({ length: 548 }, (_, i) => i), 100)
    expect(c.map((b) => b.length)).toEqual([100, 100, 100, 100, 100, 48])
  })
})
