# PRD — Siftly-Ace Wave 5: Brief Cost-Caching, Personal-Fit Audit Trail, AI-Search Hardening

**Version:** v1 (DRAFT — pending Ace review + 2-pass Opus review before dispatch)
**Date:** 2026-06-08
**Author:** Apollo
**Owner:** Apollo (orchestrator)
**Repo:** `Kyzcreig/siftly-ace` · local root `~/Projects/siftly-ace` · HEAD `375ca87`
**Host:** Mac Studio M3U (always-on, Apollo's host)
**Builder:** Daedalus (`openai-codex/gpt-5.5` xhigh) via native Hermes Kanban (where swarmable)
**Predecessor:** Wave 4 (DONE — cron routing, always-on web, quote unfurl, brief personalization, pooled drain). PF_BASELINE + topic-dedup follow-up DONE (`375ca87`).

---

## 1. Summary & Goal

Four gaps Ace identified after Wave 4 went live:

1. **X-feed brief credit caching (the expensive leak).** The `x-feed-brief` cron pulls Ace's **full 24h reverse-chronological timeline** — ~1,300 tweets/run, ~13 paginated reads, **~$6.50/run at $0.005/read** (hard-capped 20 pages ≈ $10). **Nothing is cached.** Every test rerun re-pulls and re-bills the entire timeline. Add a **read-through timeline cache** so the first run of the day pays; same-day reruns (esp. for testing) cost **~$0**.

2. **Personal-fit audit trail.** After a brief run there is **no durable proof** the `pf-score.py` helper actually fired or how it scored each item. The per-run `/tmp/*-pf-score.json` is ephemeral and the Obsidian archive only stores the summary. Add **per-item audit logging** (base / affinity / raw / delta / final + top signals) persisted to the Obsidian archive frontmatter/body **and** a durable JSONL, for both `x-feed-brief` and `morning-digest`.

3. **AI-search reliability hardening.** `/ai-search` in the web UI works (verified live: fresh query → HTTP 200, real matches, ~10.5s) but has two real problems: (a) **no progress feedback** during the ~10s SDK call, so a screenshot mid-search looks permanently "stuck"; (b) a **latent 90s hang** — if `getProvider()` silently defaults to `anthropic` (DB `aiProvider` unset/typo) while only `OPENAI_API_KEY` is present, the route falls through to the `codexPrompt`/`claudePrompt` CLI path with a 90s timeout that hangs the UI. Harden both.

4. **(Investigation, folded in) Confirm AI-search is not actually broken** and document the real root-cause + fixes (this PRD section 5.3 captures the findings so it isn't re-investigated from scratch).

**Non-goals:** no change to brief *sourcing* logic or the base scoring rubric; no new X API scopes; no prod corpus-DB schema migration; no rewrite of the personal-fit math (Wave 4 + PF_BASELINE follow-up already shipped).

---

## 2. Ground Truth (live-verified 2026-06-08)

- **x-feed-brief pull** (`~/.hermes/state/cron/x-feed-brief/prompt.md` Step 1): inline `xurl` loop paginating `/2/users/56282605/timelines/reverse_chronological?max_results=100` until `created_at` crosses a 24h `SINCE` boundary or 20-page ceiling. Prompt's own cost note: "~1,300 tweets/day → ~13 pages, ~$6.50/run at $0.005/read." Plus 3 `search/recent` calls (20 each ≈ $0.30).
- **No cache today.** The `run-*/responses.jsonl` files under the brief state dir are an *incidental* agent debug dump written **during** a run; **no script reads them back**, and the prompt has no "load cache" step. Only `x-brief-seen.json` persists (dedupe-by-ID for re-*posting*, not re-*paying*).
- **morning-digest** is cheap by contrast: `search/recent` only (3 queries), **no timeline sweep**. Caching it is optional/low-value.
- **pf-score audit gap:** prompt Step 4.5 calls `timeout 30s pf-score.py … > /tmp/<brief>-pf-score.json`; that temp file is not archived. Obsidian archive frontmatter has counts, not per-item base/fit/final.
- **AI-search live test:** fresh uncached query `POST /api/search/ai` → **HTTP 200**, real AI matches, **10.5s** (genuine LLM call). DB `aiProvider=openai`; production launchd web server injects `OPENAI_API_KEY` (len 164) via `with-secrets.sh`. So **not broken now.**
- **AI-search latent bug:** `lib/settings.ts getProvider()` returns `anthropic` for any value of DB key `aiProvider` that isn't exactly `openai`/`minimax`. `app/api/search/ai/route.ts` then, if the SDK client fails/absent, falls through to a **90s** `codexPrompt`/`claudePrompt` CLI path (lines 374–403) — the true "hangs forever" failure mode.

---

## 3. Feature 1 — X-Feed Timeline Read-Through Cache

### 3.1 Design
- **Extract** the inline timeline sweep from the prompt into a script: `scripts/x-feed-fetch.ts` (tsx) or `scripts/x-feed-fetch.sh`. The prompt calls the script instead of inlining `xurl` pagination. (Keeps the brief prompt thin and makes the fetch unit-testable.)
- **Cache store:** `~/.hermes/state/cron/x-feed-brief/cache/timeline-<YYYY-MM-DD>.jsonl` plus a `meta.json` (`fetched_at`, `since`, `page_count`, `tweet_count`, `newest_id`, `oldest_id`).
- **Read-through logic** (before any paid pull):
  1. If a cache file for the current logical day exists AND `now - fetched_at < TTL` (default **90 min**, env `X_FEED_CACHE_TTL_MIN`) → **reuse cached tweets, ZERO new reads.**
  2. Else if a *warm-but-stale* cache exists → **incremental top-up:** since the timeline is newest→oldest, fetch pages only until the first tweet whose `id <= meta.newest_id` (i.e. already cached), then merge + rewrite cache. Costs 1–2 pages instead of ~13.
  3. Else (no cache / older than the 24h window) → full sweep (current behavior), write cache.
- **Search calls** (3× `search/recent`, ~$0.30): cache them too keyed by query+day; cheap but free wins are free.
- **Escape hatches:** `--force` / `X_FEED_FRESH=1` forces a full fresh pull (the daily 7:30am cron can opt into freshness if ever desired; default is cache-respecting so reruns are free). `--no-cache` bypasses read+write entirely.
- **Credit-safety:** before any paid pull, log intended page budget; honor the existing 20-page ceiling. Never let a cache miss silently exceed the cap.

### 3.2 Cost outcome
- First run of the day: ~$6.50 (unchanged).
- Every same-day rerun within TTL: **~$0** (full cache hit).
- Stale-cache rerun (incremental): ~$0.01–0.50 (1–2 pages).

### 3.3 Acceptance criteria
- [ ] Fetch logic extracted to a script; brief prompt calls it; brief output is byte-equivalent in shape to today's.
- [ ] Cold run writes `timeline-<date>.jsonl` + `meta.json`; logs `cache: MISS (full sweep, N pages, ~$X)`.
- [ ] Warm rerun within TTL performs **0** X API reads; logs `cache: HIT (0 reads)`; produces a brief from cached data.
- [ ] Stale rerun does incremental top-up: fetches only pages newer than `meta.newest_id`; logs page count + `merged N new`.
- [ ] `--force`/`X_FEED_FRESH=1` bypasses cache and does a full pull; `--no-cache` neither reads nor writes cache.
- [ ] Unit tests: cache hit, stale incremental merge, dedupe-on-merge, force/no-cache, TTL boundary, 20-page ceiling honored on miss.
- [ ] Dry-run proof: two consecutive runs; second logs 0 reads. (Captured in `docs/reviews/` evidence.)
- [ ] **CONFIG-CLASS GATE (G-W5-1):** the `prompt.md` edit (inline loop → script call) is shown to Ace as a diff with timestamped `.bak`, ≥1 dry-run, before going live.

---

## 4. Feature 2 — Personal-Fit Audit Trail (both briefs)

### 4.1 Design
- **Persist the helper output.** After Step 4.5 calls `pf-score.py`, copy the result to a durable per-run artifact:
  - `~/.hermes/state/x-bookmarks/pf-audit/<brief>-<YYYY-MM-DDTHHMMZ>.json` (full helper output: `ok`, `pf_weight`, `pf_baseline`, per-item `id/affinity/raw/delta/signals`).
  - Append a one-line summary to `~/.hermes/state/x-bookmarks/pf-audit/log.jsonl`: `{ts, brief, ok, pf_weight, pf_baseline, n_items, n_positive, n_negative, fired:true|false, reason?}`.
- **Obsidian archive enrichment.** In the brief archive (`Content/X Feed Brief/YYYY-MM-DD.md` and the digest archive), for each **selected/posted** item add an audit line: `base_score`, `personal_fit_affinity`, `personal_fit_raw`, `personal_fit_delta`, `final_score`, top 2 signals. Add frontmatter: `personal_fit_fired: true|false`, `pf_weight`, `pf_baseline`.
- **Explicit "fired" proof.** If the helper times out / returns `ok:false` / is skipped (`PF_WEIGHT=0`), the archive frontmatter records `personal_fit_fired: false` + reason. This closes "should have fired" → "provably did/didn't."
- Prompts for **both** `x-feed-brief` and `morning-digest` updated symmetrically.

### 4.2 Acceptance criteria
- [ ] After a real run, `pf-audit/<brief>-<ts>.json` exists with per-item affinity/raw/delta.
- [ ] `pf-audit/log.jsonl` gets one summary line per run with `fired` + counts.
- [ ] Obsidian archive shows per-selected-item audit line + frontmatter `personal_fit_fired/pf_weight/pf_baseline`.
- [ ] Forced-failure path (`pf-score --timeout-self-test` shim or PF_WEIGHT=0) → archive records `fired:false` + reason; brief still posts.
- [ ] **Verification rerun:** one live (or dry) run of each brief produces the audit artifacts proving the helper engaged with `pf_baseline=0.18`.
- [ ] **CONFIG-CLASS GATE (G-W5-2):** prompt edits shown as diff + `.bak` + dry-run before live.

### 4.3 "Should we run it again?" — answer
Yes, **once**, after the audit logging lands — that's the cheap, definitive way to confirm personal-fit fired (the morning-digest re-run is search-only, no timeline cost). For `x-feed-brief`, the **timeline cache (Feature 1) must land first** so the confirming rerun is free instead of ~$6.50. Order: build Feature 1 → build Feature 2 → one dry/live rerun of each brief to capture audit artifacts.

---

## 5. Feature 3 — AI-Search Hardening

### 5.1 Findings (investigation result — DONE)
- AI-search is **not currently broken** (live 200 in 10.5s). The "stuck" screenshot = no progress UI during the ~10s SDK call and/or a pre-launchd `next dev` without the injected key.

### 5.2 Fixes
- **Provider/key consistency guard:** at request time, if resolved `provider` has **no usable SDK key** (e.g. provider=anthropic but only `OPENAI_API_KEY` present), **do not silently fall to the 90s CLI path**. Either (a) return a fast, clear `400`/`409` ("provider X selected but no key; set aiProvider/key in Settings"), or (b) auto-select the provider whose key IS present. Prefer (b) with a logged warning, falling back to (a).
- **Bound the CLI path:** drop CLI timeout from 90s → a UI-friendly bound (e.g. 25s) OR gate the CLI path behind an explicit opt-in env so the default web path is always the fast SDK. A 90s synchronous hang is never acceptable for an interactive search box.
- **Progress UX:** the page already aborts at 100s; add a lightweight "this can take ~10–15s" hint + elapsed indicator after ~3s so it never *looks* frozen.
- **Surface real errors:** ensure the route's error JSON (already present) reaches the UI error banner (it does) — add the resolved provider/model to the error for faster diagnosis.

### 5.3 Acceptance criteria
- [ ] With DB `aiProvider` unset and only `OPENAI_API_KEY` present, a search resolves via OpenAI SDK (or returns a fast clear error) — **never** a 90s CLI hang.
- [ ] CLI path is bounded ≤25s or opt-in only; verified by forcing the SDK to fail and timing the response.
- [ ] UI shows an elapsed/“~10–15s” hint after 3s; no permanent-looking "Searching…".
- [ ] Unit/integration test: provider/key mismatch → fast deterministic outcome (no long hang).
- [ ] Live verify: fresh query returns 200 with results; mismatch case returns quickly.

---

## 6. Phasing & Gates

| Phase | Work | Swarmable? | Gate |
|---|---|---|---|
| P1 | Feature 1 fetch-script + read-through cache + tests | Yes (Daedalus) | G-W5-1 prompt diff |
| P2 | Feature 2 audit logging (both briefs) + tests | Yes | G-W5-2 prompt diff |
| P3 | Feature 3 AI-search hardening + tests | Yes | none (no prompt/config) |
| P4 | One confirming dry/live rerun of each brief; capture audit + cache-hit evidence | Apollo (main agent) | live-post awareness |

**Config-class gates** (Hard Config Rules): every `~/.hermes/state/cron/*/prompt.md` edit = show diff → impact + rollback (`.bak` + revert) → Ace approval → apply → verify → report. `PF_WEIGHT=0` remains the personal-fit kill switch; `X_FEED_FRESH=1` / `--no-cache` are the cache escape hatches.

**Verification standard:** `npm run verify` green; pf-score Python tests green; independent senior diff-review of any swarmed task (don't trust worker self-reports); cache cost-savings proven by a real 2-run dry-run showing 0 reads on the second.

---

## 7. Open Questions
1. Cache TTL default — 90 min reasonable, or longer (the timeline doesn't change much intra-day)? Could default higher and rely on `--force` for genuine freshness.
2. Feature 3 fix (a) vs (b): hard error on provider/key mismatch, or auto-pick the present key? (Leaning auto-pick + warn.)
3. Should morning-digest also cache its `search/recent` calls, or leave it (cheap)? (Leaning: cache for symmetry, low priority.)
