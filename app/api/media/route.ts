import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_HOSTS = new Set([
  'pbs.twimg.com',
  'video.twimg.com',
  'ton.twimg.com',
  'abs.twimg.com',
  'unavatar.io',
])

function isAllowedUrl(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr)
    return protocol === 'https:' && ALLOWED_HOSTS.has(hostname)
  } catch {
    return false
  }
}

function getFilename(urlStr: string, contentType: string): string {
  try {
    const pathname = new URL(urlStr).pathname
    const last = pathname.split('/').pop()?.split('?')[0] ?? ''
    if (last.includes('.')) return last
  } catch { /* ignore */ }
  if (contentType.includes('mp4')) return 'video.mp4'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'photo.jpg'
  if (contentType.includes('png')) return 'photo.png'
  if (contentType.includes('gif')) return 'animation.gif'
  if (contentType.includes('webp')) return 'photo.webp'
  return 'media.bin'
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const mediaUrl = searchParams.get('url')
  const isDownload = searchParams.get('download') === '1'

  if (!mediaUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  if (!isAllowedUrl(mediaUrl)) {
    return NextResponse.json({ error: 'URL not allowed' }, { status: 403 })
  }

  try {
    // Forward Range header so video seeking / partial content works correctly
    const rangeHeader = request.headers.get('range')

    const upstream = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://twitter.com/',
        'Origin': 'https://twitter.com',
        'Accept': '*/*',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    })

    // 206 Partial Content is success for range requests
    if (!upstream.ok) {
      return new NextResponse(null, { status: upstream.status })
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }

    // Forward range-related headers so browser can seek into videos
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) responseHeaders['Content-Range'] = contentRange
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) responseHeaders['Content-Length'] = contentLength

    if (isDownload) {
      const filename = getFilename(mediaUrl, contentType)
      responseHeaders['Content-Disposition'] = `attachment; filename="${filename}"`
    }

    // Preserve upstream status (200 or 206) — critical for video range requests
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (err) {
    console.error('Media proxy error:', err)
    return NextResponse.json({ error: 'Upstream fetch failed' }, { status: 502 })
  }
}
