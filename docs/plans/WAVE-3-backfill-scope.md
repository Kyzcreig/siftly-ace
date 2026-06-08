# Wave 3 — Cost-Gated X-API Backfill + Daily Incremental Cron

**Status:** scoped / ready to dispatch (2026-06-08)
**Owner:** Apollo (orchestrator) · Builder: Daedalus (openai-codex/gpt-5.5 xhigh)
**PRD:** `docs/plans/PRD-ace-x-knowledge-base.md` (v5) — D4/D5/D9b/D9c, §"Credit-floor guard", §"Backfill timing", Phase 2, Acceptance "Backfill does not deplete brief credits"
**Depends on:** Wave 1 (ingest engine), Wave 2 (enrich/embed/export), persistent embed key (commit `25b8b6b`)

---

## 1. Goal

Turn the existing one-shot ingest engine into a **safe, cost-gated, repeatable corpus loader**:

1. **Credit-floor preflight** — before ANY ingest run, read remaining X API credits and abort+alert if below a reserve sized to protect the morning/X-feed briefs.
2. **Cost-estimate gate** — before the full paginated backfill, print `N items (M images, V video) ≈ $X.XX` and require explicit `--confirm` (or relay to Ace).
3. **402 CreditsDepleted handling** — trap mid-run, alert `#alerts`, stop cleanly (cursor persisted, resumable).
4. **Daily incremental cron** — 5:30am PT, hard 20-min budget, bounded pages, credit-floor guarded, runs ingest→enrich→embed→export end-to-end and alerts on failure.
5. **One real backfill** — execute the gated full backfill with Ace present; report the actual corpus ceiling (D5 discovery).

> Phases 1–4 are buildable now. **Phase 5 (the real backfill spend) is a main-agent / Ace-present gate** — a swarm worker must NOT run it (per prd-swarm-planner §2.9: dispatch the gate, not the gated spend).

---

## 2. Ground truth (verified 2026-06-08 — do not re-litigate)

- **Engine already present** in `lib/xurl-ingest.ts` (663 lines): paginates `pagination_token`→`meta.next_token`, 429 backoff honoring retry (`isRetryable429` + exponential `sleep`), detects 402/`CreditsDepleted` (`classifyXurlError`), dedups bookmark>like by `tweetId` upsert, `--limit` gated to `--dry` only (cursor-safety). CLI: `scripts/ingest.ts` (`--max-pages 50 --page-size 100 --source both`).
- **MISSING** (the Wave 3 delta): no credit-floor preflight, no cost-estimate `--confirm` gate, no 402→alert wiring (402 currently just throws), no reserve config, no daily cron.
- **Credit meter auth nuance (verified live):** `/2/usage/tweets` is **OAuth 2.0 Application-Only** — calling it with the user-context token returns `403 Unsupported Authentication`. The credit-floor guard MUST use the app-only **bearer**, not the ingestion user token. `xurl --app siftly-ace` defaults to the user token; the guard needs the bearer path explicitly.
- **Phase-0 balance:** project_cap 2,000,000 reads / period, usage ~6,166, cap_reset_day 9. ~1.99M headroom. Cost `$0.005/read`; backfill ~3–5k items ≈ **$15–25**; daily incremental = pennies.
- **No `saved_at`/`liked_at`** on payloads → incremental reconciles by `tweetId` upsert over a bounded recent window, never short-circuits on first-seen-ID (X ordering unstable). Weekly full re-page = safety net.
- **Alerts** → Discord `#alerts` (`1480528231286181948`) via `~/.hermes/scripts/notify.py --channel discord` (and/or telegram).
- **Embed key** loads via `scripts/with-secrets.sh` (1Password, no repo literal).

---

## 3. Task DAG

Disjoint write scopes. Each task: `block review-required`, do NOT self-merge. Coder = Daedalus.

### T-W3-1 — Credit-floor guard (preflight + reserve config)  ·  no parents
**Write scope:** `lib/credit-guard.ts` (new), `lib/settings.ts` (reserve key only), `lib/__tests__/credit-guard.test.ts`
**Outcome:** `checkCreditFloor({ reserve })` reads `/2/usage/tweets` via **app-only bearer** for `siftly-ace`, returns `{ remaining, reserve, ok }`. Reserve default sized ≥ both briefs' combined daily read budget (config `SIFTLY_CREDIT_RESERVE`, default 50_000 — generous). On `ok=false` returns a structured abort, never throws past the caller.
**Evals:** unit — mock usage payload (cap/usage) → correct `remaining`; below-reserve → `ok=false`; 403/parse-fail → conservative `ok=false` (fail-closed) + reason. Negative: user-token 403 path must be detected and surfaced as a config error, not silently treated as "no credits".
**Caveat branch:** if the balance read is unavailable, guard degrades to **timing-isolation + hard batch-caps** (PRD Pass-2 OQ1) — implement the `balanceUnavailable` fallback returning `ok=true` only when batch-cap + off-window constraints are satisfied, with a logged note.

### T-W3-2 — Cost-estimate gate + `--confirm`  ·  no parents
**Write scope:** `lib/cost-estimate.ts` (new), `scripts/ingest.ts` (flag wiring only), `lib/__tests__/cost-estimate.test.ts`
**Outcome:** before a non-`--dry` full backfill, do a bounded **count pass** (or use `--max-pages`×`--page-size` ceiling) → print `est: N reads ≈ $X.XX (rate $0.005/read)` and require `--confirm` to proceed; without it, print estimate and exit 0. Daily incremental (`--incremental`) skips the gate (pennies). Estimate is read-only.
**Evals:** unit — N reads → correct dollar math at $0.005; `--confirm` absent → no ingest, exit 0, estimate printed; `--incremental` → gate skipped. Negative: estimate must not itself burn more than a bounded probe of credits.

### T-W3-3 — 402 mid-run handling: alert + clean resumable stop  ·  parents: [T-W3-1]
**Write scope:** `lib/xurl-ingest.ts` (402 path only — wrap the existing `classifyXurlError`→402 into an abort that persists cursor + emits an alert hook), `lib/__tests__/xurl-ingest-402.test.ts`
**Outcome:** on 402 `CreditsDepleted` mid-pagination: persist last good cursor (already in `Setting`), stop the loop cleanly (no partial-row corruption), and invoke an injected `onCreditsDepleted` alert callback (wired to notify.py at the script layer). Resuming re-reads from the persisted cursor.
**Evals:** unit — simulated 402 on page 3 → pages 1–2 persisted, cursor saved, callback fired once, no throw past caller; re-run resumes from saved cursor (no duplicate rows via `tweetId` upsert). Coexistence: 429 retry path unchanged (regression).

### T-W3-4 — Daily incremental cron driver  ·  parents: [T-W3-1, T-W3-3]
**Write scope:** `scripts/daily-ingest.sh` (new, wraps with-secrets.sh), `scripts/daily-ingest.ts` (new orchestrator: credit-floor → bounded ingest → enrich → embed → export → alert-on-fail), `docs/deploy/launchd/ai.siftly.daily-ingest.plist` (new), `lib/__tests__/daily-ingest.test.ts`
**Outcome:** one command runs the full daily pipeline with a **hard 20-min wall budget** (kill+alert if exceeded), bounded `--max-pages`, credit-floor preflight (abort+alert if below reserve), and a single `#alerts` failure notification on any stage error. launchd plist scheduled **5:30am PT**, `no_agent`, secrets via with-secrets.sh. Does NOT run the full backfill.
**Evals:** unit/integration — orchestrator short-circuits + alerts when credit-floor fails (no ingest attempted); stage failure → exactly one alert with the failing stage; time-budget overrun → kill + alert. Dry-run path proves the wiring without real spend. `plutil -lint` the plist.

### T-W3-5 — (GATED, main-agent only) Execute the real backfill  ·  parents: [T-W3-2, T-W3-3, T-W3-4]
**NOT a swarm task.** With Ace present, off the brief window: run cost-estimate → get `--confirm` → full paginated backfill in credit-gated batches → enrich → embed → export. Report actual corpus ceiling (D5), bookmark/like split, truncation, total reads spent vs estimate. Apollo runs this directly.

---

## 4. Review plan

- Per task: independent verify (tsc + targeted tests run by Apollo, not worker self-report) + senior Opus diff-review (local `:18801/anthropic`, fallback F1 `100.92.54.25:18801`, `max_tokens ≥ 6000`).
- Trust-boundary focus: fail-closed credit logic (T-W3-1), no-spend-without-confirm (T-W3-2), no-corruption-on-402 + resumability (T-W3-3), alert-exactly-once + budget-kill (T-W3-4).
- Merge each APPROVE/APPROVE_WITH_CHANGES (real findings applied, hallucinated declined w/ recorded reason) → commit → push.

## 5. Safety gates (main-agent / manual only)

- **Real X-API spend (T-W3-5)** — never dispatched to a worker; Apollo runs it with Ace present after the `--confirm` estimate.
- **launchd load** — Apollo installs/loads the plist after review; not a worker action.
- **Credit reserve number** — final reserve sized with Ace before first live daily run (D9c open question OQ3).
