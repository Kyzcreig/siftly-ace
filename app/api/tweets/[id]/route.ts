import { NextResponse } from 'next/server'
import { getCachedTweetById } from '@/lib/tweet-cache'

const TWEET_ID_RE = /^[0-9]+$/

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params
  if (!TWEET_ID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid tweet id' }, { status: 400 })
  }

  const tweet = await getCachedTweetById(id)
  if (!tweet) {
    return NextResponse.json({ tweet: null }, { status: 404 })
  }

  return NextResponse.json({ tweet })
}
