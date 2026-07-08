import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INTERRUPT_ALERT_STREAK,
  formatInterruptStreakAlert,
  observationFromIngest,
  parseInterruptFromStdout,
  updateInterruptStreaks,
  type InterruptStreakState,
} from '../interrupt-streak'

const D1 = '2026-07-06'
const D2 = '2026-07-07'
const D3 = '2026-07-08'

describe('updateInterruptStreaks — the persistent-403 guard', () => {
  it('stays SILENT on a single transient bookmark 403 (streak 1 < threshold 2)', () => {
    const { next, alerts } = updateInterruptStreaks(
      {},
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D1,
    )
    expect(alerts).toEqual([])
    expect(next.bookmark?.consecutive403).toBe(1)
    expect(next.bookmark?.streakStartedOn).toBe(D1)
  })

  it('PAGES once the bookmark 403 streak reaches the threshold (2 days running)', () => {
    const day1 = updateInterruptStreaks(
      {},
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D1,
    )
    expect(day1.alerts).toEqual([])

    const day2 = updateInterruptStreaks(
      day1.next,
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D2,
    )
    expect(day2.alerts).toHaveLength(1)
    expect(day2.alerts[0]).toMatchObject({ source: 'bookmark', consecutive403: 2, streakStartedOn: D1 })
    expect(day2.next.bookmark?.consecutive403).toBe(2)
  })

  it('re-pages daily while the block persists (a multi-day auth block IS real degradation)', () => {
    let state: InterruptStreakState = {}
    for (const [day] of [[D1], [D2], [D3]]) {
      const r = updateInterruptStreaks(
        state,
        observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
        day,
      )
      state = r.next
    }
    // Day 3 → streak 3, still ≥ threshold, still pages.
    const day3 = updateInterruptStreaks(
      // rebuild to day-2 state, then observe day 3
      { bookmark: { consecutive403: 2, streakStartedOn: D1, lastUpdated: D2, lastStatus: 403 } },
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D3,
    )
    expect(day3.alerts).toHaveLength(1)
    expect(day3.alerts[0].consecutive403).toBe(3)
    expect(day3.alerts[0].streakStartedOn).toBe(D1)
  })

  it('RESETS the streak (and goes silent) when a later run completes cleanly', () => {
    const primed: InterruptStreakState = {
      bookmark: { consecutive403: 2, streakStartedOn: D1, lastUpdated: D2, lastStatus: 403 },
    }
    const { next, alerts } = updateInterruptStreaks(primed, observationFromIngest({}), D3)
    expect(alerts).toEqual([])
    expect(next.bookmark?.consecutive403).toBe(0)
  })

  it('a NON-403 interrupt (429/network) BREAKS the 403 streak — different failure mode', () => {
    const primed: InterruptStreakState = {
      bookmark: { consecutive403: 3, streakStartedOn: D1, lastUpdated: D2, lastStatus: 403 },
    }
    const { next, alerts } = updateInterruptStreaks(
      primed,
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 429 }),
      D3,
    )
    expect(alerts).toEqual([])
    expect(next.bookmark?.consecutive403).toBe(0)
    expect(next.bookmark?.lastStatus).toBe(429)
  })

  it('tracks bookmark and like streaks INDEPENDENTLY', () => {
    // bookmark broke both days; like ran clean day-2 (so like never accrues).
    const day1 = updateInterruptStreaks(
      {},
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D1,
    )
    const day2 = updateInterruptStreaks(
      day1.next,
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D2,
    )
    expect(day2.alerts.map((a) => a.source)).toEqual(['bookmark'])
    expect(day2.next.like).toBeUndefined()
  })

  it('does NOT reset a source that never RAN this observation (earlier break / 402 short-circuit)', () => {
    // bookmark broke with 403 → `like` never fetched (ranClean=false). like's prior
    // streak must be carried forward untouched, not reset.
    const primed: InterruptStreakState = {
      like: { consecutive403: 1, streakStartedOn: D1, lastUpdated: D1, lastStatus: 403 },
    }
    const { next } = updateInterruptStreaks(
      primed,
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D2,
    )
    expect(next.like?.consecutive403).toBe(1) // untouched
    expect(next.bookmark?.consecutive403).toBe(1)
  })

  it('a 402 credits-depleted run does NOT reset streaks (ranClean=false) and does not itself page', () => {
    const primed: InterruptStreakState = {
      bookmark: { consecutive403: 1, streakStartedOn: D1, lastUpdated: D1, lastStatus: 403 },
    }
    const { next, alerts } = updateInterruptStreaks(
      primed,
      observationFromIngest({ creditsDepleted: true }),
      D2,
    )
    expect(alerts).toEqual([])
    expect(next.bookmark?.consecutive403).toBe(1) // carried, not reset
  })

  it('threshold is configurable', () => {
    const { alerts } = updateInterruptStreaks(
      {},
      observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }),
      D1,
      1, // page on the very first 403
    )
    expect(alerts).toHaveLength(1)
  })
})

describe('observationFromIngest', () => {
  it('ranClean only when neither interrupt nor credits', () => {
    expect(observationFromIngest({}).ranClean).toBe(true)
    expect(observationFromIngest({ interruptedSource: 'bookmark', interruptedStatus: 403 }).ranClean).toBe(false)
    expect(observationFromIngest({ creditsDepleted: true }).ranClean).toBe(false)
  })
})

describe('parseInterruptFromStdout', () => {
  it('parses the real INTERRUPTED line the ingest stage prints', () => {
    const out = [
      'xurl-ingest complete sources=bookmark,like pages=1 rows-fetched=90 created=0 updated=90 skipped=0',
      'bookmark: pages=1 rows=90 next-cursor=abc',
      'INTERRUPTED on bookmark (status=403): xurl bookmarks failed: 403 Forbidden',
      'Partial rows were saved + cursor persisted — re-run the same command to resume from where it stopped.',
    ].join('\n')
    expect(parseInterruptFromStdout(out)).toEqual({ source: 'bookmark', status: 403 })
  })

  it('handles status=unknown', () => {
    expect(parseInterruptFromStdout('INTERRUPTED on like (status=unknown): boom')).toEqual({
      source: 'like',
      status: undefined,
    })
  })

  it('returns undefined on a clean run', () => {
    expect(parseInterruptFromStdout('xurl-ingest complete sources=bookmark,like created=5 updated=10')).toBeUndefined()
  })
})

describe('formatInterruptStreakAlert', () => {
  it('names the source, the streak, and points at the OAuth token as the likely cause', () => {
    const msg = formatInterruptStreakAlert({ source: 'bookmark', consecutive403: 2, streakStartedOn: D1 })
    expect(msg).toContain("'bookmark'")
    expect(msg).toContain('2 consecutive')
    expect(msg).toContain(D1)
    expect(msg.toLowerCase()).toContain('oauth')
    expect(msg.toLowerCase()).toContain('auth')
  })
})

describe('DEFAULT_INTERRUPT_ALERT_STREAK', () => {
  it('is 2 — one transient 403 stays silent, two in a row pages', () => {
    expect(DEFAULT_INTERRUPT_ALERT_STREAK).toBe(2)
  })
})
