# Brief Live-Wiring PRD — Review Summary (v4 → v5)

**Final verdict: APPROVE** (3 independent Opus reviewers, 2 passes each via claude-api-proxy + f1 + f2).

## Pass 1 (v4) — APPROVE WITH CHANGES (all 3 reviewers)
Real blockers caught (not nitpicks):
1. **Preflight paradox** — "preflight" survived in AC-6, R2, Phase-1 title, contradicting D-4's own
   "first-fetch-is-health" resolution. A preflight fetch burns the per-IP RSS budget and causes the 429
   it checks for.
2. **Wall-clock arithmetic** (f1) — 20-min cron budget vs measured 45-60s/IP RSS spacing never reconciled;
   no per-source Reddit time box; lane concurrency unstated.
3. **Black-hole proxy** (f1) — no bounded per-fetch SOCKS timeout; a connect-but-never-respond proxy hangs.
4. **Zero-exit-bad-output** (proxy) — D-8/AC-12 only captured exit code; truncated/garbage stdout at exit 0
   feeds a corrupt deduped set.
5. **Canary baseline integrity** (f2) — "vs un-wired baseline" undefined; a cross-day diff proves nothing.
6. **Rotation vs silent-block/high-volume** (proxy, f2) — rotating subset confounds raw high-volume-day and
   per-sub silent-block.
7. **OQ-2 N=3** — unconfirmed constant gating a binding AC.

## v5 fixes
- Preflight purged in all 4 binding places; D-4/D-11 are the health model.
- D-10: per-source Reddit ≤180s time box + day-seeded rotating ~5-of-9 subset + concurrent lanes.
- D-11: bounded ≤8s per-fetch timeout + black-hole test (AC-6).
- D-8/AC-12: stdout schema validation + un-deduped fallback on parse failure (two E2Es).
- D-2/AC-16: pool-identical canary (frozen pool, features OFF vs ON, one pool hash both arms).
- D-2b: high-volume uses post-normalization count; absolute floor = hard G3 precondition.
- D-4b/D-5/AC-5: rotation-aware aggregate-Reddit silent-block (per-sub zero ≠ alert).
- AC-15: dry-run perf log must prove ≤180s + safe spacing + zero 429s + total under 20-min budget.
- OQ-2: gated to G2, do-not-build-with-unconfirmed-N.

## Pass 2 (v5) — APPROVE (all 3 reviewers REFUSED to rubber-stamp)
Each reviewer independently re-checked the Pass-1 blockers against v5 text, found them genuinely resolved,
and declined to re-raise stale/fake BLOCKs (the anti-fake-finding behavior). Residual items — all already
gated in the PRD, none rising to BLOCK:
1. D-2b absolute floor TBD → hard G3 precondition (tracked).
2. OQ-2 N=3 → confirm at G2.
3. AC-14 watchdog-in-cron-obs → verify at G2 (no_agent jobs have missed coverage before).
4. github off-topic → folded into G1 dry-run (d) — confirm a non-AI trending repo scores below gate.
5. Per-sub silent block under rotation → accepted (aggregate watchdog won't catch a single off-day sub).

## Ground truth captured (Apollo, live 2026-06-14)
- All 9 locked subreddits return HTTP 200 (real; none 404).
- RSS budget tighter than the 2500ms default — drove D-10 rotation + time box.
- github-trending.ts live: 15 real candidates, exit 0, honest engagement.
