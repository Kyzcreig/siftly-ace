# T4 — Wave 2 Pass-1 Senior Opus Diff-Review

Endpoint: 100.92.54.25:18801/anthropic, claude-opus-4-8

Let me analyze this diff carefully against the contract.

Key areas to examine: path scoping, idempotency, security (path traversal in filenames), index regeneration churn, the README writing to outputDir root.

Let me trace through the critical concerns:

1. **Filename sanitization / path traversal**: `noteFilename` uses `sanitizeFilename` which strips `/\\` and other chars. But `authorHandle` and `tweetId` come from tweet data. `sanitizeFilename` removes `/<>:"\\|?*\n\r` and collapses whitespace. Notably it does NOT remove `.` — so `tweetId` of `..` could be problematic, but `..` alone -> filename `date - @author - ...md`. The `assertInside` check catches escapes anyway. Good defense.

2. **Idempotency**: Default `overwrite=false` skips existing notes. Indexes are always overwritten. Re-running produces deterministic output (sorted). Index overwrite is fine — not churn in DB, just file rewrites of derived content. Acceptable.

3. **DEFAULT_OBSIDIAN_EXPORT_DIR has trailing slash** — `path.resolve` normalizes. `assertInside` uses resolvedRoot without trailing slash. Fine.

4. **README.md written to outputDir root**, others to `_index`. Within scope. Fine.

5. **assertInside correctness**: `resolvedTarget.startsWith(resolvedRoot + path.sep)`. Solid against traversal. The note filename path is checked. Good.

6. **No deleteMany, no DB writes** — read-only on DB. No schema edits. No paid API. No audio/video persistence (only references media url/localPath, doesn't download). Good.

7. **Real-path correctness**: If two tweets produce the same filename (same date+handle+tweetId), tweetId is unique so unlikely. But `dateOnly` could be 'unknown-date' and tweetId could collide across... no, tweetId unique.

8. **Skip-then-stale**: With `overwrite=false`, if a tweet was enriched AFTER first export (new categories/tags), re-running skips it — note stays stale. This is a real correctness concern but matches the documented overwrite semantics. Worth a medium note.

9. **Index always reflects full current dataset including skipped notes** — good, indexes link to notes that may not have been (re)written but exist. Consistent.

10. **Error path resource leaks**: No temp files created here. Tests use mkdtemp but don't clean up — minor test hygiene, not production.

11. **Unsanitized tweet text written to disk**: text is written raw into MD body and into frontmatter? No — text not in frontmatter. In body it's raw markdown. Could contain `---` causing frontmatter confusion? The body comes after frontmatter so a `---` line in body is just an hr. YAML frontmatter only at top. `bookmarkLinks` slices text into index — newlines collapsed. Fine.

12. **entities written as raw JSON into frontmatter** via `yamlJson` -> `JSON.stringify`. That's valid YAML (JSON is a YAML subset) on a single line. OK.

13. One real bug: `assertInside` is called but `writeExportFile` also resolves relativePath against outputDir. If `noteFilename` somehow produced an absolute path... `sanitizeFilename` strips `/` so can't be absolute. Fine.

The diff is clean and defensively written. No data-destruction. Main legitimate finding is the stale-note-on-skip behavior.

```json
{"verdict":"APPROVE_WITH_CHANGES","blockers":[],"high":[],"medium":[{"id":"M1","file":"src/lib/obsidian/export.ts","line_hint":"exportSavedTweetsToObsidian / exists() skip branch","issue":"With the default overwrite=false, an existing note for a tweet is skipped entirely. If that tweet was re-enriched after the first export (new categories, semantic tags, OCR caption, segment reclassification), the on-disk note silently goes stale while the regenerated indexes link to it as if current.","why_destructive_or_wrong":"Not destructive, but a real correctness drift on the production re-run path: the daily cron defaults to no-overwrite, so enrichment updates never reach notes. Tests only cover first-write, hiding this.","fix":"Either write notes when content has changed (compare a hash/etag or stored content), or document that the cron must pass --overwrite, or skip only when an unchanged-content hash matches. At minimum gate skip on a content fingerprint, not mere file existence."},{"id":"M2","file":"src/lib/obsidian/export.ts","line_hint":"sanitizeFilename / noteFilename","issue":"sanitizeFilename does not strip '.' or leading dots, and does not guard against an all-dots or empty tweetId (e.g. tweetId '..' or '.'). authorHandle empty falls back to 'unknown' but tweetId has no fallback.","why_destructive_or_wrong":"assertInside catches path escape, so it converts a malformed tweetId into a thrown error captured in result.errors rather than a traversal — safe but a tweet with a pathological/empty tweetId yields a confusing filename like '<date> - @h - .md' or collides. Low real risk since tweetId is numeric from X, but it's untrusted-shaped input.","fix":"Add a fallback for empty sanitized tweetId (e.g. use bookmark.id) and strip leading/trailing dots in sanitizeFilename to harden the real path beyond the assertInside backstop."},{"id":"M3","file":"src/lib/obsidian/export.test.ts","line_hint":"mkdtemp usages","issue":"Tests create temp dirs via mkdtemp but never remove them (no afterEach rm).","why_destructive_or_wrong":"Pure test hygiene / resource leak in os.tmpdir on repeated runs; not a production concern and not in scoped path.","fix":"Add afterEach to rm the temp dir recursively, or use a tracked tmp helper."}],"notes":"The exporter is read-only against the DB (no deleteMany, no upserts, no schema edits, no paid API, no audio/video download — it only references media url/localPath), and is well-scoped: assertInside() resolves and prefix-checks every write against the export root, so path-traversal via authorHandle/tweetId filenames degrades to a captured error rather than escaping the vault. No 'why saved' inference is persisted (segment/weight are derived heuristics written only into derived notes, not the schema). Idempotency is sound for first-run and index regeneration is deterministic (sorted groupings, full-dataset rebuild). The one substantive finding (M1) is the no-overwrite default silently leaving re-enriched notes stale on the cron path — worth resolving before relying on daily syncs, but it is drift, not destruction. Approve with the listed changes; no blockers."}
```