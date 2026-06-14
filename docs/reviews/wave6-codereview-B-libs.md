# Independent Senior Review

## Verdict
APPROVE WITH CHANGES

## Findings (severity-ordered)

### HIGH

**H1 — DEDUP: URL canonicalization does NOT strip `utm_*`, `fbclid`, `ref`, `x.com s=` correctly because tracking-only params survive when the value sort happens — actually wrong on a different axis: it never lowercases the *path*, but the bigger miss is the param set itself.** (cross-brief-dedup.ts, `canonicalizeCrossBriefUrl`)
The prompt asserts the canonicalizer strips `utm_*/fbclid/ref/x.com s=`. Verifying against code: `TRACKING_PARAMS = {'fbclid','gclid','ref','ref_src'}` — but **`utm_*` is handled via prefix check (`lowerKey.startsWith('utm_')` ✓), `fbclid` ✓, `ref` ✓, `x.com s` ✓**. So the *named* set passes. **The real bug: `gclid` is stripped but the contract didn't ask for it (harmless), while `igshid`, `mc_cid`, `mc_eid`, and bare `s=` on non-x.com hosts are NOT stripped.** The missed branch: two briefs surface the same article, one via `?s=09` from a non-x.com share (e.g. a t.co-resolved nitter/fxtwitter host, or `twitter.com` rather than `x.com`) — `twitter.com` is never normalized to `x.com`, so `s=` survives there and the two URLs hash differently → **false-split, the same item surfaces twice across briefs.** Tests almost certainly only feed canonical `x.com`.

**H2 — DEDUP: `www.` stripping is wrong for any `www2.`/`wwwN.` and, more importantly, host is lowercased but the `www.` slice uses `slice(4)` which is correct for `www.` only — the genuine HIGH is the missing `m.`/`mobile.` and that `twitter.com`≠`x.com` are treated as distinct hosts.** (canonicalizeCrossBriefUrl)
Same article on `x.com/foo/status/1` vs `twitter.com/foo/status/1` vs `mobile.twitter.com/...` produce three distinct `urlCanonHash` values → cross-brief dedup silently fails for the single most common X surface. Title-MinHash is the only backstop, and for short tweet-style titles MinHash over a tiny token set is unstable. Missed branch: host-equivalence classes.

**H3 — DIVERSITY: `DEFAULT_LAMBDA = 10` makes MMR degenerate into pure diversity, not relevance/diversity balance.** (diversity-rerank.ts)
Standard MMR is `λ·rel − (1−λ)·sim` with λ∈[0,1]. Here the formula is `relevance − lambda·maxSim` with **lambda defaulting to 10**. Since cosine sim is clamped to [0,1] and relevance is typically also ~[0,1], a single picked item with sim=0.1 imposes a penalty of 1.0 — swamping any relevance signal. **Effect: the reranker is almost entirely diversity-driven by default**; the highest-relevance item can be evicted by a marginally-less-similar lower-relevance item. Tests that use orthogonal embeddings (sim=0) never exercise this because the penalty is always 0. Missed branch: any candidate set with non-zero pairwise similarity. This is a tuning bug that will visibly degrade brief quality.

**H4 — DIVERSITY: the replacement loop does not re-evaluate `maxSimilarityToPicked` after evictions, so `picked` can hold stale similarity/MMR scores and violate the per-author cap transiently.** (diversityRerank main loop)
Each candidate is scored against the *current* `picked` set, then possibly swapped in by evicting `lowestRankedIndex`. But already-picked items' `maxSimilarityToPicked` (and thus `mmrScore`) are **never recomputed** when the set composition changes. The final returned `mmrScore`/`diversityPenalty` fields can be inconsistent with the actually-returned set (an item scored against a peer that was later evicted keeps the now-wrong penalty). For pure ranking the *membership* may still be plausible, but **the emitted scores are not trustworthy** and any downstream consumer treating `mmrScore` as authoritative is misled. Also: `decrementAuthor` then re-set can briefly let a 3rd item from a capped author sit in `picked` between eviction and the cap check on the *next* iteration — but since the cap is checked at top of loop using live counts, this is bounded. Missed branch: limit-bound sets with churn.

### MED

**M1 — DEDUP: `evictExpiredUnsafe` uses lexicographic `pt_day < cutoff` which is correct for `YYYY-MM-DD`, but `shiftPtDay` computes the cutoff in **UTC** while `ptDayForDate` computes the day in **America/Los_Angeles**.** (cross-brief-dedup.ts)
TTL boundary drift: a PT day string is shifted by `setUTCDate`, which is calendar-correct for the string arithmetic, so this one is actually fine — **but** the result is `< cutoff`, i.e. with `ttlDays=3` and today=`2026-06-13`, cutoff=`2026-06-10`, and rows with `pt_day='2026-06-10'` are **kept** (not `<`). So effective retention is 3 full days + today = 4 calendar days, not 3. Missed branch: exact-boundary eviction test. Bounded and arguably intended, but it contradicts "3-day TTL."

**M2 — DEDUP atomicity: `checkAndRemember` is correct (single BEGIN IMMEDIATE), but `check()` is a non-transactional read.** (CrossBriefDedupStore)
Two concurrent briefs each calling `check()` then later `remember()` (rather than `checkAndRemember`) can both see "not duplicate" and both insert — the upsert's `ON CONFLICT(pt_day,url_canon_hash)` saves them from a hard error on URL match, but a **title-only** duplicate has no unique constraint, so both rows persist → the dedup intent is lost for title matches under the split check/remember path. The atomic path is fine; the **exposed non-atomic `check`+`remember` API is a footgun.** Missed branch: concurrent title-near-dup via the two-call API. Recommend documenting `checkAndRemember` as the only concurrency-safe entry, or removing standalone `check`.

**M3 — DEDUP: store IS its own sqlite file** ✓ (`cross-brief-seen.db`, not `prisma/dev.db`) — verified, no bug. Noting because you asked.

**M4 — NORMALIZER: `trials = Math.max(n, successes)` silently rewrites the denominator, breaking cross-source comparability.** (engagement-normalize.ts)
`normalizeEngagement('reddit', 500, 0)` yields `successes=500, trials=500` → `phat=1.0` → Wilson LB collapses toward a high value driven entirely by `z²` terms. Because the gatherers pass `n = raw + comments` (Reddit) or `stars+forks` (GH), `n` is **not a Bernoulli trial count** — it's a heuristic magnitude. Feeding a non-trial `n` into a Wilson interval is **mathematically meaningless across sources**: HN's `n` and GH's `n` have different semantics, so the "normalized" outputs are not comparable, defeating the stated purpose. The math is internally correct and monotonic in `successes` for fixed `trials`, and n=0/div-by-zero are guarded. But the **modeling is wrong**: this is a confidence-interval-shaped number, not a comparable engagement score. Missed branch: any cross-source ranking test (green tests likely check single-source monotonicity only).

**M5 — NORMALIZER: non-monotonic in `n`.** (wilsonLowerBound)
For fixed `successes`, increasing `trials` *lowers* `phat` but *tightens* the interval — the LB is not monotonic in `n`. Two items with identical `raw` but different `n` (e.g. same upvotes, different comment counts in Reddit's `sampleSize = raw+comments`) get reordered by comment volume in a non-obvious direction. Likely unintended coupling. Missed branch: fixed-raw / varying-n pair.

**M6 — GATHERERS: GitHub-trending HTML scrape is brittle on the `stars today` extraction.** (github-trending.ts, `parseArticle`)
`starsToday` is parsed by regex `/[\d,.]+\s+stars?\s+today/i` over `stripTags(block)` — but GitHub localizes and sometimes renders "X stars today" with a leading SVG/`·` or non-breaking space already collapsed; more fragile, `parseCount` strips **both** `,` and `.` indiscriminately, so `1.2k` → `12` (k-suffix dropped) and `1,234` → `1234` (correct). **`1.2k stars` is read as 12 stars.** Same bug in `extractLinkCount` for stargazers/forks. Missed branch: any repo with a `k`/`m` abbreviated count — i.e. essentially every genuinely trending repo. This silently under-weights the most popular repos. Both gatherers do correctly **degrade to `[]`+warn** on 429/403/empty/malformed ✓ and import `normalizeEngagement` with a sane fallback ✓.

**M7 — EVAL: `roc_curve` / `auc_score` raise on any missing score, but `evaluate_labeled_rows` calls `auc_score` for *every* `score_field` including ones absent from organic-skip rows → a single skip row missing one A/B field aborts the whole eval.** (rank_metrics.py)
Mixed labeled sets where only some rows carry the `probe` score (common during A/B rollout) make the entire run throw `ValueError`, not skip-the-field. Missed branch: partial score coverage. Prefer per-field row filtering (only rows that have the field) with an explicit min-count guard, rather than all-or-nothing.

### LOW

**L1 — EVAL vacuous-pass guard is good but incomplete.** (`_normalize_rows`) Requires ≥1 positive and ≥1 organic_skip ✓ and rejects random negatives ✓ — solid. But `ndcg_at`/`precision_at` can still return a degenerate `1.0` when there's exactly 1 positive and 1 skip and the positive outranks — that's a 2-row "perfect" score. Consider a minimum cohort size (e.g. ≥5 positives) before reporting nDCG to avoid celebrating noise. Missed branch: tiny-cohort vacuous high score.

**L2 — PROVENANCE: append-safe ✓ but unbounded growth per-day-file with no rotation/compaction.** (surfaced-provenance.ts) One JSONL per PT day is naturally bounded by daily volume and won't grow unboundedly within a file, but **no retention/cleanup** exists — the directory grows forever. Matches "append-safe" but not "no unbounded growth" at the directory level. The `maturityDays >= 14` floor is enforced ✓. Add a documented retention sweep.

**L3 — PROVENANCE: `surfacedProvenancePath` uses `isoDate(now)` in **UTC**, while the rest of the system keys on PT day.** A brief surfaced at 23:30 PT lands in the *next* UTC day's file — provenance file boundaries won't line up with dedup `ptDay`. Cosmetic but will confuse the eval join. Missed branch: late-PT-evening surfacing.

**L4 — REDDIT: `redditUrl` resolves relative permalinks against `reddit.com`, fine, but `url ?? permalink ?? ''` can emit `''` when both resolve null yet `title` passed the guard** — actually guarded (`!url && !permalink` rejects), so `''` is unreachable. No bug; noted to confirm I checked.

**L5 — DIVERSITY: `normalizeLimit` throws on non-integer `limit`, but the default `options.limit ?? candidates.length` is always an int, and `lambda`/`cap` validation is sound. Empty input → `[]` ✓, single item ✓, all-identical embeddings → first wins, rest penalized (with λ=10, harshly) — correct membership, see H3.**

## Required Changes
1. **(H1/H2)** Canonicalizer: fold `twitter.com`, `mobile.twitter.com`, `www.twitter.com`, `m.twitter.com` → `x.com`; strip bare `s` on the X host family (not just `x.com`); add `igshid`, `mc_cid`, `mc_eid` to `TRACKING_PARAMS`; strip `m.`/`mobile.` host prefixes generally or document the limitation. Add tests for cross-host equivalence.
2. **(H3)** Change MMR default to `λ∈[0,1]` semantics (`λ·rel − (1−λ)·sim`) with default ~0.7, OR document that `lambda` here is a raw penalty weight and set a sane default (e.g. 0.3–0.5) — `10` is wrong either way. Add a test with non-orthogonal embeddings asserting relevance still dominates.
3. **(H4)** Either recompute `maxSimilarityToPicked`/`mmrScore` for retained items after each eviction, or clearly mark those fields as "score-at-insertion, not final" so downstream doesn't trust them. Add a churn test (limit < N, correlated embeddings).
4. **(M4/M5)** Stop feeding heuristic magnitudes into a Wilson interval as `trials`. Either (a) pass a real per-source observation count, or (b) replace with a documented cross-source normalizer (log-scaled percentile within source). At minimum, document that outputs are **not** cross-source comparable and remove the `trials=max(n,successes)` silent rewrite. Add a cross-source ordering test.
5. **(M6)** Fix `parseCount` to honor `k`/`m`/`b` suffixes (`1.2k`→1200) and stop stripping `.` before suffix handling. Add fixtures with `1.2k`/`3.4k stars today`.
6. **(M7)** Make per-field AUC/ROC filter to rows that have that field, with an explicit minimum-pairs guard; don't abort the whole eval on partial coverage.
7. **(M1)** Fix TTL to strict `<= cutoff` semantics or set cutoff to `currentPtDay − ttlDays + 1` so "3-day TTL" retains exactly 3 days. Add a boundary-day eviction test.
8. **(M2)** Document/guard that `checkAndRemember` is the only concurrency-safe path; make standalone `check` clearly advisory.
9. **(L1/L2/L3)** Add a tiny-cohort guard to nDCG reporting; add a retention sweep for provenance files; switch provenance file dating to PT day to match dedup keys.

## Lens Notes
- I verified each claim against the supplied source. Where the prompt's premise held (store is its own sqlite file M3; gatherers degrade-not-throw M6; n=0 guarded M4; pure-function diversity has no global mutation), I said so plainly rather than inventing a defect.
- The tests-pass-but-branches-miss pattern clusters in three places: **non-orthogonal-similarity** (H3/H4 never fire when test embeddings are orthogonal), **cross-host/cross-source** (H1/H2/M4 never fire with single-host/single-source fixtures), and **abbreviated counts** (M6 never fires with raw integer fixtures). Those three fixture gaps are where I'd aim new tests first.
- Highest blast-radius for live briefs: **H3 (λ=10)** — it's not a crash, it's a silently-bad ranking that will ship looking green. That alone is why this is APPROVE-WITH-CHANGES and not a clean APPROVE.
- Honesty caveat: H1/H2 severity assumes X/twitter URLs are a meaningful share of cross-brief candidates (they are, given the bookmark provenance). If the dedup store only ever sees already-`x.com`-normalized URLs upstream, demote both to MED.