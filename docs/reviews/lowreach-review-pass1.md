## Verdict

**APPROVE WITH CHANGES**

The change is well-evidenced, correctly targets a real inflation hole, and the test coverage is genuinely good. None of the defects below are correctness-blocking on the observed pool, but two are real and one is a latent classification bug that will bite later. Fix them and ship.

## Critical Blockers

None. The guard is reversible (down-rank), exempts the stated safety cases, and the self-test asserts the spam/rant fall below gate while TL/engaged/non-X are exempt. No data-loss or irreversible-harm path.

## Required Changes

1. **`_is_x` retweet/source bug — the `floor=5` divisor field may be missing on real X rows.** The penalty hinges on `_engagement = likes + retweets`. If the upstream X ingest names those fields differently on some rows (e.g. `favorite_count`/`retweet_count`, or `public_metrics.like_count` nested), `_num` returns 0 for both and **every such post is treated as zero-reach** — including the 15283/2458/1767-engagement gems. This is the single highest false-positive risk and it is invisible in the self-test because the test hand-feeds `likes`/`retweets`. **Required:** confirm against a live DIGEST8 row that `item["likes"]`/`item["retweets"]` are the actual populated keys (not nested/aliased), and add one self-test asserting a known high-engagement real row reads `_engagement >= 5`. If the ingest uses metric aliases, normalize them in `_engagement`.

2. **`_is_x` no-source fallback misclassifies plain-text X rows and over-claims non-X.** The fallback requires `tweet_text or authorHandle` AND `not (title or hn_points)`. Two gaps: (a) a real tweet whose row carries a `title`-like field (some scrapers populate `title` with the tweet text) is classified **non-X → exempt → spam survives**. (b) Conversely fine for safety, but it means your guard silently no-ops on an unknown slice. Since the whole design says "source-driven," **make missing-source a logged anomaly, not a guess** — if `source` is empty on an X-shaped row, emit it to the audit dict (`unsourced_items`) so you can see how often the fallback fires rather than trusting it blindly.

3. **Penalty magnitude (20) and floor (5) are fit to one pool — pin them as named, documented constants with the derivation, and add a regression guard.** The math `80 + ~10 − 20 = 70 < 77` only holds while pf caps near 10. If `personal_fit_delta` can reach 15–20 (does it? — see Open Questions), a flat-80 spam item with high pf clears 77 *after* penalty and the guard silently fails. **Required:** add a self-test for the worst realistic case — `base=80, pf=MAX_PF, eng=0` — asserting `_final < ALSO_GATE`. If that fails, the penalty must scale with pf or the floor logic must hard-cap, not soft-subtract. Right now 20 is "the number that worked on 120 candidates," which is brittle by your own anti-arbitrary standard.

## Lens Notes

**Data-quality:** The evidence is strong and honest — flat-rate-80, 26/98 zero-engagement, @emollick scored *below* a spam bot, and the explicit verification that no tracked-exemption-would-save item was genuine. That last point is the best part of the diff: it preempts the obvious "but tracked projects!" objection with real data. Keep that comment; it's the justification for the most counterintuitive design choice.

**False-positive risk (Q1):** The TL+engagement exemption is *adequate for the X surface as it actually behaves* — genuine content earns engagement (your floor of 5 is trivially cleared by anything real; top values are 15k/2.4k/1.7k, and 40 items already exceed 20). The "0-like gem from a small real builder" is the theoretical worst case, but the data shows it doesn't occur in practice — real builders aren't at literal 0 likes+0 RT in a 98-item X pool. The residual risk is **field-aliasing (Required #1)**, not the threshold itself. The exemption net is fine; the input plumbing is what to verify.

**Down-rank vs discard (Q4):** You're right to be suspicious — on the *current* pool, −20 always drops a flat-80 item below gate, so "down-rank" is observationally identical to "discard." But it's still the correct design for two reasons the data doesn't show: (a) a penalized item with unusually high base (say model rates a low-reach item 95) lands at 95+pf−20 and *can* still survive — discard would kill it; (b) it composes cleanly with forced-distribution and future gate tuning instead of being a special-cased terminal state. So "down-rank not discard" is meaningful as architecture even when it's a distinction-without-difference on this pool. Worth a one-line comment saying exactly that, so a future reader doesn't "simplify" it into a discard.

**Interaction with forced-distribution / gates (Q3):** Clean. Penalty applies in `score_item` before `apply_forced_distribution`, so the `>=90`/`==100` clamps operate on already-penalized finals — no double-jeopardy, no ordering hazard. Penalized items can't sneak into the ≥90 band. Good.

**Classification (Q5):** Covered in Required #1/#2 — the `_is_x` heuristic is the weak link, not the penalty logic.

## Open Questions

1. **What is the actual max of `personal_fit_delta`?** The whole guard's sufficiency rests on `pf ≲ 10`. If pf can hit 15–20, the −20 penalty is under-powered and spam re-clears the gate. This is the one number that determines whether the magnitude is "evidenced" or "lucky." Confirm the pf cap and add the worst-case self-test.

2. **Are `likes`/`retweets` the literal populated keys on every live X row,** or do some rows carry aliased/nested metrics? (Required #1.) A single live-row `keys()` dump settles it.

3. **How often does the no-source `_is_x` fallback actually fire on real data?** If it's >0% you're guessing on real rows; instrument it before trusting it (Required #2).

4. Minor: `low_reach_penalized` counts over `selected + also + discarded` — confirm a penalized item can't appear in *both* a retained list and discarded (double-count). Likely fine given disjoint partitioning, but worth a glance since the audit number will be quoted.
LR-P1-EXIT=0
