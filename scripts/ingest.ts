import prisma from '../lib/db'
import { ingestXurlSources, type XurlSource } from '../lib/xurl-ingest'

interface CliOptions {
  app: string
  userId: string
  maxPages: number
  pageSize: number
  limit?: number
  dryRun: boolean
  sources: XurlSource[]
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/ingest.ts [--limit N] [--dry] [--max-pages N] [--page-size N] [--source bookmark|like|both]',
    '',
    'Reads Ace\'s X bookmarks and likes via xurl OAuth2 and upserts Bookmark rows.',
    'Defaults: --app siftly-ace --user-id 56282605 --max-pages 50 --page-size 100 --source both',
  ].join('\n')
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function parseSources(value: string | undefined): XurlSource[] {
  if (!value || value === 'both') return ['bookmark', 'like']
  if (value === 'bookmark' || value === 'like') return [value]
  throw new Error('--source must be bookmark, like, or both')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    app: 'siftly-ace',
    userId: '56282605',
    maxPages: 50,
    pageSize: 100,
    dryRun: false,
    sources: ['bookmark', 'like'],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
      case '--dry':
      case '--dry-run':
        options.dryRun = true
        break
      case '--limit':
        options.limit = parsePositiveInt(argv[++i], '--limit')
        break
      case '--max-pages':
        options.maxPages = parsePositiveInt(argv[++i], '--max-pages')
        break
      case '--page-size':
        options.pageSize = parsePositiveInt(argv[++i], '--page-size')
        break
      case '--app':
        options.app = argv[++i] ?? ''
        if (!options.app) throw new Error('--app requires a value')
        break
      case '--user-id':
        options.userId = argv[++i] ?? ''
        if (!options.userId) throw new Error('--user-id requires a value')
        break
      case '--source':
        options.sources = parseSources(argv[++i])
        break
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.limit !== undefined && !options.dryRun) {
    throw new Error('--limit is only allowed with --dry/--dry-run so pagination cursors cannot skip un-ingested rows')
  }

  const result = await ingestXurlSources({
    db: prisma,
    app: options.app,
    userId: options.userId,
    maxPages: options.maxPages,
    pageSize: options.pageSize,
    limit: options.limit,
    dryRun: options.dryRun,
    sources: options.sources,
  })

  const rowsIngested = result.created + result.updated
  console.log([
    `xurl-ingest ${options.dryRun ? 'dry-run ' : ''}complete`,
    `sources=${options.sources.join(',')}`,
    `pages=${result.pagesFetched}`,
    `rows-fetched=${result.rowsFetched}`,
    `rows-deduped=${result.rowsDeduped}`,
    `rows-ingested=${rowsIngested}`,
    `created=${result.created}`,
    `updated=${result.updated}`,
    `skipped=${result.skipped}`,
  ].join(' '))

  for (const source of options.sources) {
    const sourceStats = result.perSource[source]
    console.log(
      `${source}: pages=${sourceStats.pages} rows=${sourceStats.rows} next-cursor=${sourceStats.nextCursor ?? 'none'}`,
    )
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
