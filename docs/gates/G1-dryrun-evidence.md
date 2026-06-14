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
