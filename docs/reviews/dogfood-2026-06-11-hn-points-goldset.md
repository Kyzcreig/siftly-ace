# Dogfood Report — 2026-06-11 (hn_points crowd-signal + gold-set cert harness)

**Scope:** Adversarial QA of today's artifacts — the `hn_points` crowd-signal term in
`score_digest.py` and the §6a gold-set certification harness (`gold_set_eval.py`). These are
CLI/scoring artifacts (not a web app), so dogfood = malformed-input fuzzing + harness
robustness against tampered/hollow fixtures.

## Method
- Fuzzed `hn_points` with 9 adversarial input types (missing, 0, negative, string, garbage,
  float, huge, bool, list).
- Probed the X byte-identical guarantee with a stray `hn_points` key on an X tweet.
- Tampered the gold set (missing label, invalid enum, tanked known_good, empty corpus) to
  confirm the harness fails loud, not silent.

## Findings & resolutions

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | **Medium** | An X tweet carrying a stray `hn_points` key would be hijacked onto the HN points curve (65→69), because `_hn_points` keyed only on the field's presence. Latent footgun even though live ingest never co-populates. | **Source-gated** `_hn_points`: only `source∈{hackernews,hn}` uses the curve. X byte-identical guarantee is now structural, not an assumption. Also excluded `bool` (int subclass). Selftest assertion added. |
| 2 | **Medium** | An empty/hollow gold set passed all 4 bars **vacuously** (exit 0) — would green-light a cutover against nothing. Silent-pass violates the engine's "no silent failure" rule. | Added a **non-emptiness corpus floor**: ≥10 real items with ≥1 each of known_good/known_bad/neutral, else `passed=False` with a visible FAIL line. 3 regression tests (empty, single-class, ratified clears). |
| — | Pass | Missing/0/negative/garbage/list `hn_points` → safely 0, no crash. Huge value → capped at 14. String/float coerce correctly. | No action — robust by construction. |
| — | Pass | Tampered fixtures (missing label, invalid enum, tanked known_good) all surfaced as validate errors / red bars. | No action — fails loud as designed. |
| — | Pass | Off-topic HN story at 5,000 pts still scored < ALSO (topic gating dominates crowd signal). | No action — correct safety property. |

## Result
2 real hardening fixes shipped. Full verify gate green: 180 JS + 10 e2e + 28 Python + gold 4/4, exit 0.
No crashes found; no silent-pass paths remain.
