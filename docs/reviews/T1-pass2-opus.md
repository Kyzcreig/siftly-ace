# T1-fix Pass-2 Senior Review — Opus (claude-opus-4-8 via F1 proxy :18801)

**Verdict: APPROVE WITH CHANGES** (non-blocking fast-follow, applied immediately).

All pass-1 findings RESOLVED, verified on disk + independently re-run (vitest 5/5, prisma ok, build clean, live dry smoke, --limit guard fires):
- B1 RESOLVED — media block gated by `includeMedia = row.media.length>0 && !sameMediaItems(...)`; empty-media like re-sighting no longer wipes bookmark media.
- B2 RESOLVED — upsertRows skips on sourcePriority and on source-equal+content-unchanged; idempotent re-run → updated=0.
- H1 RESOLVED — CLI hard-errors `--limit` without `--dry`; dry-run skips persistState.
- H2 RESOLVED — new test: like row → bookmark re-sighting sets source=bookmark, updated=1.
- H3 RESOLVED — assertNoXurlErrors tolerates errors[] when usable data present (warns, continues).
- M1 RESOLVED — rows-ingested = created+updated (distinct from rows-deduped).
- M3 — route.ts null->'unknown' KEPT (verified NECESSARY: Bookmark.authorHandle/authorName are non-nullable String columns; reverting the edit breaks `npm run build` with `Type 'string | null' is not assignable to type 'string'`. Not scope-creep — a required build fix the new schema-aware typecheck surfaces).

No blocking regressions. Two non-blocking follow-ups APPLIED by Apollo at review time:
- R1 — added `orderBy: { id: 'asc' }` to mediaItems select so sameMediaItems is order-stable (hardens the B1 path against unordered Prisma returns).
- R3 — null-out nextCursor when a page was trimmed (defense-in-depth so the --limit data-hole stays dead even if the dry guard is ever relaxed).
