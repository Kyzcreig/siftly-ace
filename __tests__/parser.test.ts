import { describe, expect, it } from 'vitest'
import { parseBookmarksJson } from '@/lib/parser'

describe('parseBookmarksJson', () => {
  it('re-imports Siftly CLI list output without replacing tweet identity', () => {
    const exported = {
      total: 1,
      page: 1,
      limit: 20,
      pages: 1,
      bookmarks: [
        {
          id: 'database-bookmark-id',
          tweetId: '2081153980294648186',
          text: 'Parser round-trip fixture',
          authorHandle: 'simonw',
          authorName: 'Simon Willison',
          source: 'bookmark',
          tweetCreatedAt: '2026-07-25T23:05:49.000Z',
          mediaItems: [
            {
              id: 'database-media-id',
              type: 'photo',
              url: 'https://pbs.twimg.com/media/example.jpg',
            },
          ],
          categories: [],
        },
      ],
    }

    const parsed = parseBookmarksJson(JSON.stringify(exported))

    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      tweetId: '2081153980294648186',
      text: 'Parser round-trip fixture',
      authorHandle: 'simonw',
      authorName: 'Simon Willison',
      tweetCreatedAt: new Date('2026-07-25T23:05:49.000Z'),
      media: [
        {
          type: 'photo',
          url: 'https://pbs.twimg.com/media/example.jpg',
          thumbnailUrl: 'https://pbs.twimg.com/media/example.jpg',
        },
      ],
    })
  })

  it('preserves a video thumbnail across Siftly export re-import', () => {
    const exported = [
      {
        tweetId: '2081153980294648187',
        text: 'Video fixture',
        authorHandle: 'simonw',
        authorName: 'Simon Willison',
        tweetCreatedAt: '2026-07-25T23:06:49.000Z',
        mediaItems: [
          {
            type: 'video',
            url: 'https://video.twimg.com/ext_tw_video/example.mp4',
            thumbnailUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/example.jpg',
          },
        ],
      },
    ]

    const [parsed] = parseBookmarksJson(JSON.stringify(exported))

    expect(parsed.media).toEqual([
      {
        type: 'video',
        url: 'https://video.twimg.com/ext_tw_video/example.mp4',
        thumbnailUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/example.jpg',
      },
    ])
  })
})
