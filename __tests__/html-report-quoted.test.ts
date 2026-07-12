import { describe, expect, it } from 'vitest'
import { quotedCard, primaryLink, tweetCard } from '../scripts/html_report'

// Regression guard for the quote-tweet rendering bug (2026-06-26): a parent tweet
// that quote-tweets another post (e.g. Harrison Chase quoting Jake Broekhuizen's
// X Article) previously rendered ONLY the parent text+media — the entire quoted
// post, including its outbound article/link, was silently dropped.

describe('primaryLink', () => {
  it('labels an X native /i/article/ url as a friendly CTA', () => {
    const t: any = { entities: { urls: [{ expanded_url: 'http://x.com/i/article/2069811501511462912', url: 'https://t.co/x' }] } }
    const l = primaryLink(t)
    expect(l).not.toBeNull()
    expect(l!.href).toBe('https://x.com/i/article/2069811501511462912') // http→https
    expect(l!.label).toBe('Read the article on X →')
  })

  it('uses the display_url (stripped of scheme/www) for a normal outbound link', () => {
    const t: any = { entities: { urls: [{ expanded_url: 'https://www.langchain.com/blog/foo', display_url: 'langchain.com/blog/foo' }] } }
    const l = primaryLink(t)
    expect(l!.href).toBe('https://www.langchain.com/blog/foo')
    expect(l!.label).toBe('langchain.com/blog/foo →')
  })

  it('skips bare t.co media links and returns null when nothing real remains', () => {
    const t: any = { entities: { urls: [{ expanded_url: 'https://t.co/abc', url: 'https://t.co/abc' }] } }
    expect(primaryLink(t)).toBeNull()
  })

  it('returns null when there are no urls', () => {
    expect(primaryLink({ entities: { urls: [] } } as any)).toBeNull()
    expect(primaryLink({} as any)).toBeNull()
  })
})

describe('quotedCard', () => {
  it('renders a quoted post author + its outbound article link (the dropped-link bug)', () => {
    const q: any = {
      id_str: '2069811501511462912',
      user: { name: 'Jake Broekhuizen', screen_name: 'jakebroekhuizen' },
      text: 'https://t.co/sz6jqZLBXV',
      entities: { urls: [{ expanded_url: 'http://x.com/i/article/2069811501511462912', url: 'https://t.co/sz6jqZLBXV' }] },
    }
    const html = quotedCard(q)
    expect(html).toContain('class="quoted"')
    expect(html).toContain('Jake Broekhuizen')
    expect(html).toContain('@jakebroekhuizen')
    expect(html).toContain('href="https://x.com/i/article/2069811501511462912"')
    expect(html).toContain('Read the article on X →')
    // body was only a stripped media t.co → no empty q-text line
    expect(html).not.toContain('class="q-text"')
  })

  it('renders quoted body text with a real outbound link when present', () => {
    const q: any = {
      id_str: '123',
      user: { name: 'LangChain', screen_name: 'LangChain' },
      text: 'How we built full-text search https://t.co/i0YG73AQHE',
      entities: { urls: [{ expanded_url: 'https://www.langchain.com/blog/full-text-search', display_url: 'langchain.com/blog/full-text…', url: 'https://t.co/i0YG73AQHE' }] },
    }
    const html = quotedCard(q)
    expect(html).toContain('LangChain')
    expect(html).toContain('class="q-text"')
    expect(html).toContain('href="https://www.langchain.com/blog/full-text-search"')
  })

  it('is fail-safe: empty/garbage input yields empty string, never throws', () => {
    expect(quotedCard(null)).toBe('')
    expect(quotedCard(undefined)).toBe('')
    expect(quotedCard('nope' as any)).toBe('')
    expect(quotedCard({})).toBe('')
  })
})

describe('tweetCard with quoted_tweet', () => {
  it('embeds the quoted sub-card inside the parent tweet', () => {
    const t: any = {
      id_str: '2069856656335556766',
      user: { name: 'Harrison Chase', screen_name: 'hwchase17', verified: true },
      text: 'a lot of agent memory follows a simple three step process:',
      favorite_count: 243,
      conversation_count: 11,
      quoted_tweet: {
        id_str: '2069811501511462912',
        user: { name: 'Jake Broekhuizen', screen_name: 'jakebroekhuizen' },
        text: 'https://t.co/sz6jqZLBXV',
        entities: { urls: [{ expanded_url: 'http://x.com/i/article/2069811501511462912', url: 'https://t.co/sz6jqZLBXV' }] },
      },
    }
    const html = tweetCard(t, '<span class="badge">B · 86</span>')
    expect(html).toContain('Harrison Chase')
    expect(html).toContain('class="quoted"')
    expect(html).toContain('Jake Broekhuizen')
    expect(html).toContain('Read the article on X →')
  })

  it('renders a parent tweet\'s in-body link inline exactly once (no duplicate CTA)', () => {
    // The @sama "GPT-5.6 preferred model" case: the outbound link's t.co IS in the
    // body text, so renderTweetText resolves it inline. The parent-link CTA row must
    // NOT also render it — that was the duplicate-link bug Ace caught (2026-07-12).
    const t: any = {
      id_str: '1',
      user: { name: 'Someone', screen_name: 'someone' },
      text: 'check this out https://t.co/abc',
      entities: { urls: [{ expanded_url: 'https://example.com/post', display_url: 'example.com/post', url: 'https://t.co/abc' }] },
    }
    const html = tweetCard(t, '')
    // inline anchor present…
    expect(html).toContain('href="https://example.com/post"')
    // …but exactly once (no duplicate CTA row), and no q-link CTA for it.
    expect((html.match(/href="https:\/\/example\.com\/post"/g) || []).length).toBe(1)
    expect(html).not.toContain('example.com/post →')
    expect(html).not.toContain('class="q-link"')
  })

  it('surfaces a parent link as a CTA when it is NOT already inline in the body', () => {
    // Link card / no t.co token in the visible text → renderTweetText won't render
    // it, so the parent-link CTA row is the only place it appears. Keep that path.
    const t: any = {
      id_str: '1',
      user: { name: 'Someone', screen_name: 'someone' },
      text: 'a thread with no link token in the body',
      entities: { urls: [{ expanded_url: 'https://example.com/post', display_url: 'example.com/post', url: 'https://t.co/abc' }] },
    }
    const html = tweetCard(t, '')
    expect(html).toContain('href="https://example.com/post"')
    expect(html).toContain('example.com/post →')
    expect(html).toContain('class="q-link"')
  })
})
