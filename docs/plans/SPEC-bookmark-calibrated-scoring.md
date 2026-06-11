# SPEC — Bookmark-Calibrated Digest Scoring

**Status:** v1 — specced 2026-06-11. Offline/shadow analysis + a constants re-fit. NOT a config flip; the resulting constant changes ship via the already-cutover deterministic scorer (no new Hard-Config surface beyond tuning `score_digest.py` constants, which is code).
**Owner:** Apollo. **Repo:** `Kyzcreig/siftly-ace`. **Surface:** `score_digest.py` scoring constants + `docs/eval/`.
**Builds on:** SPEC-deterministic-digest-scoring.md (v4, cutover live) + SPEC-label-trust-backstops.md.

---

## 1. Problem (ground-truthed 2026-06-11, real numbers)

The deterministic scorer is live, but the score distribution is **compressed at the top** — 6 of 141 items ≥90, five within 7 points of each other. Root cause is NOT the gate; it's that the two biggest terms are **near-constant on this corpus**, so they offset everyone equally and separate no one:

Real breakdowns from today's posted digest:
```
100  base=70 eng=15 auth=8 pf=0  rec=10   paulg
 97  base=70 eng=0  auth=8 pf=6  rec=10   Predictbook
 95  base=70 eng=5  auth=0 pf=7  rec=10   yabarich
 93  base=58 eng=10 auth=8 pf=4  rec=10   deedydas
 92  base=70 eng=6  auth=0 pf=3  rec=10   MohFx2008
```

1. **`base=70` is both the ceiling and the mode.** The model labels almost everything `launch`/`actionable_now` → BASE 70. Base does ~zero separating work (it's a near-constant), and the model's over-use of the top label is the OLD inflation relocated into the label.
2. **`recency=10` is constant** — a *daily* brief means every item is <24h old, so recency adds +10 to everyone. Pure offset, zero discrimination.
3. **Floor effect:** base 70 + recency 10 = **80 before any real signal**. The only terms that actually vary are engagement (0–15) and pf (small), so the live spread collapses into 80–100.

**Ace's framing (2026-06-11):** "we're losing resolution by not using the whole range." Correct. And: "obviously bookmarks should score high and stuff I pass on should score low — focus on the productive bookmarks, not memes/politics."

**Directive:** calibrate the scoring constants against Ace's REAL revealed preferences (his bookmark corpus) so productive bookmarks score high, passed-over noise scores low, and the full 0–100 range is used.

---

## 2. Ground truth available (verified)

- `prisma/dev.db` → `Bookmark` table: **2,650 bookmarks + 912 likes** (3,562 rows).
- Per row: `text`, `authorHandle`, `rawJson.tweet.public_metrics` (`like_count`, `retweet_count`, `reply_count`, `quote_count`, `bookmark_count`, `impression_count`), `rawJson.tweet.created_at`, and `semanticTags` (100% populated).
- `semanticTags` gives a clean **productive vs non-productive** split (real top tags):
  - **Productive (positives):** developer-tools, dev-tools, ai-ml, ai-resources, tech-industry, startups-business, design-product, productivity, security, finance-investing.
  - **Exclude from positives (Ace's call — not signal of "good digest content"):** politics, news, meme-humor, funny-memes, health-wellness, entertainment, sports, food-drink, gaming, crypto-web3 (debatable — flag for Ace).

---

## 3. The calibration sets (revealed preference, not hand-labeled)

- **POSITIVES (P):** bookmarks whose `semanticTags` intersect the productive set AND do NOT contain an excluded tag (politics/meme/etc.). These are "Ace deliberately saved a productive post" = should score HIGH. Target ~800–1,200 after filtering.
- **HARD NEGATIVES (N-hard):** bookmarks tagged ONLY with excluded categories (politics/meme/sports) — Ace saved them, but they are NOT digest-worthy productive content. Tests that the scorer separates "productive save" from "fun save."
- **SOFT NEGATIVES (N-soft):** the **non-selected** items from recent digest debug pools (`_last_run_debug.json` history) — real timeline content Ace did NOT get shown / that fell below the gate. "Didn't make the cut" noise.
- All sets are frozen + versioned in `docs/eval/calibration/` so re-fits are reproducible.

---

## 4. Step 3 FIRST (measurement before any change) — REQUIRED

Per Ace: do the measurement as part of this spec, before re-fitting. Build `scripts/calibrate_scoring.py --measure`:

1. Pull P / N-hard / N-soft from the DB + digest-pool history.
2. **Label them** with the enum rubric. Two options, decide at build:
   - (a) cheap heuristic labeler from `semanticTags` + text (fast, deterministic, no spend), or
   - (b) a real model-labeling pass (matches production label quality, small cost).
   Start with (a) for the measurement; note divergence risk.
3. Score every item with the **current** constants.
4. **Report the separation** (the deliverable Ace wants to SEE):
   - score histogram for P vs N-hard vs N-soft (overlaid).
   - median / p25 / p75 per set; **overlap zone**; how many positives fall below TOP_GATE and how many negatives clear it.
   - **AUC / rank-separation** (probability a random positive outranks a random negative) — the single headline number for "is the scorer using the range to separate good from bad?"
   - per-term variance on the positives (proves base/recency are near-constant; quantifies the resolution loss).

**Gate:** if Step-3 shows P and N already cleanly separate (AUC high, little overlap), we may only need gate re-derivation, not a constants re-fit. Measure before assuming the fix.

---

## 5. The re-fit (only after Step 3 shows the problem)

Fix the two resolution-killers identified in §1, then fit to maximize P-vs-N separation:

### 5.1 Decompress the base table
The 36-cell BASE currently tops at 70 with `launch`/`benchmark`/`tutorial` all crowding 60–70. Re-spread so the *productive* content types Ace bookmarks most (dev-tools, ai-ml, analysis with substance) occupy the high range, and spread the ladder across a wider band (e.g. 15–60 instead of 0–70) so base actually discriminates. Keep row/column monotonicity (selftested).

### 5.2 Recency: slab → tiebreak
On a daily brief, recency is a constant. Demote `recency_points` from a +10 slab to a small ±3 tiebreak (or 0 for the morning digest, where everything is same-day). Recover those 10 points of range for terms that actually vary. (Keep the larger recency band available for any future non-daily surface via a constant.)

### 5.3 Re-fit weights to the calibration sets
Treat it as a simple, INTERPRETABLE fit (NOT a black-box model — Ace wants explainable scores):
- grid/coordinate search over the handful of constants (base spread, ENGAGEMENT_K/caps, author tier, pf cap, substance adj) to **maximize AUC(P vs N-soft) + AUC(P-productive vs N-hard)** subject to:
  - monotonicity constraints preserved,
  - the gold-set bar still passes (zero known_bad in TOP, every known_good ≥ ALSO),
  - no single term allowed to dominate (interpretability: each term's max contribution bounded).
- **Engagement caveat (don't overfit to virality):** bookmarks skew toward Ace's taste, not raw popularity — a low-engagement post Ace bookmarked is a STRONG positive. So engagement weight must stay bounded; the fit should LEARN that author-tier + content-type matter more than raw likes for "Ace likes this." This is the anti-"@yoheinakajima" property, reinforced by real data.

### 5.4 Re-derive gates
Set TOP_GATE / ALSO_GATE / LOW_REACH_SCORE_CAP from where the calibrated positives cluster: TOP_GATE at roughly the P-distribution's p60–p75 so a typical productive bookmark would clear Top, and noise sits below. Keep `LOW_REACH_SCORE_CAP = ALSO_GATE − 5` (computed). Keep MAX_TOP=5 / MAX_ALSO=2.

---

## 6. Personal-fit interaction (already partly here)
`pf-score.py` already scores affinity from the bookmark corpus (PF_WEIGHT=30, pf_points cap 12). This calibration is COMPLEMENTARY: pf tunes the per-item affinity term; this tunes the BASE/engagement/recency structure so the *whole* score uses the range. Re-fit should hold pf as an input and tune around it (avoid double-counting taste — the fit measures marginal contribution).

---

## 7. Acceptance criteria
- [ ] `calibrate_scoring.py --measure` builds frozen P / N-hard / N-soft sets from the DB + digest-pool history, versioned in `docs/eval/calibration/`.
- [ ] Step-3 separation report produced: overlaid histograms, per-set quartiles, overlap zone, **AUC**, per-term variance — committed as the baseline artifact BEFORE any re-fit.
- [ ] Productive-bookmark filter excludes politics/meme/sports/etc. per Ace; crypto-web3 flagged for Ace's call.
- [ ] Re-fit (if Step 3 warrants) decompresses base + demotes recency; constants remain interpretable (per-term contribution bounded + logged).
- [ ] Post-fit: AUC(P vs N-soft) materially improved vs baseline; full 0–100 range used (positives spread, not clustered at 90–100).
- [ ] Gold-set bar still passes; backstops (off-topic / fragment / low-reach) unchanged and still green.
- [ ] All `score_digest.py` selftests green incl. the existing incident cases (@yoheinakajima 2-like still < 90, spam < emollick).
- [ ] New constants proposed as a reviewed diff; live-verified on a real digest pool (the constants change is code, not a prompt/config flip).
- [ ] Docs + AGENTS.md + mem0 updated.

## 8. Decisions (Ace, 2026-06-11) — RESOLVED
1. **crypto-web3 = NOISE (exclude from positives).** General crypto is not wanted. ONLY exception: a post where the crypto angle is genuinely about AI AND the AI part is very interesting — but that's rare and will be captured by the AI tags, not the crypto tag. So: `crypto-web3`/`finance-crypto` join the EXCLUDE list; an item tagged crypto is a positive ONLY if it ALSO carries a strong AI tag (ai-ml/ai-resources).
2. **Labeling = BOTH, sequenced.** Heuristic labels (free) for the Step-3 measurement baseline. IF Step 3 warrants a re-fit, run the production model-labeling pass on the final calibration set so the shipped constants are fit against production-quality labels (faithful transfer). Don't spend until the measurement proves it's needed.
3. **Bookmarks-only** for the positive set (912 likes held out as a later check). CONFIRMED.
4. **Taste > virality CONFIRMED.** A low-engagement post Ace would bookmark must be able to beat a high-engagement post he wouldn't. Engagement weight stays bounded; author-tier + content-type carry more weight for "Ace likes this."

EXCLUDE tag set (final): politics, news, meme-humor, funny-memes, health-wellness, entertainment, sports, food-drink, gaming, crypto-web3, finance-crypto. Crypto-with-strong-AI-tag is the one conditional-include.

---

## 9. STEP-3 CONCLUSION (2026-06-11) — measurement done, re-fit NOT needed (yet)

**Finding: the scorer is already well-calibrated to actionable content. The apparent "57% of bookmarks below gate" was a CONTAMINATED positive set, not a scorer defect.**

Evidence (all on real bookmark data):
| Positive set definition | AUC vs hard-neg | median |
|---|---|---|
| semanticTags "productive" (TOPIC filter) | 0.51–0.75 | 33 |
| **model-labeled ACTIONABLE (substance filter)** | **0.951** | **66** |

- `semanticTags` captures **topic, not substance**: a tweet tagged `startups-business`/`dev-tools` is often an opinion, founder-wisdom, or hot take. ~50–70% of "productive"-tagged bookmarks are model-labeled `opinion`/`off`.
- When positives are filtered to genuinely actionable saves (model `content_type` ∈ {launch, benchmark, tutorial, field_report, analysis} ∧ on_topic≠off), they score **median 66**, and the scorer separates them from BOTH politics/meme bookmarks (AUC 0.951) AND from Ace's own opinion-saves (AUC 0.968) — near-perfect.
- This means the scorer **correctly** ranks Ace's opinion/hot-take bookmarks low — which is desired (the digest is for actionable content; tuning to score opinions high would re-introduce the inflation we just removed).

**pf finding (separate, real):** pf_delta is slightly NEGATIVE on productive bookmarks because the pf preference-profile (`~/.hermes/state/x-bookmarks/preference-profile.json`) is built from the WHOLE corpus (politics-heavy: top author @elonmusk 260 saves, top topics include politics/finance). The pf model reflects "everything Ace saves," not "what belongs in a productive digest." This is a pf-profile calibration issue, independent of the base-table scoring.

### Revised recommendation
1. **Do NOT re-fit the base table to the contaminated set.** It scores actionable content correctly.
2. **The genuine remaining issues are narrower:**
   - (a) **8/40 actionable bookmarks below gate (~20%)** — inspect these specific misses; likely the base-table harshness on `analysis`/`field_report` (§5.1) on a SMALL scale, not a wholesale re-spread.
   - (b) **recency=+10 slab is still dead weight** on a daily brief (§5.2) — demoting it to a tiebreak is still worth doing; it's pure offset, costs nothing to fix, recovers range.
   - (c) **pf profile is politics-contaminated** — rebuild the pf profile from PRODUCTIVE bookmarks only (or segment it) so pf rewards digest-taste, not whole-corpus-taste.
3. **Gates are basically right** — 0 hard-negs clear, actionable median 66 sits above TOP=58. Minor: TOP could rise slightly to tighten, but not urgent.

### Decision needed from Ace
The big re-fit is **not warranted**. The productive, bounded improvements are: (b) recency→tiebreak, (a) inspect/soften base for analysis/field_report, (c) rebuild pf profile from productive saves. Recommend doing (b)+(c) (cheap, clearly correct) and inspecting (a) before any base-table change.
