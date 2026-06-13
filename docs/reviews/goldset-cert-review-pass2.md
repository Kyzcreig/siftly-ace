# Independent Senior Review

## Verdict
APPROVE WITH CHANGES

The gap diagnosis is correct and empirically grounded (FACT 1–3), the scope is honest (Non-Goals match FACT 8, no smuggled re-tuning), and the v2 text genuinely resolved all five Pass-1 items — I verified each rather than re-raising them. The architecture is right: real `select_shadow` (not a reimplementation), mode-pinned to tiebreak 49/45, hard-error-on-missing-label, mutation-matrix-per-bar, gate-pin, prove-before-ratify. What remains are second-order defects the fixes introduced or left unclosed — concrete and fixable, none requiring re-tuning or scope expansion.

## Pass-1 Fixes — Verified Resolved (not re-raising)
- **Blocker 1 (vacuous Bar 1)** → resolved by D-4 bar-strength note + D-7 margins + per-bar mutation. Honestly acknowledged, not hidden. ✓
- **Blocker 2 (one mutation)** → resolved by the mutation MATRIX, one perturbation per bar, each reds exactly its bar (Invariant, D-4, Phase 2/3). ✓
- **Blocker 3 (labeled-set pass assumed)** → resolved by D-8 prove-on-proposed-labels-before-ratify. ✓
- **RC-4 (gates can move)** → resolved by D-10 gate-pin hard-fail on resolved gates ≠ 49/45. ✓
- **RC-5 (hn_points mis-map)** → resolved by D-9 HN `source="hackernews"`, low-reach-cap-exempt. ✓

## Critical Blockers

1. **D-9's "exempt from low-reach cap" claim is unverified against the engine and may be false — §5 / D-9 / FACT 5.** D-9 asserts the X-only low-reach cap "already gates on `_is_x` (FACT 5 — HN isn't X)," so HN items are automatically exempt by `source="hackernews"`. But FACT 5 only lists `LOW_REACH_SCORE_CAP = ALSO_GATE - 5`; it does **not** confirm the cap's predicate is `_is_x` keyed on `source=="hackernews"`. AGENTS.md describes `_is_x` / `_engagement` falling back to `public_metrics.{like_count,retweet_count}` — the exact source-string check is not in the Evidence Pack. If the cap keys on anything other than the literal `"hackernews"` source value (e.g. "not in a known-X-source set," or an `authorHandle` heuristic), an HN known_good gets capped at ALSO−5 and **Bar 2 fails for a schema reason the PRD claims it solved.** Required: the harness must *assert* the exemption empirically (score one HN known_good, confirm `low_reach_capped=false`) rather than assume it from a fact that doesn't state it.

2. **Bar 3 ("every neutral < TOP_GATE") has no proven mutation that isolates it, and may be untestable on this fixture — D-4 / Phase 2 / FACT 1.** The mutation matrix says bar3 = "lift a neutral past TOP_GATE." But the only neutral in the Evidence Pack (`yohei-2like`, final=36) is a low-reach 2-like item — under the production low-reach cap it's structurally pinned *below* ALSO, let alone TOP. To mutate it *past TOP_GATE* (49) you must defeat the low-reach cap AND clear 49 — a large, artificial perturbation that may incidentally trip Bar 1 or Bar 4 too, so the test can't prove it reds *exactly* Bar 3. If the fixture contains only one or two neutrals and they're all floor-pinned, Bar 3 is as structurally vacuous as Bar 1 was — but unlike Bar 1, the PRD does **not** acknowledge this. Required: enumerate the neutrals in the gold set, show at least one can be mutated to red Bar 3 in isolation, or document Bar 3 as structurally-satisfied (like Bar 1) so its weakness is visible at ratification.

3. **The mutation matrix mutates the engine in-memory but the PRD never says the mutation is reverted/isolated per case — Phase 2 `--mutate` / Phase 3.** Phase 2 describes `--mutate <bar1..4>` "perturbs the engine in-memory." If `gold_set_eval_test.py` runs the four mutations + the clean ratified-set pass + the gate-pin case in one process and the perturbation mutates module-level constants (`OFF_TOPIC_PEN`, `BASE`, gates) without a guaranteed teardown, **bar-N's mutation can leak into bar-(N+1)'s run or into the clean pass**, producing either false reds or — worse — a *false green* on the clean assertion that hides a real regression. This is the classic shared-mutable-state test bug. Required: each mutation runs in an isolated subprocess or with explicit save/restore (fixture teardown) of every constant it touches, and the test asserts the clean run is byte-identical with and without the matrix having run.

## Required Changes

1. **Assert the HN low-reach exemption empirically, don't claim it (D-9).** Add to the harness: score at least one HN known_good and assert `low_reach_capped == false` and `final ≥ ALSO_GATE` for a *scoring* reason. If the engine's cap predicate isn't `source=="hackernews"`, this surfaces it as a real finding instead of a silent Bar-2 schema failure. (Closes Blocker 1.)

2. **Enumerate neutrals and prove or document Bar 3's testability (D-4/Phase 2).** List the neutral items in the fixture. If the only neutral(s) are low-reach floor-pinned, either (a) show a mutation that reds *exactly* Bar 3 without tripping Bars 1/4, or (b) add the same bar-strength honesty note Bar 1 got — "Bar 3 is structurally satisfied on this fixture; Bar 4 carries the signal" — so it isn't presented as a load-bearing bar it can't be. (Closes Blocker 2.)

3. **Mandate per-mutation isolation in the test (Phase 3).** Specify that each `--mutate` case runs in its own subprocess (preferred — `subprocess.run([... "--mutate", bar])`, assert exit 1) OR with a pytest fixture that snapshots and restores every mutated module constant. Add one assertion: the clean ratified-set run passes identically whether or not the mutation cases ran first (no state leak). (Closes Blocker 3.)

4. **Make the gate-pin read the SAME resolved value the bars use, not a re-derivation (D-10).** D-10 asserts resolved gates == 49/45. Specify that the harness captures the *exact* `top_gate`/`also_gate` values it passes into `select_shadow` (FACT 5: `select_shadow(..., top_gate, also_gate)`) and pins *those*, not a separately-read constant — otherwise a regression could move the constant the pipeline uses while the pin reads a stale literal and stays green. One source of truth for the gate value, asserted == 49/45, fed to both the pin and the pipeline.

5. **Specify forced-distribution's interaction with the bars (§5 / D-4).** `select_shadow` runs forced-distribution (≤MAX_TOP, ≤MAX_ALSO caps) on a 15-item pool. Bar 1 ("zero known_bad in TOP within MAX_TOP slots") and Bar 2 ("every known_good ≥ ALSO_GATE") can interact badly: if >MAX_ALSO known_goods clear ALSO_GATE *by score* but get squeezed out of placement by the slot cap, does Bar 2 evaluate on *score ≥ ALSO_GATE* or on *placement in ALSO*? The PRD uses both framings ("scores ≥ ALSO_GATE" in D-4.2 vs "placement" in §5). Pick one explicitly: Bar 2 should evaluate on **score**, not placement, or a benign slot-cap eviction reads as a scorer regression. Disambiguate in D-4.

## Lens Notes
- **Product:** Diagnosis maps 1:1 to FACT 1–3; Non-Goals match FACT 8 exactly; OQ-2 honestly defers the 200-item corpus. No scope smuggled. ✓
- **Architecture:** Correct call using real `select_shadow` over `score_item` — placement bars need the full pipeline; D-5 explicitly forbids a reimplementation, killing production drift. ✓
- **Security:** Clean — static fixture, no network/keys, CI-safe, genuinely additive rollback. Nothing to flag.
- **DevOps:** `&&`-chain wiring into `npm run verify` (D-5) correctly addresses the swallowed-subshell risk; confirm the Python lives *after* the JS selftests so a fast fail short-circuits cheaply.
- **Implementation:** Hard-error-on-missing-label (no coerce, §5) is the single best decision here — keep it absolutely. The shared-state mutation hazard (Blocker 3) is the one implementation trap the fixes introduced.
- **QA:** Mutation-matrix-per-bar is the right shape, but its *isolation* (Blocker 3) and Bar 3's *testability* (Blocker 2) are unproven — without those, "4 bars, 4 mutations" can still be "1 real net + 3 that can't be exercised."

## Open Questions
- **OQ-1 (Ace, at ratification):** Ratify the 15 proposed label sets as-presented, or eyeball/adjust? Apollo presents the full table with margins (D-7).
- **OQ-2 (Ace):** Ship v1 at 15 items now, or expand to the ~200-item sampled window? (Recommend: ship the 15-item incident regression-net now; expand only for statistical confidence — the incident cases are what actually broke.)
- **OQ-B (Ace):** If Apollo's correctly-reasoned ideal labels make a known_good fail its bar through the real pipeline (a genuine scorer finding, not a label error), BLOCK ratification, or ship `xfail` on that item with a documented known-gap? (Recommend BLOCK — a failing cert that ships green is worse than no cert; this is the D-8 path.)