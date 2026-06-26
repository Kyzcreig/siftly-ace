import { describe, expect, it } from 'vitest'

import {
  detectReadAmplification,
  runDailyIngest,
  type DailyIngestFailure,
  type DailyIngestStageCommand,
  type DailyIngestStageRunResult,
} from '../daily-ingest'

// ---------------------------------------------------------------------------
// detectReadAmplification — the pure guard logic.
// batchCap for the live daily job = 5 pages × 100 × 2 sources = 1000.
// ---------------------------------------------------------------------------
describe('detectReadAmplification', () => {
  const CAP = 1000

  it('FLAGS the bug signature: full-walk-sized reads, early-stop NOT engaged, no reason', () => {
    // The exact incident: 947 reads for 18 new, cheap path should have engaged.
    const r = detectReadAmplification({ reads: 947, created: 18, batchCap: CAP, earlyStopped: false, fullWalkReason: undefined })
    expect(r?.anomaly).toBe(true)
    expect(r?.reason).toContain('947 API reads')
  })

  it('stays QUIET on a normal early-stop day (small reads, early-stop engaged)', () => {
    expect(detectReadAmplification({ reads: 190, created: 18, batchCap: CAP, earlyStopped: true })).toBeNull()
  })

  it('stays QUIET on a legitimate weekly safety-net day (high reads WITH a reason)', () => {
    expect(detectReadAmplification({ reads: 947, created: 18, batchCap: CAP, earlyStopped: false, fullWalkReason: 'safety-net' })).toBeNull()
  })

  it('stays QUIET on a deliberate kill-switch day', () => {
    expect(detectReadAmplification({ reads: 1000, created: 5, batchCap: CAP, earlyStopped: false, fullWalkReason: 'kill-switch' })).toBeNull()
  })

  it('does NOT double-flag a probe-error day (that has its own WARN/alert path)', () => {
    expect(detectReadAmplification({ reads: 980, created: 3, batchCap: CAP, earlyStopped: false, fullWalkReason: 'probe-error' })).toBeNull()
  })

  it('stays QUIET when reads are below the 60% ceiling even without an explicit reason', () => {
    // 599 < 600 threshold — a partial walk that still mostly early-stopped, not the bug.
    expect(detectReadAmplification({ reads: 599, created: 10, batchCap: CAP, earlyStopped: undefined })).toBeNull()
  })

  it('fires exactly at the 60% boundary', () => {
    expect(detectReadAmplification({ reads: 600, created: 10, batchCap: CAP, earlyStopped: false })).not.toBeNull()
    expect(detectReadAmplification({ reads: 599, created: 10, batchCap: CAP, earlyStopped: false })).toBeNull()
  })

  it('is inert when batchCap is bogus (no divide-by-zero / false alarm)', () => {
    expect(detectReadAmplification({ reads: 947, created: 18, batchCap: 0, earlyStopped: false })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the guard must produce a LOUD alert through runDailyIngest's
// sendAlert path on an anomalous run, and stay silent on a clean early-stop run.
// ---------------------------------------------------------------------------
function ingestStage(): DailyIngestStageCommand {
  return { name: 'ingest', command: 'mock', args: ['ingest'] }
}

function runWith(stageResult: DailyIngestStageRunResult) {
  const alerts: { message: string; failure: DailyIngestFailure }[] = []
  const heartbeats: string[] = []
  return {
    alerts,
    heartbeats,
    promise: runDailyIngest({
      config: {
        env: { NODE_ENV: 'test', SIFTLY_DAILY_CRON: '1' } as NodeJS.ProcessEnv, // cron path → heartbeat runs
        ingestMaxPages: 5,
        pageSize: 100,
      },
      stages: [ingestStage()],
      checkCreditFloor: async () => ({ ok: true, reason: '' }) as never,
      runStage: async () => stageResult,
      sendAlert: async (message, failure) => { alerts.push({ message, failure }) },
      sendHeartbeat: async (message) => { heartbeats.push(message) },
    }),
  }
}

describe('runDailyIngest — read-amplification loud alert', () => {
  it('fires a LOUD alert when the ingest full-walked with no reason (the bug)', async () => {
    const { alerts, heartbeats, promise } = runWith({
      sourceRows: { bookmark: 450, like: 497 },
      created: 18,
      updated: 405,
      earlyStopped: false,
      fullWalkReason: undefined,
    })
    const result = await promise
    expect(result.ok).toBe(true) // run still succeeds — it's a warning, not a failure
    expect(heartbeats.length).toBe(1) // heartbeat still sent
    const ampAlert = alerts.find((a) => a.message.includes('read-amplification'))
    expect(ampAlert).toBeDefined()
    expect(ampAlert?.message).toContain('947 API reads')
  })

  it('stays SILENT (no alert) on a clean early-stop run', async () => {
    const { alerts, promise } = runWith({
      sourceRows: { bookmark: 95, like: 95 },
      created: 18,
      updated: 40,
      earlyStopped: true,
      fullWalkReason: undefined,
    })
    await promise
    expect(alerts.find((a) => a.message.includes('read-amplification'))).toBeUndefined()
  })

  it('stays SILENT on a legitimate safety-net day (high reads WITH reason)', async () => {
    const { alerts, promise } = runWith({
      sourceRows: { bookmark: 450, like: 497 },
      created: 18,
      updated: 405,
      earlyStopped: false,
      fullWalkReason: 'safety-net',
    })
    await promise
    expect(alerts.find((a) => a.message.includes('read-amplification'))).toBeUndefined()
  })
})
