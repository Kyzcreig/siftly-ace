import { NextRequest, NextResponse } from 'next/server'
import { exportAllBookmarksCsv, exportBookmarksJson, exportCategoryAsZip } from '@/lib/exporter'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const categorySlug = searchParams.get('category')

  if (!type) {
    return NextResponse.json(
      { error: 'Missing required query param: type (csv | json | zip)' },
      { status: 400 }
    )
  }

  if (type === 'csv') {
    try {
      const csv = await exportAllBookmarksCsv()
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.csv"',
        },
      })
    } catch (err) {
      console.error('CSV export error:', err)
      return NextResponse.json(
        { error: `Failed to export CSV: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  if (type === 'json') {
    try {
      const json = await exportBookmarksJson()
      return new NextResponse(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.json"',
        },
      })
    } catch (err) {
      console.error('JSON export error:', err)
      return NextResponse.json(
        { error: `Failed to export JSON: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  if (type === 'zip') {
    try {
      let zipBuffer: Buffer

      if (categorySlug) {
        zipBuffer = await exportCategoryAsZip(categorySlug)
        const safeSlug = categorySlug.replace(/[^a-z0-9-_]/gi, '_')
        return new NextResponse(new Uint8Array(zipBuffer), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="bookmarks-${safeSlug}.zip"`,
          },
        })
      }

      // ZIP of all bookmarks — export category by category; for simplicity export all JSON as zip
      const json = await exportBookmarksJson()
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('bookmarks.json', json)
      zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="bookmarks-all.zip"',
        },
      })
    } catch (err) {
      console.error('ZIP export error:', err)
      return NextResponse.json(
        { error: `Failed to export ZIP: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      )
    }
  }

  return NextResponse.json(
    { error: `Unknown export type: ${type}. Use csv, json, or zip.` },
    { status: 400 }
  )
}
