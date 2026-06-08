#!/usr/bin/env npx tsx
import { createEmbeddingProviderFromEnv, embedBookmarkCorpus } from '../src/lib/search/embeddings'
import { resolveDatabasePath } from '../src/lib/vec'

interface EmbedCliOptions {
  dbPath: string
  limit?: number
  batchSize?: number
  force: boolean
  confirmFullBackfill: boolean
  forceFallback: boolean
  sqliteVecExtensionPath?: string
  env: NodeJS.ProcessEnv
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/embed.ts --limit N [--force] [--batch-size N] [--db PATH|file:PATH]',
    '',
    'Embeds Bookmark rows into bookmark_embeddings and, when available, sqlite-vec.',
    'Defaults to OpenAI text-embedding-3-small. Provider is swappable with env:',
    '  SIFTLY_EMBED_PROVIDER=openai|openai-compatible|local',
    '  SIFTLY_EMBED_MODEL=text-embedding-3-small',
    '  SIFTLY_EMBED_BASE_URL=http://ace-ai:PORT/v1',
    '  SIFTLY_EMBED_API_KEY=<key-or-local-placeholder>',
    '  SIFTLY_SQLITE_VEC_EXTENSION_PATH=/path/to/vec0.dylib',
    '',
    'Safety: unbounded/full backfill is refused unless --confirm-full-backfill is passed by the main agent.',
  ].join('\n')
}

function parseArgs(argv: string[]): EmbedCliOptions {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const options: EmbedCliOptions = {
    dbPath: resolveDatabasePath(env.DATABASE_URL ?? 'file:./prisma/dev.db'),
    force: false,
    confirmFullBackfill: false,
    forceFallback: false,
    env,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
      case '--db':
        options.dbPath = resolveDatabasePath(requiredValue(argv, ++i, '--db'))
        break
      case '--limit':
        options.limit = positiveInt(requiredValue(argv, ++i, '--limit'), '--limit')
        break
      case '--batch-size':
        options.batchSize = positiveInt(requiredValue(argv, ++i, '--batch-size'), '--batch-size')
        break
      case '--force':
        options.force = true
        break
      case '--confirm-full-backfill':
        options.confirmFullBackfill = true
        break
      case '--force-fallback':
        options.forceFallback = true
        break
      case '--sqlite-vec-extension':
        options.sqliteVecExtensionPath = requiredValue(argv, ++i, '--sqlite-vec-extension')
        break
      case '--provider':
        env.SIFTLY_EMBED_PROVIDER = requiredValue(argv, ++i, '--provider')
        break
      case '--model':
        env.SIFTLY_EMBED_MODEL = requiredValue(argv, ++i, '--model')
        break
      case '--base-url':
        env.SIFTLY_EMBED_BASE_URL = requiredValue(argv, ++i, '--base-url')
        break
      case '--api-key':
        env.SIFTLY_EMBED_API_KEY = requiredValue(argv, ++i, '--api-key')
        break
      case '--dimensions':
        env.SIFTLY_EMBED_DIMENSIONS = String(positiveInt(requiredValue(argv, ++i, '--dimensions'), '--dimensions'))
        break
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  if (options.limit === undefined && !options.confirmFullBackfill) {
    throw new Error('Refusing unbounded embedding backfill; pass --limit N for a sample or --confirm-full-backfill after approval')
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const provider = createEmbeddingProviderFromEnv(options.env)
  const result = await embedBookmarkCorpus({
    dbPath: options.dbPath,
    provider,
    limit: options.limit,
    batchSize: options.batchSize,
    force: options.force,
    vecOptions: {
      forceFallback: options.forceFallback,
      extensionPath: options.sqliteVecExtensionPath,
      env: options.env,
    },
  })

  console.log([
    'embed complete',
    `db=${options.dbPath}`,
    `model=${result.model}`,
    `selected=${result.selected}`,
    `embedded=${result.embedded}`,
    `skipped=${result.skipped}`,
    `dimensions=${result.dimensions ?? 'n/a'}`,
    `vec=${result.vecMode}`,
    `vec-status=${JSON.stringify(result.vecStatus.reason)}`,
  ].join(' '))
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
