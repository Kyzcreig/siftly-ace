# SPEC — Deterministic Digest Scoring (model = qualitative only)

**Status:** v4 — APPROVED FOR BUILD. Three senior review passes (Pass-1 AWC: 5 blockers+6 RC; Pass-2 AWC: cap-inertia/pf-fold/missing-tables; Pass-3 delta: conditional APPROVE on 3 constant-pin/prose tighten-ups, all applied). No blockers remain.
**Owner:** Apollo. **Repo:** `Kyzcreig/siftly-ace`. **Surface:** `morning-digest` cron (and, by extension, `x-feed-brief`).
**Supersedes:** the Step-5 prose rubric in `~/.hermes/state/cron/morning-digest/prompt.md`.

---

## 1. Problem (ground-truthed, not hypothetical)

The model currently produces the **quantitative** `base_score` (1–10 per metric × weights → 0–100) in prose (prompt.md Step 5). On real data this score is **noise**:

- On the 2026-06-10 DIGEST8 pool, the model flat-rated **14 X items at exactly base 80** regardless of content quality.
- `@emollick` (real thought-leader, 249 likes, substantive routing insight) scored **base 71** — *lower* than a crypto spam bot (`@bitnewsbot`, 0 engagement) at **base 80**.
- `@yoheinakajima` (2 likes) hit **final 100** — the absolute ceiling — on a low-engagement post, because TL boost + pf stacked on an already-inflated base with no engagement reality check.

We've been patching this at the **gate** with deterministic guards (hard-discard, topic-gated boost, low-reach cap, event-dedup). Those hold the line, but the root cause remains: **the model is being asked for a number, and it is bad at numbers.** Each new failure mode needs another gate patch.

**Ace's directive (2026-06-10):** “we need a different approach for scoring posts that is more deterministic and has less room for the model. the model can give qualitative judgments but not quantitative.”

---

## 2. Design principle

> **The model classifies. Python scores.**

The model is reduced to a small set of **bounded categorical judgments** per item — things an LLM is reliable at ("is this a real launch or a hot take?", "is this actionable or just commentary?"). Python deterministically maps those categories + **objective signals** (engagement, author tier, recency, media, source) to a final 0–100 score. No free-floating 1–10 metric, no model-authored final number.

This subsumes all three current guards (they become *inputs* to the deterministic scorer, not post-hoc patches) and fixes the @yoheinakajima ceiling (engagement becomes a real term, not just an exemption).

---

## 3. The model's new job: a bounded rubric (qualitative only)

For each candidate the model emits a small JSON object with **enumerated** fields only — no numbers it invents:

```json
{
  "id": "<candidate id>",
  "content_type": "launch|benchmark|field_report|tutorial|analysis|opinion|news|promo|reply_fragment",
  "actionability": "actionable_now|reference|context_only|none",
  "substance": "concrete|mixed|vague",
  "on_topic": "core|adjacent|off",
  "event_key": "<normalized-event-slug>"
}
```

- Every field is a **closed enum** (or a slug). The model picks one label; it cannot emit "87".
- These are qualitative judgments LLMs are reliable at. `content_type=promo` / `reply_fragment` and `substance=vague` are exactly the spam/fragment signals, now produced as *labels* instead of being implicitly buried in a number.
- `event_key` stays (clustering is qualitative), but Python's distinctive-bigram pass remains the backstop (the model's event_keys are unreliable — proven 2026-06-10).

**Malformed / missing labels — fail SAFE, never silent, never fatal (a daily digest must always ship):** before lookup, Python normalizes each label (strip whitespace, lowercase, apply a small documented synonym map, e.g. `announcement→launch`, `howto→tutorial`, `review→analysis`). If a label is STILL out-of-enum, missing, or the model JSON is unparseable for an item, that item is assigned a **defined safe-default label set** — `content_type=opinion`, `actionability=context_only`, `substance=mixed`, `on_topic=adjacent` → a mid-low base (25), **not 0 (would silently bury a good post) and not a crash (would kill #daily)**. Every coercion/default is logged to the debug dump (`_label_coerced: true` + the raw vs coerced label) and increments a `label_coercion_count` counter; if that counter exceeds a threshold in a run, the cron fires a `#alerts` warning so chronic mislabeling is visible rather than rotting silently.

**Calibration burden drops to near-zero**: the prompt no longer needs the elaborate anchor/forced-distribution prose (the part the model kept ignoring). It needs clear *label definitions*, which are far more stable.

---

## 4. Python's new job: deterministic scoring

`scripts/score_digest.py` (new) computes the final score from the model's labels + objective signals. Proposed model (all constants live at the top of the file, tunable, documented):

```
final = BASE[content_type, actionability]            # categorical base (§4.1 — 36-cell table)
        + SUBSTANCE_ADJ[substance]                   # concrete +3 / mixed 0 / vague −5
        + engagement_points(likes, retweets, handle) # log-scaled, capped (§4.2; unknown cap lower)
        + author_tier_points(handle)                 # +8 TL / +6 tracked-author / 0 unknown (§4.3)
        + pf_points(personal_fit_delta)              # bounded personal-fit (§4.3a) — NOT folded away
        + recency_points(published_at)               # §4.6a table
        + media_points(has_image/video/transcript)   # §4.6b table
        − OFF_TOPIC_PEN[on_topic]                     # off → −40 (§4.5#2)
final = clamp(0, 100, final)

Committed constants (top of `score_digest.py`, all selftested): `SUBSTANCE_ADJ={concrete:+3, mixed:0, vague:−5}`, `OFF_TOPIC_PEN={core:0, adjacent:0, off:40}`.
```

### 4.1 Categorical base (replaces the 1–10×weights)
A 2-D lookup keyed by `(content_type, actionability)`. **The full table is committed (9 content_types × 4 actionabilities = 36 cells), not given by example** — an under-specified table is where the next "why 80?" lives. Cells (rows = content_type, cols = actionability `actionable_now | reference | context_only | none`):

| content_type \ actionability | actionable_now | reference | context_only | none |
|---|---|---|---|---|
| launch        | 70 | 60 | 48 | 40 |
| benchmark     | 66 | 60 | 46 | 38 |
| field_report  | 60 | 52 | 42 | 34 |
| tutorial      | 64 | 58 | 44 | 34 |
| analysis      | 56 | 50 | 40 | 30 |
| news          | 50 | 44 | 36 | 28 |
| opinion       | 40 | 34 | 25 | 18 |
| promo         | 5  | 5  | 5  | 5  |
| reply_fragment| 0  | 0  | 0  | 0  |

The selftest asserts **column monotonicity** (`launch ≥ benchmark ≥ field_report ≥ analysis ≥ news ≥ opinion ≥ promo ≥ reply_fragment` within each actionability column) and **row monotonicity** (`actionable_now ≥ reference ≥ context_only ≥ none`) so a future edit can't silently invert "a real launch beats a hot take" — that ordering is now **structural**, not a model whim. `reply_fragment × *` and `promo × *` sit below any reachable gate → effectively discarded. All 36 values live at the top of `score_digest.py`, tunable + documented.

### 4.2 Engagement as a first-class term (fixes @yoheinakajima ceiling)
`engagement_points = round(K * log10(1 + likes + retweets))` with committed **`K=6`** and **`ENGAGEMENT_CAP=15`** (known/TL handles), **`ENGAGEMENT_CAP_UNKNOWN=6`** (§4.2a). Both pinned at the top of `score_digest.py` like every other constant; tunable in shadow. A 2-like post gets ~+1; a 250-like post ~+6; a 15k-like post hits the cap. **This is the key change Ace asked for**: engagement is now a *continuous contributor*, so a genuinely low-engagement post can't reach 100 on author-tier alone — it needs the crowd. Thought-leaders still get an author-tier bump, but it's **additive and bounded**, not a multiplier that lets a 2-like tweet ceiling out.
  - **Anti-gaming (blocker, not optional):** the log curve makes *cheap* purchased engagement the most efficient (0→50 likes buys more points than 5k→10k). Two standing defenses: (a) **engagement points for UNKNOWN handles are capped lower** (`ENGAGEMENT_CAP_UNKNOWN=+6` vs `+15`), so a bot ring buying 50–200 likes on a no-name account can't convert cheap engagement into a TOP slot. **The exemption keys off AUTHORSHIP tier only** (handle ∈ thought-leaders or tracked-AUTHORS list), NOT a tracked-project *mention* in the text (today's `_matches_tracked` is a content-keyword match — spam name-drops labs, so a mention must not raise the engagement cap). Handle-tier is resolved ONCE per item and drives the hard-discard backstop, `author_tier_points`, AND the engagement cap consistently; (b) the **`low_reach_cap` stays permanently** (§4.3) as the hard floor under all of it. Optional future signal: engagement/follower ratio once follower counts are ingested (not required for v1).
  - **4.2a fresh-content floor** (timing caveat from the low-reach review): if ingest ever goes near-real-time, fresh good posts have no engagement yet. Mitigation: a small `content_type` floor — but **gated on `author_tier=thought_leader` AND `on_topic != off`** so it can't be gamed by labeling a promo as `launch` (Open-Q5). A no-name account gets no fresh-content floor. **Ships DARK for v1** (`FRESH_FLOOR_ENABLED=False`, constant=0) — current ingest is ~daily so tweets already have engagement by scoring time; this path only arms if ingest moves near-real-time, so it isn't an untested live branch in v1.

### 4.3 Author tier (additive, bounded)
`thought_leader = +8`, `tracked_project_mention = +6`, `unknown = 0`. Topic-gating from guard #2 folds in here: the TL bump only applies when `on_topic != off` (the model's label now drives it, deterministically). No more ±30-point swings.

### 4.3a Personal-fit as a bounded term (preserves the dimension, capped)
`pf_points = clamp(−PF_CAP, +PF_CAP, personal_fit_delta)` with **`PF_CAP=12`** (down from today's uncapped ~24.6). pf stays a real, continuous contributor — the @emollick substantive-routing case that depended on pf does not regress — but it can no longer single-handedly dominate the score or race the low-reach cap (the original reason the guard used a hard cap). `PF_CAP` is a tunable re-derived in shadow alongside the gates. `PF_WEIGHT=0` still makes pf_points a no-op (kill-switch preserved).

### 4.4 Single scoring authority — no double-counting (ownership boundary)
**During shadow AND the one-release backstop, `score_digest.py` is the SOLE producer of the `final` the gate (TOP_GATE/ALSO_GATE) consumes.** `select_digest.py` is rewired so `score_item()` no longer computes its own `base + pf + boost`; it consumes `score_digest.py`'s `final` and applies ONLY the downstream gate / forced-distribution / event-dedup / selection logic. The old `compute_boost` (author/tracked) is folded into `author_tier_points` and must NOT be applied a second time — a tracked author gets its bump exactly once. **Personal-fit is NOT folded away** (that would silently delete a 0–24.6-point dimension — pf is continuous, author_tier is ≤8): it survives as its **own bounded `pf_points` term** (§4.3a). The single-authority rule means `score_digest.py` applies author_tier AND pf_points exactly once each; `select_digest.py` applies neither. `low_reach_cap` runs **after** `score_digest.py` as the permanent floor-guard (§4.3), capping the already-engagement-scored `final`, never re-scoring it. Any guard not yet rewired runs in **log-only/assert mode** (computes its old value, logs disagreement vs the new `final` to the debug dump, does NOT mutate the score) until it is either folded in or retired. This is the explicit boundary: **one authority mutates the score; everything else gates, logs, or selects.**

### 4.6 Recency + media tables (committed, not by example)
- **`recency_points`** (mirrors the old prose anchors): `≤24h:+10, ≤3d:+6, ≤7d:+3, >7d:0`. Computed from `published_at`.
- **`media_points`**: `has_video_or_transcript:+4, has_image:+2, none:0` (monotonic `video ≥ image ≥ none`; selftest asserts). A transcript/OCR-enriched media item is worth slightly more than a bare image.
- Both are tunables re-derived in shadow if the distribution warrants. **Double-count guard:** the §4.2a fresh-content floor **ships dark for v1 (constant 0)** so no recency double-count is possible now. When/if armed (near-real-time ingest), it acts as a *minimum-base substitute* (raises an otherwise-engagement-starved fresh post to a floor; applies only when engagement≈0 AND thought_leader AND on_topic), NOT an additive bonus on top of `recency_points` — so it never stacks.

### 4.5 The three current guards become inputs, not patches
- **#1 hard-discard** → `content_type=reply_fragment` or `substance=vague`+`actionability=none` → base 0 → below gate. (Python still runs the bare-fragment text check as a backstop, since the model may mislabel.)
- **#2 topic-gated boost** → `OFF_TOPIC_PEN[on=off]` + TL-bump-only-when-on-topic. Memes: `on_topic=adjacent` (kept), Ace's call preserved.
- **#3 low-reach cap** → **kept PERMANENTLY as a hard floor-guard**, not retired. Engagement-as-a-term reduces how often it bites, but it is NOT obviated: removing it would hand a paid-likes lever straight into the digest. The cap (`unknown handle + engagement < floor → final ≤ LOW_REACH_SCORE_CAP`) stays as a standing defense against a label exploit (model coerced/tricked into `launch`) AND against cheap purchased engagement parking in the steep part of the log curve (see §4.2 anti-gaming). **`LOW_REACH_SCORE_CAP` is NOT the old blind-inherited constant 70 — it is committed as `LOW_REACH_SCORE_CAP = ALSO_GATE − 5` (COMPUTED from the re-derived gate, never hardcoded)**, so it always sits strictly below the gate; the new BASE table tops at 70 and ALSO_GATE drops accordingly, so a cap left at 70 would sit above the gate and bind nothing. A selftest asserts `LOW_REACH_SCORE_CAP < ALSO_GATE` so the floor-guard can never go silently inert.

---

## 5. Why this is more deterministic + less model room

| Today | After |
|---|---|
| Model emits a 0–100 number it invents | Model emits 4 enum labels |
| Calibration is elaborate prose the model ignores | Calibration is a Python lookup table |
| New failure → new gate patch | New failure → adjust a constant / a label def |
| Engagement is only an exemption | Engagement is a continuous scored term |
| Score is unauditable ("why 80?") | Score is a sum of named, logged terms |

The scorer emits a per-item **breakdown** (`{base, substance_adj, engagement, author, recency, media, off_topic_pen, final}`) into the debug dump, so every score is explainable from disk — the billing-truth / explicit-breakdown property Ace wants.

---

## 6. Migration / rollout (safe, phased)

1. **Build `score_digest.py`** with the lookup tables + selftests (mirror the incident pools: spam bot, @emollick, @yoheinakajima 2-like, Fable launch cluster — assert sane relative ordering).
2. **Shadow mode:** run the new scorer alongside the current pipeline for N days, dump both scores to the debug artifact, **don't change what posts**.
   - **Re-derive ALL range-dependent constants against the NEW score range (REQUIRED, not inherited blind):** the new BASE table tops out at 70 (vs the old flat ≈80), so the inherited `TOP_GATE=83 / ALSO_GATE=77 / MAX_GE_90=2 / MAX_EQ_100=1 / PF_CAP` are wrong by construction, and the **OLD** `LOW_REACH_SCORE_CAP` of 70 is likewise dead — replaced by the computed `ALSO_GATE − 5` (selftest enforces `< ALSO_GATE`) — they'd either empty the digest (load-bearing #daily breaks) or re-inflate it. The shadow artifact dumps the new-score distribution; pick new gates so the new pipeline produces the **same digest cardinality** (≈MAX_TOP top + MAX_ALSO also) on the incident pools + shadow corpus as today. Gates ship **with** the cutover as tunables, never as inherited constants.
   - **Compare against a FROZEN GOLD SET, not by eyeballing** (see §6a). No flip until the numeric bar in §6a is met.
3. **Cutover** (config-gated, Ace approves): swap Step 6.7 to consume `score_digest.py` output; the model prompt shrinks to the label rubric. Keep the existing guards as backstops for one release.
4. **Retire** the Step-5 prose rubric + the now-redundant guard logic once shadow data + a live week confirm parity-or-better.

Each phase is reversible. **The cutover is TWO distinct Hard-Config-Rules edits** to `~/.hermes/state/cron/morning-digest/prompt.md`, each diff→backup→approve→verify: (1) the **prompt** change (Step-5 prose rubric → the bounded label rubric) and (2) the **gate-constant** change (new TOP_GATE/ALSO_GATE/distribution). Surface both diffs to Ace together but call them out as separate privileged changes (Open-Q3).

### 6a. Shadow gate — frozen gold set + objective comparator (makes "≥ current" measurable)
"≥ current ranking" is only meaningful against a **pre-registered, versioned-in-repo gold set** (`docs/eval/digest-gold-set.json`): the incident pools (spam bot, @emollick, @yoheinakajima 2-like, Fable launch cluster) PLUS a sampled ~200-item window hand-labeled `known_good | known_bad | neutral` (labeling owner = Ace; Apollo pre-labels, Ace ratifies — Open-Q2). Cutover is **blocked** until, across all N shadow days:
- **zero `known_bad` items land in the TOP set**, AND
- **every `known_good` item scores ≥ the (re-derived) ALSO_GATE**, AND
- **top-5 set-overlap with the human-ideal TOP ≥ 0.8 (4 of 5)**, AND
- **new gates reproduce current digest cardinality** (≈MAX_TOP+MAX_ALSO) on the shadow corpus.

**Gold-set label semantics (Open-Q1):** `known_good` = items whose IDEAL placement is TOP or ALSO (not "every benign post"); a correctly-labeled `opinion×context_only` low-value-but-fine post is `neutral`, not `known_good`, so the "every known_good ≥ ALSO_GATE" bar isn't unsatisfiable by construction. `neutral` items must simply NOT appear in TOP and carry no ordering constraint. `known_bad` = spam/fragment/off-topic that must never reach TOP.

These are the literal acceptance gates (mirrored in §7). If any fails, tune constants/labels and re-run shadow — do not cut over.

---

## 7. Acceptance criteria

- [ ] `score_digest.py` is pure + selftested; the incident pools rank correctly (spam < @emollick; @yoheinakajima 2-like cannot reach 100; Fable launch collapses to one).
- [ ] **BASE table fully enumerated (36 cells)**; selftest asserts row+column monotonicity (§4.1).
- [ ] Engagement is a continuous term (proven: identical-label items rank by engagement) **and capped lower for unknown handles** (anti-gaming, §4.2); `low_reach_cap` retained permanently (§4.3).
- [ ] **Malformed/missing labels never crash and never silently zero a post** — coerced→safe-default (base 25), logged + counted, `#alerts` over threshold (§3).
- [ ] **Single scoring authority:** `score_digest.py` produces the `final` the gate consumes; no author/tracked/pf bump applied twice; unrewired guards run log-only (§4.4).
- [ ] **Personal-fit survives as a bounded `pf_points` term (PF_CAP, §4.3a)** — not silently deleted; @emollick case does not regress; `PF_WEIGHT=0` still no-ops.
- [ ] **`LOW_REACH_SCORE_CAP` re-derived strictly below ALSO_GATE** (selftest asserts `< ALSO_GATE`); cap is not the blind-inherited 70 (§4.3, §6).
- [ ] **All range constants committed + tabulated:** SUBSTANCE_ADJ, OFF_TOPIC_PEN, recency_points, media_points (monotonicity selftested); no term referenced-but-undefined (§4.6).
- [ ] **Engagement-cap exemption keys off authorship tier only**, not a tracked-project mention; handle-tier resolved once (§4.2).
- [ ] **Fresh-content floor ships dark for v1** (`FRESH_FLOOR_ENABLED=False`) (§4.2a).
- [ ] Model output is **labels only** — no invented numbers anywhere in the path.
- [ ] Every final score has a logged term-by-term breakdown in the debug dump.
- [ ] **Gates re-derived** against the new score range so cutover reproduces current digest cardinality (§6 step 2).
- [ ] **Frozen gold set** (`docs/eval/digest-gold-set.json`, Ace-ratified) exists; shadow passes the §6a objective bar (zero known_bad in TOP, all known_good ≥ ALSO_GATE, top-5 overlap ≥ 0.8, cardinality parity) across all N days.
- [ ] Cutover executed as **two** separate Hard-Config edits (prompt + gates), each diff→backup→approve→verify.
- [ ] 2-pass Opus review APPROVE; live-verified end-to-end; docs + Obsidian + mem0 updated.

---

## 8. Open questions for Ace

1. **Shadow duration** before cutover — how many days of parallel scoring do you want to see? (proposed: 5–7.)
2. **Engagement weighting** — how hard should the crowd count vs. author tier? (the log curve + caps are tunable; I can mock 2–3 curves on the real corpus for you to pick.)
3. **Floor for fresh content** (4.2a) — keep a `content_type` floor so a brand-new launch from a known handle isn't buried for having 0 engagement yet? (recommended: yes.)
4. **Scope** — morning-digest only first, then port to `x-feed-brief`? (recommended: yes, prove on one surface.) **Confirm whether `x-feed-brief` shares this `prompt.md`/scoring path or a parallel copy** (Open-Q4) — if shared, cutover hits two surfaces at once.

---

## 9. Pass-1 review resolution map (senior review, claude-bridge-f2/Opus, APPROVE-WITH-CHANGES)
| # | Blocker | Resolution |
|---|---|---|
| B1 | "≥ current" unmeasurable; shadow can't gate | §6a frozen gold set + 4 objective numeric bars; §7 mirrors them |
| B2 | Double-scoring between new scorer + old guards | §4.4 single-authority boundary; no bump applied twice; unrewired guards log-only |
| B3 | Gates calibrated on OLD distribution | §6 step-2 re-derives gates against new range; cardinality-parity acceptance |
| B4 | No fail-open/closed for malformed labels | §3 normalize→safe-default(base 25)→log+count→`#alerts`; never crash, never silent-zero |
| B5 | Log-curve engagement gameable; low_reach_cap removed | §4.2 unknown-handle engagement cap +6; §4.3 low_reach_cap kept PERMANENTLY |
| RC6 | BASE table specified by example only | §4.1 full 36-cell table + monotonicity selftest |
| OQ3 | prompt vs gate = one or two privileged edits | §6: explicitly TWO Hard-Config edits |
| OQ5 | fresh-content floor a new gaming vector | §4.2a floor gated on thought_leader + on_topic, ships DARK v1 |

### Pass-2 resolution map (claude-bridge-f2/Opus, APPROVE-WITH-CHANGES — verified prior fixes, caught fix-induced issues)
| # | Issue | Resolution |
|---|---|---|
| P2-NI1 | `LOW_REACH_SCORE_CAP=70` inert vs new 70-ceiling table / lower ALSO_GATE | §4.3+§6 re-derive cap strictly < ALSO_GATE; selftest asserts |
| P2-NI2 | "fold pf_delta into author_tier" silently deletes a 24.6-pt dimension | §4.3a pf_points as own bounded term (PF_CAP=12); §4 formula now includes it |
| P2-NI3 | engagement-cap exemption conflated tracked-author vs tracked-mention | §4.2 exemption = authorship tier only; handle-tier resolved once |
| P2-OQ2/3 | media_points / recency_points referenced but never tabulated | §4.6 full tables + monotonicity selftest + double-count guard |
| P2-OQ1 | gold-set "every known_good ≥ ALSO_GATE" could be unsatisfiable | §6a label semantics: known_good = ideal-TOP/ALSO only; neutral has no floor |
| P2-OQ4 | fresh-floor an untested live path in v1 | §4.2a ships dark (FRESH_FLOOR_ENABLED=False) until ingest goes real-time |

**Pass-2 verdict:** B1/B2/B4/RC6 RESOLVED; B3/B5 were PARTIAL (cap left at old 70) → re-derived the cap with the gates; pf preserved as bounded term; tables committed.

**Pass-3 delta (conditional APPROVE for build):** pf RESOLVED; cap-relation + media/recency tables RESOLVED. Three non-blocker tighten-ups applied: (1) `LOW_REACH_SCORE_CAP = ALSO_GATE − 5` committed (computed, not hardcoded; bare "70" scrubbed to old-wrong-value); (2) `K=6`, `ENGAGEMENT_CAP=15` committed at top of scorer; (3) fresh-floor double-count prose de-linted (dark v1 / minimum-base-substitute when armed). Reviewer: "Pin the two missing constant values and de-lint the fresh-floor prose, then this is APPROVE for build." Done → **APPROVED FOR BUILD.**
