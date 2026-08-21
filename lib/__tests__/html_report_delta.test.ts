import { describe, expect, it } from 'vitest'

import { deltaLabel, deltaSummaryHtml, linkCard, tweetCard } from '../../scripts/html_report'

describe('morning brief delta presentation', () => {
  it.each(['new', 'moved', 'resolved'] as const)('leads a story card with %s', (status) => {
    const item: any = {
      source: 'HN',
      title: 'A selected story',
      url: 'https://example.com/story',
      score: 88,
      _delta: { status },
    }

    const html = linkCard(item, '')

    expect(html).toContain(`delta-${status}`)
    expect(html.indexOf(status[0].toUpperCase() + status.slice(1))).toBeLessThan(html.indexOf('A selected story'))
  })

  it('escapes delta movement detail', () => {
    const html = deltaLabel({ status: 'moved', from: '<Top #2>' })

    expect(html).toContain('Moved')
    expect(html).toContain('&lt;Top #2&gt;')
    expect(html).not.toContain('<Top #2>')
  })

  it('leads a hydrated tweet card with its delta', () => {
    const tweet: any = {
      id_str: '123',
      text: 'Hydrated tweet body',
      user: { screen_name: 'builder', name: 'Builder' },
      entities: { urls: [] },
    }

    const html = tweetCard(tweet, '', undefined, { status: 'new' })

    expect(html).toContain('delta-new')
    expect(html.indexOf('New')).toBeLessThan(html.indexOf('Hydrated tweet body'))
  })

  it('reports collapsed unchanged items without rendering them as cards', () => {
    const html = deltaSummaryHtml({
      previous_date: '2026-08-18',
      counts: { new: 6, moved: 1, resolved: 6, unchanged: 3 },
    })

    expect(html).toContain('6 new')
    expect(html).toContain('1 moved')
    expect(html).toContain('6 resolved')
    expect(html).toContain('3 unchanged items collapsed')
  })
})
