# Evidence Pack — pf-selfmaint + xfeed-cutover PRD

## daily-ingest.ts buildDailyIngestStages + stage loop (the soft-fail seam)
```ts
export type DailyIngestSourceName = 'bookmark' | 'like'
export type DailyIngestStageName = 'ingest' | 'enrich' | 'embed' | 'export'
export type DailyIngestFailureStage = DailyIngestStageName | 'credit-floor' | 'pipeline'
export type DailyIngestFailureKind = 'credit-floor' | 'stage-failure' | 'timeout'


export function buildDailyIngestStages(config: Partial<DailyIngestConfig> = {}): DailyIngestStageCommand[] {
  const ingestMaxPages = normalizePositiveInt(config.ingestMaxPages, DEFAULT_INGEST_MAX_PAGES)
  const pageSize = normalizePositiveInt(config.pageSize, DEFAULT_PAGE_SIZE)
  const stageLimit = normalizePositiveInt(config.stageLimit, DEFAULT_STAGE_LIMIT)

  return [
    {
      name: 'ingest',
      command: 'npx',
      args: ['tsx', 'scripts/ingest.ts', '--incremental', '--max-pages', String(ingestMaxPages), '--page-size', String(pageSize)],
    },
    {
      name: 'enrich',
      command: 'npx',
      args: ['tsx', 'scripts/enrich.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'embed',
      command: 'npx',
      args: ['tsx', 'scripts/embed.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'export',
      command: 'npx',
---- stage loop (aborts on throw) ----
      })
    }

    for (const stage of stages) {
      activeStage = stage.name
      if (abortController.signal.aborted) throw timeoutFailure(activeStage, wallBudgetMs)
      const stageResult = await runStage(stage, { signal: abortController.signal, cwd: config.cwd, env: config.env })
      mergeSourceRows(successSummary, stageResult)
      stagesRun.push(stage.name)
    }

```

## DailyIngestStageName union + DailyIngestStageCommand
```ts
export type DailyIngestSourceName = 'bookmark' | 'like'
export type DailyIngestStageName = 'ingest' | 'enrich' | 'embed' | 'export'
export type DailyIngestFailureStage = DailyIngestStageName | 'credit-floor' | 'pipeline'
export type DailyIngestFailureKind = 'credit-floor' | 'stage-failure' | 'timeout'

export interface DailyIngestStageCommand {
  name: DailyIngestStageName
  command: string
  args: string[]
}

```

## profile.ts JSON write (needs atomic) + briefRelevantOnly already-shipped
```ts
      .slice(0, options.formatLimit ?? FORMAT_LIMIT)
      .map(([format]) => format),
    downrank_patterns: sortedBuckets(negativeBuckets).map(([pattern]) => pattern),
    novelty_profile: { evergreen_ratio: 0 },
    scoring_guidance: [
      'Use source weights bookmark=1.0 and like=0.3.',
      'Use top_topics, high_signal_authors, and favorite_formats as additive personal-fit signals only.',
      'Apply circularity guard: rows tagged origin:brief-surfaced are excluded from topic/source affinity reinforcement.',
      'Novelty calibration disabled because saved_at/liked_at are unavailable; do not substitute importedAt.',
      'No why saved inference is emitted or consumed.',
    ].join(' '),
  }
}

export async function writePreferenceArtifacts(
  profile: PreferenceProfile,
---- signal_basis output ----

  return {
    updated_at: isoNow(options.now),
    corpus_size: corpusSize,
    signal_basis: {
      mode: briefRelevantOnly ? 'brief-relevant-only' : 'whole-corpus',
      signal_rows: signalRows,
    },
    top_topics: sortedBuckets(topicBuckets)
      .slice(0, options.topTopicLimit ?? TOPIC_LIMIT)
      .map(([name, bucket]) => ({ name, weight: roundWeight(bucket.weight), segment: dominantSegment(bucket) })),
    high_signal_authors: sortedBuckets(authorBuckets)
      .slice(0, options.authorLimit ?? AUTHOR_LIMIT)
```

## score_digest gates + MAX_TOP/MAX_ALSO (module-level constants — #2 must parameterize)
```py
# (b) Recency-as-tiebreak toggle (read here, before the gates, because the gates
# are mode-aware). When set, recency contributes 0 additive points and is used
# only as a sort tiebreak; see recency_points()/recency_rank(). Ships DARK.
RECENCY_AS_TIEBREAK = os.environ.get("RECENCY_AS_TIEBREAK", "").strip().lower() in ("1", "true", "yes", "on")

# ── Gates (re-derived against the new score range, spec §6 step-2) ───────────
# Gates are MODE-AWARE so they never drift out of sync with the recency mode:
#  - default (additive recency +10): 58/50 — the post-cutover-spec values that
#    every fresh same-day item is inflated toward.
#  - tiebreak (recency=0 additive): 49/45 — empirically re-derived from the live
#    141-item debug pool so selection is PRESERVED once the +10 slab leaves the
#    sum (see calibrate_gate_recency.py). NOT the naive -10 (39/40 over-admits on
#    light days). These are a FLOOR; MAX_TOP/MAX_ALSO still cap actual output.
if RECENCY_AS_TIEBREAK:
    TOP_GATE = 49
    ALSO_GATE = 45
```

## select_digest build_render_input (engine dispatch) + select_shadow signature
```py
def build_render_input(data, tl_handles, tl_aliases, tracked, now=None, engine="legacy"):
    pool = data.get("all_scored") or []
    if engine == "deterministic":
        # CUTOVER (2026-06-11): the deterministic scorer (score_digest.py) owns the
        # `final`; this module stays the single render-contract authority but its
        # scoring is swapped. Lazy import avoids the score_digest<->select_digest cycle.
        import score_digest as _sd  # noqa: E402
        selected, also, discarded, _meta = _sd.select_shadow(pool, tl_handles, tl_aliases, tracked, now=now)
    else:
```

## select_shadow signature + how it reads MAX_TOP/MAX_ALSO/gates
```py
69:#    light days). These are a FLOOR; MAX_TOP/MAX_ALSO still cap actual output.
71:    TOP_GATE = 49
72:    ALSO_GATE = 45
74:    TOP_GATE = 58
75:    ALSO_GATE = 50
76:MAX_TOP = 5            # max Top Stories slots (mirrors select_digest)
77:MAX_ALSO = 2          # max Also Noted slots
133:# blind-inherited 70). Always strictly < ALSO_GATE by construction.
134:LOW_REACH_SCORE_CAP = ALSO_GATE - 5
304:    X item → cap at LOW_REACH_SCORE_CAP (computed < ALSO_GATE)."""
485:def select_shadow(pool, tl_handles=None, tl_aliases=None, tracked=None, now=None):
493:    --shadow score dump showed (dupes, >MAX_TOP overflow, no distribution).
523:        if f >= TOP_GATE and len(selected) < MAX_TOP:
525:        elif f >= ALSO_GATE and len(also) < MAX_ALSO:
534:            "gates": {"top": TOP_GATE, "also": ALSO_GATE, "low_reach_cap": LOW_REACH_SCORE_CAP},
535:            "cleared_top": sum(1 for it in scored if it["_final"] >= TOP_GATE),
536:            "cleared_also": sum(1 for it in scored if it["_final"] >= ALSO_GATE)}
566:    check(LOW_REACH_SCORE_CAP < ALSO_GATE, f"LOW_REACH_SCORE_CAP {LOW_REACH_SCORE_CAP} !< ALSO_GATE {ALSO_GATE}")
567:    check(ALSO_GATE <= TOP_GATE, "ALSO_GATE > TOP_GATE")
584:    check(fs < ALSO_GATE, f"spam {fs} cleared ALSO_GATE")
```

## x-feed prompt Step 5 (model-prose scoring — to be replaced) + gates
```
## Step 5 — Score each post (1-10 per metric, normalize to 0-100)

| Metric | Weight | Criteria |
|---|---|---|
| Builder Relevance | 3x | Useful for building AI agents, coding tools, personal AI? |
| Engagement Signal | 2x | High likes/quotes/replies relative to author size? |
| Novelty | 2x | New info, launch, hot take, or genuinely surprising? |
| Actionability | 2x | Can Ace learn from, build on, reply to, or use this? |
| Source Quality | 1x | Credible builder, insider, thought leader? |

Raw score = sum(rating × weight). Max = 100.

Grade:
- 93-100 → 🔥 A
- 90-92 → ✅ A-
- 87-89 → 👍 B+
- 83-86 → 👍 B
- 80-82 → 📋 B-
- 77-79 → 📋 C+
- 73-76 → 📋 C
- 70-72 → 🔹 C-
- below 70 → ⬜ D

**Auto-score 0:** corporate PR, fundraising/VC news, space/science (unless Ace follows), generic motivation, news aggregator reposts.

## Step 6 — Select up to 5 top tweets + Quick Hits + Video Ideas
**Top tweets:** select up to 5 tweets by score, each a DIFFERENT topic, only tweets scoring **60 or above**. Rank strictly by the scoring system in Step 5 after dedupe/topic clustering. If fewer than 5 qualify, include fewer.

**Quick Hits:** up to 5 MORE tweets scoring **≥ 50** that didn't make the top-10, each a different topic from the top-10 and from each other. Rendered as terse one-liners (handle + ≤10-word gist + link). Zero is valid.

**Video Ideas (Step 6.5):** while selecting, flag any tweet that sparks a genuine YouTube video idea for Ace's content lane (AI / dev-tools / indie-hacking / content / tech-business). Only truly video-worthy ones — a tutorial, reaction, build-along, or hot-take explainer — NOT every tweet. For each, derive: a one-line working title + a 1-line angle + the source tweet URL. **Each Video Idea MUST be a distinct idea mapped to a distinct tweet AND a distinct topic — no two ideas may share the same title or angle text. If two candidate tweets would produce the same idea (e.g. two different on-device-AI tweets), keep ONLY the higher-scoring one and drop the duplicate.** Zero is a valid and common result.
```

## morning-digest deterministic invocation (the pattern x-feed must mirror)
```bash
395:These labels NOW DRIVE POSTING (cutover landed 2026-06-11): Step 6.7 runs `select_digest.py --engine deterministic`, which scores from these labels via `score_digest.py` (deterministic sum of named terms) — NOT from your prose `base_score`. Still ALSO emit `base_score` (kept for the debug dump / audit), but the labels are what determine the digest. Label definitions: `launch`=new product/model/tool shipped; `benchmark`=eval/leaderboard result; `tutorial`=how-to/recipe; `field_report`=hands-on experience/result; `analysis`=substantive explanation; `news`=event report; `opinion`=take/commentary; `promo`=ad/shill; `reply_fragment`=bare reply with no standalone substance ("True"/"Yes"/emoji/short insult like "he is a scumbag"). `actionable_now`=reader can use it today; `reference`=worth saving; `context_only`=background; `none`=nothing to act on. `substance`: `concrete`=specifics/numbers/code; `mixed`=some; `vague`=empty. `on_topic`: `core`=AI/agents/building; `adjacent`=tangential incl. memes; `off`=politics/health/unrelated. **A personal attack, political insult, name-calling, dunking, or culture-war take is ALWAYS `off` — even from a thought-leader you otherwise respect (e.g. a reply calling someone "a scumbag and traitor" is `off`, NOT `core`).**
425:RECENCY_AS_TIEBREAK=1 python3 ~/Projects/siftly-ace/scripts/select_digest.py --in ~/.hermes/state/cron/morning-digest/_last_run_debug.json --out ~/.hermes/state/cron/morning-digest/_render_input.json --engine deterministic
```
