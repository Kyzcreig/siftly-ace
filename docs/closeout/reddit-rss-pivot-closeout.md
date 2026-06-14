# Closeout — Reddit Discovery Gatherer: API→RSS Pivot

**Status:** PASS
**PRD:** `docs/plans/PRD-reddit-rss-pivot.md` (v3, Opus 2-pass APPROVE WITH CHANGES → cleared)
**Shipped commits:** `a667319` (PRD+reviews) · `6e87ec4` (build) · `4bea7fc` (harden) · `cb5d3fb` (docs) — origin/main

| Item | Status | Evidence |
|---|---|---|
| Hardening pass | PASS | `docs/reviews/reddit-rss-hardening-report.md` — Opus diff-review (BLOCK→fixed B1/B2/B3/B6), 5-row failure-surface table, RED-proven, verify exit 0 |
| E2E tests | PASS | Live manual+spaced run (`reddit-rss-live-proof.md`): 10 real candidates from live RSS off the 403-blocked IP; hermetic suite 228 unit + 10 e2e |
| Acceptance criteria | PASS | AC-1..12 all green (mapped in hardening report GSD table); AC-9 best-effort by measured IP limit |
| Constitution/Invariants | PASS | never-throws (neg tests), shape-unchanged (tsc+probe), no-new-dep (empty pkg diff), polite-measured-cadence (live proof), empty-feed-observable (AC-10), honest-engagement (AC-7), authorHandle u/<name> (AC-11) — each has a test |
| Project docs | PASS | `AGENTS.md` updated (stale OAuth note → RSS-shipped reality); PRD v3 + 3 review docs committed |
| Obsidian | PASS | `Ace X Knowledge Base — System Overview.md` — gatherer-probe finding + "Reddit 403 must be solved" both updated to RSS-pivot-SHIPPED |
| Git | PASS | `cb5d3fb` pushed to `github.com/Kyzcreig/siftly-ace`; per-file `git cat-file -e origin/main:<f>` OK for all 10 shipped files; legible WHAT/WHY commit messages |
| Memory/mem0 | PASS | `mem0_conclude` DONE-marker stored; explicitly supersedes the stale "Reddit needs script-app creds in 1Password" intent (no creds needed/stored) |
| Cron/alerts | N/A | gatherer is NOT wired into any live brief/cron (grep-confirmed); alert wiring is the future live-wiring PRD's job |
| Loose ends | PASS | listed below |
| DISCOVERIES | PASS | listed below |

## Remaining work (deferred — all to the future live-wiring PRD, NOT this one)
- Wire the gatherers into the daily brief prompt (gated `prompt.md` edit; needs Ace approval + ≥3 shadow runs).
- Add a "reddit `fetched`==0 for N consecutive days" warn (handoff invariant; so a silent RSS block doesn't masquerade as "nothing hot").
- Residential egress lane for Reddit RSS if multi-sub inflow is wanted (datacenter IP ≈1 fetch/window). Needs the SSH key authorized on macbook-pro-2021 (`egress-lanes` skill).
- AutoMod sticky-post filtering + honest-zero-engagement ranking interaction — discovery-quality tuning at wire time.

## DISCOVERIES
- **Reddit API is fully dead for indie devs (2026).** Responsible Builder Policy closed self-service; the `prefs/apps` create-form is broken-by-design (CAPTCHA loops / policy-link rejection); personal "script" apps don't qualify for the approval path. The earlier app-only-OAuth fix was wasted motion — should have checked the 2026 policy state before sending Ace to register an app. **Lesson: research the current platform-access posture before building/registering against a third-party API.**
- **`/r/<sub>/hot.rss` (Atom) still returns 200 from a datacenter IP that 403s `.json`** — RSS is the surviving public-read path. But the per-IP RSS budget is TIGHT and STATEFUL (≈1 successful fetch per rolling window of minutes); an inter-request *gap* (tested 4 s, 8 s) does not buy a second 200. The lever is egress IP, not delay.
- **The `access_token` 401-vs-`.json` 403 split is the diagnostic** for "IP fine for auth, anon reads blocked" — generalizable to other rate-gated public APIs.
- **A diff-review on a SOLO build caught 3 real defensive parser gaps** (wrong-link, CDATA leak, crosspost-author) that the happy-path fixture + green suite could never surface — worth the cost.
