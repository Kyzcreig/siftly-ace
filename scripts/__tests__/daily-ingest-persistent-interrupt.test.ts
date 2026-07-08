import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkPersistentInterruptStreak,
  runDailyIngest,
  type DailyIngestFailure,
  type DailyIngestStageCommand,
  type DailyIngestStageRunResult,
  type DailyIngestSuccessSummary,
} from '../daily-ingest'

// ---------------------------------------------------------------------------
// Persistent-403 guard (C) wired end-to-end through runDailyIngest.
// A single 403 interrupt is SILENT; two consecutive daily runs PAGE.
// ---------------------------------------------------------------------------

let tmpDir: string
let statePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'siftly-interrupt-'))
  statePath = join(tmpDir, 'interrupt-streak.json')
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

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
        env: {
          NODE_ENV: 'test',
          SIFTLY_DAILY_CRON: '1',
          SIFTLY_INTERRUPT_STREAK_PATH: statePath,
        } as NodeJS.ProcessEnv,
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

const bookmark403 = (): DailyIngestStageRunResult => ({
  sourceRows: { bookmark: 90, like: 0 },
  created: 0,
  updated: 90,
  earlyStopped: true,
  interrupt: { source: 'bookmark', status: 403 },
})

const cleanRun = (): DailyIngestStageRunResult => ({
  sourceRows: { bookmark: 90, like: 100 },
  created: 5,
  updated: 185,
  earlyStopped: true,
})

describe('runDailyIngest — persistent-403 guard (C)', () => {
  it('stays SILENT on a single transient bookmark 403 (run 1)', async () => {
    const { alerts, promise } = runWith(bookmark403())
    const result = await promise
    expect(result.ok).toBe(true)
    expect(alerts.find((a) => a.message.includes('403-interrupted'))).toBeUndefined()
    // streak persisted at 1
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.bookmark.consecutive403).toBe(1)
  })

  it('PAGES on the 2nd consecutive daily bookmark 403', async () => {
    await runWith(bookmark403()).promise // run 1 (silent)
    const { alerts, promise } = runWith(bookmark403()) // run 2
    await promise
    const streakAlert = alerts.find((a) => a.message.includes('403-interrupted'))
    expect(streakAlert).toBeDefined()
    expect(streakAlert?.message).toContain("'bookmark'")
    expect(streakAlert?.message).toContain('2 consecutive')
    expect(streakAlert?.message.toLowerCase()).toContain('oauth')
  })

  it('a clean run BETWEEN two 403s resets the streak → back to silent', async () => {
    await runWith(bookmark403()).promise // streak 1
    await runWith(cleanRun()).promise // reset to 0
    const { alerts, promise } = runWith(bookmark403()) // streak 1 again
    await promise
    expect(alerts.find((a) => a.message.includes('403-interrupted'))).toBeUndefined()
  })

  it('stays SILENT forever on clean runs (never pages a healthy job)', async () => {
    for (let i = 0; i < 4; i++) {
      const { alerts, promise } = runWith(cleanRun())
      await promise
      expect(alerts.find((a) => a.message.includes('403-interrupted'))).toBeUndefined()
    }
  })
})

describe('checkPersistentInterruptStreak — direct', () => {
  const summaryWith403 = (): DailyIngestSuccessSummary => ({
    bookmarks: 90,
    likes: 0,
    created: 0,
    updated: 90,
    interrupt: { source: 'bookmark', status: 403 },
  })

  it('threshold override pages on the first 403', async () => {
    const alerts: string[] = []
    const { alerted } = await checkPersistentInterruptStreak(
      summaryWith403(),
      async (message) => { alerts.push(message) },
      { statePath, threshold: 1, today: '2026-07-08' },
    )
    expect(alerted).toEqual(['bookmark'])
    expect(alerts[0]).toContain('403-interrupted')
  })

  it('missing/corrupt state file starts fresh (no throw)', async () => {
    const badPath = join(tmpDir, 'nonexistent', 'streak.json')
    const { alerted } = await checkPersistentInterruptStreak(
      summaryWith403(),
      async () => {},
      { statePath: badPath, today: '2026-07-08' },
    )
    expect(alerted).toEqual([]) // streak 1 < default threshold 2
  })
})
