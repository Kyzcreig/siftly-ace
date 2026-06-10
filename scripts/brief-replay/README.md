# Brief Replay Harness

Offline, zero-cost, zero-post inspectors that reconstruct what the **x-feed-brief**
and **morning-digest** crons did on any given run — straight from the artifacts they
write to disk. Use these instead of re-triggering a brief when you need to answer
"why only N items?", "what got cut at the gate?", "did a video idea repeat?",
"which source dominated?", or "did personal-fit fire?".

No network. No X API credits spent. Nothing posted to Discord. Pure reads of
`~/.hermes/state/cron/<job>/`.

## Scripts

| Script | Inspects | Reads |
|---|---|---|
| `replay_x_feed.py` | x-feed-brief | `_last_run_scored.json` (Step 6.7) + `_last_run_rendered.json` (Step 6.8, newer runs) |
| `replay_morning_digest.py` | morning-digest | `_last_run_debug.json` |
| `test_replay.py` | the funnel/anomaly reducers | a fixture encoding the Jun-10 incident |

## Quick start

```bash
# Latest x-feed run, full funnel + anomalies + top 30:
python3 scripts/brief-replay/replay_x_feed.py

# A specific (e.g. archived) dump, show 40 rows:
python3 scripts/brief-replay/replay_x_feed.py --file /tmp/x-feed-scored-2026-06-10.json --top 40

# What-if: how would a run bucket at different gates? (does NOT change prod)
python3 scripts/brief-replay/replay_x_feed.py --gate-top 60 --gate-quick 50

# Machine-readable (for piping into other checks):
python3 scripts/brief-replay/replay_x_feed.py --json

# Morning digest:
python3 scripts/brief-replay/replay_morning_digest.py --top 20

# Run the tests:
python3 scripts/brief-replay/test_replay.py
```

## How to read the output

**FUNNEL (as run)** — the buckets come straight from each candidate's
`dropped_reason`, exactly as the brief LLM labelled it. This is the authoritative
"what actually happened" view. Typical reasons:
- `selected` / `selected_top` — made the top section
- `quick_hits` / `also_noted` — made the secondary section
- `topic_dup:<id>` — collapsed into another tweet's topic cluster (shown as `topic_dup`)
- `below_60` / `below_50` (x-feed) or `below_77` / `below_83` (morning) — under a gate

**WHAT-IF at gates …** (x-feed only) — re-buckets every candidate purely by
`final_score` against the gates you pass (`--gate-top` / `--gate-quick`),
ignoring topic-dedup. Answers "how many *could* qualify" and, crucially, **how
many distinct topics** that is (the brief renders one item per topic, so distinct
topics — not raw count — is what fills the brief).

**ANOMALIES** — the detectors that flag the known failure classes:
- `RENDER_DROP` — a tweet in `selected_top_ids` was NOT in `rendered_top_ids`
  (the selection→render mismatch; Jun-10 dropped @mattpocockuk). Needs the render
  manifest; `NO_RENDER_MANIFEST` means the run predates Step 6.8 or didn't write it.
- `DUP_VIDEO_IDEA` / `DUP_VIDEO_ANGLE` — the same idea title/angle string used for
  two different tweets (Jun-10 reused "Local AI agents are finally getting real…").
- `TOPIC_STARVATION` — one topic holds ≥40% and ≥5 of the high scorers (Jun-10 the
  Claude Fable 5 launch held 34/49 of the ≥60 scorers). Signals the brief is being
  crowded by a single news event.
- `DEAD_SOURCE` (morning) — a source whose every item scored 0, i.e. a probable
  silent fetch failure.
- `X_SOURCE_NOTE` (morning) — the run recorded a partial X-source failure.

## Artifacts these depend on (written by the brief prompts)

Under `~/.hermes/state/cron/x-feed-brief/`:
- `_last_run_scored.json` — **Step 6.7**, mandatory. Full `all_scored` with
  `base_score`, `personal_fit_raw/delta`, `final_score`, `signals`, `dropped_reason`,
  plus `selected_top_ids` / `quick_hits_ids`. ≤120-char snippet only (privacy).
- `_last_run_rendered.json` — **Step 6.8**, mandatory on runs ≥ 2026-06-10. Records
  what was actually rendered (`rendered_top_ids`, `rendered_quick_hits_ids`,
  `rendered_video_ideas`) + a `mismatch{}` block. This is what makes the
  selection→render drop and duplicate-idea bugs visible on disk.
- `cache/timeline-YYYY-MM-DD.json` — the raw candidate pool (timeline read). Lets a
  future re-score mode recompute scores; the current inspectors corroborate counts
  against it but don't re-score.

Under `~/.hermes/state/cron/morning-digest/`:
- `_last_run_debug.json` — every scored candidate + per-source tallies +
  `selected` / `also` + `x_failure_note`.
- `_last_run_summary.json` — small posted-summary card.

> **Gotcha (morning-digest):** its debug dump is written near the END of a run, so
> a run that died early leaves a STALE dump from the previous success. Always check
> the `ts` in the report against the run you're chasing — a stale `ts` means *that*
> run produced no fresh dump, which itself tells you it failed before scoring.

## Forcing a fresh real run (when you DO want to re-trigger)

Each brief has a PT-day anti-rerun lock. To force an off-schedule real run:
```bash
rm -f /tmp/x-feed-brief-posted-$(TZ=America/Los_Angeles date +%F).lock
rm -f /tmp/morning-digest-posted-$(TZ=America/Los_Angeles date +%F).lock
# then trigger the cron job (it will pull, score, dump, and post for real).
```
After it runs, point the replay scripts at the fresh dumps to inspect the result.

## Production gate reference (x-feed, as of 2026-06-10)

- Top-tweets gate: **final_score ≥ 60** (lowered from 77)
- Quick-hits floor: **final_score ≥ 50** (lowered from 73)

These live in `prompt.md` Step 6; the `PROD_GATE_*` constants in `replay_x_feed.py`
mirror them for the default what-if view. If the prompt gates change, update those
constants to keep the default report honest.
