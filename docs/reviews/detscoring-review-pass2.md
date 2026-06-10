I'll verify each blocker against the evidence pack as ground truth, hunting for partial fixes and new blockers. Let me work through this carefully.

Let me trace the critical mechanics:

**B2/§4.4 trace:** The spec says `low_reach_cap` runs after `score_digest.py`. But §4.5#3 and §4.3 say the cap is `unknown handle + engagement < floor → final ≤ LOW_REACH_SCORE_CAP`. Ground truth: `LOW_REACH_SCORE_CAP=70`. New BASE table tops out at 70 (`launch×actionable_now`). So an unknown-handle item's max final BEFORE the cap is already ≤70 in most cells — the cap at 70 is near-inert against the new range unless ALSO_GATE is re-derived well below 70. This needs checking against B3.

**B3 trace:** New gates must be re-derived. But §6a's acceptance bar says "every known_good item scores ≥ the (re-derived) ALSO_GATE" AND "zero known_bad in TOP." The cap LOW_REACH_SCORE_CAP=70 is a *constant from the old range* that §4.3 says is "kept permanently" — but it's NOT in the re-derivation list. If ALSO_GATE re-derives to e.g. 55 (sensible for a table topping at 70), then LOW_REACH_SCORE_CAP=70 sits *above* the gate and caps nothing — the permanent floor-guard is silently dead. That's a partial fix.

Let me write the review.

# Deterministic Digest Scoring — Senior Review (Pass 2)

## Verdict
APPROVE WITH CHANGES

## Blocker Resolution Check

**B1 (shadow gate unmeasurable) — RESOLVED.** §6a pre-registers a versioned gold set (`docs/eval/digest-gold-set.json`) with four objective numeric bars (zero known_bad in TOP, all known_good ≥ ALSO_GATE, top-5 overlap ≥ 0.8, cardinality parity), mirrored in §7. The "≥" is now falsifiable. The owner (Ace ratifies, Apollo pre-labels) and in-repo versioning are both specified.

**B2 (double-scoring / two authorities) — RESOLVED.** §4.4 establishes a single mutating authority: `select_digest.py`'s `score_item()` is rewired to consume `score_digest.py`'s `final` and apply only gate/distribution/dedup; old `compute_boost` + pf_delta are folded into `author_tier_points` and explicitly must-not-apply-twice; unrewired guards run log-only/assert. The dual-mutate path is gone, not merely supplemented.

**B3 (gates calibrated on OLD distribution) — PARTIAL.** §6 step-2 correctly re-derives TOP_GATE/ALSO_GATE/MAX_GE_90/MAX_EQ_100 against the new range with cardinality-parity acceptance — good. **But the fix left a contradictory old constant behind elsewhere:** §4.3/§4.5#3 keep `LOW_REACH_SCORE_CAP=70` (evidence: ground-truth facts) as a "permanent floor-guard," and 70 is a *blind-inherited constant from the old ≈80-flat range* — it is NOT in the re-derivation list. The new BASE table tops out at exactly 70 (`launch×actionable_now`, §4.1), so for nearly every cell an unknown-handle item's pre-cap `final` is already ≤70 and the cap at 70 caps nothing. Worse: once ALSO_GATE re-derives downward to fit a table topping at 70 (it must, per B3's own logic), the cap at 70 sits *above* the gate → the "permanent" anti-gaming floor is silently inert. The same blind-inheritance B3 flagged for the gates now lives in the cap. (See New Issue 1 / B5 link.)

**B4 (malformed-label fail-safe) — RESOLVED.** §3 specifies normalize (strip/lowercase/synonym map) → safe-default label set (`opinion`/`context_only`/`mixed`/`adjacent` → base 25) → `_label_coerced` log + `label_coercion_count` counter → `#alerts` over threshold. Never crashes, never silent-zeros, visible. Matches required-change 4 exactly. (Minor: safe-default `opinion×context_only`=25 equals the malformed base 25 cited in §3 — consistent and intentional.)

**B5 (engagement gameable; cap removed) — PARTIAL.** §4.2 adds the anti-gaming term (unknown-handle engagement cap +6 vs +15) and §4.3 reverses "obviate" → "kept permanently" — the right things are present. **But the cap that's "kept" is numerically defeated by the new range** (see B3 PARTIAL): `LOW_REACH_SCORE_CAP=70` against a 70-ceiling table and a soon-to-be-lower ALSO_GATE means the standing floor-defense the spec leans on for "cheap purchased engagement parking in the steep part of the curve" doesn't actually bind below the gate. The anti-gaming *story* (4.2(a) cap + 4.3 floor) is only half-real until the cap is re-derived against the new range. Right thing added; contradictory old number left behind.

**RC6 (BASE table by example only) — RESOLVED.** §4.1 commits all 36 cells (9×4) with both row and column monotonicity selftests, making "launch ≥ hot take" structural. The named ordering is enumerated and asserted, not illustrative.

## New Issues

1. **`LOW_REACH_SCORE_CAP=70` is a blind-inherited constant against a table that tops at 70 — must be re-derived with the gates (NEW, introduced by the §4.1 table + §4.3 "keep permanently" fix).** The cap is the load-bearing anti-gaming floor per §4.2/§4.3/§4.5#3, but it's excluded from the §6-step-2 re-derivation list. Concretely: a `launch×actionable_now` post = base 70; any unknown-handle item below that is already <70 pre-cap, so the cap rarely bites; and once ALSO_GATE drops below 70 (required by B3), the cap caps *above* the gate → dead. This silently re-opens B5's paid-likes lever. **Add `LOW_REACH_SCORE_CAP` to the §6-step-2 re-derivation set** (it must land strictly below the re-derived ALSO_GATE, e.g. ALSO_GATE−5), and add a selftest asserting `LOW_REACH_SCORE_CAP < ALSO_GATE`.

2. **The "fold pf_delta into author_tier_points" claim (§4.4) drops a 0–24.6-point term to a 0–8 term with no re-derivation (NEW).** Ground truth: `pf_delta` reaches ~24.6 today (PF_WEIGHT=30), up to ~49 at PF_WEIGHT=60. §4.4 says the pf_delta add is "folded into `author_tier_points`," but §4.3 caps author tier at +8/+6/0. Personal-fit was a continuous up-to-24.6 signal; collapsing it into a ≤8 author-tier bump isn't a fold, it's a deletion of the personal-fit dimension. Either (a) keep a bounded `pf_points` term in the §4 formula (it's absent — the formula has base/substance/engagement/author/recency/media/off_topic, no pf), or (b) state explicitly that personal-fit is being *removed* as a scoring dimension and justify it against the incident pools. As written §4.4 claims a lossless fold that the numbers contradict.

3. **`engagement_points` thought-leader/tracked vs unknown cap (§4.2) requires author tier, but §4.5#1 hard-discard and §4.3 author tier all key off the same handle lists — circular timing unspecified (minor NEW).** `ENGAGEMENT_CAP_UNKNOWN` depends on classifying the handle as unknown; ensure the handle-tier resolution runs once, before both `author_tier_points` and `engagement_points`, and that a tracked-project *mention* (content keyword, not authorship — per current `_matches_tracked`) does NOT raise the engagement cap (only authorship should). Spec conflates "tracked author" and "tracked mention" in §4.2(a) ("thought-leaders/tracked authors"). Clarify: engagement-cap exemption = authorship tier only.

## Required Changes

1. **Add `LOW_REACH_SCORE_CAP` to the §6-step-2 gate re-derivation** and assert `LOW_REACH_SCORE_CAP < re-derived ALSO_GATE` in selftest. Without this, B3 and B5 are only half-fixed — the permanent floor-guard is numerically inert against the new range (New Issue 1). Update §4.3, §6 step-2, and the §7 acceptance line.

2. **Resolve the pf_delta fold (New Issue 2):** either add an explicit bounded `pf_points` term to the §4 formula and the breakdown dict, or state in §4.4 that personal-fit is intentionally removed and show it doesn't regress the incident pools (`@emollick` substantive-routing case depended on pf). The current "folded into author_tier_points" wording silently deletes a 24.6-point dimension.

3. **Clarify engagement-cap exemption = authorship tier only (New Issue 3)**, and specify handle-tier resolution ordering (resolve once → drives hard-discard backstop, author_tier_points, AND engagement cap).

## Open Questions

1. The §6a bar "every known_good item scores ≥ ALSO_GATE" plus "zero known_bad in TOP" — is there a defined behavior when a known_good item is correctly model-labeled `opinion×context_only` (base 25) and legitimately *can't* reach a re-derived ALSO_GATE? Does that fail the gold set, or is the gold set restricted to items whose ideal placement is TOP/ALSO (i.e., known_good ≠ "every neutral-but-fine post")? Define the gold-set label semantics so the bar isn't unsatisfiable by construction.
2. The `media_points` term appears in the §4 formula and §5 breakdown but has **no committed values** anywhere (unlike BASE, SUBSTANCE_ADJ, author tier, engagement cap). Same "specified by example/omission" failure RC6 fixed for BASE — what are the actual `media_points` constants, and do they need monotonicity (`video ≥ image ≥ none`)?
3. `recency_points` is likewise referenced (§4, §5) but never tabulated. The old prose had explicit anchors (today=10…older=2). What's the committed `recency_points` table, and does it interact with the §4.2a fresh-content floor (both reward recency — double-count risk)?
4. §4.2a fresh-content floor is gated on `author_tier=thought_leader AND on_topic != off`, but is only relevant under near-real-time ingest (not current daily ingest). Should it ship dark (specced, constant=0/disabled) until ingest changes, so it's not an untested live path? Confirm it's gated off for v1.
