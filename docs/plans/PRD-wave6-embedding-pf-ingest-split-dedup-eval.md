# PRD — Wave 6: Embedding Personal-Fit + Ingest Division-of-Labor + Cross-Brief Dedup + Real Eval

**Status:** v3 (Pass-1 BLOCK → Pass-2 APPROVE-WITH-CHANGES → all 6 blockers + 5 new-defects resolved; see §8) · **APPROVED for swarm planning** · **Owner:** Apollo · **Builder:** Daedalus swarm (openai-codex/gpt-5.5 xhigh) · **Reviewer:** Opus-4-8
**Repo:** `~/Projects/siftly-ace` → `Kyzcreig/siftly-ace` · **Date:** 2026-06-13
**Source research:** Athena deep-research report `~/.hermes/profiles/athena/home/research/siftly-ingest-score/REPORT.md` (published <https://eager-echo-rbde.here.now/>), every load-bearing claim re-verified against live code below.

---

## 1. Ground Truth (live-verified 2026-06-13 — do not re-litigate)

These are confirmed against the actual code/state, not the PRDs. The swarm must treat them as fact.

### 1.1 The scoring engine (`scripts/score_digest.py`)
- Architecture: **model emits bounded enum labels; Python owns every number.** Keep this. All Wave-6 changes are *additive terms* + *ingest changes*, never a rewrite of base/gate machinery.
- `final = base + engagement_points + hn_points + author_tier_points + recency_points + media_points + pf_points − off_topic_pen`, with `low_reach_cap` and `python_on_topic` overrides.
- `PF_CAP = 12` (`scripts/score_digest.py:136`); `pf_points(item)` clamps `personal_fit_delta` to `[-PF_CAP, +PF_CAP]` (`:269-276`). This is the ONLY personalization term; `PF_WEIGHT=0` upstream → delta 0 → byte-identical output.
- Gates: x-feed `TOP_GATE=58 / ALSO_GATE=50`; digest `TOP_GATE=49 / ALSO_GATE=45` (the two briefs share the engine but carry their own gate pair).
- `hn_points` (source-gated `source==hackernews`, topic-gated, cap 14) and `_placement_engagement` (X tiebreak byte-identity) are load-bearing and **must stay byte-identical for X**.

### 1.2 The personal-fit helper (`scripts/pf-score.py`) — THE central finding
- **It does NOT use embeddings.** Affinity is keyword/alias overlap:
  `affinity = 0.42·topic_score + 0.28·author_score + 0.18·format_score − 0.18·downrank_score (+0.08 X-source prior)` (`pf-score.py:231-236`), with topics matched via a hand-written `TOPIC_ALIASES` dict (`:30-38`) and `topic_terms()` token intersection (`:149-217`).
- `raw = clamp(-1,+1, affinity − PF_BASELINE)`; `delta = raw × PF_WEIGHT`. Defaults `PF_WEIGHT=30` (`:24`), `PF_BASELINE=0.18` (`:25`), read from `~/.hermes/state/x-bookmarks/brief-config.json` or `PF_WEIGHT`/`PF_BASELINE` env.
- Always exits 0; any error → `{ok:false, base_score_only:true}` sentinel (fail-safe — load-bearing briefs never crash on it). **Keep this contract.**
- The **3,574-item embedded corpus** (text-embedding-3-small, 1536-dim) in sqlite-vec is used for *search* (`src/lib/vec.ts`) but **never for scoring brief candidates.** This is the gap Wave 6 closes.

### 1.3 Brief wiring (live crons)
- `pf-score.py` is invoked via `scripts/pf-audit.py` (timeout wrapper + durable proof artifact) from BOTH `~/.hermes/state/cron/morning-digest/prompt.md` (~line 234) and `~/.hermes/state/cron/x-feed-brief/prompt.md` (~line 82). Wrapper always exits 0; re-emits pf-score JSON or a base-score-only sentinel.
- **Editing those `prompt.md` files is a Hard-Config action** → requires Ace diff+confirm+backup. The swarm MUST NOT touch them; prompt changes are a gated main-agent step (§7).

### 1.4 Ingest today (verified from `morning-digest/prompt.md`)
- `morning-digest` **already** gathers: `gather_perplexity` (Perplexity search.mjs), `gather_hn` (HN Algolia `tags=front_page&hitsPerPage=30`), `gather_smol_latent` (smol.ai RSS + Latent Space feed), `gather_x`. It dedupes/clusters (keep-best-source) and scores via the shared engine.
- `x-feed-brief` already pulls the 24h reverse-chron home timeline (read-through cache, ~$6.50 full sweep, 20-page ceiling) + a few interest searches.
- So the division-of-labor is **half-built**: HN + RSS + Perplexity discovery already live in morning-digest. The Wave-6 *delta* is: (a) add Reddit AI subs + GitHub Trending + a small cached unfollowed-topic-X search; (b) a **shared cross-brief dedup store**; (c) trim x-feed interest-searches so discovery is morning-digest's job. NOT a greenfield ingest rewrite.

### 1.5 Corpus
- `preference-profile.json`: 2,662 bookmarks + 912 likes (3,574 total), `signal_basis: brief-relevant-only` (1,403 signal rows). Top topics: finance, dev-tools, ai-ml, startups-business, tech-industry. Full-corpus model (correct for slow-drift — keep).

### 1.6 Eval today — weaker than the "AUC 0.95" framing
- `scripts/gold_set_eval.py` runs a **15-item** frozen gold set through the real pipeline and asserts **4 pass/fail bars**. It is a valuable *regression gate* but is **not an AUC**, and 15 items can't support a rank metric. Wave 6 must grow a real eval BEFORE tuning pf.

---

## 2. Goal & Non-Goals

**Goal:** Make personal-fit a real embedding-similarity-to-positives signal (using the corpus we already built), formalize the two-brief ingest division of labor with cross-brief dedup, add bounded diversity to prevent echo-chamber, and stand up a real eval so pf can be tuned on evidence — all additive, kill-switchable, and cheap.

**Non-Goals:**
- No rewrite of `score_digest.py` base/gate/engagement/hn/author/recency/media machinery.
- No new model enum labels (more labels = more model noise).
- No per-item LLM calls added to the daily crons (cost discipline — no 15× wrapper).
- No change to X byte-identity (placement tiebreak, hn/engagement source-gating untouched).
- No live `prompt.md` / cron / launchd mutation by the swarm — those are gated main-agent steps.
- The PU logistic probe, full passive-feedback loop, and topic calibration are **P2 follow-ons**, gated on the eval showing they help — specced here but NOT in the first swarm.

---

## 3. Design

### 3.1 A1 — Rebuild `pf` affinity on embedding similarity (the flagship)
Add an embedding-similarity affinity source to `pf-score.py` computed against the existing sqlite-vec store. Formula *shape, bounds, fold, and kill-switch are unchanged* — only the affinity SOURCE changes. **Shadow is a CODE boundary, not a config hope (resolves Pass-1 Blocker #1):** the new code path is selected by an explicit mode flag and DOES NOT change live output when it merges.

**`PF_AFFINITY_MODE = {keyword | embed | shadow}`** (env `PF_AFFINITY_MODE` / `brief-config.json`, default **`shadow`** on merge):
- `keyword` — today's behavior, unchanged (the legacy affinity).
- `embed` — the new embedding affinity drives the returned `personal_fit_delta` (the promoted state).
- `shadow` (default at merge) — compute BOTH; **return the KEYWORD delta to the brief** (live output unchanged, byte-identical to today) and write the embed result ONLY to the pf-audit artifact for offline comparison. This is the structural isolation: merging the swarm's code cannot change what posts, because `shadow` returns the old number.

```
For candidate c (embedded with the same text-embedding-3-small model):
  neighbors    = sqlite-vec KNN(c, k≈50) over the positive corpus
  # vec0 default metric is L2 (VERIFIED: table is vec0(embedding float[N]) with NO distance_metric=cosine;
  # KNN ORDER BY raw distance). To get cosine, EITHER declare distance_metric=cosine on the vec table in a
  # migration, OR L2-normalize both stored + query vectors (L2 on unit vectors is monotonic with cosine).
  # The build MUST pick ONE explicitly and assert it in a test; do NOT assume cosine from a raw-distance KNN.
  # RECORD the choice as a SINGLE shared fact — a `SIFTLY_VEC_METRIC` constant (cosine|l2norm) that BOTH
  # §3.1 and §3.4-Stage-3 read — so the dedup section cannot assume a different space than A1 chose
  # (resolves Pass-2 New-Defect #3).
  sim          = cosine_from_normalized(neighbors)            # after the chosen normalization
  affinity_emb = weighted_mean( top_k(sim, k=5),
                                weight = 1.0 if neighbor is a bookmark else 0.3 )   # HKV confidence
  # keep keyword/author/format as a SMALL secondary additive term, capped at ~0.2 of affinity
  affinity     = clamp(-1, +1, affinity_emb + 0.2·affinity_keyword_legacy)
  raw          = clamp(-1, +1, affinity − PF_BASELINE)
  delta        = raw × PF_WEIGHT
pf_points = clamp(-PF_CAP, +PF_CAP, round(delta))   # PF_CAP=12 UNCHANGED
```
- **Confidence weighting moves to weights, not labels** (Hu-Koren-Volinsky): bookmark contributes at 1.0, like at 0.3, in the cosine aggregation. Label stays binary "positive."
- **Keep `PF_CAP=12`, `PF_BASELINE`, `PF_WEIGHT` (default 30), the `PF_WEIGHT=0` byte-identical kill-switch, and the always-exit-0 fail-safe sentinel.** A better signal at the same cap is the win; raising the cap is the risk.
- **Multimodal taste preserved for free:** kNN-to-positives matches a finance item to finance positives, a dev-tools item to dev-tools positives — no centroid blending.
- **Cost/perf:** candidate text must be embedded (text-embedding-3-small, ~$0.00002/1k tok — negligible) and one vec KNN per candidate (ms). Pre-warm the vec0 extension + load positive vectors ONCE per helper run (cold-load excluded from the timeout budget, as today). No per-item LLM call.
- **Fail-safe + VISIBLE source telemetry (resolves Pass-1 Blocker #2):** every run emits `affinity_source: "embed"|"keyword_fallback"|"sentinel"` into the pf-audit proof artifact. If embedding the candidate fails, the vec store is unavailable, or KNN errors → fall back to the keyword affinity AND record `affinity_source:"keyword_fallback"`. A post-promotion observability check (cron heartbeat / gold-run assertion) alerts if a live run shows `keyword_fallback`, so the silent-fallback-in-prod failure (vec extension not provisioned in the cron env — VERIFIED: `SIFTLY_SQLITE_VEC_EXTENSION_PATH` is NOT set in either cron prompt) is no longer invisible. Promotion (`PF_AFFINITY_MODE=embed`) is gated on the cron env actually provisioning the vec extension + the `affinity_source` telemetry showing `embed` on real runs.

### 3.2 A1′ — PU logistic probe (P2, specced not built)
Once A1 is live and the eval (§3.5) can score it, train a nightly logistic-regression probe (positives=label 1 with HKV sample-weights; negatives = 3–5× random feed sample, refreshed each run; SCAR → ranking correct without `/c` rescale). Emit `g(x)` as the affinity. Same fold/cap/kill-switch. **Ship only if the eval shows it beats mean-cosine.**

### 3.3 Ingest division of labor (the §1.4 delta)
- `x-feed-brief` = **followed firehose.** Trim interest-searches to the minimum; discovery is morning-digest's job. (Prompt edit = gated §7.)
- `morning-digest` = **discovery engine.** It already has HN Algolia + Perplexity + smol/Latent RSS. Add as new gather steps:
  - **Reddit AI subs** (r/LocalLLaMA, r/MachineLearning) — free 100 QPM tier; build a `scripts/gather/reddit.ts` (or `.mjs`) gatherer with a within-source engagement normalizer.
  - **GitHub Trending** — HTML scrape (no API), builder-discovery signal → `scripts/gather/github-trending.ts`.
  - **Unfollowed-topic X search** — small cached keyword/list search over accounts Ace does NOT follow, reusing the existing read-through cache mechanism; keep query set tiny (X reads are the expensive source).
- **Within-source engagement normalization** (Wilson score lower bound) before any cross-source merge — HN points ≠ Reddit upvotes ≠ X likes. Add a `scripts/lib/engagement-normalize.ts` shared helper.
- **Recency:** map onto the existing `recency_points` tiers; a daily digest wants a gentle ~12h-half-life decay, not HN's aggressive gravity. (Engine already has the right shape — no change needed beyond confirming the tier values.)

### 3.4 Cross-brief dedup
A **shared seen store** so a story can't appear in both briefs the same PT day. **Concrete design (resolves Pass-1 Blocker #3 — NO JSON fork):**
- **Storage = a dedicated sqlite table** `cross_brief_seen(pt_day TEXT, url_canon_hash TEXT, title_minhash TEXT, brief TEXT, surfaced_at TEXT, PRIMARY KEY(pt_day, url_canon_hash))` — NOT a JSON file. (A JSON file read-modify-written by two crons = last-writer-wins clobber.) **It lives in its OWN dedicated sqlite file (e.g. `~/.hermes/state/x-bookmarks/cross-brief-seen.db`), NOT `prisma/dev.db`** — the vec store loads the vec0 extension into `prisma/dev.db` (VERIFIED: `resolveDatabasePath` defaults to `prisma/dev.db`), so creating the dedup table there would force its migration to open a vec0-extension-dependent schema. Separate file = the dedup migration never touches vec0 (resolves Pass-2 New-Defect #4).
- **Atomic upsert under a transaction** (`INSERT … ON CONFLICT … ` in a `BEGIN IMMEDIATE`), so the second brief of the day reliably reads the first's writes. Define read-then-write ordering: a brief queries `WHERE pt_day=? AND url_canon_hash=?` (and a MinHash bucket scan) BEFORE selecting, then upserts its kept items.
- **Bounded:** TTL/eviction drops rows older than **N=3 PT-days** each run, so a legitimately re-surfacing story isn't suppressed forever and the store can't grow unbounded.
- **Canonicalization (precise):** lowercase host, strip `www.`, force https scheme for hashing, drop fragment, strip tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, `ref_src`, `s=…` on x.com), collapse trailing slash. Stage 1 = exact hash of the canonical URL. Stage 2 = title MinHash/SimHash near-dup (Jaccard ~0.7–0.85). Stage 3 (optional, later) = embedding-cosine headline cluster — **note: the ~0.92–0.95 threshold assumes a COSINE space; if the vec store is L2 (see §3.1), normalize first or convert — do not apply a cosine threshold to raw L2 distance.**
- Build `scripts/lib/cross-brief-dedup.ts` + the sqlite table (its own migration). Both briefs consult+update it. Wiring the briefs to call it = partly code, partly the gated prompt edit in §7.

### 3.5 Real eval (must land BEFORE/WITH A1 so A1 is measured, not assumed)
**Resolves Pass-1 Blocker #4 (circular AUC).** Scoring A1 (mean-cosine-to-positives) against *random* feed negatives is circular — random items are trivially far from the positive cloud in the same space A1 optimizes, so A1 "wins" by construction and the keyword baseline is judged on the same rigged split. The honest discriminator is **organic skips: items Ace SAW and did NOT save**, not random items.
- **P0 deliverable: label a "saw-and-didn't-save" negative set.** This is the same labeling effort §3.5 already needs to reach 150–300 items — make it explicit. Source: items that appeared in past briefs / timeline pulls and were never bookmarked/liked after the 14-day grace.
- **Feasibility (VERIFIED — promotion is structurally deferred this wave):** `origin:brief-surfaced` exists today ONLY as a profile-reinforcement circularity guard (`scripts/profile.ts`, `preference-profile.json` scoring_guidance) — there is **no dated surfaced-item provenance log**, so the count of items that are BOTH ≥14 days past surfacing AND carry provenance is effectively **~0 at P0**. Therefore: P0 builds the eval harness + STARTS logging surfaced-item provenance (a new durable log), but the saw-didn't-save negative set cannot reach ~150 until ≥14 days of provenance accrue. **`embed`-promotion is deferred by construction to a later wave** once the log matures; A1 stays `shadow` meanwhile. State this up front, don't discover it at P0.
- **If the saw-didn't-save set cannot be labeled at P0, then promotion CANNOT be decided at P0** — A1 stays `shadow` and `embed`-promotion is explicitly deferred. Say this plainly; do not promote on a circular metric.
- **Grow the labeled set** to ≥150 items (known-good / known-bad / neutral / organic-skip). Keep the existing 15-item 4-bar gate as a HARD regression check.
- **Rank metrics** (`scripts/eval/rank_metrics.py`): precision@k / nDCG@k of the brief against held-out organic saves, and AUC/ROC of pf-score separating held-out positives **from organic skips (NOT random)**.
- **A/B the affinity source:** keyword-overlap (current) vs mean-cosine (A1) vs probe (A1′) on the SAME labeled set, scored against the saw-didn't-save negatives. Ship `embed` only if it wins on nDCG/AUC against that honest split.

### 3.6 Diversity / echo-chamber mitigation
- **MMR or per-author/per-topic cap** at the morning-brief SELECT step (relevance − λ·similarity-to-already-picked). Single-pass, cheap. `scripts/lib/diversity-rerank.ts` (or fold into the existing select/guard path).
- Keep the bounded pf term (PF_CAP=12) — the literature's `λ<1` envelope says base relevance can never be fully overridden; ±12 on a ~50–70 base is well within it.

### 3.7 Passive feedback loop (P2, specced not built; circularity-safe)
- Build on the EXISTING `origin: brief-surfaced` tag + circularity guard in `preference-profile.json` scoring_guidance.
- Surfaced→saved → counts ONCE as feedback signal, NOT re-added to organic affinity. Surfaced-never-saved after 14-day grace → WEAK negative for the probe's negative set (never a hard penalty). Organic saves → the only strong positive.
- Optional exploration holdout: reserve ~1 brief slot for a low-pf/high-base item to generate unbiased signal.

---

## 4. Risks & Guards (non-negotiables)
- **Don't regress live briefs.** A1 ships behind the existing `PF_WEIGHT` knob; `PF_WEIGHT=0` already renders byte-identical. Run A1 in **shadow** (score in parallel, change nothing) against `_last_run_debug.json` for ≥3 runs, diff the OUTPUT TEXT, then promote. Mirrors the Wave-4 dry-run gate.
- **Spam/echo/rage-bait:** embedding-pf relaxes NO existing guard — `low_reach_cap`, `OFF_TOPIC_PEN`, `python_on_topic`, promo/fragment bases all fire first. pf bounded at ±12 can't rescue an off-topic/spam item over the gate. Add a gold-set hard case: a bad item that embeds NEAR a positive must still be gated out.
- **Cost discipline:** no per-item LLM calls; only candidate embedding (negligible) + vec KNN (ms). New discovery sources are free/near-free (Reddit free tier, GitHub scrape, small cached X). Heavy `last30days` stays OFF the daily cron.
- **X byte-identity:** `_placement_sort_key`, hn/engagement source-gating, forced-distribution unchanged. pf only changes `_final` via the bounded additive term, exactly as today.
- **Fail-safe everywhere:** pf-score always exits 0; embedding/vec failure → keyword fallback → base-score sentinel. The daily digest survives every failure mode.

---

## 5. Acceptance Criteria
1. `pf-score.py` gains an embedding affinity source (sqlite-vec mean-top-k, HKV-weighted bookmark 1.0 / like 0.3, keyword retained as ≤0.2 secondary) selected by `PF_AFFINITY_MODE`; PF_CAP/PF_BASELINE/PF_WEIGHT/kill-switch/exit-0-sentinel unchanged. The build picks cosine-vs-L2 explicitly and a unit test asserts the chosen metric. A real-vec e2e proves the embedding path is taken when provisioned (hard-fail if it silently demotes, per the silent-skip rule).
2. **`PF_AFFINITY_MODE=shadow` (the merge default) returns the KEYWORD delta to the brief and writes the embed result only to the pf-audit artifact** — a regression test proves brief output is byte-identical to pre-Wave-6 under `shadow`. (This is the real safety gate; AC#3's `PF_WEIGHT=0` byte-identity is a secondary kill-switch check, not the primary proof.)
3. `pf-score.py` emits `affinity_source: embed|keyword_fallback|sentinel` every run; a test proves a forced vec-failure records `keyword_fallback` (not a silent revert), and `PF_WEIGHT=0` still renders byte-identical.
4. A bad item that embeds near a positive is still gated out — **authored against A1's actual embedding space (so this case is serial-after-A1, not parallel).**
5. New gather steps (Reddit, GitHub Trending, cached unfollowed-X) produce candidates with Wilson-lower-bound within-source engagement; unit tests per gatherer + a negative case (empty/rate-limited/malformed-HTML source degrades, doesn't crash).
6. Cross-brief dedup (sqlite table, `(pt_day,url_canon_hash)` PK, atomic upsert, 3-day TTL) suppresses a story already surfaced by the other brief same-day; unit tests for a UTM-param variant, a reworded-title near-dup, AND a same-day-both-briefs concurrency/ordering test.
7. Eval: a **saw-and-didn't-save negative set is labeled** (or promotion is explicitly deferred); labeled set ≥150 items; `rank_metrics.py` emits nDCG@k + AUC against organic skips (NOT random); A/B compares keyword vs mean-cosine on that split; the 15-item 4-bar gate still passes.
8. MMR/diversity re-rank caps near-identical / same-author items at select; unit test proves 5 near-identical candidates collapse.
9. **Shadow promotion gate has a NUMERIC fail condition (resolves Pass-1 Blocker #6):** under `shadow`, the embed delta is **computed AND persisted to the pf-audit artifact every run** (not lazily) — this persisted value is the data source for the gate. A1 may promote to `embed` only after ≥3 shadow runs where **gate-crossings ÷ items_scored_that_run ≤ 10%, evaluated PER-BRIEF (digest 49/45 and x-feed 58/50 separately, never pooled), taken as the MAX over the ≥3 runs** — counting items that cross their TOP/ALSO gate in a direction they wouldn't have under keyword-pf. Ace signs off on the 3-run diff. An observe-only diff with no fail threshold is NOT acceptance. *(per-brief denominator + persisted-embed-value resolve Pass-2 New-Defects #1, #2.)*
10. `npm run verify` (tsc + lint + JS unit + e2e + Python tests + gold 4/4) exits 0. CI must provision the vec extension path or the real-vec e2e is pinned to skip-with-visible-warning (not flaky-fail).

---

## 6. Phasing
**Write-scope disjointness (resolves Pass-1 Blocker #5 + Required-Change #7):** all of `scripts/gather/reddit.*`, `scripts/gather/github-trending.*`, `scripts/lib/engagement-normalize.*`, `scripts/lib/cross-brief-dedup.*` (+ its migration), `scripts/lib/diversity-rerank.*`, `scripts/eval/rank_metrics.py` are NEW files with disjoint write scope → genuinely parallel. **`pf-score.py` is the ONLY shared mutable surface and is touched solely by the A1 task.** No task regenerates `score_digest.py` or the vec schema (the dedup migration is its OWN new table, not the bookmark vec table).

- **P0a — parallel wave** (disjoint new files, no live mutation, swarm-safe): the 3 gatherers, engagement-normalize lib, cross-brief-dedup lib + migration, diversity-rerank lib, and the eval labeling+metrics harness (`rank_metrics.py` + the saw-didn't-save negative set).
- **P0b — SERIAL chain** (must NOT be parallel — all depend on the A1 affinity contract): **(i) A1 affinity rewrite in `pf-score.py` (shadow default) → (ii) the AC#4 adversarial gold case authored against A1's embedding space + the A/B harness wired to A1 → (iii) shadow runs.** One owner for `pf-score.py`; the gold-case and A/B tasks start only after A1 lands.
- **P1 (gated main-agent, with Ace):** promote A1 `shadow`→`embed` after ≥3 clean shadow runs meeting the AC#9 ≤10% tolerance + the cron env provisions the vec extension + `affinity_source:embed` telemetry confirmed · the `prompt.md` edits wiring briefs to the dedup store + trimmed x-feed searches (Hard-Config diff+confirm) · re-derive gates if the distribution shifts.
- **P2 (follow-on, eval-gated):** PU logistic probe (A1′) · full passive feedback loop · topic calibration · optional weekly `last30days` deep-sweep.

---

## 7. Hard-Config / Gated Steps (NOT swarm work)
- Any edit to `~/.hermes/state/cron/morning-digest/prompt.md` or `x-feed-brief/prompt.md` (wiring dedup, trimming searches, the pf merge instructions) → Apollo shows Ace the exact diff, backs up, confirms, applies, verifies. Gated.
- Promoting A1 from shadow → live (changing what the brief actually posts) → gated, after ≥3 clean shadow runs Ace reviews.
- No launchd/cron schedule changes by the swarm.

---

## 8. Blocker-Resolution Map (Pass-1 BLOCK → v2)
| # | Pass-1 Blocker | Resolution in v2 |
|---|---|---|
| 1 | A1 can silently change live output before promote (shadow was config-hope) | §3.1 `PF_AFFINITY_MODE={keyword|embed|shadow}`, default `shadow` returns the KEYWORD delta — shadow is now a CODE boundary; merging cannot change posts. AC#2 proves byte-identity under `shadow`. |
| 2 | Invisible keyword fallback in prod (vec extension unset in cron env — verified) | §3.1 `affinity_source` telemetry into pf-audit + post-promotion alert on `keyword_fallback`; promotion gated on cron env provisioning the vec extension. AC#3. |
| 3 | Cross-brief dedup shared-JSON race/clobber, unbounded, JSON-or-sqlite fork | §3.4 sqlite table, `(pt_day,url_canon_hash)` PK, atomic `BEGIN IMMEDIATE` upsert, 3-day TTL, precise canonicalization. JSON fork dropped. AC#6 + concurrency test. |
| 4 | Circular AUC (A1 vs random negatives = win-by-construction) | §3.5 negatives = **saw-and-didn't-save organic skips**, NOT random; labeling that set is a P0 deliverable; if unlabelable, promotion deferred. AC#7. |
| 5 | A1 / eval / gold-case not disjoint — serially dependent | §6 split into P0a parallel (disjoint new files) + P0b SERIAL chain (A1 → gold-case+A/B → shadow). Write-scope disjointness stated; `pf-score.py` sole shared surface. |
| 6 | AC#8 shadow diff was observe-only, no fail condition | AC#9: numeric tolerance **X=10%** of items crossing a gate in a direction they wouldn't under keyword-pf, across ≥3 runs, Ace signs off. |

**Required-Change #7** (assert gatherer/lib write-scope disjointness, no score_digest/vec-schema regen) → folded into §6 header. **OQ2 (cosine vs L2)** → verified L2 default, §3.1 now requires an explicit metric choice + assertion. **OQ5 (vec ext in cron env)** → verified NOT set; §3.1 promotion gate addresses it.

### Pass-2 (APPROVE WITH CHANGES) — 5 new-defects resolved → v3
| # | Pass-2 New Defect | Resolution in v3 |
|---|---|---|
| 1 | AC#9 10% tolerance had no denominator / pooled-vs-per-brief ambiguity | AC#9 now: `gate-crossings ÷ items_scored_that_run ≤ 10%`, **per-brief** (never pooled), MAX over ≥3 runs. |
| 2 | Shadow runs might not compute/persist the embed delta the AC#9 diff needs | AC#9 now requires the embed delta is **computed AND persisted to pf-audit every shadow run** as the gate's data source. |
| 3 | Stage-3 dedup could assume a different metric space than A1 chose | §3.1 records the choice as a single shared `SIFTLY_VEC_METRIC` constant both §3.1 and §3.4 read. |
| 4 | Dedup table in `prisma/dev.db` would force its migration to open the vec0-extension schema | §3.4: dedup table lives in its OWN sqlite file (`cross-brief-seen.db`), NOT `prisma/dev.db` (verified vec store is in dev.db). |
| 5 | Saw-didn't-save eligible pool asserted, not sized | §3.5: verified no dated provenance log exists → pool ~0 at P0; `embed`-promotion **deferred by construction** this wave; P0 starts the provenance log. |

All 6 Pass-1 blockers verified RESOLVED in the section text (each quoted in `docs/reviews/wave6-review-pass2.md`); the 5 Pass-2 defects were spec-tightening (none re-opened a blocker or risked live output — the `shadow`-default code boundary means a merge can't change what posts). **v3 is APPROVED for swarm planning.**
