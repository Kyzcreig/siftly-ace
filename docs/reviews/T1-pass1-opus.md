# T1 Senior Diff-Review — Opus (claude-opus-4-8 via F1 proxy :18801)

**Verdict: BLOCK** (2 BLOCK data-destructive, 3 HIGH, 4 MEDIUM, 5 LOW). All findings verified against code on disk (none hallucinated). Build passed (exit 0), vitest 2/2, live --limit 3 --dry smoke OK — yet the diff-review caught data-destructive bugs the tests structurally couldn't see (MemoryIngestDb models media as array-overwrite, hiding the relational delete+recreate).

## BLOCK
- **B1** `updateBookmarkData`: `mediaItems.deleteMany:{}` runs on every update. With media.length===0 a like re-sighting WIPES bookmark-populated media. Also churns MediaItem ids / wipes future enrichment every run.
- **B2** `upsertRows`: only bookmark+like skip; like→like & bookmark→bookmark fall through to update → full-table churn (+B1 media churn) on idempotent re-runs.

## HIGH
- **H1** `--limit` trims a page but persists its next_token → next run resumes past un-ingested tail = permanent silent data hole. (dry-run hid it.) Fix: refuse --limit without --dry, or don't advance cursor on limit-truncation.
- **H2** like-row→bookmark DB overwrite (the contract headline) is UNTESTED. Add the test.
- **H3** `assertNoXurlErrors` throws on ANY errors[]; X returns 200+data+errors[] for tombstoned referenced tweets → one bad tweet aborts whole ingest. Fix: only throw when no usable data.

## MEDIUM
- **M1** `rows-ingested = rowsDeduped` (seen, not written) — misleading. Use created+updated.
- **M2** IngestState.lastCursor is write-only telemetry, never read for resume — document or wire resume.
- **M3** out-of-scope route.ts null→'unknown' edit changes existing scraper's persisted values — revert or sign off.
- **M4** clampPageSize floor checked — OK.

## LOW
- L1 double assertNoXurlErrors; L2 retry only 429 (not 5xx); L3 maxBuffer OK; L4 hardcoded user id (document, not secret); L5 referenced_tweets[0] only.

Fixes dispatched back to owning worker (Daedalus) as T1-fix.
