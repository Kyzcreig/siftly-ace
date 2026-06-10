## Verdict
APPROVE

The CAP genuinely closes blocker #3. The pf-magnitude race is eliminated by construction, the two field-plumbing risks are ground-truthed and defended, and the audit counter is wired. The one residual concern (cap demoting a legit-but-low-engagement model-90 post) is real but is correctly the *intended* behavior given this surface's data, not a defect. Ship it.

## Resolved (per Pass-1 item)

1. **Field-aliasing (Required #1) — RESOLVED, genuinely.** Two-layer fix: ground-truthed that `likes`/`retweets` are the literal keys on 98/98 rows, *and* added a real fallback to `public_metrics.{like_count,retweet_count}` so a future ingest rename can't silently zero-out reach. The `lowreach:public_metrics-counts` test feeds nested metrics and asserts exemption — that's the test that was missing in Pass 1. Not cosmetic.

2. **No-source fallback instrumentation (Required #2) — RESOLVED.** `unsourced_items` counts pool rows with empty/blank source and is printed in the audit line. This is exactly "make the guess visible" rather than trust it. Correct scope: it counts *all* unsourced rows (the population the fallback adjudicates), which is the right denominator to watch. Minor note below, not blocking.

3. **THE BIG ONE — pf magnitude (Required #3) — RESOLVED, by construction.** This is the right fix, not a cosmetic one. A hard cap at 70 is invariant to base/pf/boost: `min(final, 70)` cannot be raced by pf regardless of whether pf_delta is 10, 24.6, or 49. The worst-case tests prove it: `base100+pf49` → capped ≤70, `base80+pf24.6+boost15`=100 → capped <77. A fixed `-20` would have let `base80+pf24.6=104.6 → clamp 100 → -20 = 80 ≥ 77` survive — the author correctly identified that their own Pass-1 math (`80+10-20=70`) was the lucky-pool case. The cap removes the dependency on pf's bound entirely. This is the strongest part of the diff.

## New Issues

None blocking. Three observations, all sub-blocker:

- **"Cap not discard" is real, but barely exercised — and the test proves the *weaker* claim.** `lowreach:cap-not-discard` asserts a `base95` low-reach item lands at exactly 70, *not* zeroed. That confirms cap≠discard mechanically. BUT on this pool the cap (70) is still below ALSO_GATE (77), so a capped item is **discarded by the gate anyway** — observationally identical to discard *today*. The distinction only becomes load-bearing if ALSO_GATE ever drops below 70, or if low-reach items compete against each other in a same-band tiebreak. So it's not a distinction-without-difference *as architecture* (it composes cleanly, survives gate-tuning), but a reviewer should know it has **zero observable effect on the current pool** — the value is purely future-proofing. That's a legitimate design choice, not a defect, and the inline comment says so.

- **The model-90 demotion you asked about is REAL and INTENDED — confirm you accept it.** A low-reach unknown-handle X post the model rates 90 gets capped to 70 and thus dropped. Is that wrong? No — and the design is internally consistent: the entire premise of #3 is that *base score is not trustworthy on the X surface* (flat-80 inflation, @emollick scored below a spam bot in Pass-1 evidence). If base is untrustworthy, a base-90 from an unknown zero-engagement handle is exactly as suspect as a base-80 one — engagement is the substituted quality signal precisely *because* the model's number is noise here. So capping a model-90 is not "wrongly demoting a legit post," it's "refusing to trust an inflated number from a handle the crowd ignored." The only way this bites is a genuine high-quality post from an unknown builder at literal 0 likes/0 RT — and Pass-1 already established that doesn't occur in a 98-item live pool (real builders aren't at 0/0). **Verdict: sound, but it rests on the empirical "real content earns ≥5 engagement" claim. If that ever stops holding (e.g. a fresh-post ingest that captures tweets seconds after posting, before engagement accrues), this cap will eat good content.** Worth a one-line comment flagging the timing assumption. Non-blocking.

- **`unsourced_items` denominator vs the fallback's actual firings don't perfectly match.** The counter tallies every pool row with blank source. But `_is_x`'s fallback only *fires* (and only matters) on blank-source rows that are *also* tweet-shaped AND not story-shaped. So `unsourced_items > 0` doesn't mean the X-guess fired — a blank-source HN row would inflate this counter without ever touching `_is_x`'s tweet branch. Today both are 0 so it's moot, but if you ever want the metric to mean "how often did we *guess X*," it's currently "how often was anything unsourced." Adequate as a tripwire (any non-zero → go look), imprecise as a fallback-fire rate. Cosmetic.

## Open Questions

1. **Timing/freshness of the ingest** — does any X source capture tweets early enough that a genuinely good post could be at 0 likes/0 RT at scoring time? If the digest ever moves to near-real-time ingest, the `≥5 engagement = real` premise (which the whole cap leans on) weakens and the model-90 demotion above starts eating good content. Only real follow-up worth tracking; everything else is shipped.

2. Minor/already-fine: confirm `low_reach_capped` can't double-count across `selected + also + discarded` — partitions are disjoint by construction so this is almost certainly fine, same as Pass-1 Q4. A glance only since the number gets quoted.
LR-P2-EXIT=0
