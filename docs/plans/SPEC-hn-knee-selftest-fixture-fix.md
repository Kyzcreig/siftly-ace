# SPEC — Fix: score_digest.py hn-knee selftest fails (stale fixture, not a scorer bug)

**Status:** spec → fix · **Owner:** Apollo · **Repo:** `~/Projects/siftly-ace` · **Date:** 2026-06-13
**Scope:** `scripts/score_digest.py` `_selftest()` ONLY. Pre-existing (fails on clean HEAD `3397252`, unrelated to Wave 6).

## Symptom
`python3 scripts/score_digest.py --selftest` → `SELFTEST FAILED: front-page HN (234pts) below TOP_GATE: 52.0` / `knee mispositioned: 234pt=52.0 (want ≥58), 40pt=47.0 (want <58)`. Surfaced via `MorningDigestRegressionTest.test_selftests_still_pass`.

## Root cause (EMPIRICALLY VERIFIED, not reasoned)
The selftest's `hn_news = lambda pts: {...}` fixture (score_digest.py ~line 802) builds an HN story with **no `created_at` field**, so its recency term is **0**. The digest gates (TOP=58 / ALSO=50) were explicitly calibrated assuming the **additive recency +10 is present** (see the gate comment at score_digest.py:64 "default (additive recency +10): 58/50"). Measured breakdowns:

| hn_points | created_at | recency | engagement | _final | vs TOP=58 |
|---|---|---|---|---|---|
| 234 | (none — fixture) | 0 | 5 | **52** | ❌ below |
| 234 | fresh ISO ts | 10 | 5 | **62** | ✅ clears |
| 40 | fresh ISO ts | 10 | 0 | 57 | ✅ stays below |
| 2345 | fresh ISO ts | 10 | 13 | 70 | ✅ clears |

So the **scorer is correct** — a real front-page HN story (which is recent → gets +10 recency) at 234 pts scores 62 and clears TOP exactly as the hn_points design intends. The **fixture is unrealistic**: it asserts the TOP-clearing behavior against a story state (a front-page HN item with zero recency) that cannot occur in production, where HN front-page items are by definition recent. This is a stale/incomplete-fixture bug introduced when the hn_points selftest was written without a timestamp, masked until the selftest was wired into `npm run verify`.

## Decision
**Fix the fixture, NOT the scorer or the gates.** Re-tuning the scorer or lowering the gate to make a recency-less story clear TOP would corrupt the calibrated 58/50 gates for the real (recency-present) population. The honest fix is to give the synthetic HN fixture a realistic fresh `created_at`, matching how front-page HN stories actually arrive.

## Change
In `score_digest.py` `_selftest()`, the `hn_news` fixture lambda gains a fresh `created_at` (e.g. `datetime.now(timezone.utc).isoformat()`), so the recency term is +10 as the gates assume. All existing hn-knee assertions then hold against a production-realistic story:
- 234pt on-topic front-page → 62 ≥ TOP (the knee/differentiation goal).
- 40pt minor → 57 < TOP (minor stays below).
- crowd-term monotonicity (e40 ≤ e90 < e234 < e2345), PIVOT=0, cap, off-topic-gate assertions are recency-independent and unchanged.

## Verification
- `python3 scripts/score_digest.py --selftest` exits 0.
- `python3 -m pytest scripts/__tests__/ -q` → all pass (incl. `MorningDigestRegressionTest`).
- `python3 scripts/gold_set_eval.py` still 4/4.
- Confirm the fix is fixture-only: `git diff` touches only the `_selftest` fixture, no scoring constants/gates.
