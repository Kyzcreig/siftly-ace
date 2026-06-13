# Independent Senior Review

## Verdict
APPROVE WITH CHANGES

The five Pass-1 fixes are genuinely resolved — I verified each against the updated code, not the changelog claims. B2 (the topic-gate) and B1 (the cap invariant) are the two I most wanted to see become *structural*, and both did. But the topic-gate fix introduced one real ordering/duplication concern, and two Pass-1 calibration gaps remain only *partially* closed. None are byte-identity or data-loss class, so this is not a BLOCK — but they should land before cutover.

## Critical Blockers

None at BLOCK severity. The X byte-identity guarantee holds structurally (source-gate in `_hn_points` + the stray-key selftest is discriminating), off-topic safety is now structural, and the cap invariant is now enforced by assertion. Demoting Pass-1's blockers #1 and #2 to resolved is justified; the remaining items are APPROVE-WITH-CHANGES severity.

## Required Changes

1. **Topic-gate is evaluated twice and can drift from `_hn_points`'s own source-gate (score_digest.py, score_item).** The new guard is `if eng and eff_on_topic == "off" and _hn_points(item) is not None: eng = 0`. This calls `_hn_points(item)` a *second* time (first call is inside `engagement_points`). It's correct today, but it couples the gate's correctness to two independent evaluations of the same predicate staying in lockstep. Cleaner and regression-proof: have `engagement_points` return whether the crowd branch was taken (or expose it on the breakdown), and gate on *that* fact, so the gate can never disagree with the term it's gating. As written, a future edit to `_hn_points`'s source set (`"hackernews","hn"`) that isn't mirrored here silently un-gates off-topic HN. Minor, but it re-introduces the "two things must agree" fragility B2 was meant to remove.

2. **`e90 >= 1` proves lift exists but NOT that the 50–90 live-cluster band lands where intended (Pass-1 blocker #3 only half-closed).** The new band tests assert PIVOT→0 (good, discriminating) and 90→≥1. But Pass-1's actual concern was that a real slow-day front-page story at ~70 pts gets only ~+1 and **stays sub-TOP**, defeating the differentiation goal. There is still no test asserting a *borderline-quality* HN story in the 60–90 band does NOT wrongly reach TOP, and none asserting a *legitimately front-page* slow-day story DOES clear. `e90 >= 1` is satisfied by +1, which may be exactly the under-promotion the digest is supposed to fix. Add a `_final`-level assertion at ~70–90 pts for both a high-base and low-base item so the knee's real-world position is pinned, not just its sign.

3. **Monotonicity strengthened correctly, but the tie→recency interaction (Pass-1 Q4) is still untested.** `e2345 > e234 > e90 >= e40` is now strict on the breakdown term where it matters and correctly allows `e90 >= e40` (both may be 0/low) — good, that's the right discriminating shape. But with `RECENCY_AS_TIEBREAK=1`, two *distinct* front-page stories whose crowd terms round to the same integer still fall through to recency, not crowd-signal. The `>= e40` rung explicitly tolerates a tie at the low end; nothing tests that two genuinely different high-point stories don't tie at the *_final* level and silently reorder by recency. Add one assertion that two realistic adjacent front-page values (e.g. 234 vs 400) produce distinct `_final`, or document that recency-break-on-tie is intended.

4. **`MIN_CORPUS = 10` is now named (B5 ✓) but still a hand-set literal, not computed from the gold manifest (Pass-1 Required-Change #5 only partially closed).** Naming it killed the magic-literal smell and the comment explains the "below 15 to allow pruning" intent — that's a real improvement. But it can still **false-fail** a legitimately pruned 8-item corpus or **false-pass** a 10-item set padded with weak neutrals. The stronger form remains: derive the floor from the certified gold-set manifest (`>= len(GOLD_MANIFEST)` or a documented fraction of it) so the threshold tracks the actual corpus rather than a guess. Acknowledged as a judgment call — if 10 is a deliberate floor below a fixed 15-item set, an assertion `MIN_CORPUS < len(gold_manifest)` would lock that relationship.

5. **Off-topic safety test is now discriminating (B2 ✓) — but assert the term is 0 for the *on-topic* mega too, to prove the gate is scoped.** The updated test asserts the engagement TERM is 0 for the 5000-pt off-topic story (correctly discriminating — revert the gate and it fails). Good. To prove the gate is *scoped to off-topic only* and didn't accidentally zero on-topic crowd lift, pair it with the existing `e2345 > 0` assertion explicitly labeled as the scope-guard, so a future over-broad gate (zeroing all HN crowd terms) fails loudly.

## Lens Notes
- **Architecture:** B2's gate is correct but re-evaluates `_hn_points` redundantly (Required Change #1) — the source-of-truth should be the term that was actually computed, not a re-derived predicate.
- **Scoring-correctness:** B1 cap invariant (`HN_POINTS_CAP <= ENGAGEMENT_CAP`, 14≤15) is now *enforced by selftest* — Pass-1's top blocker is genuinely closed; the 60–90 knee position remains the soft spot.
- **Security/abuse:** Source-gate + `bool`/garbage exclusion still airtight; the off-topic gate now closes the "5000 pts rescues junk" path structurally, not arithmetically.
- **QA:** Monotonicity and off-topic tests are now discriminating (revert-the-fix → red). Remaining gaps are coverage (band/tie), not vacuousness.

## Open Questions
1. The B1 invariant holds at 14≤15 — but is HN crowd-signal *meant* to be able to equal the strongest known-author X ceiling (both can hit ~14–15)? If an HN megastory should never outrank a top-tier X thought-leader tweet, the invariant should be strict `<`, not `<=`.
2. For an *unknown*-author X tweet the cap is `ENGAGEMENT_CAP_UNKNOWN` (lower than 14). An HN megastory therefore *can* outscore any unknown-author X tweet on the crowd term alone — is that the intended editorial priority (curated front-page > random viral tweet)?
3. Real (non-synthetic) gold corpus actual count and class split — still the open variable that decides whether `MIN_CORPUS=10` is a false-fail/false-pass risk (carried from Pass-1 Q3).
4. Does `select_shadow`'s dedup/cap/distribute step preserve crowd-driven TOP ordering, or can a now-promoted HN story still be truncated below the fold? (carried from Pass-1 Q5 — still not in the pack.)
5. With the gate calling `_hn_points` twice, is there a perf/consistency reason not to thread the crowd-branch flag through the breakdown instead? (drives Required Change #1.)