#!/usr/bin/env tsx
/**
 * output_shadow.ts -- Wave 6 P1 OUTPUT-changing-feature shadow harness.
 *
 * Stages the Wave-6 features that change the POSTED candidate SET (cross-brief
 * dedup, MMR diversity, surfaced-provenance) behind the SAME shadow/validation
 * discipline we used for embedding-pf: run the REAL modules over a brief's REAL
 * run dump, compute what they WOULD have done, write a durable shadow artifact --
 * and change NOTHING the brief posts.
 *
 * OFFLINE + read-only against the live briefs. Never edits a prompt.md, never
 * posts, never reorders a live render. Uses the production modules
 * (scripts/lib/cross-brief-dedup, scripts/lib/diversity-rerank,
 * scripts/lib/surfaced-provenance) -- NOT reimplementations -- so the evidence it
 * accumulates is exactly what the live wiring would do.
 *
 * WHY (Wave-6 P1 cutover, output-changing half): pf-score shadow is already live.
 * The dedup/diversity/gatherer features are built+merged but UNWIRED because they
 * alter the posted set and we won't wire output-changing logic into a load-bearing
 * daily brief without a shadow window. This harness IS that window. After >=3 runs
 * per brief, wave6-output-shadow-watch reports staging-readiness so Ace/Apollo can
 * make the single gated prompt.md live-wire with evidence in hand.
 *
 * WHAT IT SHADOWS, per brief run dump:
 *   1. cross-brief dedup -- would this brief's posted items be suppressed as
 *      same-PT-day duplicates of the OTHER brief's posted items? (real
 *      CrossBriefDedupStore against a throwaway temp DB; the OTHER brief's posted
 *      set is replayed first so the diff is causal.)
 *   2. MMR diversity -- re-rank the brief's posted+near-miss pool. Live dumps carry
 *      NO embeddings, so similarity falls back to author-key diversity via
 *      perAuthorCap (the embedding-free signal). Flagged as a FLOOR: real wiring
 *      would have embeddings and sharper similarity. Reports author-cap drops +
 *      reorderings.
 *   3. surfaced-provenance -- append the posted items to the dated provenance log so
 *      the saw-didn't-save maturation clock starts (safe, additive side effect; the
 *      ONE write, into docs/eval/surfaced-items/, never into a brief).
 *
 * Writes a per-run artifact to
 *   ~/.hermes/state/x-bookmarks/output-shadow/<brief>-<ts>.json
 * (ids + reasons only, snippet<=120 chars, privacy parity with pf-audit), pruned
 * after 14 days, plus a one-line summary to output-shadow/log.jsonl.
 *
 * Usage:
 *   tsx scripts/output_shadow.ts                 # both briefs, latest dump each
 *   tsx scripts/output_shadow.ts --brief morning-digest
 *   tsx scripts/output_shadow.ts --in <dump.json> --brief x-feed-brief
 *   tsx scripts/output_shadow.ts --no-provenance # skip the provenance write
 *   tsx scripts/output_shadow.ts --dry-run       # compute + print, write nothing
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CrossBriefDedupStore, ptDayForDate } from './lib/cross-brief-dedup'
import { diversityRerank, type DiversityRerankCandidate } from './lib/diversity-rerank'
import { appendSurfacedProvenance, type SurfacedItemInput } from './lib/surfaced-provenance'

const HOME = homedir()
const BRIEFS = ['morning-digest', 'x-feed-brief'] as const
type Brief = (typeof BRIEFS)[number]

const DUMP_PATH: Record<Brief, string> = {
  'morning-digest': path.join(HOME, '.hermes/state/cron/morning-digest/_last_run_debug.json'),
  'x-feed-brief': path.join(HOME, '.hermes/state/cron/x-feed-brief/_last_run_scored.json'),
}

const RENDER_PATH: Partial<Record<Brief, string>> = {
  // morning-digest's posted set is owned by select_digest.py -> _render_input.json
  // (selected/also in the debug dump are empty; all_scored carries model-prose
  // dropped_reasons that do NOT reflect the deterministic engine's choices).
  'morning-digest': path.join(HOME, '.hermes/state/cron/morning-digest/_render_input.json'),
}

interface RenderInput {
  ts?: string
  selected?: ScoredItem[]
  also?: ScoredItem[]
}

// Env-overridable for hermetic test isolation (defaults unchanged in prod).
const ARTIFACT_DIR =
  process.env.OUTPUT_SHADOW_ARTIFACT_DIR ?? path.join(HOME, '.hermes/state/x-bookmarks/output-shadow')
// Optional provenance log dir override (defaults to surfaced-provenance's own default).
const PROVENANCE_DIR = process.env.OUTPUT_SHADOW_PROVENANCE_DIR ?? undefined
const ARTIFACT_TTL_DAYS = 14
const PER_AUTHOR_CAP = 2 // mmr author cap
const SNIPPET_MAX = 120

interface ScoredItem {
  id?: string
  tweet_id?: string
  url?: string
  title?: string
  tweet_text?: string
  text_snippet?: string
  summary?: string
  authorHandle?: string
  authorName?: string
  source?: string
  final_score?: number
  base_score?: number
  dropped_reason?: string
}

interface BriefDump {
  run_id?: string
  ts?: string
  all_scored?: ScoredItem[]
  selected?: ScoredItem[]
  also?: ScoredItem[]
  selected_top_ids?: string[]
  quick_hits_ids?: string[]
}

interface PostedItem {
  id: string
  title: string
  url: string
  snippet: string
  authorKey: string | null
  source: string
  score: number
}

interface DedupFinding {
  id: string
  snippet: string
  reason: string
  matchedBrief?: string
}

interface DiversityFinding {
  id: string
  snippet: string
  authorKey: string | null
  effect: 'author_cap_drop' | 'reordered'
  fromRank?: number
  toRank?: number
}

interface BriefShadow {
  brief: Brief
  run_id: string
  run_ts: string
  posted_count: number
  dedup: { would_suppress: number; findings: DedupFinding[] }
  diversity: {
    mode: 'author-cap-floor (no embeddings in dump)'
    author_cap: number
    would_drop: number
    would_reorder: number
    findings: DiversityFinding[]
  }
  provenance: { logged: number; path: string | null }
  claimed: boolean
}

function parseArgs(argv: string[]) {
  const out: { brief?: Brief; inPath?: string; dryRun: boolean; provenance: boolean } = {
    dryRun: false,
    provenance: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--brief') out.brief = argv[++i] as Brief
    else if (a === '--in') out.inPath = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-provenance') out.provenance = false
  }
  return out
}

export function clipSnippet(item: ScoredItem): string {
  const raw =
    item.title?.trim() ||
    item.text_snippet?.trim() ||
    item.summary?.trim() ||
    item.tweet_text?.trim() ||
    ''
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX - 1) + '\u2026' : raw
}

function itemId(item: ScoredItem): string {
  return item.id || item.tweet_id || item.url || clipSnippet(item) || 'unknown'
}

export function authorKeyFor(item: ScoredItem): string | null {
  const raw = (item.authorHandle || item.authorName || '').trim().toLowerCase()
  return raw.length > 0 ? raw : null
}

function toPosted(it: ScoredItem): PostedItem {
  return {
    id: itemId(it),
    title: (it.title || it.text_snippet || it.summary || it.tweet_text || '').trim() || itemId(it),
    url: it.url || 'https://x.com/i/web/status/' + (it.tweet_id ?? itemId(it)),
    snippet: clipSnippet(it),
    authorKey: authorKeyFor(it),
    source: it.source || 'unknown',
    score: typeof it.final_score === 'number' ? it.final_score : it.base_score ?? 0,
  }
}

/** Reconstruct the items the brief actually POSTED from its run dump. */
export function postedItems(brief: Brief, dump: BriefDump): PostedItem[] {
  const byId = new Map<string, ScoredItem>()
  for (const it of dump.all_scored ?? []) byId.set(itemId(it), it)

  let raw: ScoredItem[] = []
  if (brief === 'morning-digest') {
    // ground truth = select_digest.py's _render_input.json (selected + also).
    const renderPath = RENDER_PATH['morning-digest']
    if (renderPath) {
      try {
        const render = JSON.parse(readFileSync(renderPath, 'utf8')) as RenderInput
        raw = [...(render.selected ?? []), ...(render.also ?? [])]
      } catch {
        /* fall through to dump */
      }
    }
    if (raw.length === 0) raw = [...(dump.selected ?? []), ...(dump.also ?? [])]
    if (raw.length === 0) {
      raw = (dump.all_scored ?? []).filter(
        (it) => it.dropped_reason === 'selected_top' || it.dropped_reason === 'also_noted',
      )
    }
  } else {
    const ids = [...(dump.selected_top_ids ?? []), ...(dump.quick_hits_ids ?? [])]
    raw = ids.map((id) => byId.get(id)).filter((x): x is ScoredItem => Boolean(x))
  }

  return raw.map(toPosted)
}


function loadDump(p: string): BriefDump {
  return JSON.parse(readFileSync(p, 'utf8')) as BriefDump
}

export function runDedupShadow(
  store: CrossBriefDedupStore,
  brief: Brief,
  ptDay: string,
  posted: PostedItem[],
): { would_suppress: number; findings: DedupFinding[] } {
  const findings: DedupFinding[] = []
  for (const item of posted) {
    if (!item.url && !item.title) continue
    let res
    try {
      res = store.checkAndRemember({ brief, title: item.title, url: item.url, ptDay })
    } catch {
      continue
    }
    if (res.duplicate && res.matchedBrief && res.matchedBrief !== brief) {
      findings.push({
        id: item.id,
        snippet: item.snippet,
        reason: res.reason ?? 'url',
        matchedBrief: res.matchedBrief,
      })
    }
  }
  return { would_suppress: findings.length, findings }
}

export function runDiversityShadow(posted: PostedItem[]): BriefShadow['diversity'] {
  // Rerank WITHIN the posted set only. Injecting a near-miss pool as
  // replacements requires the pool be scored on the SAME basis as the posted
  // items; in the live dumps the posted set and the all_scored pool can use
  // different score bases (morning-digest posts from select_digest.py's
  // deterministic _render_input, while all_scored carries model-prose
  // final_score), so mixing them would fabricate misleading drops. Within-posted
  // rerank is scoring-basis-clean and answers exactly: would MMR's author cap
  // have dropped an over-concentrated author, and would it have reordered the
  // posted items? Full pool-replacement is correctly DEFERRED to the live wiring,
  // where the candidate pool is scored uniformly at the select step.
  const candidates: DiversityRerankCandidate[] = posted.map((p) => ({
    id: p.id,
    relevance: p.score,
    authorKey: p.authorKey,
  }))
  const limit = posted.length || candidates.length
  const reranked = diversityRerank(candidates, { limit, perAuthorCap: PER_AUTHOR_CAP })

  const rerankedIds = reranked.map((r) => r.candidate.id)
  const postedIds = posted.map((p) => p.id)
  const rerankedSet = new Set(rerankedIds)
  const bySnippet = new Map(posted.map((p) => [p.id, p]))

  const findings: DiversityFinding[] = []
  let drops = 0
  let reorders = 0

  for (let i = 0; i < postedIds.length; i++) {
    const id = postedIds[i]
    if (!rerankedSet.has(id)) {
      drops++
      const item = bySnippet.get(id)!
      findings.push({ id, snippet: item.snippet, authorKey: item.authorKey, effect: 'author_cap_drop', fromRank: i })
    }
  }
  for (let toRank = 0; toRank < rerankedIds.length; toRank++) {
    const id = rerankedIds[toRank]
    const fromRank = postedIds.indexOf(id)
    if (fromRank >= 0 && fromRank !== toRank) {
      reorders++
      const item = bySnippet.get(id)
      if (item) {
        findings.push({ id, snippet: item.snippet, authorKey: item.authorKey, effect: 'reordered', fromRank, toRank })
      }
    }
  }

  return {
    mode: 'author-cap-floor (no embeddings in dump)',
    author_cap: PER_AUTHOR_CAP,
    would_drop: drops,
    would_reorder: reorders,
    findings,
  }
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

function artifactPathFor(brief: Brief, runTs: string): string {
  return path.join(ARTIFACT_DIR, brief + '-' + runTs.replace(/[:.]/g, '-') + '.json')
}

export async function shadowOneBrief(
  brief: Brief,
  inPath: string,
  opts: { dryRun: boolean; provenance: boolean },
): Promise<BriefShadow | null> {
  let dump: BriefDump
  try {
    dump = loadDump(inPath)
  } catch (err) {
    console.error('[output_shadow] ' + brief + ': cannot read dump ' + inPath + ': ' + (err as Error).message)
    return null
  }

  const runTs = dump.ts || new Date().toISOString()
  const ptDay = ptDayForDate(new Date(runTs))
  const posted = postedItems(brief, dump)
  if (posted.length === 0) {
    console.error('[output_shadow] ' + brief + ': 0 posted items in dump -- nothing to shadow')
  }

  const tmpDb = path.join(tmpdir(), 'output-shadow-dedup-' + process.pid + '-' + Date.now() + '.db')
  const store = new CrossBriefDedupStore({ dbPath: tmpDb, ttlDays: 3 })
  try {
    const other = BRIEFS.find((b) => b !== brief)!
    try {
      const otherDump = loadDump(DUMP_PATH[other])
      const otherPt = ptDayForDate(new Date(otherDump.ts || runTs))
      if (otherPt === ptDay) {
        for (const it of postedItems(other, otherDump)) {
          try {
            store.remember({ brief: other, title: it.title, url: it.url, ptDay })
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch {
      /* other dump missing -- dedup reports 0 */
    }

    const dedup = runDedupShadow(store, brief, ptDay, posted)
    const diversity = runDiversityShadow(posted)

    // Atomic idempotency claim: try to EXCLUSIVELY create this run's artifact file
    // (O_EXCL). Only the winner owns the durable side-effects (provenance append +
    // log line + final artifact). A check-then-act statSync would be TOCTOU-racy —
    // N concurrent runs would all see "not processed" and all append provenance,
    // inflating the saw-didn't-save "saw" count that gates the embed promotion eval.
    // dryRun never claims/writes.
    let claimed = false
    if (!opts.dryRun) {
      mkdirSync(ARTIFACT_DIR, { recursive: true })
      try {
        writeFileSync(artifactPathFor(brief, runTs), '{}', { flag: 'wx' })
        claimed = true
      } catch {
        claimed = false // EEXIST: another run already processed this exact run
      }
    }

    let provenance: BriefShadow['provenance'] = { logged: 0, path: null }
    if (opts.provenance && claimed && posted.length > 0) {
      const items: SurfacedItemInput[] = posted.map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        source: p.source,
      }))
      try {
        const res = await appendSurfacedProvenance(items, { brief, now: new Date(runTs), ...(PROVENANCE_DIR ? { logDir: PROVENANCE_DIR } : {}) })
        provenance = { logged: res.count, path: res.path }
      } catch (err) {
        console.error('[output_shadow] ' + brief + ': provenance append failed: ' + (err as Error).message)
      }
    }

    return {
      brief,
      run_id: dump.run_id || runTs,
      run_ts: runTs,
      posted_count: posted.length,
      dedup,
      diversity,
      provenance,
      claimed,
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
}

function writeArtifact(shadow: BriefShadow): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const stamp = shadow.run_ts.replace(/[:.]/g, '-')
  const fp = path.join(ARTIFACT_DIR, shadow.brief + '-' + stamp + '.json')
  writeFileSync(fp, JSON.stringify(shadow, null, 2))
  const logLine =
    JSON.stringify({
      ts: shadow.run_ts,
      brief: shadow.brief,
      posted: shadow.posted_count,
      dedup_suppress: shadow.dedup.would_suppress,
      div_drop: shadow.diversity.would_drop,
      div_reorder: shadow.diversity.would_reorder,
      provenance_logged: shadow.provenance.logged,
    }) + '\n'
  appendFileSync(path.join(ARTIFACT_DIR, 'log.jsonl'), logLine)
  return fp
}

function printSummary(shadow: BriefShadow, artifactPath: string | null): void {
  console.log('\n=== output-shadow: ' + shadow.brief + ' (run ' + shadow.run_id + ') ===')
  console.log('posted: ' + shadow.posted_count)
  console.log(
    'cross-brief dedup: would suppress ' +
      shadow.dedup.would_suppress +
      ' item(s) already surfaced by the other brief',
  )
  for (const f of shadow.dedup.findings) {
    console.log('  - [' + f.reason + ' dup of ' + f.matchedBrief + '] ' + f.snippet)
  }
  console.log(
    'MMR diversity (' +
      shadow.diversity.mode +
      ', cap=' +
      shadow.diversity.author_cap +
      '): ' +
      shadow.diversity.would_drop +
      ' drop / ' +
      shadow.diversity.would_reorder +
      ' reorder',
  )
  for (const f of shadow.diversity.findings.slice(0, 6)) {
    const move = f.effect === 'author_cap_drop' ? 'DROP@' + f.fromRank : f.fromRank + '->' + f.toRank
    console.log('  - [' + move + '] (' + (f.authorKey ?? 'no-author') + ') ' + f.snippet)
  }
  console.log('surfaced-provenance: logged ' + shadow.provenance.logged + ' item(s)')
  if (artifactPath) console.log('artifact: ' + artifactPath)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const briefs: Brief[] = args.brief ? [args.brief] : [...BRIEFS]
  pruneArtifacts()

  for (const brief of briefs) {
    const inPath = args.inPath && args.brief === brief ? args.inPath : DUMP_PATH[brief]
    const shadow = await shadowOneBrief(brief, inPath, { dryRun: args.dryRun, provenance: args.provenance })
    if (!shadow) continue
    // Only the run that won the atomic claim writes the durable artifact + log line.
    // A non-dryRun run that lost the claim (concurrent duplicate) still prints its
    // recomputed view but does NOT touch durable state.
    let artifactPath: string | null = null
    if (!args.dryRun && shadow.claimed) artifactPath = writeArtifact(shadow)
    printSummary(shadow, artifactPath)
  }
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1]
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href)
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error('[output_shadow] fatal: ' + (err as Error).message)
    process.exit(1)
  })
}
