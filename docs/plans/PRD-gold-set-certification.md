# PRD — Gold-Set Certification for Deterministic Digest Scoring

**Status:** DRAFT → v2 (P1) → v3 (P2) → v4 (P3) → v5 — APPROVED → **v6 — BUILT & LIVE-VERIFIED** (2026-06-11)
**Review trail:** `docs/reviews/goldset-cert-review-pass{1,2,3,4}.md` — Opus, 4 passes
(AWC → AWC → AWC → AWC-zero-blockers). All blockers + required changes resolved; Pass-4 found no
critical blockers, only acceptance-criteria sync (now applied). Cleared for build.
**Owner:** Apollo (build) · Ace (ratifies the gold labels)
**Project:** `~/Projects/siftly-ace`
**Source SHA at authoring:** 24c965f
**Created:** 2026-06-11
**Relates to:** SPEC-deterministic-digest-scoring.md §6a; the x-feed + morning-digest deterministic cutover (already live).

---

## 1. Summary & Goal

The deterministic scorer (`score_digest.py`) is **live in production** on both briefs. Its
SPEC §6a defined a **frozen gold set** (`docs/eval/digest-gold-set.json`) as the objective
acceptance gate — "zero known_bad in TOP, every known_good ≥ ALSO_GATE, top-set overlap ≥ 0.8,
cardinality parity." That gate **cannot run today**, for three concrete reasons:

1. **The 15 gold items carry no enum labels.** The scorer reads `content_type / actionability /
   substance / on_topic`; the gold items only have `label` (known_good/known_bad/neutral) + `text`.
   With no enum labels, every item coerces to `SAFE_DEFAULT` (opinion×context_only) and scores
   meaninglessly — e.g. `incident-emollick-routing` (known_good) scores **48**, below ALSO_GATE,
   purely because it has no labels, not because the scorer is wrong. *(Verified by running the gold
   set through `score_item` at 24c965f: 15/15 `label_coerced:true`.)*
2. **The gold set is `status: DRAFT — awaiting Ace ratification`.** SPEC §6a names Ace as the
   ratifying owner; it was never ratified.
3. **No harness exists to run the §6a bar.** Grepped `scripts/ e2e/ __tests__/` — nothing consumes
   `digest-gold-set.json`. The bar is prose in a JSON `_meta` block, not executable.

**Goal:** make the §6a gold-set gate **real and runnable** — label the gold items with the ideal
enum labels (Apollo proposes, Ace ratifies), flip the gold set to RATIFIED, and build a harness that
scores it through the live engine and asserts the four §6a bars, wired into `npm run verify`.

**Why now:** the cutover shipped without its own certifying gate. The live-pool invariants hold
empirically (we verified zero known-bad-pattern items in TOP on real runs), but there is no
**regression net**: a future scorer/table edit could silently re-introduce the spam-over-emollick
inversion and nothing would catch it. This PRD closes that hole.

---

## 2. Non-Goals

- **NOT** re-tuning the scorer, BASE table, gates, or any constant. This certifies the *current*
  engine; if the gate fails, that's a finding to discuss, not a license to move numbers.
- **NOT** building the "~200-item sampled window" SPEC §6a mentions as a future expansion. v1 is the
  **15 frozen incident/real items already in the file**. A 200-item hand-labeled corpus is a roadmap
  item (trigger: we want statistical confidence beyond the incident cases).
- **NOT** certifying the *model labeler's* accuracy. The gold set certifies the **scorer**: "given
  correct labels, does the math place items correctly?" Labeler quality is a separate eval (the
  shadow-diff harness already surfaces labeler issues on live pools).
- **NOT** touching the live `prompt.md` or any cron config. This is repo-only (eval fixture + script
  + test). No Hard-Config change.

---

## 3. Constitution / Invariants

- **Invariant — the gold labels are the IDEAL labels, not model output.**
  - *Why:* the gold set isolates the *scoring math* from *labeler noise*. The labels must be what a
    perfect classifier would emit for each text, hand-assigned and Ace-ratified — so a gate failure
    unambiguously means "the scorer mis-placed a correctly-labeled item."
  - *Closeout proof:* each item's labels are justified in a `label_rationale` field; Ace ratified.

- **Invariant — the gold set is FROZEN and versioned in-repo.**
  - *Why:* reproducibility. A shadow/gold run must be re-runnable to the same result.
  - *Closeout proof:* file committed; harness reads it from the repo path, no network.

- **Invariant — the harness certifies the CURRENT engine; EACH bar must FAIL on a regression that
  targets it.** A single mutation only proves the harness *can* go red, not that all four bars are
  load-bearing — three could be miswired (always-true) and the suite stays green forever.
  - *Why:* it's a regression net, not a rubber stamp. A green run must mean every bar is alive.
  - *Closeout proof:* a **mutation matrix** — one perturbation per bar, each asserted to turn *exactly
    that bar* RED: (a) push a known_bad into TOP → Bar 1 red; (b) drop a known_good below ALSO_GATE →
    Bar 2 red; (c) lift a neutral past TOP_GATE → Bar 3 red; (d) zero OFF_TOPIC_PEN / invert a guard →
    Bar 4 red. (Review Pass-1 Blocker 2.)

- **Invariant — the gates the bars compare against cannot silently move.** If a future regression
  retunes TOP_GATE/ALSO_GATE themselves (the Non-Goal this harness guards), the bars would move with
  them and stay green.
  - *Why:* a gate-retune is exactly the regression class to catch; the harness must not absorb it.
  - *Closeout proof:* the harness asserts the engine's resolved tiebreak gates equal the expected
    (49/45) and hard-fails on mismatch. (Review Pass-1 Required Change 4.)

- **Invariant — no secrets, no live API. Pure local scoring.**
  - *Why:* the gold items are static text; scoring is deterministic and offline.
  - *Closeout proof:* harness runs with no network/keys; CI-safe.

---

## 4. Resolved Decisions

- **D-1 — Apollo proposes labels, Ace ratifies.** Per SPEC §6a (`owner_ratify: Ace`). Apollo assigns
  the 4 enum labels + a one-line rationale per item; Ace reviews the table and says "ratified" (or
  corrects specific labels). The file's `status` flips to `RATIFIED (Ace, <date>)` only on Ace's word.
- **D-2 — Ideal labels, not model-run labels.** (See Invariant 1.) The labels encode the *correct*
  classification of each text, so the gate tests scoring, not labeling.
- **D-3 — v1 = the existing 15 items.** No new corpus. The 15 are the headline incident cases
  (yohei-2like, spam bot, emollick inversion, elon reply-fragment, elon politics, ivermectin) + real
  builder/HN items. They exercise every guard. Sufficient for a regression net.
- **D-4 — The four §6a bars are the pass criteria, adapted to a single-pool fixture:**
  1. **No known_bad clears TOP_GATE _by score_** (Pass-3 RC-4 — NOT merely "no known_bad lands in a
     TOP slot": on a 15-item pool forced-distribution could fill MAX_TOP with known_goods and *evict* a
     known_bad that scored above TOP_GATE, so a placement-only Bar 1 would read green while the exact
     inversion is live. Bar 1 asserts on **score ≥ TOP_GATE**, the regression that matters).
  2. **Every known_good scores ≥ ALSO_GATE** (on score, D-11 — slot-cap eviction is benign).
  3. **No neutral clears TOP_GATE _by score_** (neutral must not be TOP-worthy; no ordering constraint).
  4. **No known_bad outscores any known_good** (the anti-inversion bar — the original spam>emollick bug).
  - *(The SPEC's "top-5 overlap ≥ 0.8" and "cardinality parity" bars assume a multi-day live corpus;
    for the 15-item fixture the label-class bars above are the faithful, runnable equivalent. Noted as
    a deliberate adaptation, not a silent drop.)*
  - **Bar-strength honesty (Review Pass-1 Blocker 1; Pass-2 Blocker 2; Pass-3 Blocker 1) — the net is
    2 fully load-bearing bars + 2 structurally-satisfied:** Bars **1 & 3 are structurally satisfied** on
    this fixture (nearly true by construction): the known_bad items (spam bot, reply-fragment, ivermectin)
    score at/near the floor (≈0) via BASE=0/5 + OFF_TOPIC_PEN, and the lone low-engagement neutral
    (`yohei-2like`, 2 likes) is low-reach-capped well below TOP regardless of the mid-distribution math.
    **Bars 2 (known_good ≥ ALSO_GATE) & 4 (anti-inversion) carry the real signal** — Bar 4 fails the
    moment a known_bad outscores a known_good (the exact 2026 regression). This is stated plainly, not
    dressed up. The harness still (a) prints per-item **margins** (D-7) so a vacuous pass is visible, and
    (b) proves each bar's *assertion wiring* fires via the mutation matrix — **but the `--mutate bar3`
    case exercises a SYNTHETIC injected neutral (scaffolding), which proves the bar3 assertion logic
    fires, NOT that the certified pool exercises Bar 3.** D-12's neutral enumeration surfaces this at
    ratification so Ace sees exactly which bars are live nets vs structurally-satisfied.
- **D-12 — Neutral enumeration at ratification (Pass-2 Blocker 2).** Phase 1 lists every `neutral` item
  + its final score + whether it is floor-pinned (low-reach-capped or BASE-floored). If all neutrals are
  floor-pinned, Bar 3 is documented as structurally-satisfied (like Bar 1), so Ace sees at ratification
  that Bars 2 & 4 are the load-bearing ones and Bar 3's mutation uses a synthetic fixture.
- **D-7 — Margin report, not just pass/fail (Review Pass-1 RC-2).** For each known_good print
  `final − ALSO_GATE`; for each known_bad print `TOP_GATE − final`; for each neutral print
  `TOP_GATE − final`. A bar that passes by a thin margin (e.g. emollick at 48 vs tiebreak ALSO 45 →
  +3) is a latent flake Ace should see at ratification. The harness WARNs (does not fail) on a
  known_good margin < 5 so thin passes are surfaced, not hidden.
- **D-8 — Labeled-set pass is a Phase-1 gate BEFORE ratification (Review Pass-1 Blocker 3 / RC-3).**
  Apollo scores the *proposed-label* set through `select_shadow`; **all 4 bars must pass on the proposed
  labels before the table is presented to Ace.** If a bar fails on *correctly-reasoned* labels, that is
  a **scorer finding** (Non-Goal §2) — surface it to Ace, do NOT reverse-engineer labels to force the
  gate green (that would make the gate certify nothing). The Acceptance Criteria's "passes 4/4" is thus
  *demonstrated*, never *assumed*.
- **D-9 — HN-item engagement mapping (Review Pass-1 RC-5; tightened Pass-2 Blocker 1).** Some gold
  items carry `hn_points`, not `likes/retweets`; the engine's low-reach cap reads `likes+retweets`
  (would treat an HN item as zero-engagement → spuriously low-reach-capped). HN items are mapped as
  `source="hackernews"`. **The exemption is ASSERTED EMPIRICALLY, not assumed:** the harness scores at
  least one HN known_good and asserts `_breakdown.low_reach_capped == false` AND `final ≥ ALSO_GATE` for
  a *scoring* reason. If the engine's low-reach predicate is NOT keyed off `source` the way we expect
  (i.e. an HN item does get capped), that surfaces as a real finding (an HN known_good failing Bar 2 for
  a *schema* reason), to fix before ratification — never silently passed.
- **D-10 — Gate-pin assertion, ONE literal (Review Pass-1 RC-4; Pass-2 RC-4; Pass-3 RC-3).** The
  expected tiebreak gate values appear as a literal in **exactly one place** in the harness
  (`TOP_GATE_EXPECTED=49, ALSO_GATE_EXPECTED=45`). The harness (a) feeds *those same symbols* into
  `select_shadow(..., top_gate=TOP_GATE_EXPECTED, also_gate=ALSO_GATE_EXPECTED)`, and (b) reads the
  engine's resolved module gates via the engine's own accessor (`score_digest.TOP_GATE`/`.ALSO_GATE`
  under `RECENCY_AS_TIEBREAK=1`, FACT 5 L70-75) and asserts they equal those symbols. No re-typed
  `49`/`45` anywhere else — so the pin and the pipeline can never read different values, and a
  regression that moves the engine constant is caught (engine != expected).
- **D-11 — Bar 2 on SCORE; Bars 1, 3, 4 on SCORE too (Pass-2 RC-5; Pass-3 RC-4).** `select_shadow`'s
  forced distribution + MAX_TOP/MAX_ALSO slot caps can evict a high-scoring item from *placement* on a
  15-item pool. To avoid a benign slot-cap eviction masking (or faking) a regression, **all four bars
  evaluate on the item's `final` SCORE, not on which slot it landed in:** Bar 1 = no known_bad has
  `final ≥ TOP_GATE`; Bar 2 = every known_good has `final ≥ ALSO_GATE`; Bar 3 = no neutral has
  `final ≥ TOP_GATE`; Bar 4 = no known_bad's `final` exceeds any known_good's `final`. (Placement via
  the full pipeline is still *run* — event-collapse + forced-distribution + low-reach cap shape the
  `final` — but the *assertion* is on the resulting score, which is what the regression moves.)
- **D-5 — Harness is a Python script + a pytest wrapper, wired into `npm run verify`.** Matches the
  existing pattern (`score_digest.py --selftest`, the `__tests__/*.py` suite). It runs the real
  `select_shadow` pipeline (the same one production uses), not a reimplementation. **The verify wiring
  is an explicit `&&` chain so a non-zero harness exit actually fails `npm run verify`** (Review Pass-1
  DevOps note — not a swallowed subshell), and the gold gate runs **AFTER** the JS steps
  (`tsc && lint && vitest && e2e && python3 scripts/gold_set_eval.py`, Pass-3 RC-5) so a cheap JS
  fast-fail short-circuits before the heavier gold scoring; the harness is import-only/offline so it
  cannot hang CI.
- **D-6 — Mode awareness.** The harness runs under `RECENCY_AS_TIEBREAK=1` (production's mode) so the
  gates it asserts against (49/45) match live. It prints which gates it used.

---

## 5. Architecture / Design

```
docs/eval/digest-gold-set.json   (15 items, NOW + 4 enum labels each + label_rationale, RATIFIED)
        │
        ▼
scripts/gold_set_eval.py         (the harness)
   1. load gold set; map gold schema → engine schema
      (handle→authorHandle, text→tweet_text; HN items source="hackernews", low-reach-cap-exempt, D-9)
   2. assert engine resolved gates == tiebreak (49/45) — hard-fail on mismatch (D-10)
   3. score the WHOLE set through select_shadow()  ← the real production pipeline
      (event-collapse → forced-distribution → gates → TOP/ALSO), RECENCY_AS_TIEBREAK=1
   4. evaluate the 4 D-4 bars on each item's `final` SCORE (D-11) — Bar1: no known_bad ≥ TOP_GATE;
      Bar2: every known_good ≥ ALSO_GATE; Bar3: no neutral ≥ TOP_GATE; Bar4: no known_bad > any known_good
   5. print a per-item table (id · gold_label · final · placement · MARGIN · pass/fail, D-7)
      + WARN on known_good margin < 5 + a PASS/FAIL summary; exit 0 (pass) / 1 (fail)
        │
        ▼
scripts/__tests__/gold_set_eval_test.py   (pytest: ratified-set PASS + MUTATION MATRIX (1 per bar,
                                            each reds exactly its bar) + gate-pin hard-fail case)
        │
        ▼
npm run verify  →  add `python3 scripts/gold_set_eval.py` to the gate (after the py selftests)
```

**Why `select_shadow`, not raw `score_item`:** the §6a bars are about **placement** (TOP/ALSO), which
is decided by the full pipeline (gates + dedup + forced-distribution + low-reach cap), not the raw
score. Scoring items in isolation would miss event-collapse and the slot caps. The harness must use
the same authority production uses.

**Schema mapping (gold → engine), exact:** `handle → authorHandle`, `text → tweet_text`,
`source` kept, `likes/retweets/hn_points` kept, plus the 4 new enum fields read directly. The harness
asserts every item carries all 4 labels before scoring (a missing label is a hard error, not a
coerce — so an un-labeled item can never silently pass).

---

## 6. Implementation Phases

### Phase 1 — Label, prove-on-proposed-labels, then ratify
Apollo assigns `content_type / actionability / substance / on_topic` + `label_rationale` to all 15
items. **Before presenting to Ace (D-8), score the proposed-label set through `select_shadow` and
confirm all 4 bars pass on the proposed labels** — if a bar fails on correctly-reasoned labels, that's
a scorer finding (Non-Goal §2), surfaced to Ace, NOT papered over by re-labeling. Then flip `status`
to `RATIFIED` **only after Ace's explicit ratification**. Bump `_meta` with the adapted D-4 bar
definitions + the margin/gate-pin notes.
- *Unit/script check:* a validator asserts all 15 items carry all 4 enum labels from the allowed value
  sets (no typos, no missing).
- *E2E/integration check:* score the proposed-label set through `select_shadow`; print the per-item
  table **with margins (D-7)** + the **neutral enumeration (D-12)** (each neutral's score + floor-pinned
  flag) for Ace to eyeball before ratifying; all 4 bars green on proposed labels.
- *Negative/adversarial:* an item with a bogus enum value (`content_type: "lunch"`) must hard-error,
  not coerce.
- *Verify with:* `python3 scripts/gold_set_eval.py --validate-only` → "15/15 items fully labeled";
  `python3 scripts/gold_set_eval.py` on the proposed labels → `PASS (4/4)`.

### Phase 2 — Build the harness
`scripts/gold_set_eval.py`: load → map (D-9 HN exemption) → assert gates == 49/45 (D-10) →
`select_shadow(RECENCY_AS_TIEBREAK=1)` → evaluate the 4 D-4 bars → **margin report (D-7)** → table +
PASS/FAIL + exit code.
- *Unit/script check:* on the ratified set, prints PASS, all 4 bars + margins, exits 0.
- *E2E/integration check:* uses the real `select_shadow` (no reimplementation); asserts the engine's
  resolved gates equal tiebreak 49/45 and hard-fails on mismatch (D-10).
- *Negative/adversarial — the regression-net proof is a MUTATION MATRIX (Blocker 2), one per bar,
  each in an ISOLATED SUBPROCESS (Pass-2 Blocker 3):* a `--mutate <bar1|bar2|bar3|bar4>` flag
  (test-only) that perturbs the engine in-memory so that *exactly that bar* goes RED — (bar1) lift a
  known_bad's BASE so its `final` clears TOP_GATE; (bar2) drop a known_good below ALSO_GATE; (bar3) lift
  a SYNTHETIC injected neutral's `final` past TOP_GATE (the production neutral is floor-pinned, D-12);
  (bar4) zero `OFF_TOPIC_PEN` so a known_bad outscores a known_good. **Each mutation runs in its own
  subprocess**
  (`subprocess.run([..., "--mutate", bar])`) so an in-memory perturbation of a module constant
  (`OFF_TOPIC_PEN`, `BASE`, gates) can NEVER leak into another case or into the clean ratified-set run.
  Each proves its bar is individually load-bearing, not always-true.
- *Evals (this IS the eval):* the 4 D-4 bars are the metric; target = all 4 pass on the ratified set,
  with margins reported; known_good margin < 5 emits a WARN (OQ-A).
- *Verify with:* `python3 scripts/gold_set_eval.py` → `GOLD SET: PASS (4/4 bars)` + margin lines, exit 0.

### Phase 3 — Wire into the test gate
`scripts/__tests__/gold_set_eval_test.py` (pytest): asserts exit 0 on the ratified set, asserts the
**full mutation matrix — one mutation per bar IN ITS OWN SUBPROCESS, each reds exactly its target bar**
(Blocker 2 + Pass-2 Blocker 3), and asserts the gate-pin (D-10) hard-fails on a wrong gate.
**Leak-prevention is the subprocess isolation itself** (Pass-3 Blocker 2): because every mutation runs
in its own `subprocess.run`, the parent pytest process never mutates a module constant, so the clean
ratified-set run cannot be contaminated — that IS the guarantee, stated as such (no separate "ran the
matrix first" assertion, which would be vacuously true under subprocess isolation and prove nothing).
The test asserts each mutation subprocess exits 1 on its target bar and the in-process clean run exits 0.
Add the harness to `npm run verify` as an explicit `&&` step (D-5).
- *Unit/script check:* `pytest scripts/__tests__/gold_set_eval_test.py -q` → ratified-set-pass +
  4 mutation-per-bar cases + gate-pin case all pass.
- *E2E/integration check:* `npm run verify` runs the gold gate via `&&` and stays green; a forced
  harness exit-1 makes `npm run verify` exit non-zero (proves the wiring isn't a swallowed subshell).
- *Negative/adversarial:* the mutation matrix (Phase 2) asserted here — each bar proven load-bearing.
- *Verify with:* `npm run verify` exits 0 with the gold gate included; `pytest …gold_set_eval_test.py`
  green including all 4 per-bar mutations + the gate-pin.

---

## 7. Security, Privacy, Ops, Observability

- **No secrets, no network.** Static fixture, offline scoring. CI-safe.
- **Observability:** the harness prints a full per-item table (id · label · final · placement · ✓/✗)
  so a failure names exactly which item/bar broke — no black box.
- **Rollback:** pure additive (one fixture edit + one script + one test + one verify line). Revert =
  drop the script from `verify` and the commit. No production surface touched.
- **No Hard-Config change.** Repo-only; the live crons are untouched.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| My proposed labels are wrong → gate certifies the wrong thing | Ace ratifies every label; rationale per item makes review fast; ideal-label invariant. |
| Gate is a rubber stamp (always green) | **Mutation MATRIX — one per bar (Phase 2/3)** proves each of the 4 bars is individually load-bearing; a single mutation only proves the harness *can* go red, not that every bar is wired (Review Pass-1 Blocker 2). |
| Bar 1 is vacuous (known_bad already score ~0) | Acknowledged in D-4 bar-strength note; Bar 4 (anti-inversion) carries the real signal; margins (D-7) make a vacuous pass visible; per-bar mutation proves Bar 1 still fails when a known_bad is pushed toward TOP. |
| Labels reverse-engineered to force the gate green | D-8: proposed labels must pass the bars *before* ratification, and a bar failing on correctly-reasoned labels is a **scorer finding**, surfaced — never fixed by re-labeling. |
| A future regression moves the GATES themselves | D-10 gate-pin: harness hard-fails unless resolved gates == tiebreak 49/45. |
| HN item spuriously low-reach-capped (schema, not scoring) | D-9: HN mapped `source="hackernews"`, exempt from the X-only low-reach cap; harness distinguishes schema-fail from scoring-fail. |
| 15 items too few for statistical confidence | Scoped honestly as v1 regression-net for the *incident cases*; 200-item corpus is a named roadmap item, not silently dropped. |
| Harness drifts from production scoring | Harness calls the real `select_shadow`, not a copy; mode-matched to tiebreak gates; gate-pin asserts the match. |

---

## 9. Open Questions

- **OQ-1 (for Ace, at ratification):** do you want to eyeball/adjust any of my 15 proposed label sets,
  or ratify as-proposed? (I'll present the full table with margins.)
- **OQ-2:** keep v1 at 15 items, or do you want me to expand to the ~200-item sampled window now?
  (Recommendation: ship the 15-item regression net now; expand only if you want statistical
  confidence — the incident cases are what actually broke before.)
- **OQ-A (Review Pass-1):** under production tiebreak gates, `emollick-routing` clears ALSO by a thin
  margin (~3 pts). Acceptable as a pass, or should the harness emit a **WARN** on known_good margins
  < 5 so latent flakes are visible at ratification? (Recommend WARN at < 5 — fail nothing, surface it.)
- **OQ-B (Review Pass-1):** if my *correctly-reasoned* ideal labels make a known_good fail its bar
  through the real pipeline (a genuine scorer finding, not a label error), should that **BLOCK
  ratification** (cert can't ship until the scorer is discussed), or land as a documented known-gap
  with the harness shipped `xfail` on that item? (Recommend BLOCK — a failing cert that ships green is
  worse than no cert. This is the D-8 path.)

---

## 10. Acceptance Criteria

- [ ] All 15 gold items carry valid `content_type/actionability/substance/on_topic` + `label_rationale`.
      Evidence: `python3 scripts/gold_set_eval.py --validate-only` → "15/15 fully labeled", 0 coercions.
- [ ] Gold set `status` = `RATIFIED (Ace, <date>)`, **and the D-12 neutral enumeration (each neutral's
      score + floor-pinned flag) was shown to Ace at ratification** (Pass-4 RC-3) so he saw which bars
      are live nets (2 & 4) vs structurally-satisfied (1 & 3). Evidence: the file header + the ratification
      table (margins + neutral enumeration) + Ace's explicit say-so in-thread.
- [ ] WHEN the ratified set is scored through `select_shadow`, the system SHALL satisfy all 4 D-4 bars
      **evaluated on `final` score (D-11)**, with margins reported (known_good margin < 5 → WARN).
      Evidence: `python3 scripts/gold_set_eval.py` → `PASS (4/4)` + margin lines, exit 0.
- [ ] **The gate-pin (D-10) holds:** the engine's resolved tiebreak gates equal 49/45 (single literal,
      fed to both the pipeline and the assertion). Evidence: `gold_set_eval.py` hard-fails if
      `score_digest.TOP_GATE/ALSO_GATE` (under `RECENCY_AS_TIEBREAK=1`) ≠ 49/45.
- [ ] **The HN empirical exemption (D-9) holds:** an HN known_good scores with `low_reach_capped==false`
      AND `final ≥ ALSO_GATE` for a *scoring* reason (not a schema mis-map). Evidence: harness assertion
      passes on the HN known_good items; an unexpectedly-capped HN item surfaces as a finding, not a pass.
- [ ] **The gate has teeth — the FULL mutation matrix (Pass-4 RC-1), not one mutation.** Evidence:
      `pytest scripts/__tests__/gold_set_eval_test.py -q` — all four per-bar mutation **subprocesses**
      (`--mutate bar1|bar2|bar3|bar4`) exit 1 on their target bar, the gate-pin hard-fail case exits 1,
      and the clean ratified-set run exits 0 (subprocess isolation = no state leak).
- [ ] The gold gate runs **after the JS steps** in the `npm run verify` `&&` chain and the suite stays
      green. Evidence: `npm run verify` exit 0; a forced harness exit-1 makes `npm run verify` non-zero.
- [ ] No production surface touched. Evidence: `git diff` touches only `docs/eval/`, `scripts/`, `package.json`.

## 11. Build Log — As-Built Deviations (v6, 2026-06-11)

Built and live-verified. Two deviations the build surfaced that the approved spec (v5) did **not**
anticipate — both are correctness fixes, documented here rather than silently absorbed:

1. **Ratification reclassified 2 items neutral → known_good** (Ace ratified in-thread):
   - `incident-yohei-2like` (66): a real Yohei field-report. The fixture assumed engagement would gate
     it to ALSO; but `yoheinakajima` is a thought-leader → exempt from the X-only low-reach cap, so it
     scores on merit. 66 in low-TOP is acceptable — **the original incident was it hitting 100**, which
     the deterministic engine already fixed. Reclassified known_good (Bar 2 covers it).
   - `real-voxyz-claude-learning-repo` (70): **root-caused** — the fixture assumed an "unknown-handle
     engagement cap" would hold it to ALSO, but `LOW_REACH_ENGAGEMENT_FLOOR = 5` and voxyz has **36 likes**,
     so the cap structurally cannot fire. Relabeling `actionable_now → reference` only moved it 76 → 70
     (both > TOP_GATE). This is a **real-scorer finding**, not a labeling fix: a concrete on-topic template
     with real crowd signal IS TOP-worthy. Reclassified known_good (actionability honestly kept `reference`).

2. **Mutation matrix (D-4) — two design corrections found during implementation:**
   - **Isolation via engine-global perturbation was wrong.** The spec's `_apply_mutation` mutated
     `score_digest.BASE` / `OFF_TOPIC_PEN`; zeroing `OFF_TOPIC_PEN["off"]` lifted an *unrelated neutral*
     (`real-hn-css-bad-parts` → 50) over TOP_GATE and red **bar3** while targeting bar1/bar4 — cross-bar
     leakage, the exact failure the matrix exists to catch. **Fix:** mutations now inject ONE forced-score
     synthetic probe of the target label *after* all real items score through the unperturbed engine. No
     engine global is touched → no real item moves, no other bar can spuriously flip.
   - **bar4 semantics: `> max_good` → `> min_good`.** The spec/code asserted "no known_bad > **max** known_good"
     but the docstring's intent ("no known_bad > **any** known_good") is `> min_good` — the strict, stronger
     guard. Side benefit: bar4's probe at `min_good+1` (= 48) stays **below** TOP_GATE(49), so bar4 reds in
     isolation. With `> max_good` (83), any inversion necessarily also breached TOP — un-isolatable.
   - **Documented entailment `bar1 ⇒ bar4`:** because `min_good (47) < TOP_GATE (49)`, any known_bad that
     breaches TOP_GATE (bar1) necessarily also out-scores the weakest known_good (bar4). So `--mutate bar1`
     correctly reds `{bar1, bar4}`; this is asserted explicitly in the test, not hidden.

**As-built artifacts:** `scripts/gold_set_eval.py` (harness), `scripts/__tests__/gold_set_eval_test.py`
(8 tests — clean cert, 4-bar mutation matrix, no-leak, gate-pin), `docs/eval/digest-gold-set.json`
(RATIFIED, 15/15 labeled), `package.json` (`test:py` + `gold` folded into `npm run verify`).
**Note (pre-existing gap closed):** the Python suite (25 tests) was **not** in `npm run verify` before this
build — it is now, so the gold gate + the deterministic-engine tests actually run in CI/local verify.
**Verification:** `npm run verify` exit 0 — typecheck + lint(0 err) + JS unit + e2e + 25 Python + gold 4/4.
One advisory `⚠ THIN` margin: `real-hn-fable-guardrails` at 47 (+2 over ALSO_GATE) — WARN only (OQ-A), non-blocking.

## 12. Follow-on — the THIN margin traced to a real scorer gap (hn_points crowd-signal), 2026-06-11

The `⚠ THIN` advisory above was investigated rather than waved off (Ace: "what should we do about this?").
Root cause was a genuine production blind spot the gold set exposed:

- **Finding:** `real-hn-fable-guardrails` (a 234-pt front-page HN story) scored 47 = base 44 + substance 3,
  **engagement 0**. `_engagement()` reads only `likes + retweets`; HN stories have neither — their crowd
  signal is `hn_points`, which the engine **never read**. So a 2,345-pt #1 and a 40-pt minor story scored
  identically, clustering all HN news at ~47 (barely over ALSO_GATE, ~never TOP, zero differentiation).
  Verified against the live morning-digest run (13 HN items, points 9–2,345, all engagement 0).
- **Decision (Ace-approved):** map `hn_points` → a crowd-signal term (the HN analog of likes/retweets).
  Log-scaled around a pivot below which there's no boost (minor stories stay ALSO), capped like the known
  X-engagement tier. `HN_POINTS_K=8, PIVOT=50, CAP=14`. Modeled on real data: pts<50→+0, 90→+2 (TOP knee),
  234→+5 (fable now **52**, real margin), 2,345→+13. **X items byte-identical** (source-gated, see below).
- **Safety property (verified in selftest):** points NEVER rescue an off-topic story — a 5,000-pt off-topic
  HN item still scores < ALSO (topic gating dominates the crowd term).
- **Dogfood hardening (2 fixes):**
  - **Source-gate `_hn_points`** — only `source∈{hackernews,hn}` uses the points curve, so an X tweet that
    somehow carried a stray `hn_points` key can NEVER be hijacked off the likes/retweets curve. Makes the
    X byte-identical guarantee structural, not an assumption. (Also excludes `bool`, an int subclass.)
  - **Corpus non-emptiness floor in the cert harness** — an empty/hollow gold set previously passed all 4
    bars *vacuously* (exit 0), which would green-light a cutover against nothing. Now requires ≥10 real
    items with ≥1 each of known_good/known_bad/neutral, else a visible FAIL. (Silent-pass is unacceptable.)

**As-built (follow-on):** `scripts/score_digest.py` (`_hn_points` + HN branch in `engagement_points`, §4.2b
constants, 6 selftest assertions incl. monotonicity, TOP knee, cap, off-topic-still-gated, X-hijack-prevention);
`scripts/gold_set_eval.py` (corpus floor + `corpus_counts` in result + FAIL line); `scripts/__tests__/gold_set_eval_test.py`
(+3 corpus-floor tests, +entailment-direction-robust mutation tests). `docs/reviews/dogfood-2026-06-11-hn-points-goldset.md`.
**Verification:** `npm run verify` exit 0 — typecheck + lint(0 err) + 180 JS + 10 e2e + 28 Python + gold 4/4.
fable now scores 52 (margin +7, no longer THIN); the gold set re-certifies clean with the new engine.
