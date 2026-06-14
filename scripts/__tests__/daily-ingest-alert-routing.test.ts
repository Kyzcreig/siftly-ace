import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_ALERT_CHANNEL_ID,
  DEFAULT_LOG_CHANNEL_ID,
  runDailyIngest,
  runStageCommand,
  sendDiscordAlert,
  sendDiscordHeartbeat,
  type DailyIngestFailure,
  type DailyIngestStageCommand,
} from '../daily-ingest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

const spawnMock = vi.mocked(spawn)

const failure: DailyIngestFailure = {
  kind: 'stage-failure',
  stage: 'enrich',
  reason: 'fixture enrich failure',
}

function stage(name: DailyIngestStageCommand['name']): DailyIngestStageCommand {
  return { name, command: 'mock-stage', args: [name] }
}

function mockNotifyExits(codes: number[]) {
  spawnMock.mockImplementation(() => {
    const code = codes.shift() ?? 0
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> }
    child.pid = 1234
    child.killed = false
    child.kill = vi.fn()
    queueMicrotask(() => child.emit('exit', code, null))
    return child as never
  })
}

function mockStageOutput(stdout: string) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      killed: boolean
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 1234
    child.killed = false
    child.kill = vi.fn()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('exit', 0, null)
    })
    return child as never
  })
}

function okCredit() {
  return {
    remaining: 100_000,
    reserve: 50_000,
    ok: true,
    reason: 'remaining credits 100000 at/above reserve 50000',
  }
}

function testEnv(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...vars } as NodeJS.ProcessEnv
}

describe('daily ingest Discord routing', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.clearAllMocks()
  })

  it('routes failure alerts to the verified alerts channel by default', async () => {
    mockNotifyExits([0])

    await sendDiscordAlert('boom', failure, testEnv())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--channel', 'discord', '--target', DEFAULT_ALERT_CHANNEL_ID]))
  })

  it('routes success heartbeats to the verified logs channel by default', async () => {
    mockNotifyExits([0])

    await sendDiscordHeartbeat('Daily ingest OK — 5 new saved, 1 existing refreshed.', { bookmarks: 7, likes: 11, created: 5, updated: 1 }, testEnv())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--channel', 'discord', '--target', DEFAULT_LOG_CHANNEL_ID]))
    // structured (v4) contract: routed through the queue wrapper with source/title/severity, not raw --send
    expect(args).toEqual(expect.arrayContaining(['--severity', 'low', '--source', 'siftly-daily-ingest', '--title', 'Siftly Daily Ingest']))
    expect(args).not.toContain('--send')
    // API reads are surfaced as a fact labelled to read as read-volume, never as new saves
    expect(args).toEqual(expect.arrayContaining(['--fact', 'API reads=18 (7 bookmarks + 11 likes)']))
    expect(args).toEqual(expect.arrayContaining(['--fact', 'New saved=5']))
  })

  it('honors alert and log channel environment overrides', async () => {
    mockNotifyExits([0, 0])

    await sendDiscordAlert('boom', failure, testEnv({ SIFTLY_ALERT_CHANNEL: 'alert-override' }))
    await sendDiscordHeartbeat('Daily ingest OK — 0 new saved, 0 existing refreshed.', { bookmarks: 1, likes: 2, created: 0, updated: 0 }, testEnv({ SIFTLY_LOG_CHANNEL: 'log-override' }))

    const alertArgs = spawnMock.mock.calls[0][1] as string[]
    const logArgs = spawnMock.mock.calls[1][1] as string[]
    expect(alertArgs).toEqual(expect.arrayContaining(['--target', 'alert-override']))
    expect(logArgs).toEqual(expect.arrayContaining(['--target', 'log-override']))
  })

  it('falls back to Home Discord if the targeted failure alert post fails', async () => {
    mockNotifyExits([1, 0])

    await sendDiscordAlert('boom', failure, testEnv())

    expect(spawnMock).toHaveBeenCalledTimes(2)
    const targetedArgs = spawnMock.mock.calls[0][1] as string[]
    const fallbackArgs = spawnMock.mock.calls[1][1] as string[]
    expect(targetedArgs).toEqual(expect.arrayContaining(['--target', DEFAULT_ALERT_CHANNEL_ID]))
    expect(fallbackArgs).toEqual(expect.arrayContaining(['--channel', 'discord']))
    expect(fallbackArgs).not.toContain('--target')
  })

  it('sends a cron success heartbeat without using the failure-alert sender', async () => {
    const sendAlert = vi.fn()
    const sendHeartbeat = vi.fn()
    const runStage = vi.fn(async (nextStage: DailyIngestStageCommand) => {
      if (nextStage.name === 'ingest') return { sourceRows: { bookmark: 7, like: 11 }, created: 5, updated: 1 }
    })

    const result = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      runStage,
      sendAlert,
      sendHeartbeat,
      stages: [stage('ingest')],
      wallBudgetMs: 10_000,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })

    expect(result.ok).toBe(true)
    expect(sendAlert).not.toHaveBeenCalled()
    expect(sendHeartbeat).toHaveBeenCalledTimes(1)
    expect(sendHeartbeat.mock.calls[0][0]).toBe('Daily ingest OK — 5 new saved, 1 existing refreshed.')
  })

  it('parses ingest stdout into net-new + per-source heartbeat counts', async () => {
    mockStageOutput('xurl-ingest complete rows-ingested=10 created=9 updated=1 skipped=2\nbookmark: pages=1 rows=7 next-cursor=abc\nlike: pages=1 rows=11 next-cursor=def\n')

    const result = await runStageCommand(stage('ingest'), {
      cwd: '/tmp/siftly-test',
      env: testEnv(),
      signal: new AbortController().signal,
    })

    expect(result?.sourceRows).toEqual({ bookmark: 7, like: 11 })
    expect(result?.created).toBe(9)
    expect(result?.updated).toBe(1)
  })

  it('keeps heartbeat failures non-fatal and still sends failure alerts on failed runs', async () => {
    const sendAlert = vi.fn()
    const sendHeartbeat = vi.fn().mockRejectedValue(new Error('logs channel denied'))

    const success = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      runStage: vi.fn(async (nextStage: DailyIngestStageCommand) => {
        if (nextStage.name === 'ingest') return { sourceRows: { bookmark: 1, like: 2 } }
      }),
      sendAlert,
      sendHeartbeat,
      stages: [stage('ingest')],
      wallBudgetMs: 10_000,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })

    expect(success.ok).toBe(true)
    expect(success.heartbeatError).toMatch(/logs channel denied/)
    expect(sendAlert).not.toHaveBeenCalled()

    sendAlert.mockClear()
    sendHeartbeat.mockClear()
    const failed = await runDailyIngest({
      checkCreditFloor: vi.fn().mockResolvedValue(okCredit()),
      runStage: vi.fn(async () => {
        throw new Error('stage exploded')
      }),
      sendAlert,
      sendHeartbeat,
      stages: [stage('ingest')],
      wallBudgetMs: 10_000,
      config: { env: testEnv({ SIFTLY_DAILY_CRON: '1' }) },
    })

    expect(failed.ok).toBe(false)
    expect(sendHeartbeat).not.toHaveBeenCalled()
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })
})
