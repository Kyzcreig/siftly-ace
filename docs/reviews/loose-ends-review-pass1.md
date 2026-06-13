# Independent Senior Review
## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None

## Required Changes
1. **The e2e guard (focus #4) is silently vacuous if the tie doesn't form.** `if hti["_final"]==xti["_final"] and hti["_final"]>=ALSO_GATE:` wraps the ONLY assertion in sub-check (3). If either condition fails, the entire fresher-HN-wins test passes by doing nothing — and this is the one check that actually exercises `select_shadow` end-to-end. Add an explicit `check(hti["_final"]==xti["_final"], "e2e fixture must tie on _final")` and `check(hti["_final"]>=ALSO_GATE, ...)` BEFORE the conditional so a fixture that drifts out of the tie fails loudly instead of green-passing. Sub-check (1) already does this for its tie (`check(ihi["_final"]==ilo["_final"], ...)`) — mirror that discipline here.

2. **`_placement_engagement` HN-detection predicate is over-loose on the fallback path (focus #3).** The guard is `bd.get("labels") is not None and _hn_points(it) is not None`. An item reaches the `_engagement(it)` fallback whenever EITHER `_breakdown` is missing/not-a-dict, `labels` is None, OR `_hn_points` is None. Both call sites are asserted to operate on scored items (always have `_breakdown`), so the `.get("_breakdown")` → None fallback won't fire in production — acceptable. BUT: confirm `_hn_points(it)` returns None for X items (so X never accidentally takes the HN branch). If an X item ever carries an `hn_points` key (e.g. a merged/enriched record), it would silently switch to the capped crowd term and **break the byte-identity guarantee in #1**. Add a positive `source`-based gate (`it.get("source")=="hackernews"`) to the HN branch rather than inferring HN purely from `_hn_points is not None`.

## Lens Notes
Architecture — change is correctly localized to one helper + one key; both call sites provably operate on scored items, so the `.get()` fallback is dead-but-safe in prod.
Scoring-correctness — focus #1 holds: X branch returns raw `_engagement()` unchanged, so two X tweets with equal capped crowd term but different raw likes+retweets still order by raw (byte-identical); focus #2's cross-scale HN(~0–14) vs X(~0–50000) comparison is acceptable ONLY because it fires strictly post-`_final` and strictly dominates the old HN-pinned-to-0 behavior.
QA — sub-check (1) and (2) are sound and assert their preconditions; sub-check (3)'s payload-bearing assertion is gated behind an unverified `if` (Required Change #1).

## Open Questions
1. Cross-scale rung (focus #2): post-`_final`-tie, a low-signal HN story (crowd term ~3) now beats a viral X tweet (raw 50000) on the engagement rung. Is that ever the WRONG call for the digest, or is `_final` equality enough to make the two genuinely interchangeable so the HN-favoring nudge is harmless? Strictly better than the old bug either way, but worth a one-line product confirmation.
2. The `<=`→`<` tightening asserts `HN_POINTS_CAP < ENGAGEMENT_CAP` (14 < 15). Is any other code path relying on `HN_POINTS_CAP == ENGAGEMENT_CAP` being permissible? If the two caps are ever reconciled to equal in future tuning, this selftest now hard-fails by design — confirm that's the intended guardrail, not an accidental footgun.