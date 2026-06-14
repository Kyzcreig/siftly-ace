# Closeout — Wave 6 P1 Output-Feature Staging + Hardening

**Status:** PASS for the shipped staging surface (output-shadow harness, gatherer probe, watcher cron).  
**Correctly open / not closed:** `PF_AFFINITY_MODE=embed` promotion and the live `prompt.md` output-feature wire-in remain gated until their shadow windows produce evidence and Ace signs off.

**Ran against:** project commit `46f8f4d` initially; hardening fix commit `8f01117`; docs closeout commit `46f8f4d`; closeout report introduced in `e3447a7` (follow-up commits may correct this report text).  
**Repo:** `Kyzcreig/siftly-ace`.

## Hardening pass

| Real path | Failure mode attacked | Was covered before? | Test / evidence added | RED proven? | Status |
|---|---|---:|---|---|---|
| `scripts/output_shadow.ts` durable side-effects | Concurrent runs of the same brief/run-ts all append surfaced-provenance because the idempotency guard was check-then-act (`statSync`) | No | Atomic O_EXCL artifact claim; subprocess test `logs provenance exactly once across N CONCURRENT runs` | Yes — reverted to statSync and the test failed `expected 12 to be 3` | PASS |
| `scripts/output_shadow.ts` sequential rerun | Re-running a processed run double-logs saw-didn't-save provenance | Partly | Subprocess test `does not re-log provenance on a SEQUENTIAL re-run` | Yes by same reverted-statSync family; fixed path logs once | PASS |
| `scripts/output_shadow.ts` malformed/missing dump | Missing file / malformed JSON / empty dump crashes cron | No explicit adversarial proof | CLI adversarial runs: missing and malformed dump print clear error and exit 0; empty dump prints 0-posted summary and exits 0 | N/A (existing defensive behavior verified) | PASS |
| `scripts/output_shadow.ts` untrusted strings | Shell metacharacters / malformed URLs execute or corrupt state | No explicit adversarial proof | Evil dump with `$(rm -rf ...)`, backticks, SQL-ish handle, `javascript:` URL, invalid URL; no shell execution, no crash, `/tmp/pwned` absent | N/A (no shell path) | PASS |
| `scripts/gatherer_probe.ts` live fetch | Reddit/GitHub source failure blocks probe or writes bad state | No explicit adversarial proof | Live probe: reddit returns HTTP 403 and becomes 0 fetched; github-trending returns 14 net-new; exit 0 | N/A | PASS |
| `wave6-output-shadow-watch.py` aggregation | Corrupt artifact crashes watcher; watcher spams before enough evidence | No explicit adversarial proof | Injected corrupt JSON artifact; watcher exit 0 and silent while `<3` runs | N/A | PASS |

**Key discovery:** the output-shadow idempotency guard was TOCTOU-racy. Before the fix, 3 concurrent real runs produced `51` provenance lines (17 items × 3) and `6` output-shadow log lines (2 briefs × 3 runs). After the atomic O_EXCL claim, 4 concurrent real runs produced exactly `17` provenance lines and `2` log lines.

## Dry runs

| Check | Evidence | Status |
|---|---|---|
| `output_shadow.ts --dry-run` | Exit `0`; state snapshot before/after across `~/.hermes/state/x-bookmarks/output-shadow`, `~/.hermes/state/x-bookmarks/gatherer-probe`, and `docs/eval/surfaced-items` was byte-identical | PASS |
| `gatherer_probe.ts --dry-run --limit 3` | Exit `0`; same byte-identical state proof | PASS |
| Watcher pre-ready behavior | `python3 ~/.hermes/scripts/wave6-output-shadow-watch.py` with `<3` valid runs: stdout `''`, exit `0` | PASS |

## Real runs

| Check | Evidence | Status |
|---|---|---|
| `npx tsx scripts/output_shadow.ts` | Exit `0`; wrote two artifacts. `morning-digest`: posted `7`, dedup `1`, MMR `0/0`, provenance `7`. `x-feed-brief`: posted `10`, dedup `1`, MMR `1 drop / 8 reorder`, provenance `10`. Provenance file line count `17`. | PASS |
| `npx tsx scripts/gatherer_probe.ts --limit 5` | Exit `0`; artifact sources: `reddit: fetched 0, net_new 0`, `github-trending: fetched 14, net_new 14`. | PASS |
| Watcher ready-path | Generated three genuine x-feed output-shadow artifacts by replaying real run dumps with distinct timestamps. Watcher reported x-feed ≥3 runs with aggregate dedup/MMR stats and did **not** mark global READY because morning-digest was still `<3` — correct gate behavior (`ready_all` requires both briefs). | PASS |

## QA / dogfood

| Surface | Evidence | Status |
|---|---|---|
| Full project gate | `npm run verify` exit `0`: TS/Vitest `221 passed / 8 skipped`; e2e `10 passed / 3 skipped`; Python `42 passed`; gold set `PASS (4/4 bars)`. | PASS |
| Live vec/shadow guard | `npm run verify:live` exit `0`: `with-secrets.sh` loaded keys by length only; vec0 path `.local/vec0.dylib`; e2e reported `mode=sqlite-vec` for fresh pipeline / migration / dimension-change tests. | PASS |
| Webapp launchd | `launchctl print gui/$(id -u)/ai.siftly.web`: `state = running`, `pid = 64273`, `last exit code = 0`, program `scripts/web-server.sh`. | PASS |
| Web routes | HTTP 200 for `/`, `/bookmarks`, `/categorize`, `/settings`, `/api/stats`, `/api/bookmarks`, `/api/categories`, `/api/import/x-oauth/status`; `/api/stats` reports real corpus (`totalBookmarks:3574`, `bookmarkCount:2662`, `likeCount:912`). | PASS |
| Adversarial API inputs | Empty/malformed AI-search JSON → 400 (`{"error":"Invalid JSON"}`); huge bookmark limit clamps to 100; negative/non-numeric page/limit falls back to defaults; nonexistent tweet id → 400. | PASS |
| Browser visual dogfood | Browser tool backend failed (`500 Server Error` on `/tabs`), and Playwright/Puppeteer are not installed. HTTP/API dogfood passed; visual click-through remains unexecuted due tool availability. | CAVEAT |
| Web logs | `~/Library/Logs/siftly-web.log` showed no recent errors/exceptions/500s from the dogfood pass. | PASS |

## Acceptance criteria / claimed-done items

| Claim | Evidence | Status |
|---|---|---|
| Output-changing features staged, not wired | `scripts/output_shadow.ts` + `scripts/gatherer_probe.ts`; `wave6-output-shadow-watch` cron daily 9am; no `prompt.md` output-feature live-wire applied | PASS |
| Shadow harness uses real modules | `output_shadow.ts` imports `CrossBriefDedupStore`, `diversityRerank`, `appendSurfacedProvenance` from production libs | PASS |
| Morning-digest posted set reconstructed correctly | Harness reads `~/.hermes/state/cron/morning-digest/_render_input.json`, not the debug dump's stale/empty selected fields | PASS |
| MMR shadow avoids mixed-score false drops | Harness reranks within the posted set only and documents pool-replacement as deferred to live wiring | PASS |
| Provenance append is idempotent under rerun/concurrency | Atomic O_EXCL claim + two regression tests; RED-proven against statSync | PASS |
| Gatherer inflow measured live | Probe artifact: github-trending healthy ~14 net-new; reddit 403 finding captured | PASS |
| Watcher reports only after enough evidence | Silent before `<3`; readiness path verified for x-feed only, and correctly withheld global READY while morning-digest `<3` | PASS |
| Docs/handoff current | `AGENTS.md`, `docs/plans/WAVE-6-LIVE-CUTOVER-PLAN.md`, Obsidian `Ace X Knowledge Base — System Overview.md`, `siftly-ace-operations` skill + reference updated | PASS |

## Constitution / invariants

| Invariant | Evidence | Status |
|---|---|---|
| Do not change live brief output without evidence + Ace sign-off | No output-feature prompt live-wire applied; embed remains shadow; watchers gate both promotions | PASS |
| No secrets in repo/docs/logs | Secrets only observed via `with-secrets.sh` length outputs; diff secret scan clean; no raw keys in commits | PASS |
| Brief failure isolation | Harness/watcher exit 0 on missing/malformed/corrupt inputs; no prompt changes that can break daily posting | PASS |
| Runtime state is local, not committed | `docs/eval/surfaced-items/` gitignored; output/gatherer artifacts live under `~/.hermes/state/x-bookmarks/` | PASS |
| Reproducible zero-context operation | Project `AGENTS.md`, Obsidian overview, and `siftly-ace-operations` skill describe next steps, watchers, artifact paths, and rollback | PASS |

## Git / docs / memory

- Project commits pushed:
  - `a3f9e8f` — output-feature staging harness + gatherer probe + watcher registration docs.
  - `8b05e42` — zero-context project docs.
  - `8f01117` — TOCTOU hardening fix + RED-proven tests.
  - `46f8f4d` — project docs update for hardening discovery.
- Hermes-home skill-doc commit pushed:
  - `ceeb5ff` — `siftly-ace-operations` skill/reference now teach atomic O_EXCL, not stale artifact-exists check.
- Obsidian updated:
  - `/Users/alexgierczyk/Obsidian/Ace Place/AI/Ace X Knowledge Base — System Overview.md`
  - `/Users/alexgierczyk/Obsidian/Ace Place/Content/X Feed Brief/_Bookmark-Informed Scoring — Handoff.md`
- mem0 updated with Wave 6 P1 staging and hardening facts.

## Cron / alerts

- `wave6-embed-shadow-watch` — daily 9am, no_agent, Discord, script `wave6-shadow-watch.py`, job id `b1d97a08b131`.
- `wave6-output-shadow-watch` — daily 9am, no_agent, Discord, script `wave6-output-shadow-watch.py`, job id `d8ff8fbce6b1`.
- Watchers are intentionally silent until enough evidence accrues; empty stdout = no delivery.

## Remaining work (real loose ends)

1. **Embed promotion remains gated** — wait for `wave6-embed-shadow-watch` to report ≥3 shadow runs with ≤10% gate-cross, plus saw-didn't-save eval maturity (~14d). Then bring the 3-run diff to Ace and flip `PF_AFFINITY_MODE=embed` only with approval.
2. **Output-feature live-wire remains gated** — wait for `wave6-output-shadow-watch` to report ≥3 runs/brief, review dedup/MMR/gatherer evidence with Ace, then apply the single gated `prompt.md` live-wire with backups.
3. **Reddit gatherer needs auth/egress strategy** — unauthenticated Reddit JSON returns 403 from this host; do not wire reddit into the morning brief until solved. Github-trending is ready.
4. **Visual browser dogfood blocked** — browser tool backend 500 and no Playwright/Puppeteer installed; API/route dogfood passed. If full visual QA is required, install/use a browser harness or fix the browser tool.

## DISCOVERIES

- The non-idempotent `appendSurfacedProvenance` call turns a small watcher race into a product-quality bug: concurrent shadow runs inflate saw-didn't-save evidence, which could bias future embed-promotion evaluation. Atomic claim is mandatory.
- For shadowing morning-digest output, `_render_input.json` is the only reliable posted-set source; `_last_run_debug.json` selected/also fields are empty and `all_scored.dropped_reason` is model-prose noise.
- Reddit public JSON is not reliable from the Mac Studio host without an auth/UA/egress fix; github-trending is the low-risk discovery source.
- The watcher readiness gate correctly handles partial readiness: it reports x-feed stats when x-feed has ≥3 runs but withholds global READY until morning-digest also reaches ≥3.
