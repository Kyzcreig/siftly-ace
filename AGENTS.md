# siftly-ace — Agent Notes

Fork of viperrcrypto/Siftly → Kyzcreig/siftly-ace. PRD: docs/plans/PRD-ace-x-knowledge-base.md (v5, approved).
Swarm plan: docs/plans/SWARM-PLAN-phase1plus.md. Coding worker = Daedalus profile (openai-codex/gpt-5.5 xhigh).

## ⭐ RANKING — CURRENT LIVE STATE (2026-06-21) — read this first
Both briefs (`morning-digest`, `x-feed-brief`) run the SAME deterministic engine: model emits 4 enum labels → `pf-score.py` adds a personal-fit delta → `score_digest.py` scores → `select_digest.py --engine deterministic` gates/selects → renderer posts. The model NEVER picks what posts.
- **Personal-fit is LIVE in `PF_AFFINITY_MODE=fused`** (shipped 2026-06-20, Ace-accepted 2026-06-21). `fused_delta = (keyword_delta + (embed_delta − pool_mean_embed))/2` — equal-weight blend of the keyword overlap scorer and the sqlite-vec embed scorer; centering cancels embed's ~+10.6 miscalibration. Code: `pf-score.py` `apply_fused_affinity()` + `affinity_mode="fused"`; `pf-audit.py` provisions the embed env for fused. Clamped to ±12 by `pf_points`/`PF_CAP`.
- **Kill-switch unchanged:** `PF_WEIGHT=0` in `brief-config.json` → base-score-only no-op. `pf-audit.py` fail-safes to base on any pf hiccup.
- **Cross-brief dedup (fixed 2026-06-21):** x-feed Step 2 now ALSO reads `morning-digest/ai-news-seen.json` so a tweet morning posts at 03:45 can't reappear in x-feed at 03:56. (Was one-directional before — the @emollick dup.)
- **A/B scaffolding RETIRED (2026-06-21):** crons `siftly-pf-preview`/`siftly-pf-gate-eval`/`siftly-fused-checkin`/`wave6-embed-shadow-watch`/`siftly-coercion-gate-watch` removed (scripts in `~/.hermes/scripts/retired/`). KEEP `siftly-gatherer-silentblock-watch` + its gatherer-probe feeder (trimmed `wave6-output-shadow-watch`). `prompt.md.bak.*-pre-fused` kept 1 wk then prune.
- Full as-built pipeline + the 36-cell BASE table + safety rails: Obsidian `AI/Ace X Knowledge Base — System Overview.md` § "Ranking — the complete pipeline".

## Incremental ingest EARLY-STOP — DONE (2026-06-15), live-verified
The daily incremental no longer re-scans a fixed window every run. PRD: `~/.hermes/plans/siftly-incremental-early-stop/PRD-incremental-early-stop.md` (Opus 2-pass APPROVED).
- **Core (`lib/xurl-ingest.ts` `fetchSourcePages`):** optional `knownTweetIds` probe + `earlyStopK` (default 3). Incremental stops paginating a source after **K consecutive already-known tweets** (newest→oldest ⇒ frontier passed). Collects the whole page before stopping (new items above the known run kept). Backfill (`resumeFromCursor:true`) NEVER early-stops (I2). Fail-open: a probe throw → full walk + `IngestResult.earlyStopError` + WARN (I7).
- **Wiring (`lib/incremental-early-stop.ts` + `scripts/ingest.ts`):** the incremental CLI branch builds a Prisma `knownTweetIds` over the shared `Bookmark` table (both sources, `tweetId @unique`) and decides per run: **kill-switch** (`SIFTLY_INCREMENTAL_EARLY_STOP=0`) > **safety-net** (full walk every `SIFTLY_INCREMENTAL_FULLWALK_EVERY_DAYS`, default 7, wall-clock via new `IngestState.lastFullWalkAt`) > early-stop on. `IngestResult.fullWalkReason` disambiguates a deliberate full walk from a probe failure (D-9).
- **Ceiling raised 2→5** (`DEFAULT_INGEST_MAX_PAGES`, env `SIFTLY_DAILY_INGEST_MAX_PAGES`): early-stop makes normal-day cost ceiling-independent; the higher cap absorbs a heavy bookmarking day. The old 2 silently dropped >~180 bookmarks/day overflow.
- **Migration:** additive nullable `IngestState.lastFullWalkAt` (`prisma/migrations/20260615000000_*`). A fresh `lastFullWalkAt=null` forces ONE baseline full walk per source, then early-stop engages.
- **Live before/after (dry-run, real corpus):** full window **10 pages / 948 reads → early-stop 2 pages / 190 reads (~80% cut)**. ~$1.89/day → ~$0.38/day on normal days; safety-net day reverts to ~378 weekly.
- **Tests:** `lib/__tests__/xurl-ingest-early-stop.test.ts` (12), `incremental-early-stop.test.ts` (helpers), `ingest-cli-early-stop.test.ts` (wiring), `credit-floor-raised-ceiling.test.ts`. Knobs: `SIFTLY_INCREMENTAL_EARLY_STOP`, `_EARLY_STOP_K`, `_FULLWALK_EVERY_DAYS`, `SIFTLY_DAILY_INGEST_MAX_PAGES`.

## Phase 0 — DONE (2026-06-07), live-verified
- Dedicated X app `siftly-ace` registered under @angalexg, **Production** env. Creds in 1Password Engineering: "X API App — siftly-ace" (id n32tdp5kpvb7i4pga2thzatqwy).
- OAuth2 PKCE grant OK. `xurl --app siftly-ace whoami` → angalexg / id 56282605.
- Bookmarks gate PASSED: GET /2/users/56282605/bookmarks → 200 with real data.
- Likes endpoint: GET /2/users/56282605/liked_tweets → 200 with data.
- Credit meter readable (app-only bearer): /2/usage/tweets → project_cap 2,000,000, project_usage 6,166, cap_reset_day 9. ~1.99M reads/period headroom. Credit-floor guard CAN read a real balance.

## Premise-gate findings (decide schema — verified against live payload)
- **No `saved_at` / `liked_at` timestamps** on bookmark/like tweets. → Dedupe "bookmark wins" = **source precedence** (bookmark > like), NOT timestamp. Novelty calibration (PRD §5.7 signal 5) falls back to tweet_created_at spread or is disabled with a logged note.
- Pagination: both endpoints use `meta.next_token` → `&pagination_token=`.
- Tweet keys available: attachments, author_id, context_annotations, conversation_id, created_at, edit_history_tweet_ids, entities, id, lang, possibly_sensitive, public_metrics, referenced_tweets, text.

## Auth note
- `forge` app left with a stray oauth2:angalexg token (Ace's call: leave it). Briefs use forge's bearer; do not rely on forge oauth2.
- siftly-ace is the ONLY app holding the intended user-context token for ingestion.

## Wave 2 — DONE (2026-06-07), commit e18feeb (pushed to Kyzcreig/siftly-ace main)
- T2 enrichment+video, T3 embeddings+sqlite-vec hybrid search, T4 Obsidian export — 3 parallel Daedalus workers on frozen T1 schema, each 2-pass senior Opus diff-review.
- Real seam verified: ingest→enrich→export on 5 live dev.db bookmarks → 11 Obsidian notes, idempotent re-export (content-hash). Project suite 54/54, tsc clean.
- Reviews: docs/reviews/T{2,3,4}-pass1-opus.md. Opus review proxy that works: http://100.92.54.25:18801/anthropic (local :18801 was weekly-429'd).
- NOT yet live-verified: T3 embed hop needs an OpenAI (or ACE-AI OpenAI-compatible) embedding key in project env. Unit tests 5/5 only.
- Remaining MEDIUM follow-ups: kanban triage task t_4a0ccc83 (drain retry/atomicity, vec0 KNN query + real sqlite-vec test, index idempotency + filename collision hash).

## T3 live-embed seam — VERIFIED (2026-06-08), commit e002855
The real embed->vec->search hop is now exercised end-to-end (was unit-tests-only before).

Env vars used (none committed; secrets pulled at runtime):
- `OPENAI_API_KEY` — from 1Password Engineering item `OpenAI API Key` (id 77x7lxny2xabgkuupkhkthttsy), field `credential`. Default embed provider/model: openai / text-embedding-3-small (1536-dim). ACE-AI swap available via `SIFTLY_EMBED_PROVIDER=openai-compatible` + `SIFTLY_EMBED_BASE_URL`/`SIFTLY_EMBED_API_KEY`.
- `SIFTLY_SQLITE_VEC_EXTENSION_PATH` — path to vec0.dylib. Binary is NOT in npm tree (full sqlite-vec install rebuilds better-sqlite3 and fails node-gyp). Fetch standalone: `npm i sqlite-vec-darwin-arm64@0.1.9 --ignore-scripts` in a throwaway dir, copy `node_modules/sqlite-vec-darwin-arm64/vec0.dylib` to `.local/vec0.dylib` (gitignored). Loads clean against the project's better-sqlite3 (vec_version v0.1.9).

Two bugs fixed in src/lib/vec.ts that were silently demoting every real run to brute-force:
1. Manual id-map table `bookmark_vec_rowids` collided with vec0's own auto-created shadow table `<vec_table>_rowids` → renamed to `bookmark_vec_idmap`.
2. better-sqlite3 binds JS numbers as float64; vec0 rejects non-integer rowid/k → bind as BigInt.

Verification: `embed --limit 5 --force` → `vec=sqlite-vec`; known-item query "Hermes language model new release" returns row cmq4gxpoj0004hoyydhm3wsfe (Teknium "Hermes v0.16.0 is out now!") as #1, every vec hit `mode=sqlite-vec` (not fallback). Suite 59/59, tsc clean.

## E2E hard-fail gate — DONE (2026-06-08), commit 19331da (pushed)
- `e2e/` suite (pipeline + vec-migration), `npm run test:e2e`. Closes the systemic gap that hid Aegis's vec0 bug: vec0 tests now HARD-FAIL (throw) instead of silently skipping when `SIFTLY_SQLITE_VEC_EXTENSION_PATH` is set and the store demotes to brute-force.
- Gate mechanic: `realVecIt = path ? it : it.skip`; `assertRealVecStore` throws on `mode !== 'sqlite-vec'`. Proof: bogus `.dylib` path -> 3 e2e fail (exit 1), not skip.
- Covers fresh-DB pipeline, legacy `bookmark_vec_rowids` self-heal, dim/provider swap, brute-force fallback correctness, video drain (OCR-preserve, dedupe compaction, stale-TTL + dead-pid reclaim, partial-owner lock timeout, live-embed missing-key hard-fail).
- Also hardened video-queue stale-lock reclaim (TOCTOU): inode-identity verified pre/post rename, rollback-on-drift, logs orphaned `.reclaiming-*` on rollback failure.
- Verified: tsc clean; 65 pass/6 skip (vec unset); 8/8 real-vec all mode=sqlite-vec. Opus pass-2 APPROVE_WITH_CHANGES (F2 applied; F1/F3 declined).

## Persistent embed key — DONE (2026-06-08), commit 25b8b6b (pushed)
- `scripts/with-secrets.sh` pulls OPENAI_API_KEY from 1Password (Engineering, `op://Engineering/77x7lxny2xabgkuupkhkthttsy/credential`) at runtime via fleet service-account token (cron) or interactive op (shell); auto-defaults SIFTLY_SQLITE_VEC_EXTENSION_PATH=.local/vec0.dylib; confirms by length only, never prints secret. NO key literal in repo (.env secret removed; .env.example documents wrapper).
- npm scripts: `embed`, `embed:secure`, `test:e2e:live`. Verified: embed:secure -> vec=sqlite-vec; test:e2e:live 8/8; suite 65/6; tsc clean.
- The redaction layer mangles `$(op read ...)` in write_file/patch content -> write the literal bytes via execute_code, verify with `od -c`.

## Wave 3 — cost-gated backfill — SCOPED (2026-06-08), not yet dispatched
- Scope + task DAG: `docs/plans/WAVE-3-backfill-scope.md`. Engine (pagination/429/402-detect/dedup) already exists in `lib/xurl-ingest.ts`; Wave 3 delta = credit-floor preflight, cost-estimate `--confirm` gate, 402->alert+resumable-stop, 5:30am daily-incremental cron (ingest->enrich->embed->export, 20-min budget, alert-on-fail).
- 4 dispatchable tasks (T-W3-1..4) + 1 GATED main-agent-only task (T-W3-5 = the real ~$15-25 backfill spend, Apollo runs with Ace present, NOT a worker).
- Credit-meter auth gotcha (verified live): `/2/usage/tweets` is App-Only bearer; user-context token -> 403. Credit-floor guard must use the bearer, not the ingest user token.
- Awaiting Ace go/no-go to dispatch the swarm.

## Wave 3 — T-W3-1/2/3 DONE (2026-06-08), commit 57fb6da (pushed); T-W3-4 in flight
- T-W3-1 credit-floor guard (lib/credit-guard.ts): checkCreditFloor reads /2/usage/tweets via app-only bearer, fail-closes on 403/parse/network, detects user-token-403 as CONFIG error, reserve default 50000 (SIFTLY_CREDIT_RESERVE). Review MEDIUM applied: fail-closed paths logger.warn.
- T-W3-2 cost-estimate gate (lib/cost-estimate.ts, scripts/ingest.ts): --confirm required for non-dry full backfill, --incremental skips gate. runIngestCli extracted (injectable deps).
- T-W3-3 402 resumable-stop (lib/xurl-ingest.ts): persist cursor + onCreditsDepleted-once + resumable; 429 unchanged. Review CRITICAL applied: added resumeFromCursor opt (default true). Daily INCREMENTAL must pass resumeFromCursor:false — X paginates newest->older, auto-resume would skip new top-of-list bookmarks. Regression test added. LOW declined (persist-before-alert is correct).
- Verified by Apollo (not worker self-report): tsc clean; new tests 18/18; full suite 83 pass/6 skip; real-vec e2e 8/8.
- **PROVISIONING GAP — RESOLVED** (see "BEARER" note below; re-verified live 2026-06-09: `xurl auth status` → siftly-ace bearer ✓, `xurl --auth app --app siftly-ace /2/usage/tweets` → 200, cap 2,000,000). The credit-floor guard's default `xurl --app siftly-ace --auth app /2/usage/tweets` path works. (Historical: the bearer was missing right after Phase-0; minted+registered + stored in 1Password since.)

## Wave 3 — T-W3-4 DONE (2026-06-08), commit 4466463 (pushed). Wave 3 swarm COMPLETE.
- T-W3-4 daily-ingest driver (scripts/daily-ingest.ts/.sh, docs/deploy/launchd/ai.siftly.daily-ingest.plist): credit-floor preflight -> ingest --incremental -> enrich -> embed -> export; 20-min wall budget (AbortController + process-group SIGTERM/SIGKILL); exactly one Discord #alerts on failure; reserve 50k. launchd 5:30am, RunAtLoad false, no_agent, secrets via with-secrets.sh.
- REVIEW CRITICAL (found by Apollo during T-W3-4 review, NOT the worker): scripts/ingest.ts passed --incremental to the cost gate but never threaded resumeFromCursor into ingestXurlSources -> daily incremental would resume a deep cursor and SKIP new top-of-list bookmarks. Fixed: resumeFromCursor:!incremental + 2 regression assertions. This is the SECOND time the same newest->older cursor hazard surfaced (engine in T-W3-3, CLI wiring here) — any new ingest entrypoint MUST set resumeFromCursor:false for incremental.
- Verified: tsc clean; full suite 88 pass/6 skip; real-vec e2e 8/8; plutil -lint OK. Opus review APPROVE.
- BEFORE FIRST LIVE DAILY RUN (Apollo-gated): (1) provision siftly-ace app-only bearer (xurl --app siftly-ace auth app --bearer-token <minted>); (2) ensure OP_SERVICE_ACCOUNT_TOKEN is in the launchd job env so with-secrets.sh can pull the key; (3) launchctl load the plist. (4) T-W3-5 = the real ~$15-25 backfill, Apollo runs with Ace present (--confirm).

## Wave 3 — LIVE PROVISIONED + structural guard + crash-safety (2026-06-08, commits 68fb6a0/46400c7/140d60b)
- BEARER: siftly-ace app-only bearer is in 1Password (item n32tdp5kpvb7i4pga2thzatqwy field bearer_token, len 118, verified HTTP 200 on /2/usage/tweets). Registered into xurl: `xurl --app siftly-ace auth app --bearer-token <...>`. Credit guard default path now works: checkCreditFloor({}) -> ok=true remaining=1993834.
- LIVE BUG FIXED: /2/usage/tweets returns project_cap/project_usage as JSON STRINGS not numbers; numberValue now coerces numeric strings (else guard fail-closed on real payload). Regression test with string shape.
- STRUCTURAL GUARD (Ace ask): IngestOptions.resumeFromCursor is now REQUIRED — tsc fails on any ingest entrypoint that doesn't choose resume(backfill)/top(incremental). Proven: deleting the flag from ingest.ts breaks `tsc --noEmit`. tsc is in CI => bug class can't reach main.
- with-secrets.sh now bootstraps OP_SERVICE_ACCOUNT_TOKEN from ~/.hermes/.env under launchd's sparse env (verified via env -i). Cron can auth at 5:30am.
- CRON LOADED: ~/Library/LaunchAgents/ai.siftly.daily-ingest.plist (launchctl load OK, 5:30am, RunAtLoad false).
- CRASH-SAFE BACKFILL: discovered the engine collected all pages in memory and upserted only at the end, so a 429-exhausted throw lost everything. Now non-402 fetch errors return partial pages + XurlInterruptedEvent; caller upserts + persists cursor; re-run resumes. Regression test added.
- CORPUS (D5 discovered via --dry): ~99 bookmarks + ~3531 likes = ~3630 reads (~$18 backfill, well under 2M cap). Bookmarks backfilled (99 created). LIKES endpoint is rate-limited at 75 req/15min — exhausted by testing; resume scheduled after window reset.
- RATE LIMIT NOTE: /2/users/:id/liked_tweets = 75 requests / 15 min. A single ~38-page likes backfill fits, but repeated runs exhaust it; on 429 the run now stops cleanly + resumable. Use x-rate-limit-reset header to time resumes.

## Image caption tier + media-text-in-search — DONE (2026-06-08), commits ba35970 + 3fcd0ef (pushed)
- NEW capability: purely-visual images (no OCR text) get a factual caption via gpt-4o-mini so image-only posts are content-searchable ("two people on a stage", "line chart trending up"). Same OpenAI key (1Password), no new provider. ~$0.0005/image (detail:low). Live backfill: 58/58 textless images captioned, $0.03 actual.
- `generateImageCaption`/`runCaptionForMediaItems`/`isCaptionCandidate`/`mergeCaptionImageTags` in src/lib/enrich/index.ts. URL allowlist-guarded (same twimg hosts as OCR). vision_caption merged into imageTags WITHOUT clobbering text_ocr/video_transcript. Auth(401/403) fail-fast so a bad key can't burn the whole batch as paid calls. Env: SIFTLY_CAPTION_MODEL / SIFTLY_CAPTION_BASE_URL / SIFTLY_CAPTION_API_KEY (defaults gpt-4o-mini / OpenAI / OPENAI_API_KEY).
- CLI: `enrich.ts --caption [--confirm]` — own cost gate (reuses enforceVisionCostGate), separate from --vision/--ocr.
- **CRITICAL FIX (found while building):** buildEmbeddingInput (src/lib/search/embeddings.ts) only embedded tweet text + semantic_tags + entities — OCR text AND the 560 video transcripts were in FTS (lib/fts.ts) but NOT the semantic vector index. Now buildEmbeddingInput + lexical rerank both include media text (OCR/caption/transcript) via a deterministic `group_concat(imageTags, char(1) ORDER BY m.id)` subquery, flattened through buildImageContext (lib/image-context.ts, which now surfaces vision_caption + video_transcript). char(1)/\u0001 separator.
- Senior Opus review APPROVE_WITH_CHANGES applied: deterministic group_concat ordering; auth fail-fast + test. Declined char(1)-collision (model/tesseract output can't emit \u0001) and concurrent read-then-write race (single-process CLI).
- Verified: tsc clean; suite 100 pass/6 skip; real-vec e2e 8/8. Content-search proven live: "dramatic landscape with rock formations" surfaces a 1-word "Evergreen." tweet purely via its image caption.
- `scripts/finalize-after-drain.sh` (commit 3fcd0ef): waits for the video queue to drain, then re-embeds full corpus (--force, sweeps captions+OCR+transcripts into vec index) and re-exports to Obsidian. Armed as background job after the caption backfill. Until it runs, captions are live in FTS/lexical search; semantic-vector parity lands post-drain.

## Wave 4 — Always-on web launchd artifact (staged, not loaded)
- `scripts/web-server.sh` serves the Next.js production build on `0.0.0.0:3000`; `deploy/launchd/ai.siftly.web.plist` is staged in-repo only. G2/Apollo owns copying/loading it into `~/Library/LaunchAgents/` after Ace approval.
- After UI changes, refresh the live service with: `npm run build && launchctl kickstart -k gui/$(id -u)/ai.siftly.web`.

## Video drain "errors" — ROOT-CAUSED (2026-06-08), not a bug
- 91 queue entries at status=error / attempts=3 (parked, not retrying). Live-investigated, not assumed:
  - **61 "empty transcript"** = video has an audio track but no speech (music/ambient/silent) → Parakeet returns empty. Correct, unrecoverable as a transcript.
  - **30 "ACE-AI service unavailable / all backends failed"** = MISLEADING script message. True cause proven server-side AND reproduced locally: `yt-dlp -x` fails with `Postprocessing: WARNING: unable to obtain file audio codec with ffprobe`. ffprobe on the downloaded mp4 shows **0 audio streams** (video-only h264). i.e. these are **silent videos with no audio stream at all** — same root category as the 61, just detected at extract time instead of transcribe time.
- CONCLUSION: all 91 are genuinely non-transcribable (no speech). NOT recoverable by re-pull/repair. Thumbnail OCR + image caption tiers still cover their visual content for search.
- COSMETIC BUG (low pri, not fixed): parakeet-transcribe.sh reports "ACE-AI service unavailable" when /health is 200 but /transcribe returns 502. The 502 detail (real reason) is swallowed. If we ever touch the script: surface the /transcribe error body instead of the generic "service unavailable". Also could pre-check audio-stream presence to mark no-audio videos distinctly from real backend outages.

## Wave 5 — SPEC DRAFTED (2026-06-08), not yet dispatched
- Spec: `docs/plans/PRD-wave5-cache-audit-aisearch.md`. Three features: (1) x-feed timeline read-through cache (kills ~$6.50/rerun leak — first run pays, same-day reruns ~$0), (2) personal-fit audit trail (durable per-item base/affinity/raw/delta/final → pf-audit/*.json + log.jsonl + Obsidian frontmatter `personal_fit_fired`), (3) AI-search hardening.
- **AI-search investigation RESULT (live-verified): NOT broken.** Fresh uncached `POST /api/search/ai` → HTTP 200, real matches, ~10.5s genuine LLM call. DB `aiProvider=openai`; launchd web injects OPENAI_API_KEY via with-secrets.sh. "Stuck" screenshot = no progress UI during the ~10s SDK call (and/or a pre-launchd `next dev` without the key). LATENT bug: `getProvider()` (lib/settings.ts) defaults to `anthropic` for any non-`openai`/`minimax` value of DB key `aiProvider`; route then falls to a 90s `codexPrompt`/`claudePrompt` CLI path (app/api/search/ai/route.ts:374-403) = the real "hangs forever" mode. Fix = provider/key-consistency guard + bound/opt-in the CLI path + progress UX.
- x-feed pull cost truth: `prompt.md` Step 1 paginates `/2/users/56282605/timelines/reverse_chronological?max_results=100` to a 24h boundary (~1,300 tweets ≈ 13 pages ≈ $6.50/run, 20-page cap). NO cache today; `run-*/responses.jsonl` is an incidental agent debug dump, not read back. morning-digest is search-only (cheap).
- Awaiting Ace review + 2-pass Opus review before dispatch.

## Morning-digest deterministic renderer — DONE (2026-06-10), commit ba82736 (pushed)
`scripts/render_digest.py` — takes Discord-body composition AWAY from the cron model to kill two bugs the model kept reintroducing: the headline/summary echo (`<headline> — <headline re-truncated>`) and format/escaping drift.

- **Source-aware rendering** (Ace's design): TWEETS (`source:"X"`) render VERBATIM x-feed-style — author + likes/reposts meta line, blank, full tweet text cut at a natural sentence/newline boundary past ~600 chars (`natural_truncate`), then URL. STORIES (HN/smol.ai/Latent Space/Perplexity) render `title` headline + ONE distinct `summary` line (echo summaries dropped via `summary_echoes_headline`, >40% word-overlap or substring = echo).
- Renderer owns: `**N.**` numbering, grade emoji/letter (`grade_for`), source suffix, `<url>` wrapping, per-LINE Discord markdown escaping (`esc` — handles multi-line verbatim tweets so a leading `1.`/`-`/`#` on any line can't open a list/header), and posting via `notify.py` (list-args, no shell mangling; notify.py chunks).
- Input contract: `_render_input.json` `{date_label?, ts?, selected:[…], also:[…], footer, empty_note?}`. Item shapes: tweet `{source:"X", authorHandle, tweet_text, likes?, retweets?, score, url}`; story `{source, title, summary?, hn_points?, hn_comments?, score, url}`. Legacy `line` and `title+summary` X items still render.
- CLI: `--in/--out`, `--post --target <ch>`, `--selftest` (37/37). Cron calls it in Step 7; the model only emits JSON now.
- Prompt (`~/.hermes/state/cron/morning-digest/prompt.md`, config-class, backed up `*.bak-*-pre-srcaware-scoring`): Step 7 emits the source-aware schema; Step 5 got CALIBRATION ANCHORS + FORCED DISTRIBUTION (≤2 items ≥90, ≤1 ==100 — fixes the everything-scores-100 inflation) + engagement-bait/reply-fragment HARD-DISCARD.
- Live-verified 2026-06-10: scores spread 91/90/89/89/89/89/87 (2≥90, 0×100), tweets verbatim, story headline+summary, no markdown bleed, 107/157 discarded.
- KNOWN FOLLOW-UP (not rendering/scoring): selection still picks multiple near-duplicate tweets about ONE event from tiny no-engagement accounts — needs event-level dedup + engagement as a quality/tiebreak signal in Step 4/6. Judgment-heavy; left for Ace's call.

## Morning-digest event-dedup + engagement signal — DONE (2026-06-10), commit 4563449 (pushed)
Fixes the "one event eats the digest" bug (5 near-identical 0-like "Anthropic ships Fable 5" tweets as separate Top Stories). Spec `docs/plans/SPEC-digest-event-dedup-engagement.html` (v3, Ace D1–D4 = A/both/tiebreak-only/no-floor); 2-pass Opus review (APPROVE-WITH-CHANGES x2 → cleared, `docs/reviews/dedup-spec-review-pass{1,2}.md`) + post-build code review (`docs/reviews/dedup-code-review.md`, 3 real bugs fixed).

`scripts/render_digest.py` `dedup_and_rank(selected, also)` — pure, runs inside `render_body` BEFORE the empty-result check:
- **Grouping:** exact `event_key` (model-supplied, REQUIRED in Step-7 schema) unions items; fallback = **shared DISTINCTIVE BIGRAM** (a product/entity phrase like ("claude","fable")) via union-find. NOT Jaccard — Jaccard provably couldn't group today's real Fable tweets (overlap 0.20–0.50) without false-merging the same-org policy tweet. Conservative: no shared distinctive phrase ⇒ distinct events (false-split cosmetic, false-merge deletes news). `_GENERIC_TOKENS` (org names + launch verbs) can't be the sole link; a lone distinctive+generic bigram needs ≥2 shared to merge.
- **Winner per event:** `is_primary > final_score > engagement(likes+retweets) > text-len > tweet_id-asc` (two-pass stable sort — the original per-char `_neg_stable` tuple INVERTED for variable-length ids, code-review Finding 1).
- **is_primary:** `item.is_primary==True OR authorHandle ∈ PRIMARY_HANDLES`. Allowlist = `config/primary-handles.txt` (AI labs/official accts) ∪ `thought-leaders.txt` handles, loaded at runtime (RC1, version-controlled not inline).
- **Placement:** GATE-DRIVEN by the GROUP'S BEST member score (not the winner's own) vs 83/77 — so a Top-worthy (84) non-primary member keeps the event in Top even when a lower-scoring primary author wins the cluster (code-review Finding 3). NOT rank-bucketing.
- **Observability:** dropped dups carry `dropped_reason="event_dup"` + `lost_to_url`; CLI writes `_render_dropped.json`.
- Prompt (`prompt.md`, config-class, backed up `*.bak-*-pre-srcaware-scoring`): Step-7 schema requires `event_key` per item + optional `is_primary`.
- 57/57 self-tests (incl. today's real 5-Fable→1, policy stays separate, varlen-id tiebreak, group-best placement, weak-bigram no-merge, all-tie determinism, empty pool, span Top+Also).
- KNOWN LIMITATION (code-review Finding 5, conservative-by-design): grouping needs a shared *surface* distinctive bigram — if next week's dup coverage rephrases with NO shared adjacent product phrase AND the model omits `event_key`, dedup won't fire. `event_key` is the reliable path; the bigram fallback is a safety net, not a guarantee. A genuinely different *angle* on the same event (e.g. a safety-testing field report vs the launch announcement) is intentionally NOT merged.

## Digest selection guard — select_digest.py (2026-06-10)
3rd recurrence of the model-adherence pattern: gpt-5.5 applied the +10 thought-leader boost (and pf delta) to bare @elonmusk reply fragments ("True"/"Yes"/"💯") and off-topic political tweets, base 61 -> 83-84, posting a 7-tweet all-Elon political digest to #daily. Prose rules (Step 3 hard-discard, Step 5 boost) didn't hold. Per the deterministic-guard playbook, selection moved to Python:
- `scripts/select_digest.py` reads the FULL scored pool from `_last_run_debug.json` (`all_scored`), then: #1 hard-discards bare/off-topic reply fragments BEFORE any boost; #2 topic-gates the thought-leader boost (off-topic political TL post -> NO boost; memes count on-topic, Ace's call); applies tracked-project boost, caps, forced distribution, Top(≥83)/Also(≥77) gates; writes `_render_input.json`.
- Pipeline is now: model scores rubric+pf -> Step 6.5 debug dump (now carries verbatim `tweet_text`+`event_key`) -> Step 6.7 `select_digest.py` (owns boost+selection) -> Step 7 `render_digest.py --post` (owns render). Model's own `selected`/`final_score` are IGNORED for posting — only `all_scored` matters.
- Off-topic gate = blocklist {news, news-and-politics, politics} on `signals.topic_hits`; empty topics = off-topic (loses TL boost). Tracked-project boost is NOT topic-gated.
- Self-tests in `--selftest` include an e2e replay of the 2026-06-10 incident pool (asserts not-all-elon, bare frags discarded, good builder content surfaces).
- Prompt backup: `~/.hermes/state/cron/morning-digest/prompt.md.bak-20260610-142605-pre-select-guard`.

### Update (same day) — guard is the SINGLE selection authority + dedup hardening
Wiring select_digest.py surfaced 3 follow-on bugs, all fixed in commit f793969:
1. Two selectors fighting: render_digest's `dedup_and_rank` re-gated everything ≥83 into Top with no MAX_TOP cap, overriding the guard's 5-top/2-also split. Fix: `render_digest.py --no-dedup` renders the guard's buckets AS-GIVEN; the guard now also owns event-dedup (`_collapse_events`/`_guard_event_groups`). **The cron MUST call render with `--no-dedup`** (prompt Step 7 updated).
2. Model event_keys are unreliable (Fable-5 day → 6 distinct keys for one event). Guard unions by event_key AND runs the distinctive-bigram pass UNCONDITIONALLY (event_key only adds merges, never un-merges).
3. Unconditional bigram pass exposed weak links in render_digest's shared primitives → tightened: contraction tails (ve/re/ll/s/t/don/doesn/…) + pronouns added to `_STOPWORDS` (killed `('ve','been')` false-merge); generic theme/format words (open/source/api/code/agent/show/hn/github/…) added to `_GENERIC_TOKENS` (killed `('open','source')` and `('show','hn')` over-merges). Conservative restored: only true product-phrase clusters (e.g. `claude fable`) merge.
Pipeline final: model scores → Step 6.5 debug dump (full pool, verbatim tweet_text + event_key) → Step 6.7 `select_digest.py` (hard-discard bare frags → topic-gated boost → event-collapse → forced-dist → Top/Also) → Step 7 `render_digest.py --post --no-dedup`. Verified live on 2026-06-10 Fable-5 pool: 5 top + 2 also, launch shown once, zero Elon political junk.

### Update — low-reach cap (#3 base-score-inflation guard), 2-pass Opus reviewed
Wiring #1+#2 exposed that the model FLAT-RATES X items at base 80 regardless of quality — spam bots (@bitnewsbot) and zero-reach rants cleared the 83 gate on base+pf inflation alone (no boost). On real data @emollick (249 likes, real TL) scored base 71, LOWER than a spam bot at 80. base_score is noise on the X surface; engagement is the real signal.
Fix (select_digest.py `low_reach_cap`): an X post from a NON-thought-leader handle with likes+retweets < LOW_REACH_ENGAGEMENT_FLOOR(5) is CAPPED at LOW_REACH_SCORE_CAP(70) (< Also gate 77). **Cap, not subtraction** — robust to pf magnitude: pf-score.py emits delta = clamp(affinity-baseline,-1,1)*weight, weight normalized to max 60 → ~24.6 today (PF_WEIGHT=30), ~49 max; a fixed -N would be raced by pf. Thought-leaders, non-X stories, engaged posts exempt; tracked-project mention deliberately NOT exempt (spam name-drops labs — every such "saved" item was junk on real data). `_engagement` falls back to public_metrics.{like_count,retweet_count}. Audit adds `low_reach_capped` + `unsourced_items`.
2-pass Opus review (claude-bridge-f2; local+F1 bridges were weekly-429'd): Pass1 APPROVE WITH CHANGES (field-aliasing/unsourced/pf-magnitude) → all applied → Pass2 APPROVE. Reviews in docs/reviews/lowreach-review-pass{1,2}.md. Pass-2 timing caveat noted in code: cap leans on "real content earns ≥5 engagement" — revisit if ingest ever goes near-real-time.


## Deterministic digest scoring — CUTOVER LANDED (2026-06-11)
- The morning-digest now scores via `score_digest.py` (model emits bounded enum labels content_type/actionability/substance/on_topic; Python computes the final from a deterministic sum of named terms). Replaces the prose base_score rubric the model kept ignoring.
- Wiring: prompt.md Step 6.7 runs `select_digest.py --engine deterministic`. select_digest stays the single render-contract authority; its scoring engine is swapped via build_render_input(engine=). engine=legacy still default for any other caller.
- Label-trust BACKSTOPS (score_digest.py): Python overrides bogus model labels — is_bare_fragment forces reply_fragment; python_on_topic forces on_topic→off when the body has ZERO real tech tokens (does NOT trust enrichment topic_hits, which auto-tagged a political insult 'ai'). Fail-safe: only downgrades. Fixed the 2026-06-11 @elonmusk 'scumbag and traitor' miss (78→44, below gate).
- Also: insults=off prompt rule added (model told personal attacks/political/dunking = on_topic=off). x-feed-brief reduced 10→5. X-gather crash fixed (no Path.unlink(missing_ok=) in inline python — anaconda 3.7 on PATH).
- Gates (TOP=58/ALSO=50/cap=ALSO-5/PF_CAP=12) are FIRST-PASS for the new range; shadow-score-check cron (8am×7d) accumulates data to re-derive them. Known tuning signals: gates still admit ~21/77 over TOP; per-author clustering possible (3× @emollick in one Top 5) — consider per-author cap.
- x-feed-brief deterministic port = NOT done (Open-Q4, deferred — it uses its own inline prose scoring, no select_digest).
- Spec: docs/plans/SPEC-deterministic-digest-scoring.md (v4, 3-pass reviewed) + SPEC-label-trust-backstops.md. Backups: prompt.md.bak-cutover-20260611-113133.

## Wave 6 — DONE + LIVE CUTOVER (shadow) (2026-06-13)
- Embedding personal-fit (A1), ingest gatherers (Reddit/GitHub-Trending), cross-brief dedup (own `cross-brief-seen.db`), MMR diversity, eval harness (rank_metrics + provenance), adversarial gold A/B — all merged after 2-pass Opus diff-review + 6 fix-lanes (mutation-proven). PRD/reviews/plan in docs/plans + docs/reviews (wave6-*).
- **LIVE: pf-score runs in `PF_AFFINITY_MODE=shadow`** in both crons (prompt.md edits, backed up `.bak-wave6-*`). Brief output is BYTE-IDENTICAL (shadow returns the keyword delta); the durable pf-audit artifact ALSO records the embed shadow delta + `embedding_affinity` (l2norm) each run. `pf-audit.py` self-provisions OPENAI_API_KEY (op fast-path/mode-gate/opt-out via `PF_AUDIT_NO_OP_PROBE`) + vec0 for shadow runs.
- **NOT promoted to `embed`** — deferred by construction: needs ≥3 shadow runs ≤10% per-brief gate-cross (AC#9) + the saw-didn't-save eval (~14d provenance maturation). `wave6-embed-shadow-watch` cron (no_agent, daily 9am, id b1d97a08b131) is SILENT until ≥3 shadow runs accrue, then reports promotion-readiness to #discord. Flip = a gated one-line brief-config.json change with Ace.
- CI: `npm run verify` skips-with-warning on vec0 when unprovisioned (dev speed); `npm run verify:live` (with-secrets.sh) ARMS the real-vec + shadow byte-identity guards. Use verify:live to prove the embed path.

### Wave 6 P1 — output-feature STAGING (2026-06-14, commit a3f9e8f)
- The output-CHANGING half (cross-brief dedup, MMR diversity, discovery gatherers) was NOT wired into the briefs at cutover — they alter the posted SET, so same discipline as `embed`: shadow/validate before live-wire.
- **`scripts/output_shadow.ts`** — OFFLINE read-only harness over both briefs' real run dumps (morning-digest posted set = `_render_input.json`; x-feed = `selected_top_ids`+`quick_hits_ids` from `_last_run_scored.json`). Uses the REAL modules (cross-brief-dedup, diversity-rerank, surfaced-provenance) — NOT reimplementations. Reports cross-brief would-suppress dedups + within-posted MMR author-cap drops/reorders (scoring-basis-clean floor; pool-replacement deferred to live wiring) + starts the saw-didn't-save clock. Idempotent via atomic O_EXCL artifact claim (no provenance double-log, even under concurrent runs). Artifacts → `~/.hermes/state/x-bookmarks/output-shadow/`, 14d TTL.
- **`scripts/gatherer_probe.ts`** — live reddit+github-trending inflow probe; volume + net-new vs today's briefs (cross-deduped). **FINDING: reddit JSON = HTTP 403 from this host (datacenter-IP block) — needs auth/UA before wiring; github-trending healthy ~14 net-new/run.** Artifacts → `~/.hermes/state/x-bookmarks/gatherer-probe/`.
- **`wave6-output-shadow-watch`** cron (no_agent, daily 9am, id d8ff8fbce6b1, `~/.hermes/scripts/wave6-output-shadow-watch.py`) drives harness+probe daily + reports staging-readiness once ≥3 runs/brief. Silent until then.
- Tests: `scripts/__tests__/output-shadow.test.ts` (10). `npm run verify` exit 0 (TS 221/py 42/e2e 10/gold 4/4); `verify:live` exit 0 with vec0 armed. `docs/eval/surfaced-items/` is gitignored (runtime provenance state).
- **Hardening discovery (2026-06-14, commit 8f01117):** adversarial concurrency found a real TOCTOU race — the original artifact-exists `statSync` idempotency check let N concurrent `output_shadow` runs all append surfaced-provenance (4 runs would have logged 12 records for 3 items; live 3-run test produced 51 instead of 17). Fixed with atomic O_EXCL artifact claim (`flag: 'wx'`); only the claim-winner writes provenance/log/artifact, losers recompute+print but touch no durable state. Added hermetic env overrides (`OUTPUT_SHADOW_ARTIFACT_DIR`, `OUTPUT_SHADOW_PROVENANCE_DIR`) and RED-proven subprocess tests.
- **OUTSTANDING gated live-wire:** the single `prompt.md` edit (per brief) that wires dedup+MMR+gatherers waits on staging evidence + Ace sign-off (+ reddit 403 fix). Back up `.bak` first; rollback = restore `.bak`.

## Reddit gatherer — API DEAD, pivoted to RSS (SHIPPED), commits 6e87ec4 + 4bea7fc
- ROOT CAUSE: Reddit's "Responsible Builder Policy" (Nov 2025) CLOSED self-service API access — personal "script" apps don't qualify, the prefs/apps create-form rejects with the policy link (Ace hit it). Anon .json reads 403 from datacenter IPs. The earlier app-only-OAuth fix (f4af53a) was a DEAD END (no creds obtainable) — reverted/superseded.
- FIX (SHIPPED): `scripts/gather/reddit.ts` now reads PUBLIC RSS `/r/<sub>/hot.rss` (Atom), regex-parsed (no new dep, github-trending house style). Same `RedditCandidate` shape. authorHandle normalized to canonical `u/<name>`. Engagement = honest zeros (RSS has no metrics — NOT fabricated). Sequential + delay + bounded 429 retry (honors Retry-After); empty-feed vs truncated-feed distinct warns; never throws. Parser hardened (Opus diff-review): alternate/comments-link selection, CDATA strip, source-author anchoring.
- ALL Reddit cred plumbing removed (with-secrets.sh, .env.example) — no creds anywhere.
- MULTI-SUB SOLVED via egress-lane round-robin (commit pending, docs/reviews/reddit-rss-live-proof.md). CORRECTION: Mac Studio is NOT datacenter — egresses Charter/Spectrum residential (68.185.70.45). Reddit per-IP RSS budget ≈1 fetch/window on ANY single IP. Fix: `lanes` option round-robins subs across independent residential IPs (Spectrum direct + Starlink SOCKS 192.168.1.217:1080), dep-free curl --socks5-hostname transport. Live: 2 subs across 2 lanes -> 20 candidates, both 200, zero 429. CLI: --lane '' --lane socks5://host:port (repeatable). MacBook-Pro `cell` lane NOT needed. github-trending stays resilient (~14 net-new/run).
- NOT wired into any live brief (grep-confirmed). PRD `docs/plans/PRD-reddit-rss-pivot.md` (v3, Opus 2-pass cleared). Wiring is a separate future PRD; HANDOFF invariant: that PRD must add a "reddit fetched==0 for N days" warn.
