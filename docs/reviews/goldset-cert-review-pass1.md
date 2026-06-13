# Independent Senior Review

## Verdict
APPROVE WITH CHANGES

The diagnosis is correct, the scope is honest, and the architecture (real `select_shadow`, mode-matched gates, mutation test) is sound. But three of the four D-4 bars have evaluability/teeth gaps that, as written, let a real scorer regression pass green — which is the one thing a certification harness must not do. These are fixable with concrete edits; none require re-tuning or scope expansion.

## Critical Blockers

1. **D-4 Bar 1 ("zero known_bad in TOP") may be vacuously true — §5 / D-4.** TOP is "items clearing TOP_GATE within MAX_TOP after the full `select_shadow` pipeline." Per FACT 1, the known_bad incident items (`bitnewsbot-spam` final=0, `elon-reply-fragment` final=0) score at or near the floor *even before* labeling — and the low-reach cap (FACT 5: `LOW_REACH_SCORE_CAP = ALSO_GATE-5`) plus `OFF_TOPIC_PEN=40` push them further down. A bar that asserts "the items that already score ~0 don't reach TOP" passes no matter what the scoring math does to the *middle* of the distribution. The spam>emollick inversion this harness exists to catch happens at the ALSO boundary, not at TOP. **This bar can be green while the regression it's named for is live.** Bar 4 (anti-inversion) is the only one with real teeth here, and it's doing all the work — Bars 1–3 need to be shown to be *individually* falsifiable, not assumed.

2. **The mutation test proves the harness can go RED, not that EACH bar can — Phase 2 / Phase 3.** The single mutation (`zero OFF_TOPIC_PEN`) trips whichever bar fails first. If that mutation only ever flips Bar 4 (or Bar 1), then Bars 2 and 3 are *never demonstrated to be load-bearing* — they could be miswired (e.g. comparing the wrong field, always-true) and the suite stays green forever. A certification harness with one of four bars actually tested is a rubber stamp for the other three. **Required: one mutation per bar**, each asserted to turn exactly that bar RED.

3. **Bar 2 ("every known_good ≥ ALSO_GATE") is evaluated against placement, but FACT 1 shows the marquee known_good can't satisfy it through the pipeline — and the PRD never proves the *labeled* version does — §1 / D-4.** The whole premise is `emollick-routing` known_good scoring 48 (<ALSO 50 default, but ≥45 tiebreak). Under production tiebreak gates (45) it's a pass *by 3 points* — fragile. More importantly: the PRD asserts the labeled set "will" satisfy all 4 bars (Acceptance Criteria) but provides **no evidence the ideal-labeled items actually clear their bars** — only that the *unlabeled* set fails. If Apollo's proposed labels don't lift `emollick-routing` clear of ALSO_GATE, Phase 2 fails and the "fix" doesn't close the gap. This isn't a blocker to *approve building it*, but the PRD must state the pass is **empirically demonstrated on the labeled set before ratification**, not assumed — otherwise Ace ratifies labels against an unproven gate.

## Required Changes

1. **Make Bars 1–3 demonstrably falsifiable, one mutation each (Phase 2/3).** Replace the single `--mutate off_topic_pen` with a mutation matrix: (a) a perturbation that pushes a known_bad into TOP → Bar 1 RED; (b) one that drops a known_good below ALSO_GATE → Bar 2 RED; (c) one that lifts a neutral past TOP_GATE → Bar 3 RED; (d) zero OFF_TOPIC_PEN or invert a guard → Bar 4 RED. Assert in `gold_set_eval_test.py` that each mutation reds *exactly its target bar*. This is the difference between "the gate can fail" and "the gate works."

2. **Add a sensitivity/margin report, not just pass/fail (Phase 2 output).** For each known_good, print `final − ALSO_GATE`; for each known_bad, print `TOP_GATE − final`. A bar that passes by 3 points (emollick at 48 vs 45) is a latent flake — Ace should see the margins at ratification. This also surfaces Blocker 1: if every known_bad clears TOP by 45+ points, Bar 1 is confirmed vacuous and you know Bar 4 is your only real net.

3. **State the labeled-set pass as a Phase-1 gate, with evidence, before ratification (§6 Phase 1 / Acceptance Criteria).** Add an explicit step: "score the *proposed-label* set through `select_shadow`; all 4 bars must pass on Apollo's labels *before* presenting to Ace. If any bar fails on correct labels, that's a scorer finding (Non-Goal §2) — surface it, do not adjust labels to force green." This closes the trap where labels get reverse-engineered to satisfy the gate (which would make the gate certify nothing).

4. **Pin the gate constants the bars compare against (D-4/D-6).** The harness reads `ALSO_GATE/TOP_GATE` from the engine. If a future regression *moves the gates themselves* (exactly the Non-Goal it guards), the bars move with them and stay green. Assert the resolved gates equal the expected tiebreak values (49/45) and hard-fail on mismatch — so "someone retuned the gates" is itself caught, not silently absorbed.

5. **Guard the schema-map for `hn_points` items (§5).** FACT 6: some gold items have `hn_points`, not `likes/retweets`. The low-reach cap reads `likes+retweets` (FACT 5). Specify how an HN item's engagement maps (or is exempted) so an HN known_good isn't spuriously low-reach-capped below ALSO_GATE — otherwise Bar 2 fails for a schema reason, not a scoring one.

## Lens Notes

- **Product:** Diagnosis (3 problems) is correct and the minimal fix maps 1:1 to them; OQ-2 honestly defers the 200-item corpus. No complaints.
- **Architecture:** Correctly uses real `select_shadow` over `score_item` — the placement bars require the full pipeline; this is the right call and avoids production drift.
- **Security:** Clean — static fixture, no network/keys, CI-safe; rollback is genuinely additive. Nothing to flag.
- **DevOps:** Wiring into `npm run verify` is right, but the gate runs Python inside a JS verify — confirm non-zero exit actually fails `npm run verify` (a `&&` chain, not a swallowed subshell), else the gate is decorative.
- **Implementation:** Hard-error-on-missing-label (no coerce) is exactly right and the single most important design choice here; keep it. Map `hn_points` explicitly (Required Change 5).
- **QA:** One mutation for four bars is the central weakness — three bars are asserted but never proven load-bearing (Blocker 2). Mutation-per-bar is non-negotiable for a thing whose entire job is "go RED on regression."

## Open Questions

- **OQ-A (Ace):** Under production tiebreak gates, `emollick-routing` clears ALSO by ~3 points. Is a 3-point margin an acceptable pass, or do you want the harness to flag sub-N-point margins as a WARN (not fail) so latent flakes are visible? (Recommend WARN at <5.)
- **OQ-B (Ace):** If Apollo's *correctly-reasoned* ideal labels make a known_good fail its bar through the real pipeline (a genuine scorer finding, not a label error), do you want that to BLOCK ratification, or land as a documented known-gap with the harness shipped `xfail` on that item? (Recommend BLOCK — a failing cert that ships green is worse than no cert.)