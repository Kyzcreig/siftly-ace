# t_6530a9d3 (vec0 KNN binding + real sqlite-vec test) — Pass-2 Senior Opus Review

Looking at the diff carefully.

**R1 correctness:** The KNN subquery now uses `k = ${candidateLimit}` as a bare constant interpolated into SQL, over-fetches candidates, then JOINs/filters model+dimensions outside the KNN MATCH, with `LIMIT @limit`. The over-fetch loop doubles candidateLimit until enough rows or exhausting all vectors. This fixes the starvation bug. `candidateLimit` is interpolated, not bound — vec0 requires k as literal/constant, so binding wasn't possible. But `candidateLimit` is derived from numeric math (`Math.min`/`Math.max`/`Math.floor`), not user input, so no injection. OK.

**Concern - termination/correctness:** The loop grows candidateLimit until `rows.length >= limit` OR `candidateLimit >= vectorRows`. If candidateLimit reaches vectorRows it does a final fetch with full k. Correct — guarantees all vectors scanned when needed. No infinite loop since candidateLimit strictly increases (×2) and is capped.

**Concern - distinct count mismatch:** `sqliteVecRowCount` counts ALL rows in bookmark_vec, but vec table may hold multiple models/dims. Over-fetching to total count is safe (just slower), and the loop terminates. Fine.

**R2 correctness:** Test asserts dimension-change recreate (old 2-dim then active 3-dim, checks meta), seeds out-of-scope nearest candidates that would win raw KNN, and asserts the in-scope results survive. This genuinely reproduces the starvation bug and would FAIL against the old single-k query. Conditional skip via probe is legitimate (real extension gating), not rigging — it asserts `store.mode === 'sqlite-vec'` inside and skips with a reason otherwise.

**Adversarial checks:**
- The test reaches into `store.db` private internals — coupling but acceptable for white-box repro.
- `seedOutOfScopeSqliteVecCandidate` uses `bookmark_vec_idmap` (e002855 rename) and BigInt rowid — consistent with aegis base.
- One real concern: `ORDER BY knn.distance LIMIT @limit` — `@limit` is bound as a JS number, fine.
- The dimension-change recreate isn't directly asserted to RECREATE the vec table (it asserts meta updated to dims=3 and KNN works at 3-dim); the old 2-dim row b-sqlite-vec is no longer queryable at 3-dim, which the test implicitly relies on via filter. Acceptable coverage.

No regressions found. No test rigging.

```json
{"verdict":"APPROVE","fixes_confirmed":["R1","R2"],"fixes_not_confirmed":[],"new_regressions":[],"notes":"R1: KNN MATCH now runs with k as interpolated numeric constant (candidateLimit) over-fetching, then model/dimensions filtered post-KNN with LIMIT @limit and a doubling loop capped at total vec row count — fixes vec0 starvation where out-of-scope nearest rows displaced in-scope ones. candidateLimit is derived purely from numeric Math ops (no user input), so interpolation is not an injection vector. Loop strictly increases and is bounded by vectorRows, so it terminates and guarantees full scan when needed. sqliteVecRowCount counting all models/dims only over-fetches (safe). R2: test genuinely reproduces the bug (seeds out-of-scope nearest candidates that would win raw KNN) and would fail against the pre-fix single-k query; asserts dimension-change meta update + correct in-scope KNN ordering. Conditional skip is a legitimate real-extension gate (asserts mode==='sqlite-vec' when run, records skip reason) not rigging. Idmap/BigInt rowid usage consistent with aegis e002855. Minor non-blocking: test couples to store.db private internals (white-box, acceptable); dimension-recreate is verified via meta+KNN behavior rather than direct table re-creation assertion."}
```