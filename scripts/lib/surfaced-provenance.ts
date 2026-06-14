import { mkdir, appendFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_MATURITY_DAYS = 14
export const DEFAULT_SURFACED_PROVENANCE_RETENTION_DAYS = 90
export const DEFAULT_SURFACED_PROVENANCE_DIR = path.join(process.cwd(), 'docs', 'eval', 'surfaced-items')

export type SurfacedItemInput = {
  id: string
  url?: string | null
  text?: string | null
  title?: string | null
  source?: string | null
  rank?: number | null
  scores?: Record<string, number | null | undefined>
  metadata?: Record<string, unknown>
}

export type SurfacedProvenanceRecord = {
  id: string
  brief: string
  provenance_kind: 'brief-surfaced'
  outcome: 'saw_didnt_save_pending'
  surfaced_at: string
  matures_at: string
  maturity_days: number
  url?: string | null
  text?: string | null
  title?: string | null
  source?: string | null
  rank?: number | null
  scores?: Record<string, number | null | undefined>
  metadata?: Record<string, unknown>
}

export type AppendSurfacedProvenanceOptions = {
  brief: string
  logDir?: string
  now?: Date
  maturityDays?: number
  retentionDays?: number
}

export type SweepSurfacedProvenanceRetentionOptions = {
  now?: Date
  retentionDays?: number
}

export type SweepSurfacedProvenanceRetentionResult = {
  logDir: string
  cutoffPtDay: string
  retentionDays: number
  deleted: string[]
  kept: string[]
}

export type AppendSurfacedProvenanceResult = {
  path: string
  count: number
  records: SurfacedProvenanceRecord[]
}

function utcIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function ptDayForDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) throw new Error('failed to format PT day')
  return `${year}-${month}-${day}`
}

function shiftPtDay(ptDay: string, days: number): string {
  const out = new Date(`${ptDay}T00:00:00.000Z`)
  out.setUTCDate(out.getUTCDate() + days)
  return utcIsoDate(out)
}

function addUtcDays(date: Date, days: number): Date {
  const out = new Date(date.getTime())
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

export function surfacedProvenancePath(
  now: Date = new Date(),
  logDir: string = DEFAULT_SURFACED_PROVENANCE_DIR,
): string {
  return path.join(logDir, `surfaced-items-${ptDayForDate(now)}.jsonl`)
}

/**
 * Deletes dated surfaced-items-YYYY-MM-DD.jsonl files older than the retention window.
 * The YYYY-MM-DD boundary is the same America/Los_Angeles PT day used by dedup keys.
 */
export async function sweepSurfacedProvenanceRetention(
  logDir: string = DEFAULT_SURFACED_PROVENANCE_DIR,
  options: SweepSurfacedProvenanceRetentionOptions = {},
): Promise<SweepSurfacedProvenanceRetentionResult> {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? DEFAULT_SURFACED_PROVENANCE_RETENTION_DAYS
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('surfaced provenance retentionDays must be a positive integer')
  }

  const cutoffPtDay = shiftPtDay(ptDayForDate(now), -retentionDays)
  const deleted: string[] = []
  const kept: string[] = []
  let entries: { name: string; isFile(): boolean }[]
  try {
    entries = await readdir(logDir, { withFileTypes: true })
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === 'ENOENT') {
      return { logDir, cutoffPtDay, retentionDays, deleted, kept }
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^surfaced-items-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name)
    if (!match) continue
    const filePtDay = match[1]
    const filePath = path.join(logDir, entry.name)
    if (filePtDay < cutoffPtDay) {
      await unlink(filePath)
      deleted.push(filePath)
    } else {
      kept.push(filePath)
    }
  }

  return { logDir, cutoffPtDay, retentionDays, deleted, kept }
}

export async function appendSurfacedProvenance(
  items: SurfacedItemInput[],
  options: AppendSurfacedProvenanceOptions,
): Promise<AppendSurfacedProvenanceResult> {
  const now = options.now ?? new Date()
  const maturityDays = options.maturityDays ?? DEFAULT_MATURITY_DAYS
  if (maturityDays < DEFAULT_MATURITY_DAYS) {
    throw new Error(`surfaced provenance maturity must be >= ${DEFAULT_MATURITY_DAYS} days`)
  }

  const logDir = options.logDir ?? DEFAULT_SURFACED_PROVENANCE_DIR
  const logPath = surfacedProvenancePath(now, logDir)
  const surfacedAt = now.toISOString()
  const maturesAt = addUtcDays(now, maturityDays).toISOString()
  const records = items.map((item) => toRecord(item, options.brief, surfacedAt, maturesAt, maturityDays))

  await sweepSurfacedProvenanceRetention(logDir, { now, retentionDays: options.retentionDays })
  await mkdir(path.dirname(logPath), { recursive: true })
  if (records.length > 0) {
    await appendFile(logPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  }

  return { path: logPath, count: records.length, records }
}

function toRecord(
  item: SurfacedItemInput,
  brief: string,
  surfacedAt: string,
  maturesAt: string,
  maturityDays: number,
): SurfacedProvenanceRecord {
  if (!item.id || !item.id.trim()) {
    throw new Error('surfaced provenance item id is required')
  }
  return {
    id: item.id,
    brief,
    provenance_kind: 'brief-surfaced',
    outcome: 'saw_didnt_save_pending',
    surfaced_at: surfacedAt,
    matures_at: maturesAt,
    maturity_days: maturityDays,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.text !== undefined ? { text: item.text } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.rank !== undefined ? { rank: item.rank } : {}),
    ...(item.scores !== undefined ? { scores: item.scores } : {}),
    ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
  }
}
