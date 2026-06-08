import prisma from '../lib/db'
import {
  ENRICH_BOOKMARK_SELECT,
  enforceVisionCostGate,
  enrichBookmarkRows,
  enqueueVideoItems,
  estimateVisionCost,
  isCaptionCandidate,
  resolveVideoQueuePath,
  runCaptionForMediaItems,
  runOcrForMediaItems,
  type EnrichBookmarkInput,
  type EnrichDb,
  type EnrichMediaItemInput,
  type VideoEnrichDb,
} from '../src/lib/enrich'

interface CliOptions {
  limit: number
  force: boolean
  dryRun: boolean
  vision: boolean
  caption: boolean
  confirm: boolean
  queuePath?: string
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/enrich.ts [--limit N] [--force] [--dry-run] [--vision] [--caption] [--confirm] [--queue-path PATH]',
    '',
    'Runs Phase 3 factual enrichment. Video transcription is NOT run here; video media are only enqueued for scripts/video-enrich.ts.',
    'Vision/OCR (--vision) prints a cost estimate and requires --confirm or SIFTLY_ENRICH_CONFIRM_VISION=1 for large backfills.',
    'Image captioning (--caption) describes purely-visual images (no OCR text) via a cheap multimodal model; same cost gate.',
  ].join('\n')
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 100,
    force: false,
    dryRun: false,
    vision: false,
    caption: false,
    confirm: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
      case '--limit':
        options.limit = parsePositiveInt(argv[++i], '--limit')
        break
      case '--force':
        options.force = true
        break
      case '--dry':
      case '--dry-run':
        options.dryRun = true
        break
      case '--vision':
      case '--ocr':
        options.vision = true
        break
      case '--caption':
        options.caption = true
        break
      case '--confirm':
        options.confirm = true
        break
      case '--queue-path':
        options.queuePath = argv[++i]
        if (!options.queuePath) throw new Error('--queue-path requires a value')
        break
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  return options
}

function isOcrCandidate(media: EnrichMediaItemInput): boolean {
  if (media.imageTags && media.imageTags !== '{}') return false
  return media.type === 'photo' || media.type === 'gif' || media.type === 'video'
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const queuePath = resolveVideoQueuePath(options.queuePath)
  const bookmarks = await prisma.bookmark.findMany({
    where: options.force ? {} : { enrichedAt: null },
    orderBy: { importedAt: 'asc' },
    take: options.limit,
    select: ENRICH_BOOKMARK_SELECT,
  }) as unknown as EnrichBookmarkInput[]

  const allMedia = bookmarks.flatMap((bookmark) => bookmark.mediaItems)
  const ocrCandidates = allMedia.filter(isOcrCandidate)
  const captionCandidates = allMedia.filter(isCaptionCandidate)
  const estimate = estimateVisionCost({
    imageCount: ocrCandidates.filter((media) => media.type === 'photo' || media.type === 'gif').length,
    videoThumbnailCount: ocrCandidates.filter((media) => media.type === 'video').length,
  })
  const captionEstimate = estimateVisionCost({
    imageCount: captionCandidates.filter((media) => media.type === 'photo' || media.type === 'gif').length,
    videoThumbnailCount: captionCandidates.filter((media) => media.type === 'video').length,
  })
  const videoCount = allMedia.filter((media) => media.type === 'video').length

  console.log(`vision/OCR estimate: ${estimate.summary}`)
  console.log(`caption estimate: ${captionEstimate.summary}`)
  console.log(`factual candidates=${bookmarks.length} video-media=${videoCount}`)
  console.log(`video queue path=${queuePath}`)

  if (options.dryRun) {
    console.log('dry-run complete: no rows updated, no videos enqueued, no OCR run')
    return
  }

  const factual = await enrichBookmarkRows(prisma as unknown as EnrichDb, bookmarks)

  let ocr = { attempted: 0, succeeded: 0, failed: 0 }
  if (options.vision) {
    if (enforceVisionCostGate(estimate, { confirm: options.confirm, dryRun: options.dryRun })) {
      ocr = await runOcrForMediaItems(prisma as unknown as VideoEnrichDb, ocrCandidates)
    }
  } else {
    console.log('vision/OCR skipped: pass --vision to run the gated tier')
  }

  let caption = { attempted: 0, succeeded: 0, failed: 0 }
  if (options.caption) {
    if (enforceVisionCostGate(captionEstimate, { confirm: options.confirm, dryRun: options.dryRun })) {
      caption = await runCaptionForMediaItems(prisma as unknown as VideoEnrichDb, captionCandidates)
    }
  } else {
    console.log('caption skipped: pass --caption to describe textless images')
  }

  const videoQueue = await enqueueVideoItems(bookmarks, { queuePath })
  console.log(
    [
      'enrich complete',
      `factual=${factual.enriched}`,
      `ocr-attempted=${ocr.attempted}`,
      `ocr-succeeded=${ocr.succeeded}`,
      `ocr-failed=${ocr.failed}`,
      `caption-attempted=${caption.attempted}`,
      `caption-succeeded=${caption.succeeded}`,
      `caption-failed=${caption.failed}`,
      `video-enqueued=${videoQueue.enqueued}`,
      `video-skipped=${videoQueue.skipped}`,
    ].join(' '),
  )
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
