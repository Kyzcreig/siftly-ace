import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildDailyIngestStages,
  checkProfileProvenance,
  runDailyIngest,
  type DailyIngestStageCommand,
} from '../daily-ingest'

function testEnv(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...vars } as NodeJS.ProcessEnv
}

function okCredit() {
  return { remaining: 100_000, reserve: 50_000, ok: true, reason: 'ok' }
}

function stage(name: DailyIngestStageCommand['name'], soft = false): DailyIngestStageCommand {
  return { name, command: 'mock-stage', args: [name], ...(soft ? { soft: true } : {}) }
}

describe('#1 self-maintaining pf profile stage', () => {
  afterEach(() => vi.clearAllMocks())

  it('buildDailyIngestStages appends profile LAST, soft, with --brief-relevant-only', () => {
    const stages = buildDailyIngestStages()
    const last = stages[stages.length - 1]
    expect(stages.map((s) => s.name)).toEqual(['ingest', 'enrich', 'embed', 'export', 'profile'])
    expect(last.name).toBe('profile')
    expect(last.soft).toBe(true)
    expect(last.command).toBe('npx')
    expect(last.args).toEqual(['tsx', 'scripts/profile.ts', '--brief-relevant-only'])
  })

  it('a thrown soft profile stage does NOT fail the run; export/heartbeat still complete', async () => {
    const sendAlert = vi.fn()
    const sendHeartbeat = vi.fn()
    const runStage = vi.fn(async (s: DailyIngestStageCommand) => {
      if (s.name === 'export') return { created: 3 }
      if (s.name === 'profile') throw new Error('profile rebuild blew up')
    })

    const result = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      runStage,
      sendAlert,
      sendHeartbeat,
      stages: [stage('export'), stage('profile', true)],
      wallBudgetMs: 10_000,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })

    expect(result.ok).toBe(true)
    expect(result.stagesRun).toContain('export')
    expect(result.stagesRun).not.toContain('profile')
    expect(result.softFailures?.[0]).toMatchObject({ stage: 'profile' })
    expect(sendHeartbeat).toHaveBeenCalledTimes(1) // load-bearing heartbeat still fired
    expect(sendAlert).toHaveBeenCalled() // soft failure surfaced to #alerts
  })

  it('a thrown HARD stage still aborts with ok:false (soft flag must not weaken hard stages)', async () => {
    const result = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      runStage: vi.fn(async (s: DailyIngestStageCommand) => {
        if (s.name === 'embed') throw new Error('embed exploded')
      }),
      sendAlert: vi.fn(),
      sendHeartbeat: vi.fn(),
      stages: [stage('embed'), stage('profile', true)],
      wallBudgetMs: 10_000,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.stage).toBe('embed')
  })

  it('a wall-budget timeout during the soft profile stage surfaces as a TIMEOUT, not a swallowed soft failure', async () => {
    const result = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      // profile stage hangs past the tiny wall budget; the abort fires and the
      // stage rejects — must be classified as timeout, never soft-swallowed.
      runStage: vi.fn(async (s: DailyIngestStageCommand, ctx) => {
        if (s.name === 'profile') {
          await new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
      }),
      sendAlert: vi.fn(),
      sendHeartbeat: vi.fn(),
      stages: [stage('profile', true)],
      wallBudgetMs: 20,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('timeout')
  })
})

describe('#1 checkProfileProvenance (B5 freshness + mode)', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function writeProfile(content: unknown): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'siftly-prov-'))
    const p = path.join(dir, 'preference-profile.json')
    await writeFile(p, JSON.stringify(content), 'utf8')
    return p
  }

  it('passes for a fresh brief-relevant-only profile written during the stage', async () => {
    const stageStart = Date.now()
    const p = await writeProfile({ updated_at: new Date(stageStart + 100).toISOString(), signal_basis: { mode: 'brief-relevant-only' } })
    expect(checkProfileProvenance(stageStart, testEnv(), p)).toBeNull()
  })

  it('fails profile-contaminated when mode is whole-corpus', async () => {
    const stageStart = Date.now()
    const p = await writeProfile({ updated_at: new Date(stageStart + 100).toISOString(), signal_basis: { mode: 'whole-corpus' } })
    expect(checkProfileProvenance(stageStart, testEnv(), p)).toMatch(/profile-contaminated/)
  })

  it('fails profile-stale when updated_at predates the stage start (yesterday\u2019s profile)', async () => {
    const stageStart = Date.now()
    const yesterday = new Date(stageStart - 24 * 3600 * 1000).toISOString()
    const p = await writeProfile({ updated_at: yesterday, signal_basis: { mode: 'brief-relevant-only' } })
    expect(checkProfileProvenance(stageStart, testEnv(), p)).toMatch(/profile-stale/)
  })

  it('fails profile-write-failed when the file is missing', () => {
    expect(checkProfileProvenance(Date.now(), testEnv(), '/nonexistent/preference-profile.json')).toMatch(/profile-write-failed/)
  })

  it('a slow-but-valid rebuild still passes (no upper freshness bound)', async () => {
    const stageStart = Date.now() - 5 * 60 * 1000 // stage started 5 min ago; rebuild finished now
    const p = await writeProfile({ updated_at: new Date().toISOString(), signal_basis: { mode: 'brief-relevant-only' } })
    expect(checkProfileProvenance(stageStart, testEnv(), p)).toBeNull()
  })
})
