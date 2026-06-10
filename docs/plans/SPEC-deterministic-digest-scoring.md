# SPEC — Deterministic Digest Scoring (model = qualitative only)

**Status:** DRAFT — specced 2026-06-10, not yet built. Needs Ace review → review pipeline → swarm/build.
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

**Calibration burden drops to near-zero**: the prompt no longer needs the elaborate anchor/forced-distribution prose (the part the model kept ignoring). It needs clear *label definitions*, which are far more stable.

---

## 4. Python's new job: deterministic scoring

`scripts/score_digest.py` (new) computes the final score from the model's labels + objective signals. Proposed model (all constants live at the top of the file, tunable, documented):

```
final = BASE[content_type, actionability]            # categorical base, e.g. a lookup table
        + SUBSTANCE_ADJ[substance]                   # concrete +, vague −
        + engagement_points(likes, retweets, source) # log-scaled, capped
        + author_tier_points(handle)                 # thought-leader / tracked / unknown
        + recency_points(published_at)               # today=full … old=0
        + media_points(has_image/video/transcript)   # small bump for enriched media
        − OFF_TOPIC_PEN[on_topic]                     # off → large penalty
final = clamp(0, 100, final)
```

### 4.1 Categorical base (replaces the 1–10×weights)
A 2-D lookup keyed by `(content_type, actionability)`. E.g. `launch × actionable_now = 70`, `opinion × context_only = 25`, `promo × * = 5`, `reply_fragment × * = 0` (→ hard-discarded). This is where "a real launch beats a hot take" becomes **structural**, not a model whim.

### 4.2 Engagement as a first-class term (fixes @yoheinakajima ceiling)
`engagement_points = round(K * log10(1 + likes + retweets))`, capped at e.g. +15. A 2-like post gets ~+1; a 250-like post ~+6; a 15k-like post hits the cap. **This is the key change Ace asked for**: engagement is now a *continuous contributor*, so a genuinely low-engagement post can't reach 100 on author-tier alone — it needs the crowd. Thought-leaders still get an author-tier bump, but it's **additive and bounded**, not a multiplier that lets a 2-like tweet ceiling out.
  - Open question (4.2a): the timing caveat from the low-reach review still applies — if ingest ever goes near-real-time, fresh good posts have no engagement yet. Mitigation: a small `content_type`-based floor (a labeled `launch`/`benchmark` from a known handle gets a minimum base even at 0 engagement) so freshness isn't fatal.

### 4.3 Author tier (additive, bounded)
`thought_leader = +8`, `tracked_project_mention = +6`, `unknown = 0`. Topic-gating from guard #2 folds in here: the TL bump only applies when `on_topic != off` (the model's label now drives it, deterministically). No more ±30-point swings.

### 4.4 The three current guards become inputs, not patches
- **#1 hard-discard** → `content_type=reply_fragment` or `substance=vague`+`actionability=none` → base 0 → below gate. (Python still runs the bare-fragment text check as a backstop, since the model may mislabel.)
- **#2 topic-gated boost** → `OFF_TOPIC_PEN[on=off]` + TL-bump-only-when-on-topic. Memes: `on_topic=adjacent` (kept), Ace's call preserved.
- **#3 low-reach cap** → mostly **obviated** by engagement being a real term (a 0-reach unknown can't accumulate enough points), but keep the hard cap as a cheap floor-guard against a future label exploit.

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
2. **Shadow mode:** run the new scorer alongside the current pipeline for N days, dump both scores to the debug artifact, **don't change what posts**. Compare: does the deterministic score rank the known-good/known-bad items correctly? (This is the empirical, ground-truth-first step — no flip until the data says it's better.)
3. **Cutover** (config-gated, Ace approves): swap Step 6.7 to consume `score_digest.py` output; the model prompt shrinks to the label rubric. Keep the existing guards as backstops for one release.
4. **Retire** the Step-5 prose rubric + the now-redundant guard logic once shadow data + a live week confirm parity-or-better.

Each phase is reversible; the cutover is a Hard-Config-Rules change to `prompt.md` (diff → backup → approve → verify), exactly like the guards.

---

## 7. Acceptance criteria

- [ ] `score_digest.py` is pure + selftested; the incident pools rank correctly (spam < @emollick; @yoheinakajima 2-like cannot reach 100; Fable launch collapses to one).
- [ ] Engagement is a continuous term (proven: identical-label items rank by engagement).
- [ ] Model output is **labels only** — no invented numbers anywhere in the path.
- [ ] Every final score has a logged term-by-term breakdown in the debug dump.
- [ ] Shadow-mode data over ≥N days shows the deterministic ranking is ≥ the current one on known-good/known-bad items.
- [ ] 2-pass Opus review APPROVE; live-verified end-to-end; docs + Obsidian + mem0 updated.

---

## 8. Open questions for Ace

1. **Shadow duration** before cutover — how many days of parallel scoring do you want to see? (proposed: 5–7.)
2. **Engagement weighting** — how hard should the crowd count vs. author tier? (the log curve + caps are tunable; I can mock 2–3 curves on the real corpus for you to pick.)
3. **Floor for fresh content** (4.2a) — keep a `content_type` floor so a brand-new launch from a known handle isn't buried for having 0 engagement yet? (recommended: yes.)
4. **Scope** — morning-digest only first, then port to `x-feed-brief`? (recommended: yes, prove on one surface.)
