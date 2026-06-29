# SPEC — Scorer Junk-Label Backstop (crypto / promo / scam / foreign-clickbait)

**Status:** v3 — Opus pass-1 (BLOCK→folded) + pass-2 (APPROVE-WITH-CHANGES, converged) folded · ready
for owner go-ahead · **Author:** Apollo · **Date:** 2026-06-28
**Owner sign-off required before build** (touches the LIVE deterministic scorer + both brief prompts — gated).
**Repo:** `~/Projects/siftly-ace` · **Coding worker:** Daedalus (gpt-5.5 xhigh)
**Companion:** extends `SPEC-label-trust-backstops.md` (Backstops 1–3) → this adds **Backstop 4**.

### Pass-2 convergence resolution (what changed in v3)
- **P2-B1 clamp arithmetic** → §5.2 pins the clamp as the **LAST** write to `final`, after EVERY
  additive term (PF + author + recency + media); then `DEMOTE_CEILING = ALSO_GATE − 1` is provably
  below-gate. Gate inclusivity pinned (ALSO_GATE is a `>=` floor → ceiling at `ALSO_GATE − 1` is strictly
  below). AC-1 adds a max-envelope selftest.
- **P2-B2 holdout independence** → Phase 0: Argus labels the **FULL holdout pool's clean set** (not just
  the author's pre-flagged subset), and the precision gate runs against the *reconciled independent*
  labels; holdout **size + junk count + near-miss count reported** (a holdout with no near-misses is
  decorative).
- **`promo` route dropped** → clamp + `on_topic→off` is the whole guarantee; the `ct→promo` mutation path
  is removed unless a concrete clamp-alone-insufficient item is produced (none expected). Kills the
  per-pool `_promo_lowers` hazard entirely.
- **INV-5 pool-mean coupling** → scoped to **"no non-junk item changes slot/selection"** for the
  PF-affected field (demoting 11 items legitimately shifts `pool_mean_embed`); byte-identical retained
  only for the per-item terms. AC-3 rewritten so it can't fail on correct behavior.
- **foreign-clickbait by SCRIPT CLASS** → measured by Unicode script class, not byte-ASCII ratio (a
  Turkish/Vietnamese/Indonesian Latin-diacritic AI post must not trip it — added near-miss).
- **AC-8 fires on a `core`-labeled item** → the live proof must show B4 demoting an item the MODEL
  labeled `core` (the actual mislabel class), not merely any firing.
- `JUNK_DEMOTE_ALERT_N` baseline stated (§7).

### Pass-1 review resolution (carried from v2)
- **B-1 train==test** → held-out 2nd-day fixture + Argus independent labels (the same-day pool is tune).
- **B-2 INV-1 by construction** → monotonic clamp (now pinned as last op, P2-B1).
- **B-3 byte-stability** → all-234 oracle; INV-5 pool-relative-aware (now slot-scoped, P2-B2/INV-5).
- **B-4 text-field skew** → §5.0 field contract pinned; morning+x-feed fixtures; truncation selftest.
- scam-grant re-scoped to scam shape; lone `$TICKER` never fires; demotion-rate watchdog + per-signal
  kills; PF-relift closed.

---

## 1. Summary & Goal

**Problem (ground-truthed, today's real morning pool).** The deterministic scorer trusts the model's
4 enum labels (`content_type`, `actionability`, `substance`, `on_topic`). The model is **mislabeling
non-AI junk as `core` AI content** with high content-type labels, so it scores 83–91 and floats to the
TOP of the pool — polluting the overview and threatening the ranked Top Stories. Measured: **11 / 234
items (~4.7%) the model labeled `on_topic=core` are actually crypto-shilling, scam "FREE API GRANT"
posts, or foreign-language clickbait**, and they occupy the **highest score band** (the #1, #4, #6, #9
stories by score today were a crypto Kickstarter at 91, "$COIN U.S." at 89, an Urdu clickbait at 87, a
"🔥 WEEKLY MARKET RECAP 🟠BTC" at 87).

**Why the existing guard misses them.** `python_on_topic()` (Backstop 2) only forces `off` when the
text has a politics/insult marker, a github off-topic repo marker, **or ZERO on-topic tokens.** These
junk posts *mention AI* ("Tech Giants Embracing Chinese **AI Models**", "Mecha Comet … **AI**") so they
carry on-topic tokens → the guard short-circuits and the model's `core` label stands. There is no
detector for **"mentions AI but is actually crypto/promo/scam/foreign-clickbait."**

**Goal.** Add a conservative, **high-precision** deterministic Backstop 4 that demotes obvious junk the
model mislabels — same proven pattern as Backstops 1–3 (only ever DOWNGRADES, never upgrades; fully
audited in the breakdown) — **plus** sharpen the labeling rubric in both brief prompts so the model
labels these `off`/`promo` in the first place (defense in depth). Target: the junk that scored 83–91
today scores **below ALSO_GATE** (post personal-fit) and never appears in Top/Also or as a top overview
story, **with zero demotion of legitimate AI content** — proven on a held-out day, not the tuning day.

**Non-negotiable framing:** precision over recall. A false demotion (killing a real AI story) is worse
than a false miss (one crypto post slips through). Backstop 4 fires ONLY on high-confidence junk, and
the precision gate is measured **out-of-sample**.

## 2. Non-Goals

- **NOT** rewriting the scoring model, the BASE table, gates, or the personal-fit pipeline. The math is
  correct; only the *labels feeding it* are wrong.
- **NOT** a general-purpose spam classifier or an ML model. Deterministic, token/regex-based, auditable.
- **NOT** translating or re-ranking foreign-language content — foreign-language items that are genuinely
  on-topic AI (e.g. a Japanese LLM-news roundup) are NOT junk; the foreign-clickbait signal must be
  **clickbait-specific**, not "non-English" (see Risk R-1).
- **NOT** touching the off-topic *political/insult* guard (OFF_TOPIC_MARKERS) — that stays as-is.
- **NOT** demoting legitimate company programs (free API credits, hackathon grants, real product
  launches, AI-infra equity/earnings discussion) — these are core AI news (see B-2/B-4 near-misses).
- **NOT** changing reddit/github/HN handling — Backstop 4 is curated-source-exempt (INV-3).

## 3. Constitution / Invariants

- **INV-1 (downgrade-only, BY CONSTRUCTION — the clamp is the LAST operation).** Backstop 4's effect is
  a **monotonic score clamp applied as the final write to `final`**, after EVERY additive term (BASE,
  substance, engagement, author, **personal-fit**, recency, media) and the existing 0–100 clamp:
  `final = min(final, DEMOTE_CEILING)`. Because nothing is added after it, it is structurally incapable
  of being re-lifted. `DEMOTE_CEILING = ALSO_GATE − 1` (ALSO_GATE is a `>=` floor, so `−1` is strictly
  below-gate). The label routing is `on_topic→off` only (the `promo` route is dropped — P2). 
  - *Closeout proof:* (a) grep shows the clamp is the last assignment to `final` in `score_item`;
    (b) a selftest that adds the MAX of every additive term (PF_CAP + max author + max recency + max
    media) to a demoted item and asserts it still `< ALSO_GATE`; (c) over the all-234 pool,
    `final_with <= final_without` ∀.
- **INV-2 (precision = 1.0 on a HELD-OUT pool — not the tuning pool).** The same-day 234-item pool is the
  **tune set**. The ship-gate is precision = 1.0 measured on a **second, independently-labeled day's
  pool** (the holdout, ratified in Phase 0). 0 false demotions on the holdout is the binding gate. The
  holdout's **size, junk count, and near-miss count are reported** — a holdout with no near-misses or a
  trivial junk count is decorative and does NOT satisfy the gate.
  - *Closeout proof:* `score_digest.py --selftest` runs the holdout fixture; demoted∩(reconciled-non-junk)
    = ∅. A non-1.0 holdout precision is a NO-GO (surface, don't relabel-to-green — gold-set-eval-gates D-8).
- **INV-2b (oracle independently verified over the FULL clean set).** **Argus** (the fleet QA verifier,
  `~/.hermes/scripts/argus-judge.sh`) independently labels the **entire holdout pool — including its
  clean set, not just the author's pre-flagged subset** (P2-B2: Argus must see the clean items, or it can
  only confirm true positives and is structurally blind to the false positives the gate exists to catch).
  Disagreements are reconciled on record before ratification; the precision gate runs against the
  reconciled independent labels.
  - *Closeout proof:* the Argus verdict file (full-holdout labels) is committed under `docs/plans/`; the
    ratified label set matches the reconciliation.
- **INV-3 (curated-source exemption preserved).** Backstop 4 reuses the EXACT existing helper
  `is_topic_curated_source(item)` + the github-trending exemption — never a parallel copy.
  - *Closeout proof:* grep shows B4 calls `is_topic_curated_source`; selftest with a curated-sub item
    containing a `$TICKER` token → not demoted.
- **INV-4 (audit trail, both fire-and-miss).** Every B4 firing records `junk_backstop: <reason>` in the
  item `_breakdown`. A clean item gets **NO new breakdown key**. A B2∩B4 item records B2's reason AND
  `junk_backstop`.
  - *Closeout proof:* selftest asserts the key on a demoted item, ABSENCE on a clean item, both on a
    B2∩B4 item.
- **INV-5 (non-junk integrity — per-item byte-identical, pool SLOT-stable).** Every item B4 does NOT
  demote: its **per-item score terms** (BASE/substance/engagement/author/recency/media + breakdown) are
  byte-identical to today. The pool-relative fields (fused PF, which centers on `pool_mean_embed`,
  changes when 11 items leave the pool) are NOT required byte-identical — instead the invariant is **no
  non-junk item changes its selection SLOT** (Top/Also membership + overview top-story placement).
  Demoting junk legitimately shifts the PF mean; that's correct behavior, not a regression (P2-B2 closes
  the pass-1 "AC-3 fails on correct behavior" reintroduction).
  - *Closeout proof:* `rescore_diff.py` shows per-item terms byte-identical for all non-junk; the
    `pool_mean_embed` delta is reported (ppm); and the before/after Top/Also + overview top-stories slot
    assignment for non-junk items is unchanged. gold-set 4/4 green.
- **INV-6 (kill-switch, global + per-signal).** `SIFTLY_JUNK_BACKSTOP=0` disables B4 entirely;
  `SIFTLY_JUNK_BACKSTOP_SIGNALS=crypto,scam` (or `-foreign`) toggles individual signals.
  - *Closeout proof:* selftests for global-off and single-signal-off.

## 4. Resolved Decisions

- **D-1 — Two layers, defense in depth.** Fix BOTH the prompt labeling rubric AND the deterministic
  Backstop 4. The deterministic guard is load-bearing; the prompt is the cheaper first line. *(Ace:
  "deterministic guard owns the outcome, prose assists" + "BOIL THE OCEAN".)*
- **D-2 — Precision over recall (hard rule).** B4 demotes only on high-confidence signals. Borderline
  items are LEFT ALONE. The precision gate is **out-of-sample** (INV-2).
- **D-3 — Demotion = monotonic clamp + `on_topic→off`** (reusing OFF_TOPIC_PEN["off"]=40). The
  `content_type→promo` route is used ONLY for scam-grant/kickstarter AND ONLY if it provably lowers BASE
  (INV-1); otherwise the clamp + `off` carries it. The clamp `DEMOTE_CEILING` guarantees the item lands
  below ALSO_GATE **even after a +12 personal-fit lift** (B-1/PF-relift fix): `DEMOTE_CEILING = ALSO_GATE
  - PF_CAP - 1` so a high-affinity crypto post can't be re-lifted over the gate.
- **D-4 — Foreign-language is NOT itself a junk signal.** foreign-clickbait demotes only on non-Latin-
  dominant AND no on-topic AI token (incl. romanized model names: an explicit list — gpt/claude/llm/
  gemini/qwen/llama/mistral/grok/deepseek/…) AND a clickbait shape. ASCII-ratio threshold is a NAMED
  constant with a boundary test (emoji counted correctly so an emoji-heavy *English* builder post never
  trips it).
- **D-5 — Where B4 lives.** `score_digest.py` `is_junk_label(item) -> (reason|None)`, called in
  `score_item()` after Backstop 2, before BASE lookup. Pure, selftested. All thresholds/patterns in a
  single sourced constant block (`JUNK_*`), mirroring the `REDDIT_LOW_SIGNAL_*` house pattern.
- **D-6 — Two fixtures: tune (today) + holdout (a 2nd day).** Today's 234-item pool is the tune set
  (full 234 labeled, not just the 83+ band). A second day's pool is captured + independently labeled as
  the **holdout precision gate**. Both drawn so the fixtures carry the EXACT field B4 reads (B-4).
- **D-7 — Field contract pinned (B-2/f1).** B4 reads `tweet_text` (full body, NOT a truncated snippet)
  with `title`/`summary` fallback for non-tweets, and `source`/`url` for the curated check — identical
  under both brief shapes (the divergent part is `signals`, which B4 does NOT read). §5.0 specifies it;
  a selftest fails if the fixture text is truncated.

## 5. Architecture / Design

### 5.0 Input field contract (B-2/B-4 — pinned)

`is_junk_label(item)` reads ONLY these keys (present + identically-shaped in both brief dumps):
- **text** = `item["tweet_text"]` (full, untruncated) → fallback `item["title"]`+`" "`+`item["summary"]`
  for non-tweets. NEVER the ≤120-char pf-audit `text_snippet`. A selftest asserts the fixture's text
  field length matches the live dump's (catches a truncated-fixture skew).
- **source** = `item["source"]`, **url** = `item["url"]` → for `is_topic_curated_source` (INV-3).
- It does **NOT** read `signals` (the field that diverges morning vs x-feed), so the contract is
  shape-independent. Verified against one real morning dump AND one real x-feed dump (fixtures from both).

### 5.1 Detection signals (high-precision, corroboration-gated)

Returns a reason (→ demote) or `None`. Checked in order; first match wins. **Curated-exempt first.**

1. **`crypto-ticker`** — a `$TICKER` cashtag (`\$[A-Z]{2,6}\b`) **AND** a crypto-context corroborator
   (`crypto`, `airdrop`, `presale`, `NFT`, `pump`, `to the moon`, `market recap`, `🟠/🟢` candle,
   BTC/ETH/SOL in price context); OR ≥2 such corroborators with no cashtag. **A lone cashtag NEVER
   fires** (so `$NVDA`/`$GOOGL`/`$AMD` in an AI-infra/earnings thread is KEPT — mandatory near-miss).
2. **`scam-grant`** — scam *SHAPE*, not the benign words (B-2): requires the engagement-bait combination
   — `DM me`/`DM for` + (`link in bio`/t.co-link + no real org handle) + hype (ALLCAPS run or 🔥/🚀
   emoji), OR an impersonation pattern (`[FREE … API/GRANT] 🔥`-style bracketed-hype). A plain
   "Anthropic announces free API credits for students" / "hackathon grants open" / "limited spots,
   apply" from a real org does NOT fire (mandatory near-misses).
3. **`kickstarter-promo`** — crowdfunding shill (`kickstarter`, `indiegogo`, `back this`, `raised $Nk in
   N hours`) WITHOUT substantive AI-build content. A real "we open-sourced our AI tool, also on
   Kickstarter" with build substance is KEPT (corroboration: no AI on-topic token in the same post).
4. **`foreign-clickbait`** — measured by **Unicode SCRIPT CLASS** (not byte-ASCII ratio, P2): the
   dominant script of the letters is non-Latin (CJK/Arabic/Cyrillic/Devanagari/…) — so a Turkish/
   Vietnamese/Indonesian Latin-diacritic AI post does NOT count as non-Latin — AND no on-topic AI token
   anywhere (incl. the romanized-model list, D-4) AND a clickbait shape (excessive `=`/`#`/emoji runs,
   listicle `[N/M]`, hype markers). A CJK/Arabic/Urdu AI roundup containing "GPT"/"LLM"/model names is
   KEPT (mandatory near-miss). Emoji are excluded from the script-class tally.

Each predicate is a named function with positive + negative + boundary selftests. The corroboration
requirements are what buy precision.

### 5.2 Insertion into `score_item()` (downgrade-only — clamp is the LAST op)

```
# ── Backstop 4: junk-label demotion (crypto/scam/promo/foreign-clickbait) ──
junk_reason = None
if _b4_enabled() and not is_topic_curated_source(item):     # INV-3, reuse existing helper
    junk_reason = is_junk_label(item)                        # honors per-signal toggles (INV-6)
    if junk_reason:
        eff_on_topic = "off"                                 # OFF_TOPIC_PEN["off"] = max penalty
# ... ALL existing additive arithmetic (base + substance + engagement + author + PF + recency + media,
#     the OFF_TOPIC_PEN subtraction, and the existing 0–100 clamp) runs here ...
final = max(0.0, min(100.0, float(pre)))
# Clamp is the FINAL write to `final` — after every additive term incl. PF (P2-B1). Nothing is added
# after it, so a demoted item can NEVER be re-lifted over the gate by PF/author/recency/media.
if junk_reason:
    final = min(final, DEMOTE_CEILING)                       # DEMOTE_CEILING = ALSO_GATE - 1
    breakdown["junk_backstop"] = junk_reason                 # key only on demoted items (INV-4/INV-5)
```

`DEMOTE_CEILING = ALSO_GATE − 1` is provably below the `>=` ALSO_GATE floor regardless of how large the
additive envelope is, because the clamp is the last operation. The `content_type→promo` route from v2 is
**removed** (P2): `on_topic→off` + the clamp is the entire guarantee, and dropping the `ct` mutation
eliminates the per-pool `_promo_lowers` hazard. Clean items take neither the label change, the clamp, nor
the breakdown key (per-item byte-stable, INV-5).

### 5.3 Prompt rubric sharpening (both briefs) — unchanged from v1, plus:
- Add the same junk-label rules + a concrete ❌/✅ example block to BOTH `morning-digest/prompt.md` and
  `x-feed-brief/prompt.md`. Snapshot to `deploy/cron-prompts/`.
- **The two briefs' rubric text must be identical** (config-drift): AC-6 diffs morning-vs-x-feed rubric
  blocks AND each-vs-mirror.

## 6. Implementation Phases

- **Phase 0 — Oracle: independent labels + held-out fixture (the gate's foundation).**
  Snapshot today's full 234-item pool AND a second day's pool to
  `scripts/__tests__/fixtures/`. Label ALL items in both (junk/near-miss/clean), then run **Argus**
  (`argus-judge.sh`) as an independent labeler over the seed-11 + near-miss set; reconcile disagreements
  on record (commit the verdict). Today = tune; 2nd day = **holdout precision gate**.
  - *Unit/script check:* both fixtures parse; every allowlist id exists; the Argus verdict is committed.
  - *Negative/adversarial:* near-miss set MUST include — a real free-API-credit/grant announcement; a
    `$NVDA earnings in an AI-infra thread`; a CJK/Urdu AI roundup with model names; a **Turkish/
    Vietnamese Latin-diacritic AI post** (high non-ASCII bytes, Latin script — must NOT trip
    foreign-clickbait); an emoji-heavy ENGLISH builder post; a real AI product on Kickstarter. None may
    be demoted.
  - *Evals:* holdout precision = 1.0 is the binding gate (INV-2); tune-set recall reported (D-2).
  - *Verify with:* `--selftest` Phase-0 block + the committed Argus verdict file.

- **Phase 1 — `is_junk_label()` + field contract + signal predicates (§5.0/5.1).** Pure functions,
  sourced constant block, per-signal selftests incl. boundary tests + the truncation-skew test.
  - *Unit/script check:* per-signal positive/negative/boundary; field-contract truncation selftest.
  - *Negative/adversarial:* lone `$NVDA` does NOT fire; real free-credit announcement does NOT fire;
    curated-sub crypto crosspost is exempt; emoji-heavy English post is not foreign-clickbait.
  - *Verify with:* `--selftest`.

- **Phase 2 — Wire into `score_item()` + clamp + breakdown + kill-switches (§5.2).**
  - *Unit/script check:* incident items (velonxbt/gulVasikova/papiano) score `< ALSO_GATE` **post-PF**;
    breakdown carries `junk_backstop`; clean item has no such key; idempotent re-score is a no-op.
  - *E2E/integration check:* `rescore_diff.py` over the all-234 pool: (a) demoted set ⊆ oracle junk;
    (b) every non-junk item byte-identical incl. breakdown (INV-5); (c) `final_with <= final_without`
    ∀ (INV-1); (d) re-run pool-relative stages (PF mean, author-cap, overview top-stories) → no
    non-junk slot change.
  - *Negative/adversarial:* `SIFTLY_JUNK_BACKSTOP=0` → empty demoted set; single-signal-off works.
  - *Evals:* holdout precision=1.0 (INV-2); gold-set 4/4 green.
  - *Verify with:* `npm run verify` + `rescore_diff.py`.

- **Phase 3 — Prompt rubric (both briefs) + snapshot + drift check.**
  - *Unit/script check:* grep both live prompts for the rule sentinel; diff morning-vs-x-feed rubric
    block (must match); diff each live vs its deploy mirror.
  - *Verify with:* the grep + diffs.

- **Phase 4 — Observability: demotion-rate watchdog + recall-hole audit (§7).**
  - *Unit/script check:* the watchdog fires a #alerts notification when a run's B4 demotion count
    exceeds `JUNK_DEMOTE_ALERT_N` (baseline + headroom); the weekly audit line lists top-band
    model-`core` items for recall visibility.
  - *Verify with:* a forced over-threshold fixture → alert fires (captured, not sent).

- **Phase 5 — Live runs (both briefs), backstop-proven.** Force-run morning AND x-feed once.
  - *Verify with:* each posted overview + Top Stories carry no crypto/scam/foreign-clickbait; the debug
    dump shows **≥1 `junk_backstop` firing** (proves the deterministic layer fired, not just that the
    prompt happened to label right — B-3/f1); heartbeat clean.

## 7. Security, Privacy, Ops, Observability

- No new credentials, no network, no public posting changed. Pure scoring-layer + prompt edits.
- **Observability (two guards, per Ace's "add a LOUD guard so the class can't silently recur"):**
  1. **Demotion-rate watchdog** — if a run's B4 firing count exceeds `JUNK_DEMOTE_ALERT_N` (baseline:
     today's tune set demotes ~11/234 ≈ 5%; alert threshold = **max(8, 2× the trailing-7-day median
     count)** so a sudden over-demotion spike — B4's inverse "silently kills real items" failure, the
     "green for 11 days" trap — fires a #alerts notification). Routed via the existing fleet alert path.
  2. **Recall-hole audit** — a weekly heartbeat line listing the top-band (≥83) items the model labeled
     `core` that B4 did NOT demote, so the recall gap (D-2) stays visible instead of silently growing.
  - Every demoted item's `junk_backstop` reason is in the breakdown; `rescore_diff.py` is the audit tool.
- **Rollback:** `SIFTLY_JUNK_BACKSTOP=0` (global) or per-signal toggle (runtime, no deploy);
  `git revert` the prompt edits (backed up `.bak.*-pre-junk-backstop`). Reversible in seconds.
- **Blast radius:** scoring-only; INV-1 makes B4 structurally incapable of promoting junk — worst case
  it hides a real story, caught by the out-of-sample precision gate + the near-miss fixtures + the
  demotion-rate watchdog.

## 8. Risks & Mitigations

- **R-1 (false demotion of legit foreign / fintech-AI / grant content) — the main risk.** Mitigation:
  corroboration-gated signals (lone cashtag never fires; scam-grant needs scam shape not benign words;
  foreign needs non-Latin AND no-AI-token AND clickbait); the **out-of-sample** precision=1.0 gate
  (INV-2); independent Argus labeling (INV-2b); the explicit near-miss fixtures (Phase 0). If precision
  can't hit 1.0 on the holdout without dropping a real item, the signal is too blunt — narrow or drop
  it, never ship a real-item demotion.
- **R-2 (over-fit / regex decay).** Shape-based signals tuned on two days will drift as adversaries
  mutate ($→S, spaced cashtags, emoji obfuscation). Mitigation: the demotion-rate watchdog + recall
  audit make decay VISIBLE; **committed (not deferred) follow-up:** a scheduled monthly re-eval against
  a fresh labeled day. Honest scope: v1 = two ratified days + shape-generalization.
- **R-3 (prompt + backstop agree → backstop signal vanishes).** Once the prompt labels junk `off`, B4
  fires less — which would hide whether B4 still works. Mitigation: AC-8 asserts B4 actually FIRED in
  the live run (≥1 `junk_backstop`); the holdout fixture proves the deterministic layer independent of
  the prompt.
- **R-4 (pool-relative stages move a clean item).** Demoting 11 items changes `pool_mean_embed`,
  author-cap counts, overview salience. Mitigation: INV-5 proof re-runs those stages and asserts no
  non-junk slot change (not a per-item assumption).
- **R-5 (oracle label is itself contestable).** "Mecha Comet Kickstarter" / "$COIN" are junk by author
  fiat; a real AI-hardware crowdfund is a defensible keep. Mitigation: INV-2b independent Argus pass +
  recorded disagreement resolution; a wrong label is caught by the second labeler, not silently folded.

## 9. Open Questions

1. **`content_type→promo` vs clamp-only?** RESOLVED (pass-2): **clamp-only.** `on_topic→off` + the
   monotonic clamp (applied last) is the entire guarantee; the `ct→promo` mutation route is DROPPED —
   it added a per-pool `_promo_lowers` hazard for zero benefit the clamp doesn't already provide. (If a
   concrete clamp-alone-insufficient item ever surfaces, revisit; none expected since the clamp bounds
   the final score directly.)
2. **Should B4 fire on non-X sources?** Keep source-agnostic but curated-exempt (a crypto crosspost to a
   non-curated sub should still demote); proven by a selftest row. Curated AI sources protected by INV-3.
3. **Recall target?** Accept ~9/11 on the tune set with **100% out-of-sample precision** over chasing
   11/11. The borderline "model barely matters" hot-take is NOT forced into the junk set (D-2). The
   recall-hole audit (§7) keeps the gap visible over time.

## 10. Acceptance Criteria

- [ ] **AC-1.** The 3 unambiguous incident items each score `< ALSO_GATE` after the clamp. Evidence:
  `--selftest` incident block states ALSO_GATE's value; AND a **max-envelope selftest** adds
  PF_CAP + max(author) + max(recency) + max(media) to a demoted item and shows it STILL `< ALSO_GATE`
  (proves the clamp-as-last-op bound, P2-B1).
- [ ] **AC-2.** Precision = 1.0 on the **held-out 2nd-day** pool (INV-2); 0 false demotions; holdout
  size + junk count + near-miss count reported. Evidence: holdout selftest block; demoted∩non-junk = ∅.
- [ ] **AC-2b.** Argus independently labeled the **full holdout** (incl. clean set), committed;
  disagreements reconciled on record (INV-2b).
- [ ] **AC-3.** Every NON-JUNK item's **per-item score terms + breakdown** are byte-identical to pre-B4;
  the `pool_mean_embed` delta is reported; and **no non-junk item changes Top/Also or overview-top-story
  SLOT** (INV-5, slot-scoped — not byte-identical for the PF-coupled field). Evidence: `rescore_diff.py`.
- [ ] **AC-4.** `final_with_B4 <= final_without_B4` ∀ items; the clamp is the LAST write to `final`
  (grep); idempotent re-score is a no-op (INV-1). Evidence: selftest + grep.
- [ ] **AC-5.** Global + per-signal kill-switches work (INV-6). Evidence: selftests.
- [ ] **AC-6.** Both prompts carry the rules; morning-vs-x-feed rubric blocks match; each matches its
  mirror. Evidence: grep + diffs.
- [ ] **AC-7.** `npm run verify` green (typecheck + lint + tests + py selftest + gold-set 4/4).
- [ ] **AC-8 (live, backstop-proven on the mislabel class).** One real morning AND one x-feed run post
  junk-free overview + Top Stories, AND the debug dump shows ≥1 `junk_backstop` firing **on an item the
  MODEL labeled `core`** (proves B4 caught the actual mislabel class, not just any firing — P2). Evidence:
  the live #daily posts + both `_last_run_debug.json` audits.
- [ ] **AC-9.** Demotion-rate watchdog fires on an over-threshold fixture; recall-audit line present.
  Evidence: Phase-4 selftest.

---

### Verification command summary
- `python3 scripts/score_digest.py --selftest` — backstop + incident + tune + **holdout** + boundary +
  idempotency + kill-switch blocks.
- `python3 scripts/rescore_diff.py --in <pool>` (new) — demoted set + INV-1/INV-5 + pool-relative re-run.
- `npm run verify` — full suite incl. gold-set 4/4.
- `bash ~/.hermes/scripts/argus-judge.sh ...` — independent oracle label pass (Phase 0).
- Live: force-run morning + x-feed, inspect #daily + both debug dumps for ≥1 firing.
