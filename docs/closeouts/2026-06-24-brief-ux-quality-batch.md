# Closeout — siftly-ace Brief UX & Quality Batch (2026-06-24)

**Status:** PASS (with one inherent live-verification deferral, named below)

Scope: the batch of Ace-requested brief-quality fixes shipped 2026-06-24 across the
morning-digest and x-feed-brief pipelines — reddit low-signal demotion, unified footer,
overview clean labels, story 300-cap, auto-translate (option B), 4x landscape overview,
and long ("note") tweet full-text recovery.

Commits (all pushed to `github.com/Kyzcreig/siftly-ace` main): `75b6c1f` (unified footer)
→ `c75b8fc` (clean labels + 300-cap + translate) → `ac2fd6f` (4x overview + long-tweet
renderer) → `e1190fd` (x-feed note_tweet fetch) → `9c9c3ac` (morning note_tweet fetch) →
`e58b8bf` (AGENTS docs). Plus reddit-demotion `52622e4` earlier same day.

| Item | Status | Evidence |
|---|---|---|
| Hardening pass | PASS (inline) | Each change shipped behind the dark-flag discipline with selftests; failure paths covered: footer_build fail-safe (malformed/empty → empty, no raise), translate fail-safe (any error → original text, `SIFTLY_TRANSLATE=0` kill-switch), reddit-demotion RED-proven teeth tests, renderer note_tweet preference proven on real bytes. No DB/migration touched. |
| E2E tests | PASS | `npm run verify` exit 0: tsc clean, eslint 0 errors (14 baseline warnings), vitest **268 passed / 8 skipped**, py selftests (score_digest, footer_build) OK, **GOLD SET PASS (4/4 bars)**. Translation proven live (Chinese→EN, Japanese→EN with correct lang tag). note_tweet proven live against X API (PyTorch 280→356, another 295→577). |
| Acceptance criteria | PASS | (1) Reddit chatter demoted — 12 items on real pool, Top untouched; (2) footer unified 3-line on both, verified visually; (3) clean labels — junk fragments gone, verified by vision; (4) 300-cap proven in renderer; (5) translation replace+tag proven; (6) overview budget 1800→7200; (7) long tweets recover full body via note_tweet. |
| Constitution/Invariants | PASS | Deterministic engine still owns selection (model never picks); all changes are additive/fail-safe and never block a post; reddit-demotion is REDDIT-ONLY (github/HN/X byte-unchanged); footer/translate/overview all degrade to prior behavior on any error. |
| Project docs | PASS | `AGENTS.md` — new "Brief UX & quality batch — SHIPPED 2026-06-24" section (commit `e58b8bf`, content-verified on origin). |
| Obsidian | PASS | `Ace Place/AI/Ace X Knowledge Base — System Overview.md` — new dated batch section + status header bumped to 2026-06-24; committed to `Kyzcreig/obsidian-vault` and **content-verified on origin** (grep on remote blob = 1), re-read clean (no app clobber). |
| Git | PASS | repo clean, `HEAD == origin/main`, no local-ahead; live prompts (`~/.hermes/state/cron/*/prompt.md`) MATCH committed `deploy/cron-prompts/` snapshots and carry `note_tweet` (the running copies). Legible commit messages with WHAT/WHY. |
| Memory/mem0 | PASS | DONE-marker stored naming the batch + commit range + the 7 fixes + "not pending"; no stale open *request* existed (work came via Discord, not a tracked mem0 request). |
| Cron/alerts | PASS | both crons enabled + scheduled (`morning-digest` `33 3 * * *`, `x-feed-brief` `48 3 * * *`); fixes are in the live prompt copies the crons read. |
| Loose ends | PASS | triaged below (1 BACKLOG-verify, 1 WONTFIX-cleanup). |
| DISCOVERIES | PASS | captured below. |

## Loose-end triage

| Loose end | Disposition | Action / trigger / reason |
|---|---|---|
| Overview prose **quality/length** and the translation **tag** can only be judged on a real autonomous run (I hand-wrote overview prose to run the pipeline manually; today's selected items were all-English so no live translation fired in the examples) | BACKLOG-verify | Trigger: tomorrow's 03:33/03:48 PT runs. Both are fail-safe and structurally proven (budget, label, fetch, renderer); only the *LLM-authored prose* and a *live foreign-language item* remain to eyeball. No code action — observe the first real run. |
| 43 `prompt.md.bak.*` backups under `~/.hermes/state/cron/*/` from the day's edits | WONTFIX (now) | They're cheap rollback insurance for in-flight prompt edits; standard practice is to prune after a clean week. Not worth deleting mid-batch. Trigger to prune: one clean autonomous run. |

## DISCOVERIES

- **react-tweet truncates long ("note") tweets at ~280 chars** — its `note_tweet` field carries only an id, not the body. Full text requires the X v2 API `note_tweet.text` (FLAT shape, NOT lib's `tweetFullText()` GraphQL `note_tweet_results.result.text` shape) — a real contract-shape mismatch. The fix has THREE parts that must all be present: request the field, shape it into `tweet_text`, and have the renderer prefer the stored full text. Missing any one = no effect.
- **A renderer-only "fix" can be live-dead** — the first long-tweet fix only touched the renderer (prefer stored text) while the gather never requested `note_tweet`, so the dump never had anything fuller. Caught only when Ace asked "did you fix this in the code?" The lesson: trace the data from fetch → store → render, not just the last hop.
- **Never fabricate a "before/after" demo** — I showed an invented PyTorch tweet body as proof; Ace caught it against the real tweet. Proof must come from the real bytes (pull the actual tweet via `xurl`), never hand-written sample data. Recorded in AGENTS.md + coding discipline.
- **Reddit engagement is unavailable** — the RSS pivot (to defeat the 403s) carries zero upvote/comment counts, so the low-signal demotion had to key on body/title structure, not engagement thresholds.
- **Both briefs had the identical note_tweet gap** — fixing x-feed first, then checking morning (instead of assuming), found the same missing field. Parallel pipelines drift together; check both.

## Remaining work

- None blocking. The only open item is observing tomorrow's first real autonomous run to eyeball LLM-authored overview prose + a live translation (both fail-safe, structurally proven).
