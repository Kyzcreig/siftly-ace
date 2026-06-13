# Spec — hn_points loose-end fixes (placement tiebreak + cap invariant + review-trail)

**Status:** DRAFT → **BUILT & VERIFIED** (2026-06-11)
**Owner:** Apollo · **Project:** `~/Projects/siftly-ace`
**Relates to:** `PRD-gold-set-certification.md` §12 (hn_points crowd-signal); follows the 3 loose ends
flagged at hn_points closeout. Source SHA at authoring: `4f49cac`.

## Context

The hn_points crowd-signal shipped (commit `4f49cac`) with three named loose ends. Ground-truthed all
three; one is a **real ranking bug**, one is a **moot-but-worth-locking invariant**, one is a
**mis-triaged housekeeping item**. This spec fixes all three.

## Findings (ground truth, not assumption)

### F-b — REAL BUG: the placement tiebreak discards the HN crowd signal
`_placement_sort_key` (score_digest.py:529) is `(_final, _engagement(it), recency_rank, text)`.
`_engagement()` reads `likes + retweets`, which is **0 for every HN story** — the crowd signal that
drove the HN story's `_final` is thrown away at tiebreak time. **Proven:** an HN 234-pt story and an X
tweet that BOTH score 52 with identical crowd-term=5 — `select_shadow(max_top=1)` gives the single TOP
slot to the X tweet purely because `_engagement(HN)=0 < _engagement(X)=5`. A tied HN story always loses
its slot / gets bumped below the fold despite equal merit. This is the exact "truncate a now-promoted HN
story below the fold" risk, confirmed concrete.

**Fix:** the tiebreak's engagement rung must use the **scored crowd term the engine actually computed**
(`_breakdown["engagement"]`, which is the hn_points-derived value for HN and likes+rt-derived for X),
not raw `_engagement()`. This makes the tiebreak consistent with the score it's breaking. For X items the
breakdown engagement == the old `_engagement`-derived points, so **X placement is unchanged**
(byte-identical); only HN items — which had 0 before — now tiebreak on their real crowd term.

### F-a — MOOT invariant, lock it anyway: cap `<=` vs `<`
`HN_POINTS_CAP=14 <= ENGAGEMENT_CAP=15`. At the **total**-score level a thought-leader X tweet already
beats an HN megastory (96 vs 87) because the TL gets a +8 author bump HN never receives; and 14 < 15
already means HN's crowd term is strictly below the *known* X ceiling. So the "tie" only exists at the
isolated crowd-term level and is moot for ranking. **Fix:** tighten the selftest invariant from
`HN_POINTS_CAP <= ENGAGEMENT_CAP` to strict `<` to *lock the intent* (curated front-page crowd-signal
strictly below the strongest known-author X engagement). No constant value changes (14 < 15 already holds).

### F-c — MIS-TRIAGED housekeeping: the "stray" file is THIS repo's own artifact
`docs/reviews/PRD-prd-suite-dry-consolidation-v12-review-pass1.md` was left untracked and previously
dismissed as "a different task's file." Ground truth: `docs/plans/PRD-prd-suite-dry-consolidation-v12.md`
and `docs/reviews/PRD-prd-suite-dry-consolidation-review-summary.md` are BOTH tracked in this repo, and
the summary references "Pass 1" — so this untracked file IS the pass-1 artifact the committed summary
points to. It's a legitimate orphan of this repo's own PRD work that never got staged. **Fix:** commit it
to complete the review trail (do NOT delete).

## Non-Goals
- No change to gate values, base table, or any scored constant. F-a is a test-only tightening.
- No change to X-item scoring or placement (byte-identical guarantee preserved).
- Not touching the live morning-digest prompt/cron (repo code only).

## Acceptance criteria
- [ ] `_placement_sort_key` uses the scored crowd term (`_breakdown["engagement"]`) for the engagement
      rung; an HN story and an X tweet tied on `_final` with equal crowd terms tiebreak by recency, not
      by the X tweet always winning. Regression test: the `max_top=1` repro now keeps whichever is fresher.
- [ ] X placement is byte-identical (a selftest asserts an all-X pool selects the same items/order as before).
- [ ] Selftest invariant is strict `HN_POINTS_CAP < ENGAGEMENT_CAP`.
- [ ] The v12 review pass-1 artifact is committed (review trail complete).
- [ ] `npm run verify` exit 0 (typecheck + lint + JS + e2e + Python + gold 4/4).

## Build log (2026-06-11)

All acceptance criteria met. As-built:
- **F-b** — added `_placement_engagement(it)` in `score_digest.py`: **X items** use raw `_engagement()`
  exactly as before (byte-identical live ordering preserved — proven: two X tweets, raw 3100 vs 310, same
  capped crowd term 10, still order by raw); **HN items** (positive `source`-gated, Review RC-2) use the
  scored crowd term so a tied HN story is no longer pinned below 0. `_placement_sort_key` now calls it.
  E2e regression: a fresher HN story tied at 52.0 with an X tweet now wins the single TOP slot (before: the
  X tweet always won because HN's raw engagement was 0).
- **F-a** — selftest invariant tightened `HN_POINTS_CAP <= ENGAGEMENT_CAP` → strict `<` (14 < 15; no constant
  value changed). Locks the intent that curated front-page crowd-signal stays strictly below the strongest
  known-author X tweet.
- **F-c** — `docs/reviews/PRD-prd-suite-dry-consolidation-v12-review-pass1.md` is THIS repo's own pass-1
  artifact (the tracked v12 PRD + review-summary reference it); committed to complete the review trail.
- **Review:** 1 Opus pass — APPROVE WITH CHANGES, 0 blockers; 2 required changes applied (RC-1 e2e
  preconditions assert loudly instead of an `if`-guard; RC-2 positive source-gate on the HN branch).
  Two carried OQs are product confirmations (cross-scale rung is strictly better than the old bug;
  strict-`<` is the intended guardrail).
- **Verify:** `npm run verify` exit 0 — typecheck + lint + 180 JS + 10 e2e + 29 Python + gold 4/4.
  Review artifact `docs/reviews/loose-ends-review-pass1.md`.
