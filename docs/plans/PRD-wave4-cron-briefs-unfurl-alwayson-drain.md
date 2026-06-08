# PRD — Siftly-Ace Wave 4: Cron Alerts, Always-On Web, Quote Unfurl, Brief Personalization, Pooled Drain

**Version:** v3 (Pass-2 APPROVE — B5 escape-hatch excised from Phase 3/T3/OQ, B4 acceptance bullet added; cleared for swarm dispatch)
**Date:** 2026-06-08
**Author:** Apollo
**Owner:** Apollo (orchestrator)
**Repo:** `Kyzcreig/siftly-ace` · local root `~/Projects/siftly-ace` · HEAD `104dbfb`
**Host:** Mac Studio M3U (always-on, Apollo's host)
**Builder:** Daedalus (`openai-codex/gpt-5.5` xhigh) via native Hermes Kanban
**Predecessor:** PRD v5 (original build — DONE). This PRD is the next wave only.

---

## 1. Summary & Goal

The Siftly-Ace knowledge base is built and live (3,547 items, embedded, tag-coverage 56%, hybrid search, Obsidian export, daily ingest cron). Wave 4 closes five gaps Ace identified:

1. **Cron alert routing** — the daily ingest cron's alerts go to the Home Discord channel, not the dedicated ops channels. Route **failures → `#alerts`** (loud) and **successes → `#logs`** (quiet heartbeat).
2. **Always-on web app** — replace the manual `next dev` with a launchd-managed production server, permanently reachable over Tailscale.
3. **Quote-tweet unfurl** — render quoted/embedded X posts inline in the web UI (embed the quoted child inside our enriched card), instead of a bare "View on X" link.
4. **Brief personalization** — build the PRD-v5-specced-but-unbuilt preference model + personal-fit layer so the corpus re-ranks `x-feed-brief` and `morning-digest` candidates toward what Ace actually saves. Kill-switch + fail-safe + dry-run gated.
5. **Pooled video drain** — point the video transcription drain at the **already-live 3-backend Parakeet pool** (ACE-AI RTX PRO 6000 + ACE-MEDIA RTX 5090 + Mac Studio MLX) and parallelize the **download stage** (the real bottleneck), cutting the multi-hour tail.

**Non-goals:** no rewrite of the brief base rubric (personal-fit is additive); no change to brief *sourcing*; no new X API scopes; **no prod corpus-DB schema migration** (quote-unfurl caching uses an isolated `.local` store).

---

## 2. Ground Truth (verified live, 2026-06-08 — do not re-litigate)

| Fact | Evidence |
|---|---|
| Daily ingest cron is built + loaded | `ai.siftly.daily-ingest.plist`, 5:30am PT, `RunAtLoad false`; `daily-ingest.ts` = credit-floor → ingest→enrich→embed→export, 20-min budget |
| Cron alert mis-routes | `daily-ingest.ts:190` calls `notify.py --channel discord` → posts to `DISCORD_HOME_CHANNEL` (Home), NOT `#alerts` |
| `#alerts` = `1480528231286181948` | loud failures (Ace) |
| `#logs` = `1480525090331561984` | topic "Automated: HA events, new devices, errors" — success heartbeats (Ace) |
| `notify.py` supports explicit channel | `--target <channel_id>` overrides Discord channel (notify.py:249, `_send` target arg) |
| Brief prompts are git-tracked | `~/.hermes/state/cron/` is a git repo (HEAD `97b33d2`) → versioning/rollback feasible |
| Preference model NOT built | no `scripts/profile.ts`, no `scripts/pf-score.py` in repo |
| Quote data is present | `referenced_tweets` type `quoted` + `entities.tweetType` already stored in `rawJson` |
| `react-tweet` fits our stack | v3.3.1, MIT, **Next.js 16 compatible** (our version), no API key, renders quoted tweets natively, RSC-compatible; needs caching to avoid syndication-API IP rate-limit |
| Parakeet pool is LIVE (3 backends) | health-checked: ACE-AI `192.168.1.216:8923` (loaded), ACE-MEDIA `192.168.1.78:8923` (ok), Mac MLX `127.0.0.1:8924` (loaded). Least-inflight dispatcher `src/asr_pool.py` exists in youtube-notebooklm; `PARAKEET_URL` pins one call |
| ASR is NOT the drain bottleneck | parakeet skill: 5090 does 30-min audio in 14.2s (126× realtime); **download/acquisition I/O is the bottleneck** → parallelize downloads, keep `max_inflight=1` per card |
| Web app binds all interfaces | `next dev` listens `*:3000`; reachable `http://mac-studio-m3u:3000` (Tailscale 100.112.250.39) |
| Credit budget is a non-issue | cap 2,000,000/period; daily ingest ~380 reads + briefs ~40k/mo ≈ <3% of cap |

---

## 3. Phased Roadmap

### Phase 1 — Cron alert routing (small; Apollo or 1 worker)
**Outcome:** daily ingest failures → `#alerts`; successes → `#logs` one-line heartbeat.
- Patch `daily-ingest.ts` alert sender to call `notify.py --channel discord --target 1480528231286181948` on failure.
- Add a success heartbeat: on `ok`, post `notify.py --channel discord --target 1480525090331561984` with one line (e.g. `✅ siftly daily ingest: +N bookmarks, +M likes, KB items=T`). Success line is emitted only by the cron path, not interactive runs.
- Make both channel IDs overridable via env (`SIFTLY_ALERT_CHANNEL`, `SIFTLY_LOG_CHANNEL`) with the verified IDs as defaults, set in `daily-ingest.sh`.
- **Alert-delivery fallback (Blocker 4 fix):** if the `--target #alerts` post fails (wrong ID / revoked / bot lacks post permission), the alert sender MUST fall back to `--channel discord` (Home) AND/OR `--channel all` so a failure is NEVER swallowed — a mis-routed `#alerts` post can't make a prod failure silent. The success-heartbeat call to `#logs` MUST be wrapped so a heartbeat-send failure is logged and **cannot abort or mask the real ingest run or its failure alert** (heartbeat is best-effort, non-fatal).
- **Permission precheck (Blocker 4 / OQ3):** Phase 1 go-live includes a one-time live check that the notify bot can actually POST to BOTH `#alerts` and `#logs` (not just that the channel IDs exist) — a real test message to each before declaring Phase 1 done.
- **Config-class:** the `.plist` is unchanged (only the script changes), so no launchd reload needed unless env wiring moves into the plist — if it does, show the plist diff + Ace approval.

**Eval (objective):**
- Unit test: alert sender invoked with `--target 1480528231286181948` on a simulated stage failure; heartbeat sender invoked with `--target 1480525090331561984` on success; neither uses the Home default.
- Unit test: `PF_*`-style env override changes the target; default is the verified ID.
- Live: one forced-failure run posts to `#alerts`; one success run posts to `#logs`.
**Write scope:** `scripts/daily-ingest.ts`, `scripts/daily-ingest.sh`, `scripts/__tests__/daily-ingest*.test.ts`.

### Phase 2 — Always-on web (launchd production server)
**Outcome:** web app survives reboot, permanently at `http://mac-studio-m3u:3000`, serving the production build.
- `scripts/web-server.sh`: `npm run build` (if stale) → `npm run start -- -p 3000 -H 0.0.0.0`, with-secrets wrapper for any runtime env, logs to `~/Library/Logs/siftly-web.log`.
- launchd job `ai.siftly.web.plist`: `RunAtLoad true`, `KeepAlive true`, stdout/stderr to the log, sparse-PATH hardened (Homebrew + system paths like daily-ingest.sh).
- Document the refresh path: after a UI change, `npm run build && launchctl kickstart -k gui/$(id -u)/ai.siftly.web`.
- **Config-class (HARD RULE):** new launchd job → show the exact plist + `launchctl bootstrap` plan, get Ace approval, then load + verify.

**Eval:**
- `web-server.sh` builds + starts; `curl -sf http://127.0.0.1:3000/api/stats` returns the live corpus counts.
- `curl -sf http://mac-studio-m3u:3000/` 200 over Tailscale.
- KeepAlive respawn: kill the node PID → launchd restarts it within seconds (verified via `launchctl kickstart` + re-curl).
- Boot-survival (Required Change 7): simulate boot with a `launchctl bootout` → `launchctl bootstrap gui/$(id -u)` cycle (not just kickstart) → `curl` 200, proving `RunAtLoad` brings it up from a cold load. (A literal reboot is optional; the bootout/bootstrap cycle is the objective proxy.)
- Serves the production build (not dev): response has no Turbopack/dev HMR markers.
**Write scope:** `scripts/web-server.sh` (new), `deploy/launchd/ai.siftly.web.plist` (new, staged in-repo; install gated on Ace), README/AGENTS note.

### Phase 3 — Quote-tweet unfurl (embed quoted child in our card)
**Outcome:** a bookmark that quotes another tweet renders the quoted tweet inline inside our enriched card (keeping our tags/enrichment), matching x.com's unfurl.
- `npm install react-tweet@^3.3`.
- In `components/bookmark-card.tsx`: detect a quoted ref (`referenced_tweets` type `quoted` / `entities.tweetType === 'quote'`), extract the quoted tweet ID, and render the quoted child via `<EmbeddedTweet>` (pre-fetched) or `<Tweet id>` inside our card body. Keep our own card chrome + tags.
- **Caching (required) — DECIDED: isolated store, NO prod-DB migration (Blocker 5 fix):** `lib/tweet-cache.ts` uses a **separate SQLite file** (`.local/tweet-cache.db`, gitignored) OUTSIDE the prod Prisma corpus schema — so NO migration touches the live 3,547-item `prisma/dev.db`. Schema `tweet_syndication_cache(id TEXT PK, json TEXT, fetched_at INTEGER)`. (If `unstable_cache` proves simpler in-build, it's an acceptable equivalent — it is ALSO non-prod-schema; either way `prisma/` is never touched and the prod corpus DB is never migrated for this feature.) **Privacy/TTL (Required Change 6):** cache ONLY public tweets (the `TweetNotFound` fallback already excludes private/deleted); **TTL = 30 days**, refetch after expiry so deleted/edited tweets don't render stale forever; NEVER write auth tokens or user-context data to the cache.
- Theme: honor our dark theme (`data-theme="dark"`/`.dark` parent wrapper).
- Graceful fallback: deleted/old/private quoted tweet → `TweetNotFound` → fall back to the current "View on X" link card. Never crash the card.

**Eval:**
- The David Ondrej bookmark (`2063705880684581305`, quoting @steipete `2063697162748260627`) renders the quoted tweet inline; dark theme correct.
- Second load served from cache (no second syndication call) — assert cache hit.
- A bogus/deleted quoted ID renders the fallback link card, no thrown error (negative case).
- `npm run verify` green (typecheck + lint + unit + e2e).
**Write scope:** `package.json`, `components/bookmark-card.tsx`, `lib/tweet-cache.ts` (new), `.local/tweet-cache.db` (new isolated store, gitignored — created at runtime, NOT a Prisma migration), `components/__tests__/bookmark-card*.test.tsx`. **MUST NOT touch `prisma/schema.prisma` or run any migration against the prod corpus DB.**

### Phase 4 — Brief personalization (the main event; per PRD v5 §5.7/§5.8)
**Outcome:** the corpus measurably re-ranks brief candidates toward Ace's actual saves, with a kill-switch and zero risk to the load-bearing briefs.

**4a. Preference model — `scripts/profile.ts`**
- Reads full corpus → writes `~/.hermes/state/x-bookmarks/preference-profile.json` + `Content/X Bookmarks/Ace Bookmark Preference Profile.md` (Obsidian).
- Signals (PRD v5 §5.7): topic affinity (from tags + context-annotation tags + embedding clusters), source/author affinity (**bookmark 1.0 / like 0.3 — now correct post 104→2635 fix**), format affinity (factual flags only), negative/contrast set, with the **circularity guard** (brief-surfaced-then-saved items tagged `origin: brief-surfaced`, excluded from affinity reinforcement). Novelty calibration disabled with a logged note (no `saved_at` per premise-gate).
- Output the JSON shape in v5 §5.7.

**4b. Scoring helper — `scripts/pf-score.py`**
- Input: brief candidates JSON (tweet text + author + ids). Output: per-item `personal_fit_raw` (−1..+1) + signal breakdown, from sqlite-vec similarity to corpus + author/format/topic affinity − contrast penalty.
- **Hard 30s timeout + fail-safe:** any error/timeout/malformed/vec-load-fail → emit a sentinel that makes the brief fall back to base_score only, log one line, exit non-fatally. Tested failure path. **(OQ5)** the 30s budget covers scoring ONLY; the vec0 extension + profile JSON are **pre-warmed once at helper start** (cold-load excluded from the per-call budget) so a cold vec load can't trip the fail-safe on every first call. If pre-warm itself exceeds a separate 30s cold budget, the helper exits with the base-score sentinel (brief still completes).

**4c. Brief prompt integration (CONFIG-CLASS — diff + approval + backup + dry-run)**
- `x-feed-brief/prompt.md`: add "Step 4.5 — load preference profile + call `pf-score.py`"; fold `final = base + personal_fit_raw × PF_WEIGHT` (default 30). Audit frontmatter records base/raw/delta/final/pf_signals per item.
- `morning-digest/prompt.md`: same layer.
- Config knob `~/.hermes/state/x-bookmarks/brief-config.json` (`PF_WEIGHT`), no code change to tune.
- **Safety (v5 §5.8, non-negotiable):** git-commit prompt files + timestamped `.bak` before edit.
- **Kill-switch = conditional ABSENCE, not zero-weight (Blocker 1 fix).** The personal-fit block (Step 4.5 + the scoring fold) is injected via a **templated include that renders EMPTY when `PF_WEIGHT=0`** — so at `PF_WEIGHT=0` the rendered `prompt.md` is **literally byte-identical to the pre-Wave-4 prompt** (no "load profile / call pf-score" instructions in the token stream at all). The kill-switch test asserts byte-equality of the **rendered prompt file** against the committed pre-Wave-4 baseline, NOT just zeroed score arithmetic — because added instructions change LLM output even at weight 0.
- **Dry-run isolation (Blocker 2 fix).** Dry-runs operate on a **copy** of the prompt, never the live file. Ordering invariant (enforced by Apollo, stated in §6): **(a)** the live `ai.*` brief cron is disabled (`launchctl bootout`) for the dry-run window OR the edited prompt is kept UNCOMMITTED to the `~/.hermes/state/cron/` git repo until approved; **(b)** no scheduled cron may fire against an edited-but-unproven prompt; **(c)** promote order = dry-run on copy → diff actual **brief output TEXT** (not just numeric deltas) → Ace review → commit to cron repo → verify next live run. **≥3 dry-runs** (`DRY_RUN=1` → produce output, do NOT post/seen-write) before go-live.

**4d. Feedback loop (additive)**
- Local tweet-ID matching: brief-surfaced item later bookmarked/liked = positive (tagged distinctly per circularity guard); surfaced-but-never-saved = weak negative **only after a 14-day grace window** (OQ7 — without `saved_at`, "never saved" is bounded by a 14-day lookback so recent surfaced items aren't prematurely penalized). **Double-count guard (Product lens):** an item that is both brief-surfaced AND organically saved counts ONCE — the `origin: brief-surfaced` tag wins and excludes it from organic affinity reinforcement (per the circularity guard), so it can't be tallied as both a feedback-positive and an organic-affinity-positive. Feeds contrast set on next `profile.ts` run.

**Eval:**
- `profile.ts`: unit tests for each signal; bookmark weight 1.0 vs like 0.3 reflected; circularity-guard excludes `origin: brief-surfaced` from affinity; output JSON matches schema; runs on the real 3,547-item corpus and writes both artifacts.
- `pf-score.py`: returns calibrated scores for a fixture; **fail-safe tests** — forced timeout, malformed input, missing vec extension, missing key all degrade to "base-score only" sentinel and exit 0.
- **Kill-switch test:** `PF_WEIGHT=0` → scoring path byte-identical to unpatched (golden-file diff).
- **Dry-run gate (with Ace):** ≥3 dry-runs, patched-vs-unpatched diffs reviewed; audit frontmatter present.
- Prompt rollback: `.bak` + git revert restores pre-Wave-4 brief behavior.
**Write scope:** `scripts/profile.ts` (new), `scripts/pf-score.py` (new), `scripts/__tests__/profile*.test.ts`, `scripts/__tests__/pf-score*.{test.ts,py}`, `~/.hermes/state/x-bookmarks/brief-config.json` (new). **Prompt edits (`x-feed-brief/prompt.md`, `morning-digest/prompt.md`) are MAIN-AGENT/Apollo-only under config-gate — NOT a worker write scope.**

### Phase 5 — Pooled + parallel video drain
**Outcome:** the drain uses the live 3-backend Parakeet pool and parallel downloads; multi-hour tail → ~2h or better.
- **Route transcription through the pool:** the drain already calls `parakeet-transcribe.sh` (which now supports `PARAKEET_URL` + the `YTNB_ASR_BACKENDS` least-inflight dispatcher). Wire the drain to the pool dispatcher (health-checked, timeout→failover→re-enqueue, idempotent by input). Do NOT rebuild a balancer — it exists.
- **Parallelize the bottleneck (download), not the GPU:** replace the single global queue mutex with **per-item leases**. **Atomicity primitive (Blocker 3 fix):** the claim MUST be a single atomic SQLite statement — `UPDATE queue SET status='leasing', owner=?, leasedAt=? WHERE status='pending' ORDER BY id LIMIT ? RETURNING id` (better-sqlite3 supports `RETURNING`); NO read-then-write claim (that double-claims). Release on done; stale-lease reclaim (`leasedAt` older than TTL) returns the item to `pending`. **Lease TTL = 15 min**, and `leasedAt` is **wall-clock UTC** written by the claiming host (single queue file on the Mac Studio, so one clock — no cross-backend skew; the 3 GPU backends only transcribe, they don't touch the queue). Run 2–3 concurrent download workers feeding the pool. Keep `max_inflight=1` per card (measured: per-card concurrency gives diminishing returns).
- **Idempotency key = tweetId, with an idempotent FTS write (Blocker 3 fix):** the transcript write MUST be `INSERT … ON CONFLICT(tweetId) DO NOTHING` (or keyed UPDATE) so a reclaim of an item whose first owner wrote the transcript but died before releasing the lease can NEVER create a duplicate FTS row. Never double-transcribe a tweetId; lease expiry safe.
- Stays out-of-band (not in the 5:30am budget).

**Eval:**
- Unit/e2e: 2 workers on a seeded queue process **disjoint** items, no double-processing; a stale lease is reclaimed and reprocessed exactly once (negative/adversarial: kill a worker mid-lease).
- Pool routing: a transcribe call honors `PARAKEET_URL`/pool selection; pool health-check skips a DOWN backend.
- Live: run the real drain with the pool + ≥2 download workers; queue drains, transcripts land in FTS, finalizer fires; measured throughput beats single-stream baseline.
**Write scope:** `src/lib/enrich/index.ts` (queue lease logic only — coordinate with Phase 1 if it touches the same file; it does not), `scripts/video-enrich.ts`, `e2e/` drain tests.

---

## 4. Swarm Decomposition (for prd-swarm-planner / Kanban)

| Task | Phase | Write scope (disjoint) | Depends on | Assignee |
|---|---|---|---|---|
| T1 cron alert routing | 1 | `scripts/daily-ingest.{ts,sh}` + its tests | — | daedalus |
| T2 always-on web | 2 | `scripts/web-server.sh`, `deploy/launchd/ai.siftly.web.plist`, AGENTS note | — | daedalus |
| T3 quote unfurl | 3 | `components/bookmark-card.tsx`, `lib/tweet-cache.ts`, `.local/tweet-cache.db` (isolated), `package.json`, card tests | — | daedalus |
| T4 preference model | 4a | `scripts/profile.ts` + tests | — | daedalus |
| T5 pf-score helper | 4b | `scripts/pf-score.py` + tests | T4 (reads profile JSON shape) | daedalus |
| T6 pooled+parallel drain | 5 | `src/lib/enrich/index.ts` (lease), `scripts/video-enrich.ts`, drain e2e | — | daedalus |

**Main-agent-only (NOT dispatched as worker tasks):**
- **G1 brief prompt edits** (Phase 4c) — config-class, Apollo applies with Ace, diff+backup+≥3 dry-runs.
- **G2 launchd install** (Phase 2) — config-class, Apollo loads the plist after Ace approves.
- **G3 live brief go-live + feedback loop wiring** (Phase 4c/4d) — after dry-runs pass.

Disjoint scopes confirmed: T1 (scripts/daily-ingest), T2 (scripts/web-server + deploy), T3 (components/lib/tweet-cache), T4 (scripts/profile), T5 (scripts/pf-score), T6 (src/lib/enrich + scripts/video-enrich). T5 depends on T4's output JSON shape (link in DAG). No two workers write the same file.

**Up to 6 worker tasks** (Ace authorized up to 8; 6 is the natural disjoint count). All workers: read AGENTS.md first, `block review-required`, do NOT self-merge, run `npm run verify` for TS tasks, every-10-tool-calls `/compact`, truncate >3000-token outputs.

---

## 5. Review Plan
- **Spec review (this PRD):** Opus 2-pass via prd-review-pipeline before any dispatch.
- **Per-task senior diff-review:** Opus on each worker's integrated diff (§2.8.1) — independent re-run of tests, prove hard-fail gates fail, audit self-report vs `git diff`, triage AWC findings.
- **Phase 4 extra gate:** pf-score fail-safe proven (forced failures → base-score) + `PF_WEIGHT=0` byte-identical + ≥3 dry-runs reviewed **with Ace** before brief go-live.

## 6. Safety Gates (main-agent/manual only)
1. Brief `prompt.md` edits — config-class, never a worker, dry-run gated, `PF_WEIGHT=0` kill-switch.
2. launchd job install/load — config-class, Ace-approved plist.
3. Live brief go-live — only after dry-runs look sane.
4. No secrets in repo/transcript; runtime secrets via `with-secrets.sh`.

## 7. Risks, Tradeoffs, Open Questions
1. **Brief prompts are load-bearing (highest risk).** Mitigated: git + `.bak` + dry-runs + `PF_WEIGHT=0` + pf-score fail-safe. Nothing goes live without dry-run review.
2. **react-tweet syndication rate-limit / old tweets.** Mitigated: local cache + `TweetNotFound` fallback.
3. **Personal-fit echo chamber.** Mitigated: circularity guard + audit logging + dial-back `PF_WEIGHT`; start conservative.
4. **Lease logic idempotency.** Must be airtight (exactly-once). Adversarial test = kill mid-lease. Lower value than P1–P4 (current drain finishes in ~5h regardless) — acceptable to defer to future drains if risky.
5. **OQ:** Success heartbeat verbosity — one line per run to `#logs`, or only on change (+N>0)? (Default: every cron run, one line; cheap, `#logs` is for automated noise.)
6. **RESOLVED (was OQ):** tweet-cache store = **isolated `.local/tweet-cache.db`** (separate SQLite file, gitignored, never the prod `prisma/dev.db`). If `unstable_cache` is used instead it is likewise non-prod-schema. **Neither path touches `prisma/` or migrates the corpus DB.** Final.

## 8. Acceptance Criteria
- [ ] Daily ingest **failure** posts to `#alerts` (`1480528231286181948`); **success** posts a one-line heartbeat to `#logs` (`1480525090331561984`); neither uses the Home default.
- [ ] **Alert delivery hardened:** live precheck confirms the notify bot can POST to BOTH `#alerts` and `#logs`; a forced `--target` failure falls back to Home/`--channel all` (no swallowed failure); a heartbeat-send failure is non-fatal to the run + failure alert.
- [ ] Web app runs under launchd (`RunAtLoad`+`KeepAlive`), serves the **production** build, reachable at `http://mac-studio-m3u:3000`, survives a kill (respawn) and reboot.
- [ ] Quoted tweets render inline inside our enriched card (David Ondrej→@steipete case), dark-themed, cached on second load, with graceful fallback for missing quoted tweets.
- [ ] `profile.ts` writes preference JSON + Obsidian profile from the real corpus with correct bookmark/like weighting + circularity guard.
- [ ] `pf-score.py` returns calibrated scores AND degrades to base-score-only on every forced failure (timeout/malformed/no-vec/no-key).
- [ ] `PF_WEIGHT=0` yields byte-identical brief scoring to unpatched; prompt edits git-tracked + `.bak` reversible; ≥3 dry-runs reviewed with Ace before go-live.
- [ ] Video drain routes through the live 3-backend Parakeet pool with parallel downloads; ≥2 workers process disjoint items with exactly-once semantics; throughput beats single-stream baseline.
- [ ] `npm run verify` green across all TS phases; per-task Opus diff-review APPROVE.
- [ ] Docs updated: AGENTS.md + Obsidian overview + mem0 pointer.


---

## 9. Blocker-Resolution Map (Pass 1 → v2)

| Pass-1 finding | Resolution in v2 |
|---|---|
| B1: `PF_WEIGHT=0` "byte-identical" unverifiable (instructions still in token stream) | Kill-switch reframed to **conditional ABSENCE** — templated include renders EMPTY at `PF_WEIGHT=0`, rendered prompt byte-identical to pre-Wave-4 baseline; test asserts rendered-file equality + dry-run diffs **output text** (§4.4c) |
| B2: dry-run not isolated from prod cron | Dry-runs on a **copy**; live cron disabled or prompt uncommitted during window; explicit promote order + "no cron fires against unproven prompt" invariant (§4.4c, §6) |
| B3: lease atomicity + idempotency unspecified | Single-statement atomic `UPDATE…RETURNING` claim; **tweetId** dedup key; **`INSERT…ON CONFLICT DO NOTHING`** FTS write; 15-min TTL, wall-clock single-host queue; adversarial test = owner-wrote-then-died → no dup FTS row (§4.5) |
| B4: alert routing single point of silent failure | Fallback to Home/`--channel all` on `--target` failure; heartbeat best-effort non-fatal; **live bot-post permission precheck** to both channels (§3 Phase 1) |
| B5: tweet-cache prod-DB migration ungated | **Decided: isolated `.local/tweet-cache.db`**, no prod corpus migration (§3 Phase 3) |
| RC6: syndication cache privacy/TTL | Public-only, 30-day TTL, no tokens/user-context cached (§3 Phase 3) |
| RC7: reboot eval not objective | `bootout`→`bootstrap` cold-load cycle as objective proxy (§3 Phase 2) |
| OQ5: pf-score cold vec load in budget | vec0 + profile **pre-warmed** at start; 30s covers scoring only (§4.4b) |
| OQ7: feedback "never saved" unbounded + double-count | 14-day grace window; `origin: brief-surfaced` wins → counted once (§4.4d) |
