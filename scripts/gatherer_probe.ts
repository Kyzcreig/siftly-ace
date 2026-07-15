#!/usr/bin/env tsx
/**
 * gatherer_probe.ts -- Wave 6 P1 discovery-gatherer INFLOW probe.
 *
 * The Reddit + GitHub-Trending discovery gatherers are built+tested but UNWIRED
 * into the morning-digest gather block, because adding sources changes the posted
 * candidate SET. This probe is the safe pre-wire measurement: it actually fetches
 * both live sources, reports the candidate INFLOW (volume, per-source health), and
 * cross-dedups the inflow against what the briefs already surfaced today -- so we
 * know, before wiring, how much NET-NEW discovery these sources add vs. how much
 * overlaps existing coverage.
 *
 * What it does NOT do: it does not score, place, or post anything. Final placement
 * (does a reddit/github candidate clear the digest gate?) depends on the LLM
 * scoring + deterministic select step, which only exists in the live brief run.
 * That last mile is the ONE gated live-wire (add the gather calls to
 * morning-digest/prompt.md), made AFTER this probe + the output-shadow window give
 * Ace evidence. This probe quantifies the upside; it cannot prove placement.
 *
 * OFFLINE w.r.t. the briefs (never edits a prompt, never posts). It DOES make live
 * outbound HTTP to reddit.com + github.com/trending (read-only, public, no auth).
 *
 * Writes a per-run artifact to
 *   ~/.hermes/state/x-bookmarks/gatherer-probe/<ts>.json
 * + a one-line summary to gatherer-probe/log.jsonl, pruned after 14 days.
 *
 * Usage:
 *   tsx scripts/gatherer_probe.ts            # fetch both, report, write artifact
 *   tsx scripts/gatherer_probe.ts --dry-run  # fetch + print, write nothing
 *   tsx scripts/gatherer_probe.ts --limit 15
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { gatherRedditPosts } from './gather/reddit'
import { gatherGitHubTrending } from './gather/github-trending'
import { CrossBriefDedupStore, ptDayForDate } from './lib/cross-brief-dedup'

const HOME = homedir()
const ARTIFACT_DIR = path.join(HOME, '.hermes/state/x-bookmarks/gatherer-probe')
const ARTIFACT_TTL_DAYS = 14
const BRIEF_DUMPS: Record<string, string> = {
  'morning-digest': path.join(HOME, '.hermes/state/cron/morning-digest/_last_run_debug.json'),
  'x-feed-brief': path.join(HOME, '.hermes/state/cron/x-feed-brief/_last_run_scored.json'),
}

interface Candidate {
  title: string
  url: string
  source: string
}

interface SourceReport {
  source: string
  fetched: number
  net_new: number
  overlap: number
  error: string | null
  sample: string[]
}

interface ProbeReport {
  ts: string
  pt_day: string
  total_fetched: number
  total_net_new: number
  sources: SourceReport[]
}

function parseArgs(argv: string[]) {
  const out: { dryRun: boolean; limit?: number; lanes: string[] } = { dryRun: false, lanes: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--limit') out.limit = Number(argv[++i])
    else if (argv[i] === '--lane') out.lanes.push(argv[++i] ?? '')
  }
  return out
}

// The reddit gatherer must probe through the SAME egress lanes the LIVE briefs use,
// or it measures a strictly worse system than reality. The morning-digest brief
// gathers reddit via `--lane '' --lane socks5://192.168.1.217:1080` (direct Spectrum
// WAN + Starlink SOCKS). Reddit IP-rate-limits the home Spectrum IP (HTTP 429), so a
// direct-only probe records reddit fetched==0 and the silentblock watchdog FALSE-ALARMS
// even while the brief pulls 100 reddit items via Starlink (observed 2026-06-23: probe
// reddit=0 three days running while the brief logged reddit=100). Default the probe to
// the brief's lanes; `--lane` overrides. Keep these in sync with morning-digest prompt.md.
const DEFAULT_PROBE_LANES = ['', 'socks5://192.168.1.217:1080']

/** Seed a dedup store with everything both briefs surfaced today, so the probe can
 *  measure how much gatherer inflow OVERLAPS existing coverage. */
function seedFromBriefs(store: CrossBriefDedupStore, ptDay: string): void {
  for (const [brief, dumpPath] of Object.entries(BRIEF_DUMPS)) {
    let dump: { all_scored?: { title?: string; url?: string; tweet_text?: string }[] }
    try {
      dump = JSON.parse(readFileSync(dumpPath, 'utf8'))
    } catch {
      continue
    }
    for (const it of dump.all_scored ?? []) {
      const title = (it.title || it.tweet_text || '').trim()
      const url = it.url || ''
      if (!title && !url) continue
      try {
        store.remember({ brief, title: title || url, url: url || 'https://example.invalid/' + title, ptDay })
      } catch {
        /* skip malformed */
      }
    }
  }
}

function classify(
  store: CrossBriefDedupStore,
  ptDay: string,
  source: string,
  candidates: Candidate[],
): SourceReport {
  let netNew = 0
  let overlap = 0
  const sample: string[] = []
  for (const c of candidates) {
    if (!c.url && !c.title) continue
    let res
    try {
      res = store.checkAndRemember({ brief: 'gatherer:' + source, title: c.title, url: c.url, ptDay })
    } catch {
      continue
    }
    if (res.duplicate) {
      overlap++
    } else {
      netNew++
      if (sample.length < 5) sample.push(c.title.slice(0, 100))
    }
  }
  return { source, fetched: candidates.length, net_new: netNew, overlap, error: null, sample }
}

function pruneArtifacts(): void {
  let entries: string[]
  try {
    entries = readdirSync(ARTIFACT_DIR)
  } catch {
    return
  }
  const cutoff = Date.now() - ARTIFACT_TTL_DAYS * 86_400_000
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const fp = path.join(ARTIFACT_DIR, name)
    try {
      if (statSync(fp).mtimeMs < cutoff) rmSync(fp)
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const now = new Date()
  const ptDay = ptDayForDate(now)
  const tmpDb = path.join(tmpdir(), 'gatherer-probe-' + process.pid + '-' + Date.now() + '.db')
  const store = new CrossBriefDedupStore({ dbPath: tmpDb, ttlDays: 3 })

  const sources: SourceReport[] = []
  try {
    seedFromBriefs(store, ptDay)

    // Reddit
    try {
      const probeLanes = args.lanes.length ? args.lanes : DEFAULT_PROBE_LANES
      const reddit = (await gatherRedditPosts({
        ...(args.limit ? { limit: args.limit } : {}),
        lanes: probeLanes,
      })) as Candidate[]
      sources.push(classify(store, ptDay, 'reddit', reddit))
    } catch (err) {
      sources.push({ source: 'reddit', fetched: 0, net_new: 0, overlap: 0, error: (err as Error).message, sample: [] })
    }

    // GitHub Trending
    try {
      const gh = (await gatherGitHubTrending({})) as Candidate[]
      sources.push(classify(store, ptDay, 'github-trending', gh))
    } catch (err) {
      sources.push({
        source: 'github-trending',
        fetched: 0,
        net_new: 0,
        overlap: 0,
        error: (err as Error).message,
        sample: [],
      })
    }
  } finally {
    store.close()
    try {
      rmSync(tmpDb)
      rmSync(tmpDb + '-wal', { force: true })
      rmSync(tmpDb + '-shm', { force: true })
    } catch {
      /* ignore */
    }
  }

  const report: ProbeReport = {
    ts: now.toISOString(),
    pt_day: ptDay,
    total_fetched: sources.reduce((a, s) => a + s.fetched, 0),
    total_net_new: sources.reduce((a, s) => a + s.net_new, 0),
    sources,
  }

  console.log('=== gatherer inflow probe (' + report.pt_day + ') ===')
  console.log('total fetched: ' + report.total_fetched + ' | total net-new vs today briefs: ' + report.total_net_new)
  for (const s of report.sources) {
    if (s.error) {
      console.log('  ' + s.source + ': ERROR ' + s.error)
      continue
    }
    console.log('  ' + s.source + ': ' + s.fetched + ' fetched, ' + s.net_new + ' net-new, ' + s.overlap + ' overlap')
    for (const t of s.sample) console.log('      + ' + t)
  }

  if (!args.dryRun) {
    pruneArtifacts()
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    const fp = path.join(ARTIFACT_DIR, report.ts.replace(/[:.]/g, '-') + '.json')
    writeFileSync(fp, JSON.stringify(report, null, 2))
    appendFileSync(
      path.join(ARTIFACT_DIR, 'log.jsonl'),
      JSON.stringify({ ts: report.ts, fetched: report.total_fetched, net_new: report.total_net_new }) + '\n',
    )
    console.log('artifact: ' + fp)
  }
}

main()
  .then(() => {
    // Force a clean exit. The live HTTP gatherers (reddit/github) can leave a
    // keep-alive socket / lingering handle on the event loop, so a node that
    // otherwise finished all work + wrote its artifact will HANG on natural exit
    // and get killed by the 90s watchdog wall -> spurious "TIMEOUT, no fresh
    // artifact" alert even though the artifact was already written. Observed
    // after the cron node was bumped 24->26. The work is done here; exit 0.
    process.exit(0)
  })
  .catch((err) => {
    console.error('[gatherer_probe] fatal: ' + (err as Error).message)
    process.exit(1)
  })
