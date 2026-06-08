import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CREDIT_RESERVE,
  buildDailyIngestStages,
  runDailyIngest,
  type DailyIngestStageCommand,
} from '../../scripts/daily-ingest'

function okCredit() {
  return {
    remaining: 100_000,
    reserve: DEFAULT_CREDIT_RESERVE,
    ok: true,
    reason: 'remaining credits 100000 at/above reserve 50000',
  }
}

function stage(name: DailyIngestStageCommand['name']): DailyIngestStageCommand {
  return { name, command: 'mock-stage', args: [name] }
}

describe('daily ingest driver', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('short-circuits on credit-floor failure, sends exactly one alert, and never ingests', async () => {
    const checkCreditFloor = vi.fn().mockResolvedValue({
      remaining: 49_999,
      reserve: DEFAULT_CREDIT_RESERVE,
      ok: false,
      reason: 'remaining credits 49999 below reserve 50000',
    })
    const runStage = vi.fn()
    const sendAlert = vi.fn()

    const result = await runDailyIngest({
      checkCreditFloor,
      runStage,
      sendAlert,
      stages: [stage('ingest')],
      wallBudgetMs: 10_000,
    })

    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ stage: 'credit-floor', kind: 'credit-floor' })
    expect(checkCreditFloor).toHaveBeenCalledWith(expect.objectContaining({ reserve: DEFAULT_CREDIT_RESERVE }))
    expect(runStage).not.toHaveBeenCalled()
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert.mock.calls[0][0]).toMatch(/credit-floor/i)
    expect(sendAlert.mock.calls[0][0]).toMatch(/below reserve/i)
  })

  it('alerts exactly once with the failing stage name and exits non-zero on stage failure', async () => {
    const checkCreditFloor = vi.fn().mockResolvedValue(okCredit())
    const sendAlert = vi.fn()
    const stages = [stage('ingest'), stage('enrich'), stage('embed')]
    const runStage = vi.fn(async (nextStage: DailyIngestStageCommand) => {
      if (nextStage.name === 'enrich') throw new Error('fixture enrich failure')
    })

    const result = await runDailyIngest({
      checkCreditFloor,
      runStage,
      sendAlert,
      stages,
      wallBudgetMs: 10_000,
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.failure).toMatchObject({ stage: 'enrich', kind: 'stage-failure' })
    expect(runStage).toHaveBeenCalledTimes(2)
    expect(runStage.mock.calls.map(([nextStage]) => nextStage.name)).toEqual(['ingest', 'enrich'])
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert.mock.calls[0][0]).toMatch(/enrich/i)
    expect(sendAlert.mock.calls[0][0]).toMatch(/fixture enrich failure/i)
  })

  it('kills the active stage and sends one alert on wall-budget overrun', async () => {
    vi.useFakeTimers()
    const checkCreditFloor = vi.fn().mockResolvedValue(okCredit())
    const sendAlert = vi.fn()
    const killed: string[] = []
    const runStage = vi.fn((nextStage: DailyIngestStageCommand, context: { signal: AbortSignal }) => {
      return new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          killed.push(nextStage.name)
          reject(new Error('mock runner killed'))
        }, { once: true })
      })
    })

    const resultPromise = runDailyIngest({
      checkCreditFloor,
      runStage,
      sendAlert,
      stages: [stage('ingest'), stage('enrich')],
      wallBudgetMs: 25,
    })

    await vi.advanceTimersByTimeAsync(25)
    const result = await resultPromise

    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ stage: 'ingest', kind: 'timeout' })
    expect(killed).toEqual(['ingest'])
    expect(runStage).toHaveBeenCalledTimes(1)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert.mock.calls[0][0]).toMatch(/time budget/i)
    expect(sendAlert.mock.calls[0][0]).toMatch(/ingest/i)
  })

  it('runs the mocked end-to-end daily wiring without live X/OpenAI spend', async () => {
    const checkCreditFloor = vi.fn().mockResolvedValue(okCredit())
    const sendAlert = vi.fn()
    const observed: string[] = []
    const runStage = vi.fn(async (nextStage: DailyIngestStageCommand) => {
      observed.push([nextStage.command, ...nextStage.args].join(' '))
    })

    const result = await runDailyIngest({
      checkCreditFloor,
      runStage,
      sendAlert,
      wallBudgetMs: 10_000,
      config: { ingestMaxPages: 2, pageSize: 100, stageLimit: 500 },
    })

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(observed).toEqual([
      'npx tsx scripts/ingest.ts --incremental --max-pages 2 --page-size 100',
      'npx tsx scripts/enrich.ts --limit 500',
      'npx tsx scripts/embed.ts --limit 500',
      'npx tsx scripts/export-obsidian.ts --limit 500',
    ])
    expect(observed.join(' ')).not.toMatch(/confirm-full-backfill|--confirm\b/)
  })

  it('builds a bounded incremental stage list by default', () => {
    const stages = buildDailyIngestStages()

    expect(stages.map((nextStage) => nextStage.name)).toEqual(['ingest', 'enrich', 'embed', 'export'])
    expect(stages[0].args).toContain('--incremental')
    expect(stages[0].args).toContain('--max-pages')
    expect(stages[0].args).not.toContain('--confirm')
    expect(stages[2].args).toContain('--limit')
    expect(stages[2].args).not.toContain('--confirm-full-backfill')
  })
})
