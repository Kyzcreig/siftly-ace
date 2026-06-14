# Wave 6 — Swarm Plan (PRD-wave6-embedding-pf-ingest-split-dedup-eval.md v3, APPROVED)

**Builder:** Daedalus (`openai-codex/gpt-5.5` xhigh) · **Reviewer:** Opus-4-8 (2-pass senior diff-review per task) · **Orchestrator/integrator:** Apollo
**Board:** dedicated `wave6` board (`kanban boards create wave6 --switch`) so tasks don't mix with the `default` board.
**Workspace:** `dir:/Users/alexgierczyk/Projects/siftly-ace` (the real fork — verified: has package.json/src/prisma, remote=Kyzcreig/siftly-ace).
**Standing rule:** SLICE + LOAD BLOCKED. Do NOT dispatch until Ace's explicit go. Create every task, then `kanban block` it, then verify `⊘` in `kanban ls`.

## Bucket split (per prd-swarm-planner §2.10 / §1.1b)
- **Bucket A (swarm lanes — disjoint NEW files, zero live mutation):** T1–T6 below.
- **Bucket B/C (gated main-agent, Ace present — NOT swarm):** A1 shadow→embed promotion; the `prompt.md` edits wiring briefs to dedup + trimmed x-feed searches (Hard-Config); cron-env vec-extension provisioning; gate re-derivation. These are §7 of the PRD and are NOT tasks here.

## Write-scope disjointness (the gate for parallelism)
`pf-score.py` is the ONLY shared mutable surface → owned solely by T-A1. Everything else is NEW files. No task regenerates `score_digest.py` or the vec schema. The dedup table is its OWN sqlite file (`cross-brief-seen.db`), not `prisma/dev.db`.

---

## P0a — PARALLEL WAVE (5 lanes, disjoint new files, dispatch together after go)

### T1 — Reddit + GitHub-Trending gatherers
- **Write scope:** `scripts/gather/reddit.ts`, `scripts/gather/github-trending.ts`, their `__tests__/`. NEW files only.
- **Task:** Reddit gatherer (r/LocalLLaMA, r/MachineLearning via free JSON API) + GitHub Trending (HTML scrape). Each emits normalized candidates `{title,url,summary,source,authorHandle,engagement_raw,created_at}`.
- **Eval:** unit test per gatherer (fixture → parsed candidates); NEGATIVE case: empty / rate-limited (429) / malformed-HTML → degrades to `[]` + logged warn, never throws. (PRD AC#5)
- **Depends on:** T2 (engagement-normalize lib) for the normalizer import — coordinate the interface; if T2 not landed, stub the import behind the agreed signature.

### T2 — Within-source engagement normalizer
- **Write scope:** `scripts/lib/engagement-normalize.ts` + `__tests__/`. NEW.
- **Task:** Wilson score lower-bound normalizer; per-source (HN points / Reddit upvotes / X likes) → comparable [0,1]. Exported `normalizeEngagement(source, raw, n)`.
- **Eval:** unit test: a 3-upvote-from-nowhere item scores below a 200-upvote item; cross-source monotonicity. (PRD §3.3)

### T3 — Cross-brief dedup lib + dedicated sqlite store
- **Write scope:** `scripts/lib/cross-brief-dedup.ts` + its migration + `__tests__/`. NEW. Store = OWN file `~/.hermes/state/x-bookmarks/cross-brief-seen.db` (NOT prisma/dev.db).
- **Task:** `cross_brief_seen(pt_day,url_canon_hash,title_minhash,brief,surfaced_at)` PK `(pt_day,url_canon_hash)`; atomic `BEGIN IMMEDIATE` upsert; 3-day TTL eviction; precise URL canonicalization (lowercase host, strip www/fragment/utm_*/fbclid/gclid/ref/ref_src/x.com `s=`, force https, collapse trailing slash); title MinHash.
- **Eval:** unit tests — UTM-param variant dedupes; reworded-title near-dup (Jaccard 0.7–0.85) dedupes; **same-day-both-briefs concurrency/ordering test** (brief2 reads brief1's writes); TTL drops >3-day rows. (PRD AC#6)

### T4 — Diversity / MMR re-rank lib
- **Write scope:** `scripts/lib/diversity-rerank.ts` + `__tests__/`. NEW.
- **Task:** MMR (relevance − λ·max-sim-to-picked) + per-author cap, single-pass, for the select step. Pure function (does not mutate engine globals).
- **Eval:** unit test — 5 near-identical / same-author candidates collapse to ≤ the cap. (PRD AC#8)

### T5 — Eval harness: rank metrics + provenance log + labeled-set scaffold
- **Write scope:** `scripts/eval/rank_metrics.py`, `scripts/eval/__tests__` (or pytest), a NEW surfaced-item provenance logger `scripts/lib/surfaced-provenance.ts` + its log path. NEW files. Does NOT touch pf-score.py or score_digest.py.
- **Task:** precision@k / nDCG@k + AUC/ROC computed against an organic-skip negative set (NOT random); A/B scaffold to compare keyword vs mean-cosine vs probe affinity columns on the same labeled set. START logging surfaced-item provenance (dated) so the saw-didn't-save set can mature (≥14d). Grow/format the labeled-set file to ≥150 slots.
- **Eval:** unit tests on rank_metrics with a synthetic labeled set (known nDCG/AUC); provenance logger writes a dated record; the existing 15-item 4-bar `gold_set_eval.py` still passes (regression).
- **Note:** promotion is structurally deferred (provenance pool ~0 at P0) — this lane builds the measurement apparatus, not the promotion decision.

---

## P0b — SERIAL CHAIN (must NOT run parallel; all depend on the A1 affinity contract in pf-score.py)

### T-A1 — Embedding personal-fit in pf-score.py (shadow default)  [runs FIRST, alone on pf-score.py]
- **Write scope:** `scripts/pf-score.py`, `scripts/__tests__/pf-score*.{py,test.ts}`, a vec-metric constant module if needed. SOLE owner of pf-score.py.
- **Task:** add `PF_AFFINITY_MODE={keyword|embed|shadow}` (default `shadow`); embed affinity = HKV-weighted (bookmark 1.0 / like 0.3) mean-top-k (k=5 of KNN≈50) over the sqlite-vec positive corpus via `src/lib/vec.ts`; keyword affinity retained as ≤0.2 secondary; pick cosine-vs-L2 EXPLICITLY (record `SIFTLY_VEC_METRIC` constant) and assert it in a test; emit `affinity_source: embed|keyword_fallback|sentinel`; under `shadow` RETURN the keyword delta but COMPUTE+PERSIST the embed delta to the pf-audit artifact every run. Keep PF_CAP=12 / PF_BASELINE / PF_WEIGHT / PF_WEIGHT=0 byte-identical / always-exit-0 sentinel.
- **Eval (PRD AC#1,2,3):** (a) unit test asserts the chosen vec metric; (b) real-vec e2e proves embed path taken when provisioned (hard-fail on silent demote); (c) `shadow` returns byte-identical keyword delta (regression vs pre-Wave-6); (d) forced vec-failure records `keyword_fallback`, not a silent revert; (e) PF_WEIGHT=0 byte-identical.

### T-A2 — Adversarial gold case + A/B wiring  [runs AFTER T-A1 lands]
- **Write scope:** `docs/eval/digest-gold-set.json` (add cases), `scripts/eval/ab_affinity.py` (or extend T5's harness). Depends on T-A1's embedding space existing.
- **Task:** author a bad item that EMBEDS NEAR a positive but must still be gated out (proves pf can't rescue off-topic/spam over the gate); wire the A/B harness to score keyword vs embed affinity from the real T-A1 code.
- **Eval (PRD AC#4,7):** the near-positive bad item stays below the gate; A/B runs on the labeled set; gold 4-bar still green.

---

## Model / review
- coding_model: `openai-codex/gpt-5.5`, reasoning xhigh (Daedalus profile).
- review_model: `claude-opus-4-8`, 2-pass senior diff-review of the INTEGRATED diff per task (Apollo runs it; verify findings before fixing; prove the hard-fail gates actually FAIL on bad input).
- Apollo integrates, runs `npm run verify` (tsc+lint+JS unit+e2e+Python+gold) itself (not worker self-report), then merges.

## Safety gates that stay main-agent / Ace-present (NOT swarm)
- A1 `shadow`→`embed` promotion (after ≥3 shadow runs ≤10% per-brief gate-cross + vec ext provisioned + `affinity_source:embed` confirmed).
- Hard-Config `prompt.md` edits (dedup wiring, x-feed search trim) — diff+confirm+backup.
- Any cron/launchd change.

## Dispatch dependency DAG
- P0a: T1, T2, T3, T4, T5 — parallel (T1 imports T2's interface; agree signature first or T1 stubs it).
- P0b: T-A1 → T-A2 (serial).
- All loaded BLOCKED; unblock + `dispatch` only on Ace's explicit go.
