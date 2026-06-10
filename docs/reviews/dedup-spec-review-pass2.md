# Event-Dedup Spec — Senior Review (Pass 2)

## Verdict
APPROVE WITH CHANGES

One real new hole (placement re-split contradiction) + one underspecified item. Both are one-line spec edits, not redesigns. Everything from Pass-1 is genuinely resolved.

## Blocker Resolution Map
- **Blocker 1 (undefined primary)** — RESOLVED. `is_primary = model-emit OR authorHandle in PRIMARY_HANDLES`; allowlist is a version-controlled file unioned with existing `thought-leaders.txt`. Ground-truth confirms `source=='X'` for all, so the boolean is now the load-bearing distinguisher, not `source`.
- **Blocker 2 (winner≠placement comparator)** — PARTIAL. The comparator is fixed (score now outranks engagement at key 2), but see New Issue #1: "placement derived from winner's `final_score`" still collides with "re-split survivors by score desc" — the spec carries BOTH statements and they can disagree.
- **Blocker 3 (shingle over-grouping)** — RESOLVED. Jaccard ≥ 0.6 with explicit conservative "when in doubt DON'T merge" hard rule; unit test pins Fable(#1,#3,#5) merge / policy(#4) split. Correct direction (false-merge = data loss, false-split = cosmetic).
- **RC1 (define is_primary)** — RESOLVED. Same as Blocker 1; allowlist location/anti-rot handled.
- **RC2 (same score-aware comparator)** — PARTIAL. Comparator unified; placement statement not fully reconciled (New Issue #1).
- **RC3 (shingle match rule + guard)** — RESOLVED. Threshold + conservative bias + adversarial test all present.
- **RC4 (total order)** — RESOLVED. `tweet_id/url` ascending as final key; all-tie test asserts determinism.
- **RC5 (enum reuse + name field)** — RESOLVED. `event_dup` added to enum (not silently invented), `topic_dup` reserved for model topic-diversity drops, `lost_to_url` named, debug consumer + self-test fixtures flagged for update.

## New Issues
1. **(must-fix, one line) RC2 left two contradictory placement statements.** Step-2 still says "stable re-sort survivors by **score desc**, then re-splits Top/Also as one pool" while RC2 says "placement derived from the **surviving winner's own final_score** against the 83/77 gates, never re-derived." These are the same outcome ONLY if the re-split uses `final_score` against the fixed gates — but a naive "re-split by score desc into top-5/next-2" would re-bucket a 78 winner into Top if Top is underfilled, demoting nothing but *promoting* across the gate. Pin it: **re-split is gate-driven (`>=83`→Top, `77–82`→Also), NOT rank-driven.** Delete or reword the "re-sort by score desc, then re-split" line so it can't be read as rank-bucketing. Without this, the surviving Blocker-2 ambiguity ships.

2. **(should-fix) `is_primary` allowlist union semantics unspecified for thought-leaders.** D4's "thought-leader handle" was the *hard-floor exemption* concept; RC1 now unions `thought-leaders.txt` INTO `PRIMARY_HANDLES`. That makes every tracked thought-leader count as `is_primary=True` — meaning a thought-leader's *reaction/field-report* tweet now beats the actual official launch tweet on key 1 (both True → falls to `final_score`, usually fine, but two primaries in one cluster is now common). Acceptable, but state it: when ≥2 items are `is_primary`, key-2 `final_score` decides — confirm that's intended and that the official-launch post isn't expected to always win over a high-score thought-leader take.

## Open Questions
1. The four probes are sound and match the EVIDENCE PACK (`source=='X'` for all, no event field, 0 `topic_dup` drops, `final_score` gates). One follow-up: the spec says `event_dup` is "ADDED to the enum (+ debug consumer + self-test fixtures updated)" — confirm the **37/37 self-tests** are extended with the 4 new QA cases (same-org-split, span-Top+Also, all-tie, empty→`([],[])`), not just kept green. That's the closeout gate; verify count goes 37→41+ and live-run shows one-event-one-slot before declaring done.

Fix New Issue #1's one line and it's a green build.
