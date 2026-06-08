import prisma from '../lib/db'
import { drainVideoQueue, resolveHealthyParakeetBackends, resolveVideoQueuePath, type VideoEnrichDb } from '../src/lib/enrich'

interface CliOptions {
  limit: number
  workers?: number
  queuePath?: string
  scriptPath?: string
  timeoutMs: number
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/video-enrich.ts [--limit N] [--workers N] [--queue-path PATH] [--script PATH] [--timeout-ms N]',
    '',
    'Drains the out-of-band video transcription queue with per-item leases and 2-3 parallel download workers. This is intentionally separate from scripts/enrich.ts and the daily cron budget.',
  ].join('\n')
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { limit: 5, timeoutMs: 30 * 60_000 }
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
      case '--workers':
        options.workers = parsePositiveInt(argv[++i], '--workers')
        if (options.workers > 3) throw new Error('--workers must be 1, 2, or 3 (per-card max_inflight stays 1)')
        break
      case '--queue-path':
        options.queuePath = argv[++i]
        if (!options.queuePath) throw new Error('--queue-path requires a value')
        break
      case '--script':
        options.scriptPath = argv[++i]
        if (!options.scriptPath) throw new Error('--script requires a value')
        break
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInt(argv[++i], '--timeout-ms')
        break
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }
  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const queuePath = resolveVideoQueuePath(options.queuePath)
  const backendUrls = await resolveHealthyParakeetBackends()
  console.log(`video queue path=${queuePath}`)
  console.log(`video parakeet backends=${backendUrls.join(',') || 'none'}`)
  const result = await drainVideoQueue({
    db: prisma as unknown as VideoEnrichDb,
    queuePath,
    limit: options.limit,
    workers: options.workers,
    scriptPath: options.scriptPath,
    timeoutMs: options.timeoutMs,
    backendUrls,
  })

  console.log(
    [
      'video-enrich complete',
      `workers=${options.workers ?? 'auto'}`,
      `processed=${result.processed}`,
      `transcribed=${result.transcribed}`,
      `failed=${result.failed}`,
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
