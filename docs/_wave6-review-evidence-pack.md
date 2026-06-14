# Wave 6 PRD — Review Evidence Pack (ground truth; trust as fact)

This is the ONLY source code you need. Do not open large files. Every line below was live-verified 2026-06-13.

## scripts/pf-score.py — affinity is KEYWORD overlap, NOT embeddings (the central premise)
```python
# :24-25
DEFAULT_WEIGHT = 30.0
DEFAULT_BASELINE = 0.18
# :30-38  hand-written topic alias dict
TOPIC_ALIASES = { "dev-tools":[...], "ai-ml":[...], "startups-business":[...], "finance":[...], "security-privacy":[...], "productivity":[...], "politics":[...] }
# :231-242  THE affinity formula — keyword/author/format overlap, no embeddings anywhere
affinity = 0.42 * topic_score + 0.28 * author_score + 0.18 * format_score - 0.18 * downrank_score
if source == "x" or X_STATUS_RE.search(url): affinity += 0.08
affinity = max(-1.0, min(1.0, affinity))
raw = max(-1.0, min(1.0, affinity - baseline))   # baseline default 0.18
delta = raw * weight                              # weight default 30
# Always exits 0; any error -> {"ok":false,"base_score_only":true,"items":[]} sentinel (:41-42, :294-296)
```
NOTE: the 3,574-item embedded corpus (text-embedding-3-small, 1536-dim) lives in sqlite-vec and is used by src/lib/vec.ts for SEARCH only — pf-score.py never calls it.

## scripts/score_digest.py — engine; pf is the ONLY personalization term, capped 12
```python
# :136
PF_CAP = 12                    # down from today's uncapped ~24.6
# :269-276
def pf_points(item):
    try: d = float(item.get("personal_fit_delta") or 0.0)
    except (TypeError, ValueError): d = 0.0
    return int(round(max(-PF_CAP, min(PF_CAP, d))))   # PF_WEIGHT=0 upstream -> delta 0 -> byte-identical
# :485 final assembly
pre = base + sub + eng + auth + pf + rec + med - off   # auth is topic-gated; off=OFF_TOPIC_PEN[eff_on_topic]
# gates: x-feed TOP=58/ALSO=50 ; digest TOP=49/ALSO=45
# hn_points source-gated (source==hackernews), topic-gated, cap 14; _placement_engagement keeps X tiebreak byte-identical
```

## src/lib/vec.ts — sqlite-vec KNN store already exists (this is what A1 will call)
```ts
// :4   export type VecMode = 'sqlite-vec' | 'bruteforce'
// :48  const SQLITE_VEC_ROWIDS_TABLE = 'bookmark_vec_idmap'   (renamed off vec0's shadow table)
// :105 this.mode = loadStatus.error ? 'bruteforce' : 'sqlite-vec'   (silent demote on any failure)
// :358-366  KNN query: SELECT m.bookmark_id, knn.distance ... JOIN bookmark_vec_idmap m ON m.rowid = knn.rowid
// vec0 needs INTEGER rowid bound as BigInt (better-sqlite3 binds float64 -> rejected -> demote)
```
A real-vec e2e HARD-FAILS (throws) if SIFTLY_SQLITE_VEC_EXTENSION_PATH is set but the store demotes to brute-force (existing gate, e2e/).

## Brief wiring (LIVE CRONS — editing these prompt.md files is a Hard-Config gated action)
- morning-digest/prompt.md ~234: calls scripts/pf-audit.py (timeout wrapper) -> pf-score.py; merges personal_fit_delta onto base_score; PF_WEIGHT=0 skips entirely.
- x-feed-brief/prompt.md ~82: same pf-audit call.
- morning-digest ALREADY gathers: gather_perplexity, gather_hn (HN Algolia front_page hitsPerPage=30), gather_smol_latent (smol.ai RSS + Latent Space feed), gather_x. Dedupes/clusters keep-best-source.
- x-feed-brief pulls 24h reverse-chron home timeline (read-through cache ~$6.50, 20-page ceiling) + a few interest searches.

## Eval today
- scripts/gold_set_eval.py: 15-item frozen gold set, 4 pass/fail bars (Bar1 no known_bad>=TOP_GATE; Bar2 every known_good>=ALSO_GATE; Bar3 no neutral>=TOP_GATE; Bar4 no inversion). Gates pinned 49/45. It is NOT an AUC; 15 items can't support a rank metric.

## Corpus / profile
- preference-profile.json: 2,662 bookmarks + 912 likes (3,574), signal_basis brief-relevant-only (1,403 rows). Full-corpus model. Top topics: finance, dev-tools, ai-ml, startups-business, tech-industry.
