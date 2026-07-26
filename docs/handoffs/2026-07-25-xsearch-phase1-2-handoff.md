# HANDOFF — X-API → grok/x_search migration, Phases 1 & 2

**Branch:** `feat/xsearch-adapter` (pushed to `Kyzcreig/siftly-ace`, **NOT merged** — Apollo reviews first)
**Date:** 2026-07-25
**Scope delivered:** Phase 1 (adapter) + Phase 2 (morning-digest cutover). x-feed untouched (Phase 4/5).

---

## 1. What changed

| File | Status | What |
|---|---|---|
| `scripts/xsearch_gather.py` | **new** (~700 ln) | The adapter. Operator-syntax gather → pipeline candidate rows. |
| `scripts/__tests__/xsearch_gather_test.py` | **new** | 70 tests, one class per blocker, each paired with a RED-proof. |
| `scripts/red_prove_xsearch.py` | **new** | Mutation harness — reverts each guard, asserts the test goes RED. |
| `scripts/verify_morning_prompt_cutover.py` | **new** | Structural lint for the prompt cutover. |
| `~/.hermes/state/cron/morning-digest/prompt.md` | **modified** | Phase-2 cutover (X gather → x_search). |
| `deploy/cron-prompts/morning-digest.prompt.md` | **modified** | Repo snapshot re-synced from live. |

**Backup:** `~/.hermes/state/cron/morning-digest/prompt.md.bak.20260725-205020-pre-xsearch`
**Rollback:** `cp` that backup over `prompt.md`, or uncomment the preserved paid block. The paid
`x_api_search()` path is **kept verbatim**, commented + dated, per the spec.

---

## 2. Test counts — personally observed

| Gate | Result |
|---|---|
| `npm run verify` | **exit 0** |
| ├ `tsc --noEmit` | clean |
| ├ `eslint --max-warnings 14` | 14 problems (0 errors, 14 warnings) — **pre-existing**, at the cap |
| ├ `vitest run` | **335 passed, 8 skipped** (39 files passed, 1 skipped) |
| ├ `vitest run --dir e2e` | **10 passed, 3 skipped** |
| ├ `pytest scripts/__tests__/` | **129 passed** |
| └ `gold_set_eval.py` | **PASS 4/4 bars** |
| `pytest xsearch_gather_test.py` | **70 passed** |
| python baseline without my file | **59 passed** (59 + 70 = 129 ✓) |
| `red_prove_xsearch.py` | **12/12 guards proven non-vacuous** |
| `verify_morning_prompt_cutover.py` | **CLEAN** on new prompt, **RED** on the pre-cutover backup |

No test was modified or skipped to make anything pass. The 14 eslint warnings exist on `main`.

---

## 3. RED-PROOF output (verbatim)

```
==============================================================================
RED-PROOF — reverting each guard to its naive behavior, expecting RED
==============================================================================
baseline: 70 passed in 0.10s

  ✅ [B1] RED as expected — emit `text` instead of `tweet_text` (the spec-v3 shape)
        5 failed, 4 passed, 61 deselected
  ✅ [B1] RED as expected — drop the FLAT likes/retweets, keep only public_metrics
        4 failed, 5 passed, 61 deselected
  ✅ [B2] RED as expected — return the raw id (no string coercion)
        2 failed, 6 passed, 62 deselected
  ✅ [B3] RED as expected — ISO-only parser (drop the RFC-1123 fallback)
        3 failed, 6 passed, 61 deselected
  ✅ [B4] RED as expected — never flag an empty pool
        5 failed, 3 passed, 62 deselected
  ✅ [B4] RED as expected — exit 0 even on an empty pool / credential fallback
        2 failed, 68 deselected
  ✅ [B5] RED as expected — accept uncited tweet_ids (no hallucination guard)
        1 failed, 69 deselected
  ✅ [B5] RED as expected — read only the top-level `citations` array (the spec's literal wording)
        3 failed, 4 passed, 63 deselected
  ✅ [B5] RED as expected — ignore the `degraded` flag
        1 failed, 69 deselected
  ✅ [B6] RED as expected — always report credentials as OK (hide metered fallback)
        2 failed, 3 passed, 65 deselected
  ✅ [CONTRACT] RED as expected — build a PROSE query instead of operator syntax
        3 failed, 67 deselected
  ✅ [CONTRACT] RED as expected — drop the local window re-filter (trust grok's date math)
        1 failed, 69 deselected
==============================================================================
RED-PROOF: 12/12 guards proven non-vacuous
source unchanged (mutations ran against temp copies)
```

The harness mutates a **temp copy**, never the real source (asserted at the end), so it is safe on a
dirty tree.

### Blocker #1 — the survival fixture (the one that mattered)

`test_SURVIVAL_real_adapter_row_survives_select_with_final_gt_zero` asserts a real adapter row
survives `select_digest.select()` with `_final > 0`. Its RED-proof
(`test_RED_naive_shape_is_100pct_discarded_by_select`) shows a 10-row pool in the spec-v3 `text`
shape produces `selected == [] and also == []` with all 10 discarded as `bare_fragment`.

Also confirmed on live code:
```
_item_text({'text': 'real body'})            -> ''
_engagement(public_metrics only): select=4810.0  overview=0.0  render=0
```
i.e. the overview and renderer really do return 0 without flat keys, exactly as the review said.

---

## 4. Live end-to-end proof (not mocked)

Real `x_search` calls against the live tool, then through the **real** pipeline modules:

```
LIVE rows from x_search: 14        (3 solo calls, credential_source=xai-oauth)
legacy   -> top=5 also=2 discarded=7 (bare_fragment=1)
determin -> top=4 also=0
  audit: {"pool":14,"selected":4,"also":0,"discarded_bare":1,
          "discarded_below_gate":2,"discarded_author_cap":7,"low_reach_capped":0}
overview -> stories=11 loud_authors=[emollick(8, eng 4012), ollama(2, eng 5233)]
engagement non-zero in all 3 consumers: True

--- rendered body ---
☀️ **Morning Digest** — Saturday, July 25
🔥 **Top Stories**
**1.** [@emollick](https://x.com/emollick) · 519 likes · 38 reposts · 👍 B (86)
...
```

Real like counts render, authors rank by real engagement, the LLM labeling step is untouched
(labels still drive `score_digest`). One bare fragment (`"❤️"`, 759 likes) was correctly discarded.

---

## 5. 🔴 Things the spec got WRONG (evidence, not worked around silently)

### 5.1 The citation guard as literally worded would reject 100% of real chunks
The spec says *"require every returned tweet_id to appear in the citation set"* and the capability
ref names `citations`/`inline_citations`. **On every live call I made, the top-level `citations`
array was EMPTY while `inline_citations` carried every id:**
```json
"citations": [],
"inline_citations": [{"url":"https://x.com/i/status/2081153980294648186"}, ...]
```
An implementation reading `citations` alone drops every genuine row. The adapter **unions both
channels**. Guarded by `test_RED_top_level_citations_alone_would_reject_every_real_chunk`.

### 5.2 "50 rows over a full window" is NOT a universal ceiling — 10 is a real, silent cap
Measured live on `@emollick` with `min_faves:100`:

| call | rows |
|---|---|
| 2026-07-24 → 2026-07-26 (48h, one call) | **10** |
| 2026-07-24 → 2026-07-25 (24h, one call) | **10** |
| 2026-07-25 → 2026-07-26 (24h, one call) | **4** |

Splitting the same window yielded **14** where one call yielded **10**. The spec's 50 came from
`@elonmusk` at `min_faves:5000` — a much cheaper result set. **The task brief told me to set the
tripwire at the cap count; had I used 50 as the default, this ~29% loss would have been invisible.**
Default is now **10**. Guarded by `test_MEASURED_default_tripwire_is_10_not_the_specs_50`.

### 5.3 CHUNK DILUTION — chunking is worse than the spec implies
| call | rows |
|---|---|
| 5 handles in ONE chunk (simonw, karpathy, ollama, emollick, swyx), 48h | **1** |
| the SAME 5 handles as 5 SOLO calls, same window | **14** |

A chunk shares **one** result budget; it does not multiply. The spec's "chunk(handles, 10) → ~20
calls/day" is a **14× content loss** at that grouping. This also changes the cost/volume math: real
coverage needs closer to one call per active handle, not ~20 calls total. Prompt now defaults to
solo calls for loud accounts + `--chunk-size 5`. **This is the biggest open risk for Phase 4/5** —
x-feed covers ~200 authors, so the call volume there needs re-estimating before cutover.

### 5.4 `degraded: true` is usually benign, not a failure
The spec says "reject a chunk when `degraded == true`" — correct, but the brief implies it is an
error condition. Live, 2 of 5 solo chunks came back `degraded` purely because those handles had no
in-window posts above the floor (capability-ref G7 says exactly this). Treating it as a failure
would page every night. The adapter **rejects the chunk but does not count it as failed**, and only
alerts when **every** chunk degrades (`empty_pool` covers the real case).

### 5.5 Snowflake corruption does not originate in Python
The precision loss is real (`int(float(2081153980294648186))` ≠ the original), but CPython's `json`
has arbitrary-precision ints, so **this module's parse was never the corrupting hop** — it happens
upstream (a JS `JSON.parse`, or grok's own emission). Coercing to string here is still correct
(dedupe type-stability, and it prevents *us* introducing a float hop), but it does not retroactively
repair an already-corrupted id. Worth knowing before anyone claims the migration "fixed" ID drift.

### 5.6 §6a's suggested spend-audit grep will produce a false positive
The spec proposes `grep -rn "api\.twitter\.com" .../prompt.md` and expects no hits. My migration
note *mentions* `api.twitter.com` in prose (explaining what was disabled), so that grep still
matches. Use `scripts/verify_morning_prompt_cutover.py` instead — it distinguishes a live URL/call
site from a prose mention and from the commented-out block.

---

## 6. Guard behavior summary (what fires when)

| Condition | Adapter behavior |
|---|---|
| `rows_after_window_filter == 0` | `empty_pool: true`, alert, **exit 3**. Prompt: **do NOT create the PT-day lock.** |
| `credential_source != "xai-oauth"` | alert (silent metered billing), **exit 3**, rows still returned |
| `degraded: true` on a chunk | chunk dropped, counted, `ok` stays true; alerts only if ALL chunks degrade |
| tweet_id absent from citations | row dropped, `rows_uncited++` |
| handle returns ≥ cap (10) rows | `truncated_handles`, alert to re-query solo |
| `success: false` | `chunks_failed++`, alert |
| row with unparseable timestamp | dropped (not kept — would bypass the window filter) |
| `tweet_text: null` (media-only) | kept as `""`, counted in `rows_null_text` |

---

## 7. Scope boundaries — respected

- ❌ x-feed-brief **not touched** (Phase 4/5, shadow-first)
- ❌ `LOW_REACH_ENGAGEMENT_FLOOR` **still 5** (Phase 3)
- ❌ no live briefs run, no crons modified
- ❌ LLM labeling step **not bypassed** — labels still drive `score_digest`
- ❌ paid path **not deleted** — commented + dated
- ❌ **not merged to main**

---

## 8. Recommended next steps

1. **Apollo review** of the branch, especially §5.3 (chunk dilution) — it changes the Phase 4/5
   call-volume and cost estimate for x-feed's ~200 authors.
2. **Update the SPEC and the Obsidian capability reference** with §5.1–5.4. The capability ref's
   "50 rows / full window" row is misleading as written.
3. Run morning-digest **once manually with Ace present** before trusting the 03:33 cron, and check
   `.report.per_handle` / `.truncated_handles` to tune `--solo-handle` and `--chunk-size`.
4. Watch `x_search_calls` and `credential_source` in the perf log for the first week.
5. Phase 3 (floor 5 → 100) is unblocked but deliberately not done here.

## 9. One honest caveat

The morning-digest prompt change is **cutover-ready and lint-verified, but has not run a live brief**
— the task explicitly forbade running live briefs. The adapter itself IS live-verified end-to-end
(real x_search calls → real select → real render, §4). The untested seam is the *agent following the
new prompt instructions*, which only a supervised run can prove.
