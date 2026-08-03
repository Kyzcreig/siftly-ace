import { describe, expect, it } from 'vitest'
import { videoIdeasHtml } from '../html_report'

describe('html report video ideas', () => {
  it('renders complete linked cards and escapes X-derived text', () => {
    const html = videoIdeasHtml([{
      title: 'Build <Agents> & ship',
      angle: 'Use "receipts" > vibes',
      url: 'https://x.com/builder/status/123',
    }])

    expect(html).toContain('class="ideas"')
    expect(html).toContain('Build &lt;Agents&gt; &amp; ship')
    expect(html).toContain('Use &quot;receipts&quot; &gt; vibes')
    expect(html).toContain('href="https://x.com/builder/status/123"')
    expect(html).not.toContain('Build <Agents>')
  })

  it('drops malformed entries and never emits a non-http href', () => {
    const html = videoIdeasHtml([
      { title: '', angle: 'missing title', url: 'https://x.com/a/status/1' },
      { title: 'Safe title', angle: 'Safe angle', url: 'javascript:alert(1)' },
    ])

    expect(html).toContain('Safe title')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('missing title')
  })
})
