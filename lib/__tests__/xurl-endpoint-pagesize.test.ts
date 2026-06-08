import { describe, expect, it } from 'vitest'
import { buildXurlEndpoint } from '@/lib/xurl-ingest'

function maxResults(endpoint: string): number {
  const qs = new URLSearchParams(endpoint.split('?')[1] ?? '')
  return Number(qs.get('max_results'))
}

describe('buildXurlEndpoint page-size clamping (X bookmarks pagination bug)', () => {
  it('caps bookmarks at max_results=90 even when 100 is requested', () => {
    // X server bug: bookmarks?max_results=100 returns no next_token and silently
    // caps the whole history at ~99 items. 90 restores pagination. Regression
    // guard for the 104-vs-2600 bookmark undercount.
    expect(maxResults(buildXurlEndpoint({ source: 'bookmark', pageSize: 100 }))).toBe(90)
    expect(maxResults(buildXurlEndpoint({ source: 'bookmark' }))).toBe(90)
    expect(maxResults(buildXurlEndpoint({ source: 'bookmark', pageSize: 95 }))).toBe(90)
  })

  it('allows likes to use the full max_results=100', () => {
    expect(maxResults(buildXurlEndpoint({ source: 'like', pageSize: 100 }))).toBe(100)
    expect(maxResults(buildXurlEndpoint({ source: 'like' }))).toBe(100)
  })

  it('still honors smaller explicit page sizes for both sources', () => {
    expect(maxResults(buildXurlEndpoint({ source: 'bookmark', pageSize: 25 }))).toBe(25)
    expect(maxResults(buildXurlEndpoint({ source: 'like', pageSize: 25 }))).toBe(25)
  })
})
