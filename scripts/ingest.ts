import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import prisma from '../lib/db'
import { evaluateIngestCostGate, formatCostEstimate } from '../lib/cost-estimate'
import { ingestXurlSources, type IngestResult, type XurlIngestDb, type XurlSource } from '../lib/xurl-ingest'
import {
  decideEarlyStop,
  loadIngestStates,
  makePrismaKnownTweetIds,
  stampFullWalk,
  type BookmarkFindManyDelegate,
  type IngestStateReadDelegate,
  type IngestStateUpsertDelegate,
} from '../lib/incremental-early-stop'

interface CliOptions {
  app: string
  userId: string
  maxPages: number
  pageSize: number
  limit?: number
  dryRun: boolean
  confirm: boolean
  incremental: boolean
  sources: XurlSource[]
}

interface IngestCliDependencies {
  db?: XurlIngestDb
  ingest?: typeof ingestXurlSources
  log?: (message: string) => void
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/ingest.ts [--limit N] [--dry] [--confirm] [--incremental] [--max-pages N] [--page-size N] [--source bookmark|like|both]',
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
    confirm: false,
    incremental: false,
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
      case '--confirm':
        options.confirm = true
        break
      case '--incremental':
        options.incremental = true
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

export async function runIngestCli(argv: string[], deps: IngestCliDependencies = {}): Promise<void> {
  const options = parseArgs(argv)
  if (options.limit !== undefined && !options.dryRun) {
    throw new Error('--limit is only allowed with --dry/--dry-run so pagination cursors cannot skip un-ingested rows')
  }

  const log = deps.log ?? ((message: string) => console.log(message))
  const gate = evaluateIngestCostGate({
    maxPages: options.maxPages,
    pageSize: options.pageSize,
    dryRun: options.dryRun,
    confirm: options.confirm,
    incremental: options.incremental,
  })

  if (gate.estimate) {
    log(formatCostEstimate(gate.estimate))
    if (!gate.proceed) return
  }

  const ingest = deps.ingest ?? ingestXurlSources
  const db = deps.db ?? (prisma as XurlIngestDb)

  // Early-stop wiring (incremental only — D-4/D-7/D-8/D-9). For backfill, ingestXurlSources
  // ignores the seam anyway (I2); we simply don't compute it.
  let earlyStop: ReturnType<typeof decideEarlyStop> | undefined
  if (options.incremental) {
    const delegates = db as unknown as {
      bookmark?: BookmarkFindManyDelegate
      ingestState?: IngestStateReadDelegate
    }
    if (delegates.bookmark?.findMany) {
      const probe = makePrismaKnownTweetIds(delegates.bookmark)
      const states = await loadIngestStates(delegates.ingestState, options.sources)
      earlyStop = decideEarlyStop({ probe, states })
      if (earlyStop.fullWalkReason) {
        log(`early-stop: SKIPPED (full walk) reason=${earlyStop.fullWalkReason}`)
      }
    }
  }

  const result = await ingest({
    db,
    app: options.app,
    userId: options.userId,
    maxPages: options.maxPages,
    pageSize: options.pageSize,
    limit: options.limit,
    dryRun: options.dryRun,
    sources: options.sources,
    // Incremental runs must start from the TOP of the list (X paginates newest→older;
    // resuming from a persisted cursor would skip new bookmarks). Full backfill resumes.
    resumeFromCursor: !options.incremental,
    ...(earlyStop?.knownTweetIds ? { knownTweetIds: earlyStop.knownTweetIds } : {}),
    ...(earlyStop?.earlyStopK ? { earlyStopK: earlyStop.earlyStopK } : {}),
  })

  // D-7: after a safety-net full walk, reset the cadence by stamping lastFullWalkAt.
  // BUGFIX 2026-06-26: stamp EVERY source whose budgeted sweep completed cleanly —
  // NOT only sources that reached the absolute frontier (nextCursor === null). The
  // daily job runs --max-pages 5 against a corpus far larger than 5 pages, so a
  // safety-net walk can never exhaust; the old exhaustion-only gate meant
  // lastFullWalkAt never updated and the safety-net re-fired EVERY run forever
  // (~950 reads/night for a handful of new items). The periodic deeper sweep DID
  // run; its CADENCE must reset. A walk cut short by credit-depletion/interruption
  // is NOT a completed sweep, so those still don't stamp (cadence stays due).
  if (
    options.incremental &&
    !options.dryRun &&
    earlyStop?.fullWalkReason === 'safety-net' &&
    !result.creditsDepleted &&
    !result.interrupted
  ) {
    // Stamp sources that actually ran this sweep (have a perSource entry).
    const swept = options.sources.filter((s) => result.perSource[s] !== undefined)
    if (swept.length > 0) {
      await stampFullWalk(
        (db as unknown as { ingestState?: IngestStateUpsertDelegate }).ingestState,
        swept,
      )
    }
  }

  // D-9: surface why a full walk happened (distinct from a probe failure, I7).
  if (earlyStop?.fullWalkReason) {
    ;(result as IngestResult).fullWalkReason = earlyStop.fullWalkReason
  }

  printResult(result, options, log)
}

function printResult(result: IngestResult, options: CliOptions, log: (message: string) => void): void {
  const rowsIngested = result.created + result.updated
  log([
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
    log(
      `${source}: pages=${sourceStats.pages} rows=${sourceStats.rows} next-cursor=${sourceStats.nextCursor ?? 'none'}`,
    )
  }

  if (result.creditsDepleted) {
    log(`CREDITS DEPLETED on ${result.creditsDepleted.source} (402); fetched rows saved + cursor persisted — re-run to resume.`)
  }
  if (result.interrupted) {
    log(`INTERRUPTED on ${result.interrupted.source} (status=${result.interrupted.status ?? 'unknown'}): ${result.interrupted.message}`)
    log(`Partial rows were saved + cursor persisted — re-run the same command to resume from where it stopped.`)
  }
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1]
  return Boolean(entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href)
}

if (isDirectRun()) {
  runIngestCli(process.argv.slice(2))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
