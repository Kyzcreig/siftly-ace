# T2 — Wave 2 Pass-1 Senior Opus Diff-Review

Endpoint: 100.92.54.25:18801/anthropic, claude-opus-4-8

I'll analyze this diff carefully against the contract, looking for data-destruction, idempotency, and correctness issues.

Let me trace the critical paths:

1. **`drainVideoQueue` error handling bug** — In the catch block, `now` is referenced, but `now` is declared with `const now = ...` *inside the try block*. If `transcribe` throws synchronously or the `await` happens... actually `now` is declared before the try. Let me recheck — yes, `const now` is inside the `for` loop but before `try`. OK, it's in scope.

2. **`imageTags` field ownership collision** — This is the big one. The OCR tier writes `text_ocr` + `ocr_backend` to `mediaItem.imageTags`. The video tier writes `video_transcript` to the same `imageTags` field. But `mergeVideoTranscriptImageTags` and `mergeOcrImageTags` both spread existing — so they coexist. BUT: in `drainVideoQueue`, if `findUnique` is undefined (optional `?.`), `existing` is `undefined`, and `mergeVideoTranscriptImageTags(undefined, text)` wipes any prior OCR `text_ocr` tags. The test's `MemoryVideoDb` has no `findUnique`, so the real-path read-before-write is silently skipped → **data loss of OCR tags on re-run/video drain**.

3. **OCR candidate gate vs. cost estimate mismatch** — `isOcrCandidate` includes `video` type; video thumbnails get OCR'd writing `text_ocr`, then video transcription writes `video_transcript`. Re-running enrich with `--vision` re-OCRs (imageTags now `!= '{}'` so skipped) — idempotent-ish.

4. **Idempotency of `enrichBookmarkRows`** — uses `update` (not upsert) keyed by id, merges arrays via `uniquePreserveCase`. Re-run is stable. `bookmarkCategory.upsert` is keyed properly. Good.

5. **Security — `transcribeWithParakeet`** passes `normalizeXUrl(input)` as an execFile arg to `bash scriptPath`. `sourceUrl` is derived from `media.url` or constructed from `authorHandle`/`tweetId`. Since it's an execFile arg (not shell), no injection at this layer — but the URL flows into a shell script whose internals we can't see. The arg itself could begin with `-` (option injection) if `media.url` is attacker-controlled. `normalizeXUrl` doesn't guard leading `-`. Medium risk.

6. **Cron budget** — video drain is a separate script, never invoked by enrich.ts. Contract satisfied. Enrich.ts calls `enqueueVideoItems` (cheap file append) only. Good.

7. **Audio/video persistence** — Parakeet script handles download/discard out of band; this code stores only transcript text. Acceptable, though `yt-dlp` temp cleanup is inside the unreviewed skill script.

```json
{
  "verdict": "BLOCK",
  "blockers": [
    {
      "id": "B1",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "drainVideoQueue: const existing = await options.db.mediaItem.findUnique?.(...)",
      "issue": "Read-before-merge of imageTags uses optional chaining (findUnique?.). When findUnique is not implemented on the db object, `existing` is undefined and mergeVideoTranscriptImageTags(undefined, text) is written, OVERWRITING the entire imageTags JSON blob.",
      "why_destructive_or_wrong": "imageTags is a shared field: the OCR tier writes {text_ocr, ocr_backend} and the video tier writes {video_transcript} into the SAME mediaItem.imageTags column. If findUnique is absent/returns null, the video drain clobbers any previously-stored OCR text (and vice-versa). This is exactly the silent-overwrite-of-another-tier's-data class of bug. The test's MemoryVideoDb has no findUnique, so the green test exercises the data-losing path without detecting it. On a real re-run where OCR ran first, draining the video queue destroys text_ocr.",
      "fix": "Make the read mandatory: require db.mediaItem.findUnique (throw if missing), and if it returns a row, merge into the existing parsed object. Do an atomic read-modify-write under a transaction, or at minimum fail loudly when findUnique is unavailable rather than overwriting. Same hardening for runOcrForMediaItems which reads item.imageTags from a possibly-stale in-memory row rather than re-reading."
    },
    {
      "id": "B2",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "runOcrForMediaItems / mergeOcrImageTags vs mergeVideoTranscriptImageTags",
      "issue": "OCR uses item.imageTags captured at findMany time (from ENRICH_BOOKMARK_SELECT) as the merge base, not a fresh read. If a video transcript was written between findMany and the OCR update (or in the same enrich run, since enqueue happens after but a prior drain may have set it), the OCR write overwrites video_transcript.",
      "why_destructive_or_wrong": "Lost-update / stale-read race on the shared imageTags column across two enrichment tiers. Cross-tier overwrite of factual transcript data is data-destructive and non-idempotent under interleaving.",
      "fix": "Re-read imageTags immediately before each update (findUnique) and merge against the freshly-read value, or move OCR and transcript into distinct columns. Since schema is frozen, enforce read-before-write with a guaranteed findUnique and merge-not-replace semantics."
    }
  ],
  "high": [
    {
      "id": "H1",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "transcribeWithParakeet: execFileAsync('bash', [scriptPath, normalizeXUrl(input), ...])",
      "issue": "sourceUrl derived from media.url (attacker/ingest-controlled) is passed as a bash-script argument with no validation that it is an http(s) URL or that it does not begin with '-'.",
      "why_destructive_or_wrong": "Argument/option injection: a media.url like '--foo' or a crafted value becomes an option to the parakeet shell script, and the URL is consumed by yt-dlp downstream where a malicious value could trigger unexpected yt-dlp behavior (e.g. reading arbitrary inputs). execFile prevents shell metachar injection but not option injection into the wrapped script/yt-dlp.",
      "fix": "Validate sourceUrl with new URL() and assert protocol is https: and host is in an x.com/twitter.com/twimg allowlist before enqueueing AND before transcribing. Reject/skip leading-dash values. Pass a '--' separator to the script if it forwards args to yt-dlp."
    },
    {
      "id": "H2",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "drainVideoQueue catch block, transcript = (options.transcribe ?? (...))(record.sourceUrl); const text = (await transcript)",
      "issue": "The transcribe call is invoked but only awaited inside try via `await transcript`. If the underlying execFileAsync rejects, it rejects on the awaited promise (caught) — OK — but a synchronous throw from constructing transcribeWithParakeet (e.g. resolveParakeetScript returns null -> throw) happens at call time, still inside try, so caught. However retry/attempts are never re-incremented or bounded: an item that errors stays status 'error' and is never retried, yet enqueueVideoItems will re-enqueue it (status 'error' is not in the skip set) creating a new 'pending' with attempts+1 on next enrich run, with no max-attempts cap.",
      "why_destructive_or_wrong": "Unbounded retry growth: a permanently-failing video (deleted/geoblocked) is re-enqueued every enrich run forever, appending queue lines indefinitely and re-spending yt-dlp/Parakeet compute each drain. The queue jsonl also grows without compaction (append-only, every status transition appended).",
      "fix": "Add a maxAttempts cap (e.g. skip re-enqueue when attempts>=N and last status is 'error'), and periodically compact the jsonl (rewrite keeping latest record per key). Treat 'error' with exhausted attempts as terminal in enqueue skip logic."
    },
    {
      "id": "H3",
      "file": "src/lib/enrich/enrich.test.ts",
      "line_hint": "MemoryVideoDb has no findUnique; tests assert transcribed===1 and FTS match",
      "issue": "Test coverage validates only the overwrite path and never exercises the OCR+transcript coexistence on the same media item, so the cross-tier clobber (B1/B2) is invisible to CI.",
      "why_destructive_or_wrong": "This is precisely the 'green tests hide data-destruction' pattern the gate exists for. The fixture path differs from the real Prisma path (which DOES have findUnique, returning null for fresh rows but real data on re-run).",
      "fix": "Add a test where imageTags already contains text_ocr, then run drainVideoQueue, and assert BOTH text_ocr and video_transcript survive. Add the inverse (transcript then OCR). Implement MemoryVideoDb.findUnique."
    }
  ],
  "medium": [
    {
      "id": "M1",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "runLocalOcr remote fetch path",
      "issue": "SSRF: runLocalOcr fetches arbitrary options.url with no host allowlist when isRemote. media.url/thumbnailUrl come from ingest; OCR can be pointed at internal addresses.",
      "why_destructive_or_wrong": "Server-side request forgery to arbitrary http(s) endpoints; also no redirect cap. Not data-destructive but a real-path security issue beyond the test's local-file fixture.",
      "fix": "Restrict OCR remote fetch to pbs.twimg.com / video.twimg.com hosts; disable following redirects to non-allowlisted hosts; cap size before buffering (already capped post-read)."
    },
    {
      "id": "M2",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "enqueueVideoItems / videoSourceUrl, profileBaseHome/defaultQueuePath",
      "issue": "videoSourceUrl falls back to constructing a status URL from bookmark.authorHandle without sanitizing the handle; queue path derivation relies on HERMES_HOME string-slicing heuristics that can silently resolve to os.homedir() and write the queue to an unexpected location.",
      "why_destructive_or_wrong": "Unsanitized authorHandle embedded in a URL later passed to a shell script (compounds H1). Queue-path heuristic could split state across two files if HERMES_HOME format varies, causing duplicate enqueues / 'lost' pending items.",
      "fix": "Validate authorHandle against /^[A-Za-z0-9_]{1,15}$/ before building the URL; make the queue path resolution deterministic and assert it once at startup, logging the resolved path."
    },
    {
      "id": "M3",
      "file": "src/lib/enrich/index.ts",
      "line_hint": "drainVideoQueue success: appends 'done' record but errors are appended too; no fsync/atomic",
      "issue": "Queue is append-only j