import { describe, expect, it } from 'vitest'
import { renderCanonicalTweetText, tweetCard } from '../html_report'

describe('canonical tweet text', () => {
  it('preserves gathered text instead of hydration reply prefixes, whitespace, or display URLs', () => {
    const canonical = 'Runs locally\n\nhttps://github.com/acme/tool'
    expect(renderCanonicalTweetText(canonical)).toBe('Runs locally<br><br>https://github.com/acme/tool')

    const hydrated = {
      id_str: '123',
      text: '@reply Runs locally https://t.co/abc ',
      entities: { urls: [{ url: 'https://t.co/abc', display_url: 'github.com/acme/to…', expanded_url: 'https://github.com/acme/tool' }] },
      user: { screen_name: 'builder', name: 'Builder' },
      favorite_count: 1,
      conversation_count: 2,
    } as any
    const html = tweetCard(hydrated, '', undefined, undefined, canonical)
    expect(html).toContain('data-canonical-tweet-id="123"')
    expect(html).toContain('<div class="tw-text" data-canonical-tweet-id="123">Runs locally<br><br>https://github.com/acme/tool</div>')
    expect(html).not.toContain('@reply Runs locally')
  })
})
