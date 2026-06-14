# G1 GATE — dry-run evidence (APPLIED 2026-06-14, post-approval)

Backup: `~/.hermes/state/cron/morning-digest/prompt.md.bak-g1-reddit-github-20260614-042849`
Edits applied: gather_reddit + gather_github blocks, per-source seen-lists (reddit/github-brief-seen.json
seeded `[]`), perf counters RCT/GCT, "ALL SIX" language, both summary cards. +47 lines. Step 0 / Step 6.5
post-pipeline BYTE-IDENTICAL to backup (one-post invariant untouched).

## AC-1 — candidates flow ✓
DRY-RUN 1: reddit `--rotate` (5-of-9 day-seeded, 2 lanes concurrent) = 100 candidates from 4 subs
(AI_Agents, ChatGPTCoding, OpenAI, singularity); github-trending = 15 candidates. Reddit step 198s
(< 240s box). 1 sub (LLMDevs) 429 -> [] graceful. Engagement honest-zero confirmed.

## github off-topic check (Pass-2 residual #4 / G1 dry-run d) ✓
github pool is general trending (iptv-org, freeCodeCamp, pytest, cypress, swc) — non-AI repos flow in;
the existing scorer gates them via low Personal-Utility/Agent-Coding-Fit. Designed behavior confirmed.

## AC-2 — forced total failure degrades, brief still posts ✓
DRY-RUN 2: both lanes dead (socks5://127.0.0.1:9) -> exit 0, candidates=[], valid JSON. Brief gets
`0 Reddit` and continues. Warns sanitized (lane label only, no curl argv / D-6).

## D-11 / AC-6 — black-hole proxy bounded, not a hang ✓
A connect-then-never-respond proxy: per-fetch bounded to exactly 8s, lane marked down after the FIRST
fetch, 2nd sub skipped (not 2x8s), exit 0. The real adversarial case (vs connection-refused).

## AC-3 — one-post invariant ✓
Step 0 (already-posted short-circuit) + Step 6.5/7 (ship-once + deterministic post) byte-identical to
backup. Second same-RUN_ID run short-circuits exactly as before.

## Status
G1 APPLIED + dry-run-verified. NOT yet run live end-to-end (next real 7am morning-digest will be the
first live run with Reddit+github). Rollback = restore the .bak. Phase 2 (silent-block watchdog, G2) and
Phase 3 (output features, G3) remain gated/pending.

---

## LIVE RUN — 2026-06-14 04:56 PT (run-1781437991) — POSTED to #daily ✓
First real end-to-end run with Reddit+github competing for posted slots.
- Inflow: reddit=100, github=15, x=117, hn=30 (gather_reddit=194s < 240s box; github=1s).
- 262 scanned → 230 kept → top=5 + also=2 posted.
- **A Reddit item PLACED:** r/singularity "US government switched off Anthropic's most powerful
  AI..." → Also Noted, scored B-(82), posted with u/ attribution + clean <url>. The full loop
  (rotation → fetch → score → gate → post) is proven live, not just at the gather seam.
- Note: a second (gateway-queued) run raced and correctly hit the Step 0 one-post short-circuit
  (🛑 already ran today) — the anti-double-post guard working under a real race.

## G2 — INSTALLED + tested
- `~/.hermes/scripts/siftly-gatherer-silentblock-watch.py` (repo copy + 7 tests in docs/gates/).
- cron `756794b1d652`, daily 9:30am (after 9am probe) → #alerts (1480528231286181948).
- Alerts on: aggregate-zero N=3 consecutive run-days (rotation-aware), stale probe (>2d), schema drift.
- Silent on healthy. 7/7 tests pass. OQ-2 N=3 default (env-tunable SIFTLY_SILENTBLOCK_N).

## G3 — RUNNING (auto-READY at 3 runs/brief)
- `wave6-output-shadow-watch` (cron, daily 9am) drives output_shadow.ts + gatherer_probe.ts.
- Currently 2 runs/brief accumulated; computes real cross-brief-dedup / MMR / provenance over live
  dumps. Emits STAGING-READY once ≥3 runs/brief exist (silent until then — correct).
