# Independent Senior Review

## Verdict
APPROVE WITH CHANGES

The core design is sound and the highest-risk property (X byte-identity) is structurally protected. But there are real calibration and test-discrimination blockers that can produce a wrong digest and should be fixed before this ships to a load-bearing daily output.

## Critical Blockers

1. **`HN_POINTS_CAP=14` exceeds the X known-engagement ceiling it claims to mirror — uncapped relative promotion (score_digest.py §4.2b).** The comment says HN crowd-signal is "capped like the known X-engagement tier (`ENGAGEMENT_CAP`)" and "bounded like `ENGAGEMENT_CAP`." But the evidence pack never shows `ENGAGEMENT_CAP`'s value, and the curve is explicitly modeled to hit **+13.4 at 2,345 pts** with CAP=14. If `ENGAGEMENT_CAP < 14` (plausible — X engagement for *unknown* authors is `ENGAGEMENT_CAP_UNKNOWN`, lower still), then an HN megastory gets a **larger crowd term than any X tweet can ever earn**, including from a thought leader. CAP is a literal that should be **computed/asserted against `ENGAGEMENT_CAP`** (e.g. `HN_POINTS_CAP = ENGAGEMENT_CAP`), or the divergence justified. As written, the "capped like X" claim is unverified by any assertion and may be false.

2. **The off-topic safety test is non-discriminating — it would still pass if the crowd term DID leak through gating (gold_set_eval.py / selftest).** The off-topic selftest uses `on_topic="off"` and asserts `_final < ALSO_GATE`. But the crowd term in `engagement_points` is **not topic-gated** — only `auth` is zeroed on off-topic (`if auth and eff_on_topic == "off"`). So a 5,000-pt off-topic HN story still receives the full `+14` engagement. The test passes only because `BASE[news][reference]` for an off-topic item is low enough that `base + substance + 14` still lands under ALSO_GATE=45. That is a **coincidence of base arithmetic, not a structural guarantee.** If anyone later raises a base or substance value, off-topic HN stories silently become promotable and this test won't catch the regression in the design it claims to protect. The comment "topic gating dominates the crowd term" is **false as implemented** — nothing gates the crowd term; the base is just small.

3. **PIVOT=50 sits inside live front-page density — the "minor stays ALSO" floor is fragile (score_digest.py).** Live data: 13 HN items spanning 9–2,345 pts. Points 50–90 produce 0 to +2. The selftest only probes 40/234/2,345 — it **never tests the 50–90 boundary band**, which is exactly where real front-page stories cluster on a slow news day. A genuinely front-page story at, say, 70 pts gets only ~+1, likely staying sub-TOP, while the digest's whole purpose is differentiating front-page news. Conversely there is **no test that a borderline-quality 60–90 pt story does NOT reach TOP**. The calibration is defensible in the abstract but **untested in the live-realistic band**.

4. **The monotonicity test is integer-rounded and can mask non-strict behavior at low points (selftest).** `engagement_points` returns `int(round(...))`. The monotonic assertion uses 40/234/2,345 which are far apart, so it passes — but it does **not** prove strict monotonicity across adjacent real values (e.g. 90 vs 120 may both round to +2). Two distinct front-page stories can tie, defeating the stated goal ("a 2,345-pt #1 *outranks* a 40-pt story") for the realistic near-neighbor case. With RECENCY_AS_TIEBREAK=1, ties silently fall to recency, not crowd-signal — a subtle wrong ordering in the live digest.

## Required Changes

1. **Tie `HN_POINTS_CAP` to `ENGAGEMENT_CAP` by computation, not literal.** Either `HN_POINTS_CAP = ENGAGEMENT_CAP` directly, or add a selftest `assert HN_POINTS_CAP <= ENGAGEMENT_CAP` so the "capped like X" invariant is enforced, not just asserted in a comment. Same for the K/curve: document why HN's K=8 reaching +14 is intentionally allowed to exceed an unknown-author X tweet's ceiling, if it is.

2. **Make the off-topic guarantee structural, not arithmetic.** Topic-gate the crowd term the same way `auth` is gated: `if eng and eff_on_topic == "off": eng = 0` (or zero it in `engagement_points` given `eff_on_topic`). Then the off-topic selftest becomes discriminating — revert the gate and it fails. Today it passes for the wrong reason.

3. **Add boundary-band tests around PIVOT.** Assert behavior at 50 (exactly 0), at the 60–90 band (a borderline front-page story's promotion), and a known_bad-quality story at high points staying sub-TOP via base/substance, not via crowd accident. Prove the 234→TOP knee is from the crowd term by also asserting `_breakdown["engagement"]` equals the expected value, not just `_final >= TOP_GATE`.

4. **Strengthen monotonicity to adjacent realistic values** (e.g. 90 vs 130 vs 200) and assert strict `>` on the `engagement` breakdown term, not the rounded `_final`, so integer rounding can't hide a tie.

5. **Corpus floor: assert the bars are non-vacuous *per class*, and pin the threshold to gold-set size.** `len(real) >= 10` is a magic literal. If the real gold set is, say, 8 curated items, this floor **false-fails** a legitimately small corpus; if it's padded to 12 with weak neutrals, it **false-passes**. Compute the floor from the certified gold-set manifest (or assert `>= len(GOLD_MANIFEST)`), and additionally require that **bar4's `min_good` is drawn from ≥1 real known_good** (already implied, but assert it) so an all-synthetic-good set can't satisfy the inversion bar.

## Lens Notes
- **Architecture:** Source-gate in `_hn_points` is the right structural boundary; the X byte-identity guarantee is genuinely structural (verified by the stray-key selftest) — this part is solid.
- **Scoring-correctness:** Two real risks — CAP may exceed the X tier it claims to mirror, and the off-topic "gating dominates" claim is arithmetic luck, not enforced gating.
- **Security/abuse:** `bool` exclusion and `max(0, int(p))` are correct; negative/garbage points fail safe to None. No injection path via stray keys. Good.
- **QA:** Several assertions are non-discriminating (off-topic, monotonicity, cap-vs-ENGAGEMENT_CAP) — they pass on coincidence and won't fail if the protected behavior regresses.

## Open Questions
1. What is the literal value of `ENGAGEMENT_CAP` (and `ENGAGEMENT_CAP_UNKNOWN`)? Until that's pinned, blocker #1 can't be closed — the entire "capped like X" justification rests on it.
2. Is the crowd term *intended* to be topic-gated, or intentionally ungated with the base doing the work? If the latter, that decision needs an explicit assertion locking the base/substance ceiling so off-topic HN can never sum past ALSO_GATE.
3. What is the actual count and class distribution of the real (non-synthetic) gold corpus? That determines whether `>= 10` is the right floor or a false-fail/false-pass.
4. With `RECENCY_AS_TIEBREAK=1`, when two HN stories' crowd terms round to the same integer, is recency the intended tiebreak — or should the pre-round float crowd-signal break the tie first?
5. Does `select_shadow`'s dedup/cap/distribute step (referenced but not in the pack) re-order or truncate in a way that could drop a now-promoted HN story below the fold despite a TOP score?