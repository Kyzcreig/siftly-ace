# siftly-ace — Agent Notes

Fork of viperrcrypto/Siftly → Kyzcreig/siftly-ace. PRD: docs/plans/PRD-ace-x-knowledge-base.md (v5, approved).
Swarm plan: docs/plans/SWARM-PLAN-phase1plus.md. Coding worker = Daedalus profile (openai-codex/gpt-5.5 xhigh).

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
