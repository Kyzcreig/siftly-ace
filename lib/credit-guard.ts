import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { getSiftlyCreditReserve } from '@/lib/settings'

const execFileAsync = promisify(execFile)
const DEFAULT_APP = 'siftly-ace'
const USAGE_URL = 'https://api.x.com/2/usage/tweets'
const USAGE_PATH = '/2/usage/tweets'

interface UsageResponse {
  status: number
  text(): Promise<string>
}

type FetchImpl = (url: string, init?: { headers: Record<string, string> }) => Promise<UsageResponse>

export interface CheckCreditFloorOptions {
  reserve?: number
  bearer?: string
  app?: string
  batchCap?: number
  offWindow?: boolean
  fetchImpl?: FetchImpl
  logger?: Pick<typeof console, 'warn'>
}

export interface CreditFloorResult {
  remaining: number | null
  reserve: number
  ok: boolean
  reason: string
  balanceUnavailable?: boolean
}

type UsageReadResult =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'http'; status: number; payload: unknown | null; raw: string }
  | { kind: 'parse'; raw: string }
  | { kind: 'network'; message: string }

export async function checkCreditFloor(options: CheckCreditFloorOptions): Promise<CreditFloorResult> {
  const reserve = normalizeReserve(options.reserve ?? getSiftlyCreditReserve())

  try {
    const usage = await readUsage(options)

    if (usage.kind === 'parse') {
      return failClosed(options, reserve, `usage endpoint parse failure: invalid JSON${usage.raw ? ` (${preview(usage.raw)})` : ''}`)
    }

    if (usage.kind === 'network') {
      return failClosed(options, reserve, `usage endpoint network error: ${usage.message}`)
    }

    if (usage.kind === 'http') {
      if (isUserToken403(usage.status, usage.payload, usage.raw)) {
        return failClosed(
          options,
          reserve,
          'CONFIG: usage endpoint needs app-only bearer; user-context OAuth token returned 403 Unsupported Authentication',
        )
      }

      if (isStructurallyUnavailable(usage.status, usage.payload, usage.raw)) {
        return balanceUnavailable(options, reserve, `HTTP ${usage.status}: ${payloadMessage(usage.payload) ?? preview(usage.raw)}`)
      }

      return failClosed(options, reserve, `usage endpoint returned HTTP ${usage.status}: ${payloadMessage(usage.payload) ?? preview(usage.raw)}`)
    }

    const parsed = parseUsageBalance(usage.payload)
    if (!parsed) {
      return balanceUnavailable(options, reserve, 'usage payload missing numeric data.project_cap or data.project_usage')
    }

    const remaining = parsed.projectCap - parsed.projectUsage
    if (remaining < reserve) {
      return {
        remaining,
        reserve,
        ok: false,
        reason: `remaining credits ${remaining} below reserve ${reserve}`,
      }
    }

    return {
      remaining,
      reserve,
      ok: true,
      reason: `remaining credits ${remaining} at/above reserve ${reserve}`,
    }
  } catch (err) {
    return failClosed(options, reserve, `usage endpoint network error: ${errorMessage(err)}`)
  }
}

async function readUsage(options: CheckCreditFloorOptions): Promise<UsageReadResult> {
  if (options.bearer) return readUsageWithBearer(options.bearer, options.fetchImpl)
  return readUsageWithXurl(options.app ?? DEFAULT_APP)
}

async function readUsageWithBearer(bearer: string, fetchImpl?: FetchImpl): Promise<UsageReadResult> {
  try {
    const doFetch: FetchImpl = fetchImpl ?? ((url, init) => fetch(url, init))
    const response = await doFetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const raw = await response.text()
    const parsed = parseJson(raw)

    if (!parsed.ok) return { kind: 'parse', raw }
    const payloadHttpStatus = payloadStatus(parsed.value)
    if (payloadHttpStatus && payloadHttpStatus >= 400) {
      return { kind: 'http', status: payloadHttpStatus, payload: parsed.value, raw }
    }
    if (response.status >= 400) return { kind: 'http', status: response.status, payload: parsed.value, raw }
    return { kind: 'ok', payload: parsed.value }
  } catch (err) {
    return { kind: 'network', message: errorMessage(err) }
  }
}

async function readUsageWithXurl(app: string): Promise<UsageReadResult> {
  try {
    const { stdout } = await execFileAsync('xurl', ['--app', app, '--auth', 'app', USAGE_PATH], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    const parsed = parseJson(stdout)
    if (!parsed.ok) return { kind: 'parse', raw: stdout }
    const payloadHttpStatus = payloadStatus(parsed.value)
    if (payloadHttpStatus && payloadHttpStatus >= 400) {
      return { kind: 'http', status: payloadHttpStatus, payload: parsed.value, raw: stdout }
    }
    return { kind: 'ok', payload: parsed.value }
  } catch (err) {
    const childErr = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const stdout = childErr.stdout ? String(childErr.stdout) : ''
    const stderr = childErr.stderr ? String(childErr.stderr) : ''
    const raw = stdout || stderr || childErr.message || ''
    const parsed = parseJson(stdout)
    const status = parsed.ok ? payloadStatus(parsed.value) : statusFromText(raw)

    if (parsed.ok && status) return { kind: 'http', status, payload: parsed.value, raw }
    if (!parsed.ok && stdout.trim()) return { kind: 'parse', raw: stdout }
    return { kind: 'network', message: preview(raw) || 'xurl app-only usage request failed' }
  }
}

function normalizeReserve(reserve: number): number {
  if (!Number.isFinite(reserve) || reserve < 0) return getSiftlyCreditReserve()
  return Math.floor(reserve)
}

function parseUsageBalance(payload: unknown): { projectCap: number; projectUsage: number } | null {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data
  const projectCap = numberValue(data?.project_cap)
  const projectUsage = numberValue(data?.project_usage)
  if (projectCap === null || projectUsage === null) return null
  return { projectCap, projectUsage }
}

function numberValue(raw: unknown): number | null {
  // The X usage API returns project_cap/project_usage as JSON STRINGS ("2000000"),
  // not numbers — coerce numeric strings, reject everything else.
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function balanceUnavailable(options: CheckCreditFloorOptions, reserve: number, detail: string): CreditFloorResult {
  const batchCap = options.batchCap
  const constrained = typeof batchCap === 'number' && Number.isFinite(batchCap) && batchCap > 0 && batchCap <= reserve && options.offWindow === true

  if (constrained) {
    const reason = `balance unavailable (${detail}); proceeding under batch cap ${Math.floor(batchCap)} during off-window`
    const logger = options.logger ?? console
    logger.warn(`credit guard: ${reason}`)
    return {
      remaining: null,
      reserve,
      ok: true,
      reason,
      balanceUnavailable: true,
    }
  }

  return {
    remaining: null,
    reserve,
    ok: false,
    reason: `balance unavailable: ${detail}; missing safe batch cap/off-window constraints`,
    balanceUnavailable: true,
  }
}

function failClosed(options: CheckCreditFloorOptions, reserve: number, reason: string): CreditFloorResult {
  const logger = options.logger ?? console
  logger.warn(`credit guard: fail-closed (ingest blocked) — ${reason}`)
  return {
    remaining: null,
    reserve,
    ok: false,
    reason,
  }
}

function isUserToken403(status: number, payload: unknown, raw: string): boolean {
  if (status !== 403) return false
  const message = `${payloadMessage(payload) ?? ''} ${raw}`
  return /unsupported authentication|user context|oauth\s*2\.0 user/i.test(message)
}

function isStructurallyUnavailable(status: number, payload: unknown, raw: string): boolean {
  if (status === 404 || status === 410) return true
  const message = `${payloadMessage(payload) ?? ''} ${raw}`
  return /structurally unavailable|usage endpoint unavailable|balance unavailable/i.test(message)
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function payloadStatus(payload: unknown): number | undefined {
  const obj = payload as Record<string, unknown> | null
  if (typeof obj?.status === 'number') return obj.status
  const errors = Array.isArray(obj?.errors) ? (obj.errors as Record<string, unknown>[]) : []
  for (const error of errors) {
    if (typeof error.status === 'number') return error.status
    if (typeof error.code === 'number') return error.code
  }
  return statusFromText(JSON.stringify(payload))
}

function payloadMessage(payload: unknown): string | undefined {
  const obj = payload as Record<string, unknown> | null
  if (typeof obj?.detail === 'string') return obj.detail
  if (typeof obj?.title === 'string') return obj.title
  const errors = Array.isArray(obj?.errors) ? obj.errors : []
  if (errors.length === 0) return undefined
  return errors
    .map((error) => {
      if (typeof error === 'string') return error
      const errObj = error as Record<string, unknown>
      return String(errObj.message ?? errObj.detail ?? errObj.title ?? JSON.stringify(error))
    })
    .join('; ')
}

function statusFromText(text: string): number | undefined {
  if (/\b410\b/i.test(text)) return 410
  if (/\b404\b|not found/i.test(text)) return 404
  if (/\b403\b|unsupported authentication/i.test(text)) return 403
  if (/\b402\b|creditsdepleted/i.test(text)) return 402
  return undefined
}

function preview(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 300)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
