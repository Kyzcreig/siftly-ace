# t_683d21bf (export filename collision + index idempotency) — Pass-2 Senior Opus Review

<analysis>
Let me check R1: the fallback uses contentFingerprint(bookmark.id). But the test has first.id='::::' and second.id='****'. Both sanitize empty. The fallback is `unknown-id-${contentFingerprint(bookmark.id).slice(0,8)}`. Since first.id and second.id differ ('::::'  vs '****'), the fingerprints differ. Good, disambiguation works. But wait — what if two bookmarks have the SAME bookmark.id and empty tweetId? Then collision still. But bookmark.id should be unique (PK). The claim says "stable short hash of bookmark.id". That's what it does. OK.

But concern: contentFingerprint is hash of bookmark.id only, not full content. If bookmark.id itself sanitizes empty, two different empty-ish ids still produce different hash since raw id differs. Good.

R2: index gating. Added contentMatches check, increments only on actual write. The skip on `!overwrite && contentMatches`. Note the test expects initial indexesWritten=6 and rerun=0. Looks correct. Also added assertInside path traversal guard — good security addition, no regression for legit relative paths.

Potential regression in R2: when overwrite=true, it always writes — correct. The `continue` skips increment, good.

One concern: contentMatches reads file; if file doesn't exist it should return false. Need to assume it's implemented correctly (used elsewhere presumably for note files). Reasonable.

R1 regression: noteFilename uses contentFingerprint but is it deterministic/stable? "stable short hash" — assume yes. 8 hex chars = 32 bits, collision possible but acceptable for fallback edge case.

Note: filename now depends on bookmark.id hash even though content key for dedup... idempotency: same bookmark.id -> same filename, fine.

Tests not rigged — they assert real file contents and mtimes. Strong assertions.

Let me check assertInside ordering relative to writeExportFile — assertInside also presumably called inside writeExportFile, but adding it before contentMatches prevents reading outside outputDir. Good.

No regressions evident.
</analysis>

{"verdict":"APPROVE","fixes_confirmed":["R1","R2"],"fixes_not_confirmed":[],"new_regressions":[],"notes":"R1: noteFilename fallback now derives `unknown-id-<fp8>` from contentFingerprint(bookmark.id); test confirms two distinct empty-sanitizing rows ('::::' vs '****') get distinct files and both write (written=2, contents verified). bookmark.id is PK so collision risk is bounded; 32-bit short hash is acceptable for this edge path. R2: index loop now resolves+assertInside (adds path-traversal guard), skips on !overwrite && contentMatches (no mtime churn), increments indexesWritten only on real writes; test asserts initial=6, rerun=0, and preserved mtimes — real-path assertions, not over-mocked. overwrite=true still forces writes (no idempotency regression). Assumes contentMatches returns false for missing files (consistent with existing note-write usage). No data-loss/atomicity/SSRF/resource-leak issues introduced."}