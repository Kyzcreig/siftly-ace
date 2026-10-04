import fs from 'node:fs'
import prisma from '../lib/db'
import {
  DEFAULT_OBSIDIAN_EXPORT_DIR,
  exportSavedTweetsToObsidian,
  type ObsidianSavedTweet,
} from '../src/lib/obsidian/export'

interface CliOptions {
  overwrite: boolean
  limit?: number
  category?: string
  tweetIdsFile?: string
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/export-obsidian.ts [--overwrite] [--limit N] [--category slug] [--tweet-ids file]',
    '  --tweet-ids FILE  export only these tweetIds (one per line); index files are left as-is',
    '',
    `Writes saved X bookmark/like notes only under ${DEFAULT_OBSIDIAN_EXPORT_DIR}`,
    'Use tests for temp-dir exports; the production script intentionally has no arbitrary --output flag.',
  ].join('\n')
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { overwrite: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
      case '--overwrite':
        options.overwrite = true
        break
      case '--limit':
        options.limit = parsePositiveInt(argv[++i], '--limit')
        break
      case '--category':
        options.category = argv[++i]
        if (!options.category) throw new Error('--category requires a value')
        break
      case '--tweet-ids':
        options.tweetIdsFile = argv[++i]
        if (!options.tweetIdsFile) throw new Error('--tweet-ids requires a file')
        break
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const tweetIds = options.tweetIdsFile
    ? fs.readFileSync(options.tweetIdsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : undefined
  const where = {
    ...(options.category ? { categories: { some: { category: { slug: options.category } } } } : {}),
    ...(tweetIds ? { tweetId: { in: tweetIds } } : {}),
  }

  const bookmarks = await prisma.bookmark.findMany({
    where,
    include: {
      mediaItems: true,
      categories: { include: { category: true } },
    },
    orderBy: [{ tweetCreatedAt: 'desc' }, { importedAt: 'desc' }],
    ...(options.limit ? { take: options.limit } : {}),
  }) as ObsidianSavedTweet[]

  const result = await exportSavedTweetsToObsidian({
    outputDir: DEFAULT_OBSIDIAN_EXPORT_DIR,
    bookmarks,
    overwrite: options.overwrite,
    writeIndexes: !tweetIds,
  })

  console.log([
    'obsidian-export complete',
    `path=${DEFAULT_OBSIDIAN_EXPORT_DIR}`,
    `rows=${bookmarks.length}`,
    `written=${result.written}`,
    `skipped=${result.skipped}`,
    `indexes=${result.indexesWritten}`,
    `errors=${result.errors.length}`,
  ].join(' '))

  if (result.errors.length > 0) {
    console.log(JSON.stringify({ errors: result.errors }, null, 2))
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
