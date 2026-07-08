// interrupt-streak.ts — turn a PERSISTENT per-source ingest interruption (esp. a
// bookmarks 403) into a LOUD alert instead of silently deferring forever.
//
// WHY: the xurl ingest degrades a mid-fetch failure (403/429/network) into a
// graceful `interrupted` marker — it saves the pages fetched so far, persists the
// cursor, and resumes next run (lib/xurl-ingest.ts). For a transient blip that's
// exactly right and should stay silent. But a PERSISTENT 403 (a revoked / degraded
// OAuth token, a permission change) would keep "gracefully deferring" every night
// forever, and the corpus for that source would quietly stop advancing with NO
// signal. This tracks a per-source consecutive-day 403 streak across runs and pages
// #alerts once it crosses a threshold — so a real auth breakage surfaces, while a
// one-off 403 (streak resets on the next clean run) never pages.
//
// Scope: this is specifically the 403/auth-persistence guard. A 402 (credits) has
// its own alert path and is left untouched here; a non-403 interrupt (429/network)
// BREAKS the 403 streak (it's a different failure mode), so we don't conflate a
// rate-limit blip with an auth block.

export type InterruptSource = 'bookmark' | 'like'

export interface SourceStreak {
  /** Consecutive daily runs this source was 403-interrupted. */
  consecutive403: number
  /** ISO date (YYYY-MM-DD) of the first run in the current streak. */
  streakStartedOn?: string
  /** ISO date of the most recent run that touched this source's streak. */
  lastUpdated?: string
  /** The last interrupt status observed for this source (diagnostic only). */
  lastStatus?: number
}

export type InterruptStreakState = Partial<Record<InterruptSource, SourceStreak>>

/** What one ingest run observed, distilled from the ingest stage stdout. */
export interface RunObservation {
  /** The source that hit a graceful interrupt this run, if any. */
  interruptedSource?: InterruptSource
  /** HTTP status of that interrupt (403, 429, …), if known. */
  interruptedStatus?: number
  /**
   * True when the run completed with NO interrupt and NO credit depletion —
   * i.e. every source fetched to completion. Only then do we reset streaks for
   * sources that were NOT interrupted (a source that never ran because an earlier
   * source broke keeps its prior streak untouched).
   */
  ranClean: boolean
}

export interface StreakUpdateResult {
  next: InterruptStreakState
  /** Sources whose 403 streak is at/over threshold this run → page for these. */
  alerts: InterruptStreakAlert[]
}

export interface InterruptStreakAlert {
  source: InterruptSource
  consecutive403: number
  streakStartedOn?: string
}

export const DEFAULT_INTERRUPT_ALERT_STREAK = 2
const ALL_SOURCES: InterruptSource[] = ['bookmark', 'like']

function sourceStreak(state: InterruptStreakState, source: InterruptSource): SourceStreak {
  return state[source] ?? { consecutive403: 0 }
}

/**
 * Pure streak transition. Given the prior state, one run's observation, today's
 * ISO date, and the alert threshold, returns the next state + any sources that
 * should page this run.
 *
 * Per-source rules for THIS run:
 *  - the interrupted source with status 403 → increment its streak
 *  - the interrupted source with a NON-403 status → reset (different failure mode)
 *  - a source that ran clean (ranClean=true, not the interrupted one) → reset
 *  - a source that did not run (an earlier source broke; or a 402 short-circuit) →
 *    left untouched (no signal about it this run)
 *
 * Alert: a source pages whenever its 403 streak is >= threshold. A multi-day auth
 * block IS real degradation, so it re-pages daily until a clean run resets it —
 * consistent with "loud only on real degradation, silent on green."
 */
export function updateInterruptStreaks(
  prev: InterruptStreakState,
  observation: RunObservation,
  today: string,
  threshold: number = DEFAULT_INTERRUPT_ALERT_STREAK,
): StreakUpdateResult {
  const next: InterruptStreakState = {}
  const alerts: InterruptStreakAlert[] = []

  for (const source of ALL_SOURCES) {
    const prevStreak = sourceStreak(prev, source)
    const isInterrupted = observation.interruptedSource === source

    if (isInterrupted && observation.interruptedStatus === 403) {
      const consecutive403 = prevStreak.consecutive403 + 1
      next[source] = {
        consecutive403,
        streakStartedOn: prevStreak.consecutive403 > 0 ? prevStreak.streakStartedOn ?? today : today,
        lastUpdated: today,
        lastStatus: 403,
      }
    } else if (isInterrupted) {
      // A different failure mode (429/network/…) breaks the 403 streak.
      next[source] = { consecutive403: 0, lastUpdated: today, lastStatus: observation.interruptedStatus }
    } else if (observation.ranClean) {
      // Source completed cleanly this run → streak resets. Drop empty state.
      if (prevStreak.consecutive403 > 0) {
        next[source] = { consecutive403: 0, lastUpdated: today }
      }
      // else: leave absent (no streak to track)
    } else {
      // Source did not run this observation (earlier break / 402) → carry forward.
      if (prevStreak.consecutive403 > 0) next[source] = prevStreak
    }

    const resulting = next[source] ?? sourceStreak(next, source)
    if (resulting.consecutive403 >= threshold) {
      alerts.push({
        source,
        consecutive403: resulting.consecutive403,
        streakStartedOn: resulting.streakStartedOn,
      })
    }
  }

  return { next, alerts }
}

/**
 * Distill an ingest run into a RunObservation. `interruptLine` is the
 * "INTERRUPTED on <source> (status=<n>): …" line the ingest stage prints (if any);
 * `creditsDepleted` is true when a 402 short-circuited the run. `ranClean` is true
 * only when neither happened.
 */
export function observationFromIngest(args: {
  interruptedSource?: InterruptSource
  interruptedStatus?: number
  creditsDepleted?: boolean
}): RunObservation {
  const ranClean = !args.interruptedSource && !args.creditsDepleted
  return {
    interruptedSource: args.interruptedSource,
    interruptedStatus: args.interruptedStatus,
    ranClean,
  }
}

/** Parse the ingest stage stdout for the interrupt marker. Returns undefined if none. */
export function parseInterruptFromStdout(output: string): { source: InterruptSource; status?: number } | undefined {
  for (const line of output.split(/\r?\n/)) {
    const m = /^INTERRUPTED on (bookmark|like) \(status=(\d+|unknown)\)/.exec(line)
    if (m) {
      return {
        source: m[1] as InterruptSource,
        status: m[2] === 'unknown' ? undefined : Number(m[2]),
      }
    }
  }
  return undefined
}

export function formatInterruptStreakAlert(alert: InterruptStreakAlert): string {
  const since = alert.streakStartedOn ? ` (since ${alert.streakStartedOn})` : ''
  return (
    `Siftly ingest: '${alert.source}' source has been 403-interrupted ${alert.consecutive403} ` +
    `consecutive daily runs${since}. The graceful resume keeps deferring it, so the ${alert.source} ` +
    `corpus has stopped advancing. A persistent 403 is an AUTH/permission failure (revoked or degraded ` +
    `OAuth token), not a transient blip — check the siftly-ace X app token / re-run the OAuth2 PKCE flow.`
  )
}
