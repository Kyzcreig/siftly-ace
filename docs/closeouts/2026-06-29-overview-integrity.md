# Closeout — Overview Integrity (Landscape can't vanish or carry junk)

**Date:** 2026-06-29
**Repo:** `Kyzcreig/siftly-ace` (fork of viperrcrypto/Siftly)
**Commits:** `83fabc1` (fix), `f25b7bb` (docs) on `main`, pushed · Obsidian vault `8b36f1c`, pushed
**Trigger:** Ace caught two defects in the 2026-06-29 morning digest, then said "boil the ocean — do all the above," then "prd closeout."

## What shipped

Two distinct defects in the morning digest's "The Landscape" overview, both fixed and live on the next 03:33/03:48 PT brief run (no cron change — the existing jobs call the fixed scripts).

1. **The Landscape section silently vanished (step-ordering safety-net).**
   Root cause (proven by file mtimes): the overview is injected into `_render_input.json` by prompt Step 6.9, but the LLM ran Step 6.7 (`select_digest.py`, which *rewrites* `_render_input.json`) **after** 6.9 — overview injected 03:41, render-input rewritten 03:45 — so select clobbered it. The brief still posted (fail-safe held) but dropped the section.
   **Fix:** `scripts/build-report.sh` is now the LAST writer. Right before render it checks for the `overview` key and re-injects from the brief's linked tmp file (`/tmp/<brief>-overview-linked.txt`) if missing. Idempotent + fail-safe → step-ordering can never lose it again.

2. **The overview content was junk even when present (junk-exclusion).**
   Root cause: `scripts/overview_digest.py` ranked/filtered by the *model's RAW label* + the dump's `final_score`, and did NOT apply the Backstop-4 junk-demotion or off-topic guard that gate the *ranked* brief. So crypto/scam/`$ticker`/fragment posts the model mislabeled `core` floated to the top of the Landscape — the overview could disagree with the brief.
   **Fix:** `overview_digest._rescore_pool()` re-scores **every** pool item through `score_digest.score_item` (the single deterministic authority, incl. Backstop 4), stamps `_ov_final` (real deterministic score) + `_ov_excluded` (junk-flagged OR effective-off-topic). `aggregate()` now excludes `_ov_excluded` items from themes + top_stories and ranks by `_ov_final`. Fail-safe: if `score_digest` can't import/run, falls back to the dump's `final_score`/`on_topic` (degraded but still renders); new `rescored` flag reports which path ran. `_label` also strips a leading `t.co`/bare URL so a label never reads as an opaque link.

## Closeout gate

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 0 | Hardening | PASS | `npm run verify` green; the fix is exclude/downgrade-only + fail-safe on every path |
| 1 | E2E / tests | PASS | `npm run verify` exit 0 — 289 TS + 58 py + gold-set 4/4; `overview_digest_test.py` 10/10 (3 new) |
| 2 | Acceptance | PASS | live 231-item pool: `rescored=true`, 81 junk/off-topic excluded, no `VELON`/`$ticker`/`Voicebox`/`t.co`/fragment in stories+theme-examples; ≥5 real stories surface |
| 3 | Invariants | PASS | fail-safe fallback present; overview additive/never blocks the post; **selection engine (`select_digest.py`/`score_digest.py`) untouched** — overview only *reads* the scorer |
| 4 | Project docs | PASS | `AGENTS.md` "Overview JUNK-EXCLUSION (2026-06-29)" + SAFETY-NET notes; live cron prompts == `deploy/cron-prompts/` snapshots (diff -q in sync) |
| 5 | Obsidian | PASS | new "Overview integrity" section in `AI/Ace X Knowledge Base — System Overview.md`; pushed; content-proven on `origin/main` (grep=1) |
| 6 | Git | PASS | clean tree on live checkout; no local-ahead commits; content-proven on origin (`_rescore_pool`×2, junk test×1, safety-net×4, prompt prefilter×1); secret-scan clean |
| 7 | mem0 | PASS | DONE-marker stored 2026-06-29; prior 2026-06-24 batch marker intact |
| 8 | Cron/alerts | PASS | `morning-digest` (7a94d27271af) + `x-feed-brief` (e021c7bee158) enabled, last `ok`, next 06-30 03:33/03:48; call the fixed scripts (no stale copy) |
| 9 | Loose ends | PASS (triaged) | see below |
| 10 | Discoveries | PASS | see below |

## Loose ends (triaged)

- **Low-substance hype tweets passing the SELECTION gate** (e.g. the #1 "CODEX SUBAGENT FLOW 20X FASTER" tweet still in Top Stories) — **BACKLOG.** This fix governs only the Landscape *synthesis*; the Top/Also *selection* is a separate gate (`select_digest.py` + engagement weighting in `score_digest.py`). Trigger to pick up: Ace says the *posted stories* (not the overview) are too hype-y. Deeper scorer-tuning job (engagement-bait down-weighting), spec it before touching the live selection authority.
- **`.bak.*-pre-ov-junkfilter` prompt backups** (both briefs, 20260629-082446) — **BACKLOG.** Keep one clean week as rollback, then prune (same policy as the other `.bak.*` prompt snapshots).
- **`.bak.*-pre-fused` backups** still slated to prune — pre-existing, unchanged by this work.

## Discoveries

- The overview and the brief had **two different ranking authorities** — a silent divergence that only surfaced when the model's mislabels diverged from the deterministic verdict. Lesson: any surface that *summarizes* a gated pool must rank by the **same** gate, not a parallel one. Wired as `_rescore_pool` so they can't drift again.
- A fail-safe that "worked" (brief still posted) **masked** a real defect (the section silently vanished) — the classic green-that-isn't. The safety-net now makes the *intended* output the resilient one, not just "something posts."
- The model genuinely runs prompt steps **out of declared order** sometimes; any step that depends on an earlier step's file write must be defended at the *consuming* end, not assumed.
