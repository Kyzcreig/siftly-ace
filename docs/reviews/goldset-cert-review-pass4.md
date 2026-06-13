# Independent Senior Review

## Verdict
APPROVE WITH CHANGES — borderline APPROVE

The Pass-3 v4 fixes genuinely close their targeted findings. I checked each of the five against the document and the evidence pack, and the residual issues are narrow consistency cleanups, not load-bearing defects. I am NOT re-raising the Pass-1/Pass-2 items (D-9 HN empirical assertion, D-12 neutral enumeration, subprocess isolation, D-10 gate-pin, D-11 score-not-placement) — they are resolved and I verified each below. Two real items remain that v4 introduced or left slightly self-contradictory; neither blocks the build, but both should be tightened before APPROVED.

## Pass-3 v4 Fixes — Verified Resolved (not re-raising)

- **Pass-3 B1 (Bar 3 dressed as load-bearing)** → v4 D-4 now states plainly: "the net is 2 fully load-bearing bars + 2 structurally-satisfied," Bars 1 & 3 "nearly true by construction," and explicitly that the `--mutate bar3` case "exercises a SYNTHETIC injected neutral (scaffolding), which proves the bar3 assertion logic fires, NOT that the certified pool exercises Bar 3." This is Bar 1's honesty standard now applied to Bar 3. My prior Blocker 1 is closed. ✓
- **Pass-3 B2 (no-leak assertion theater)** → v4 Phase 3 drops the vacuous "ran the matrix first" assertion and states the guarantee correctly: "Leak-prevention IS the subprocess isolation itself… no separate 'ran the matrix first' assertion, which would be vacuously true under subprocess isolation and prove nothing." Exactly the fix I asked for (option (a)). My prior Blocker 2 is closed. ✓
- **Pass-3 RC-3 (gate-pin one literal)** → v4 D-10 now mandates `TOP_GATE_EXPECTED=49, ALSO_GATE_EXPECTED=45` as a literal in "exactly one place," feeds *those same symbols* into `select_shadow(...)`, and reads the engine's resolved gates via its own accessor — "No re-typed 49/45 anywhere else." Closes my prior RC-3. ✓
- **Pass-3 RC-4 (Bar 1 placement masks inversion)** → v4 D-4.1 + D-11 now assert ALL four bars on `final` SCORE: Bar 1 = "no known_bad has `final ≥ TOP_GATE`," with an explicit note that a placement-only Bar 1 "would read green while the exact inversion is live." This is precisely the score-not-slot fix I required. Closes my prior RC-4. ✓
- **Pass-3 RC-5 (&&-ordering)** → v4 D-5 now orders the gold gate AFTER the JS steps (`tsc && lint && vitest && e2e && python3 scripts/gold_set_eval.py`) so a cheap JS fast-fail short-circuits, and states the harness is "import-only/offline so it cannot hang CI." Closes my prior RC-5. ✓

## Critical Blockers

None. No item can make the gate certify a broken scorer green or fail to catch the 2026 inversion regression. The mechanism that matters — Bar 4 (anti-inversion) on SCORE through the real `select_shadow`, with a per-bar subprocess mutation proving it fails RED — is correctly specified and empirically grounded (FACT 1, FACT 5).

## Required Changes

1. **Acceptance Criterion #4 contradicts the document's own mutation-matrix invariant.** §10 AC#4 still reads: *"the mutation case asserts the harness exits 1 when `OFF_TOPIC_PEN` is zeroed."* That is the **single-mutation** framing v2 explicitly replaced — the whole Constitution Invariant ("EACH bar must FAIL on a regression that targets it") and D-4/Phase-3 require a **four-case matrix** (bar1/bar2/bar3/bar4), each in its own subprocess. As written, AC#4 would be satisfied by a one-bar test that the rest of the PRD calls insufficient. Fix: AC#4 must require all four per-bar mutation subprocesses to exit 1 on their target bar + the gate-pin hard-fail case — i.e. the acceptance evidence must match Phase 3, not the abandoned single-mutation proof.

2. **§10 AC list omits the two newest invariants entirely.** The Acceptance Criteria predate v3/v4 and never assert (a) the gate-pin (D-10) — that the engine's resolved tiebreak gates equal 49/45 — nor (b) the D-9 HN empirical exemption (an HN known_good asserts `low_reach_capped==false` AND `final ≥ ALSO_GATE` for a scoring reason). Both are load-bearing per the Risks table and the Architecture diagram. Add two checkboxes so closeout proof actually covers the gate-pin and the HN-schema fail-vs-scoring-fail distinction; otherwise a green AC list could ship with the gate-pin unwired (the exact gate-retune regression D-10 exists to catch).

3. **State the D-12 neutral enumeration as a Phase-1 acceptance artifact, not only a runtime print.** D-12 and Phase 1's E2E check require the neutral enumeration (each neutral's score + floor-pinned flag) to be shown to Ace *at ratification* so he sees which bars are live vs structurally-satisfied. §10 AC#2 (ratification) should explicitly require that enumeration to be part of the ratification evidence — otherwise the "Ace sees Bars 2&4 are load-bearing" honesty mechanism is procedurally optional and could be skipped, leaving Ace ratifying without the structural-satisfaction disclosure the PRD leans on for its bar-strength honesty.

## Lens Notes
- **Product:** Diagnosis maps 1:1 to FACT 1–3; Non-Goals (§2) match FACT 8 line-for-line — no re-tuning, no 200-item corpus, no labeler cert, no Hard-Config smuggled. OQ-2 honestly defers the corpus. ✓
- **Architecture:** Correct — real `select_shadow` (D-5 bans reimplementation, killing production drift), full pipeline for placement, all-bars-on-score (D-11) is the right call. ✓
- **Security:** Clean — static fixture, no network/keys, offline deterministic, CI-safe, genuinely additive rollback (drop one verify line + revert). Nothing to flag.
- **DevOps:** `&&`-chain with gold gate ordered after JS (D-5) is right; import-only/offline can't hang CI. Only residual is AC#4's stale single-mutation wording vs the matrix the rest of the doc mandates (RC-1).
- **Implementation:** Hard-error-on-missing-label (§5) remains the single best decision — an unlabeled item can never silently coerce-and-pass (directly defuses FACT 1's 15/15 `label_coerced:true`). Keep it absolutely.
- **QA:** Net is honestly "2 fully load-bearing (Bars 2 & 4) + 2 structurally-satisfied (Bars 1 & 3)," now stated plainly (v4 D-4). Mutation-matrix-per-bar in isolated subprocesses is the correct teeth-proof; the only gap is the Acceptance Criteria (§10) lagging the body — RC-1/RC-2/RC-3 are all "make §10 match §3/§6," not new design.

## Open Questions
- **OQ-1 (Ace, at ratification):** Ratify the 15 proposed label sets as-presented, or eyeball/adjust specific items? Apollo presents the full table with margins (D-7) + the neutral enumeration (D-12).
- **OQ-2 (Ace):** Ship v1 at 15 items now, or expand to the ~200-item sampled window? (Recommend: ship the 15-item incident regression-net now — those are the cases that actually broke; expand only for statistical confidence.)
- **OQ-B (Ace):** If Apollo's correctly-reasoned ideal labels make a known_good fail its bar through the real pipeline (a genuine scorer finding, not a label error), BLOCK ratification or ship `xfail` with a documented known-gap? (Recommend BLOCK — a failing cert that ships green is worse than no cert; this is the D-8 path.)