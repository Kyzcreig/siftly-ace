import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

// PUT: Replace all categories for a bookmark
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  let body: { categoryIds?: string[] } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { categoryIds = [] } = body

  try {
    // Delete existing categories
    await prisma.bookmarkCategory.deleteMany({ where: { bookmarkId: id } })

    // Insert new categories
    if (categoryIds.length > 0) {
      await prisma.bookmarkCategory.createMany({
        data: categoryIds.map((categoryId) => ({
          bookmarkId: id,
          categoryId,
          confidence: 1.0,
        })),
      })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update categories' },
      { status: 500 }
    )
  }
}
