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

## 8. Open questions for Ace
1. **crypto-web3**: positive (you save productive crypto/infra) or exclude (noise)? (43 bookmarks tagged.)
2. **Labeling for the measurement**: cheap heuristic from semanticTags (free, start here) vs a real model-labeling pass (matches prod, small cost)? Recommend heuristic for Step-3 baseline, model-pass only if the heuristic labels prove too noisy.
3. **Likes (912) as positives too**, or bookmarks-only? Bookmarks are the stronger signal; likes are weaker/noisier. Recommend bookmarks-only for the positive set, likes as a held-out check.
4. **Author-tier vs engagement priority**: confirm you want a low-engagement post you'd bookmark to beat a high-engagement post you wouldn't — i.e. taste > virality. (Spec assumes yes.)
