#!/usr/bin/env npx tsx
import { spawn, type StdioOptions } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkCreditFloor as defaultCheckCreditFloor, type CheckCreditFloorOptions, type CreditFloorResult } from '../lib/credit-guard'
import { DEFAULT_SIFTLY_CREDIT_RESERVE } from '../lib/settings'

export const DEFAULT_CREDIT_RESERVE = DEFAULT_SIFTLY_CREDIT_RESERVE
export const DEFAULT_WALL_BUDGET_MS = 20 * 60 * 1000
export const DEFAULT_INGEST_MAX_PAGES = 2
export const DEFAULT_PAGE_SIZE = 100
export const DEFAULT_STAGE_LIMIT = 500
export const DEFAULT_ALERT_CHANNEL_ID = '1480528231286181948'
export const DEFAULT_LOG_CHANNEL_ID = '1480525090331561984'

const SOURCE_COUNT = 2
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NOTIFY_SCRIPT = resolve(homedir(), '.hermes/scripts/notify.py')
const CRON_ENV_FLAG = 'SIFTLY_DAILY_CRON'

export type DailyIngestSourceName = 'bookmark' | 'like'
export type DailyIngestStageName = 'ingest' | 'enrich' | 'embed' | 'export'
export type DailyIngestFailureStage = DailyIngestStageName | 'credit-floor' | 'pipeline'
export type DailyIngestFailureKind = 'credit-floor' | 'stage-failure' | 'timeout'

export interface DailyIngestStageCommand {
  name: DailyIngestStageName
  command: string
  args: string[]
}

export interface DailyIngestConfig {
  reserve: number
  ingestMaxPages: number
  pageSize: number
  stageLimit: number
  wallBudgetMs: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface DailyIngestFailure {
  kind: DailyIngestFailureKind
  stage: DailyIngestFailureStage
  reason: string
}

export interface DailyIngestResult {
  ok: boolean
  exitCode: number
  stagesRun: DailyIngestStageName[]
  failure?: DailyIngestFailure
  alertSent?: boolean
  alertError?: string
  heartbeatSent?: boolean
  heartbeatError?: string
}

export interface DailyIngestRunContext {
  signal: AbortSignal
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface DailyIngestStageRunResult {
  sourceRows?: Partial<Record<DailyIngestSourceName, number>>
}

export interface DailyIngestSuccessSummary {
  bookmarks: number
  likes: number
}

export type DailyIngestStageRunner = (
  stage: DailyIngestStageCommand,
  context: DailyIngestRunContext,
) => Promise<DailyIngestStageRunResult | void>
export type DailyIngestAlertSender = (message: string, failure: DailyIngestFailure) => Promise<void>
export type DailyIngestHeartbeatSender = (message: string, summary: DailyIngestSuccessSummary) => Promise<void>
export type DailyIngestCreditFloorChecker = (options: CheckCreditFloorOptions) => Promise<CreditFloorResult>

export interface RunDailyIngestOptions {
  config?: Partial<Omit<DailyIngestConfig, 'env'> & { env: NodeJS.ProcessEnv }>
  stages?: DailyIngestStageCommand[]
  wallBudgetMs?: number
  checkCreditFloor?: DailyIngestCreditFloorChecker
  runStage?: DailyIngestStageRunner
  sendAlert?: DailyIngestAlertSender
  sendHeartbeat?: DailyIngestHeartbeatSender
}

class DailyIngestFailureError extends Error {
  constructor(public readonly failure: DailyIngestFailure) {
    super(failure.reason)
    this.name = 'DailyIngestFailureError'
  }
}

export function buildDailyIngestStages(config: Partial<DailyIngestConfig> = {}): DailyIngestStageCommand[] {
  const ingestMaxPages = normalizePositiveInt(config.ingestMaxPages, DEFAULT_INGEST_MAX_PAGES)
  const pageSize = normalizePositiveInt(config.pageSize, DEFAULT_PAGE_SIZE)
  const stageLimit = normalizePositiveInt(config.stageLimit, DEFAULT_STAGE_LIMIT)

  return [
    {
      name: 'ingest',
      command: 'npx',
      args: ['tsx', 'scripts/ingest.ts', '--incremental', '--max-pages', String(ingestMaxPages), '--page-size', String(pageSize)],
    },
    {
      name: 'enrich',
      command: 'npx',
      args: ['tsx', 'scripts/enrich.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'embed',
      command: 'npx',
      args: ['tsx', 'scripts/embed.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'export',
      command: 'npx',
      args: ['tsx', 'scripts/export-obsidian.ts', '--limit', String(stageLimit)],
    },
  ]
}

export async function runDailyIngest(options: RunDailyIngestOptions = {}): Promise<DailyIngestResult> {
  const config = resolveConfig(options.config)
  const stages = options.stages ?? buildDailyIngestStages(config)
  const runStage = options.runStage ?? runStageCommand
  const sendAlert = options.sendAlert ?? ((message, failure) => sendDiscordAlert(message, failure, config.env))
  const sendHeartbeat = options.sendHeartbeat ?? ((message, summary) => sendDiscordHeartbeat(message, summary, config.env))
  const checkCreditFloor = options.checkCreditFloor ?? defaultCheckCreditFloor
  const wallBudgetMs = normalizePositiveInt(options.wallBudgetMs, config.wallBudgetMs)
  const abortController = new AbortController()
  const stagesRun: DailyIngestStageName[] = []
  const successSummary: DailyIngestSuccessSummary = { bookmarks: 0, likes: 0 }
  let activeStage: DailyIngestFailureStage = 'pipeline'
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort(new Error(`daily ingest exceeded ${formatDurationMs(wallBudgetMs)} wall budget`))
  }, wallBudgetMs)
  timer.unref?.()

  try {
    activeStage = 'credit-floor'
    const credit = await checkCreditFloor({
      reserve: config.reserve,
      batchCap: config.ingestMaxPages * config.pageSize * SOURCE_COUNT,
      offWindow: true,
    })
    if (!credit.ok) {
      throw new DailyIngestFailureError({
        kind: 'credit-floor',
        stage: 'credit-floor',
        reason: credit.reason,
      })
    }

    for (const stage of stages) {
      activeStage = stage.name
      if (abortController.signal.aborted) throw timeoutFailure(activeStage, wallBudgetMs)
      const stageResult = await runStage(stage, { signal: abortController.signal, cwd: config.cwd, env: config.env })
      mergeSourceRows(successSummary, stageResult?.sourceRows)
      stagesRun.push(stage.name)
    }

    let heartbeatSent = false
    let heartbeatError: string | undefined
    if (isCronRun(config.env)) {
      try {
        await sendHeartbeat(formatHeartbeatMessage(successSummary), successSummary)
        heartbeatSent = true
      } catch (heartbeatErr) {
        heartbeatError = errorMessage(heartbeatErr)
        console.error(`daily-ingest heartbeat failed: ${heartbeatError}`)
      }
    }

    return { ok: true, exitCode: 0, stagesRun, heartbeatSent, heartbeatError }
  } catch (err) {
    const failure = timedOut
      ? timeoutFailure(activeStage, wallBudgetMs).failure
      : err instanceof DailyIngestFailureError
        ? err.failure
        : { kind: 'stage-failure' as const, stage: activeStage, reason: errorMessage(err) }

    const message = formatAlertMessage(failure)
    let alertSent = false
    let alertError: string | undefined
    try {
      await sendAlert(message, failure)
      alertSent = true
    } catch (alertErr) {
      alertError = errorMessage(alertErr)
      console.error(`daily-ingest alert failed: ${alertError}`)
    }

    return { ok: false, exitCode: 1, stagesRun, failure, alertSent, alertError }
  } finally {
    clearTimeout(timer)
  }
}

export async function runStageCommand(
  stage: DailyIngestStageCommand,
  context: DailyIngestRunContext,
): Promise<DailyIngestStageRunResult | void> {
  const captureOutput = stage.name === 'ingest'
  try {
    const result = await spawnAndWait(stage.command, stage.args, {
      cwd: context.cwd,
      env: context.env,
      signal: context.signal,
      stdio: captureOutput ? 'pipe' : 'inherit',
      killProcessGroup: true,
      pipeOutput: captureOutput,
    })
    if (captureOutput) return { sourceRows: parseIngestSourceRows(result.stdout) }
  } catch (err) {
    throw new Error(`${stage.name} failed: ${errorMessage(err)}`)
  }
}

export async function sendDiscordAlert(
  message: string,
  _failure?: DailyIngestFailure,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = envChannel(env.SIFTLY_ALERT_CHANNEL, DEFAULT_ALERT_CHANNEL_ID)
  try {
    await sendDiscordNotify(message, target, env)
  } catch (err) {
    console.error(`daily-ingest targeted alert failed; falling back to Home Discord: ${errorMessage(err)}`)
    await spawnAndWait('python3', [NOTIFY_SCRIPT, '--send', message, '--channel', 'discord'], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
      killProcessGroup: false,
    })
  }
}

export async function sendDiscordHeartbeat(
  message: string,
  _summary: DailyIngestSuccessSummary,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await sendDiscordNotify(message, envChannel(env.SIFTLY_LOG_CHANNEL, DEFAULT_LOG_CHANNEL_ID), env)
}

async function sendDiscordNotify(message: string, target: string, env: NodeJS.ProcessEnv): Promise<void> {
  await spawnAndWait('python3', [NOTIFY_SCRIPT, '--send', message, '--channel', 'discord', '--target', target], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    killProcessGroup: false,
  })
}

function resolveConfig(config: RunDailyIngestOptions['config'] = {}): DailyIngestConfig {
  const env = config.env ?? process.env
  return {
    reserve: normalizePositiveInt(config.reserve ?? numberFromEnv(env.SIFTLY_DAILY_CREDIT_RESERVE), DEFAULT_CREDIT_RESERVE),
    ingestMaxPages: normalizePositiveInt(config.ingestMaxPages ?? numberFromEnv(env.SIFTLY_DAILY_INGEST_MAX_PAGES), DEFAULT_INGEST_MAX_PAGES),
    pageSize: normalizePositiveInt(config.pageSize ?? numberFromEnv(env.SIFTLY_DAILY_PAGE_SIZE), DEFAULT_PAGE_SIZE),
    stageLimit: normalizePositiveInt(config.stageLimit ?? numberFromEnv(env.SIFTLY_DAILY_STAGE_LIMIT), DEFAULT_STAGE_LIMIT),
    wallBudgetMs: normalizePositiveInt(config.wallBudgetMs ?? numberFromEnv(env.SIFTLY_DAILY_WALL_BUDGET_MS), DEFAULT_WALL_BUDGET_MS),
    cwd: config.cwd ?? REPO_ROOT,
    env,
  }
}

function isCronRun(env: NodeJS.ProcessEnv): boolean {
  return env[CRON_ENV_FLAG] === '1'
}

function envChannel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function mergeSourceRows(summary: DailyIngestSuccessSummary, sourceRows: DailyIngestStageRunResult['sourceRows']): void {
  if (!sourceRows) return
  summary.bookmarks += normalizeNonNegativeInt(sourceRows.bookmark)
  summary.likes += normalizeNonNegativeInt(sourceRows.like)
}

function parseIngestSourceRows(output: string): DailyIngestStageRunResult['sourceRows'] {
  const sourceRows: Partial<Record<DailyIngestSourceName, number>> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^(bookmark|like):\s+.*\brows=(\d+)\b/.exec(line)
    if (!match) continue
    sourceRows[match[1] as DailyIngestSourceName] = Number(match[2])
  }
  return sourceRows
}

function formatHeartbeatMessage(summary: DailyIngestSuccessSummary): string {
  return `✅ siftly daily ingest: +${summary.bookmarks} bookmarks, +${summary.likes} likes`
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback
  return Math.floor(value)
}

function normalizeNonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return 0
  return Math.floor(value)
}

function timeoutFailure(stage: DailyIngestFailureStage, wallBudgetMs: number): DailyIngestFailureError {
  return new DailyIngestFailureError({
    kind: 'timeout',
    stage,
    reason: `time budget exceeded after ${formatDurationMs(wallBudgetMs)} while running ${stage}`,
  })
}

function formatAlertMessage(failure: DailyIngestFailure): string {
  return [`Siftly daily-ingest failed`, `stage=${failure.stage}`, `kind=${failure.kind}`, failure.reason].join(' — ')
}

function formatDurationMs(ms: number): string {
  const minutes = ms / 60_000
  if (Number.isInteger(minutes)) return `${minutes}m`
  return `${ms}ms`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  stdio: StdioOptions
  killProcessGroup: boolean
  pipeOutput?: boolean
}

interface SpawnResult {
  stdout: string
  stderr: string
}

function spawnAndWait(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      detached: options.killProcessGroup,
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (options.pipeOutput) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (options.pipeOutput) process.stderr.write(chunk)
    })

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      fn()
    }

    const terminate = () => {
      if (!child.pid) return
      try {
        if (options.killProcessGroup) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      killTimer = setTimeout(() => {
        if (!child.pid || child.killed) return
        try {
          if (options.killProcessGroup) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, 5_000)
      killTimer.unref?.()
    }

    function onAbort() {
      terminate()
    }

    if (options.signal?.aborted) terminate()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      settle(() => reject(err))
    })

    child.on('exit', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolvePromise({ stdout, stderr })
          return
        }
        const status = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
        reject(new Error(status))
      })
    })
  })
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1]
  return Boolean(entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href)
}

if (isDirectRun()) {
  runDailyIngest()
    .then((result) => {
      if (result.ok) {
        console.log(`daily-ingest complete stages=${result.stagesRun.join(',')}`)
        return
      }
      console.error(`daily-ingest failed: ${result.failure?.stage ?? 'unknown'}: ${result.failure?.reason ?? 'unknown failure'}`)
      process.exitCode = result.exitCode
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    })
}
