import { describe, expect, it } from 'vitest'
import { decodeXmlEntities, tweetBodyText } from '../xurl-ingest'

describe('tweetBodyText', () => {
  it('decodes the HTML entities X escapes in v2 `text`', () => {
    expect(decodeXmlEntities('&gt; go to &amp; drop &lt;b&gt; &quot;x&quot; it&#39;s')).toBe(
      '> go to & drop <b> "x" it\'s',
    )
  })
  it('prefers the long-form note_tweet body over the 280-char preview', () => {
    const t = {
      text: 'These 20 things are missing…\n- Custom 404 page',
      note_tweet: { text: 'These 20 things are missing\n- Custom 404 page\n- Compressed images' },
    }
    expect(tweetBodyText(t)).toContain('Compressed images')
  })
  it('falls back to text when note_tweet is absent or empty', () => {
    expect(tweetBodyText({ text: 'short' })).toBe('short')
    expect(tweetBodyText({ text: 'short', note_tweet: { text: '  ' } })).toBe('short')
    expect(tweetBodyText({})).toBe('')
  })
  it('is idempotent (a backfill may run twice)', () => {
    expect(decodeXmlEntities(decodeXmlEntities('a &amp;gt; b'))).toBe('a > b')
  })
})
