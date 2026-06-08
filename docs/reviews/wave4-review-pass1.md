# Wave 4 PRD — Senior Review (Pass 1)

## Verdict
**APPROVE WITH CHANGES** — close the blockers below before dispatch. The PRD is unusually disciplined (config-class gating, kill-switch, fail-safe), but several load-bearing claims are under-specified in ways that can corrupt the prod briefs or break exactly-once semantics.

## Critical Blockers

1. **"Byte-identical no-op" kill-switch is unverifiable as specified (§4.4c, §6.1, §8).** The kill-switch (`PF_WEIGHT=0`) lives inside `prompt.md` files that are executed by an LLM brief agent, not deterministic code. `final = base + raw × 0` zeroes the *arithmetic*, but Step 4.5 still instructs the agent to "load preference profile + call pf-score.py." Adding instructions changes the prompt's token stream and therefore can change LLM output even when the weight is 0 — the golden-file "byte-identical" test (§4 Eval) will pass on the *scoring math* while the *brief text* silently drifts. This is the highest-risk item touching load-bearing prod briefs and the safety story rests on it. **Could cause:** silent regression of production briefs with a green test.

2. **Dry-run gate semantics are not isolated from prod side-effects (§4.4c, §6.3).** `DRY_RUN=1` is described as "produce output, do NOT post/seen-write," but the dry-run runs against the *same* brief prompt files and the *same* `~/.hermes/state/cron/` git repo that the live 5:30am cron reads. There's no statement that the cron is paused, that dry-runs use a copy of the prompt, or that a dry-run cannot race a scheduled run. If a dry-run is in flight when the real cron fires (or the edited prompt is committed before dry-runs complete), live briefs run the unproven prompt. **Could cause:** unreviewed prompt reaching prod briefs.

3. **Lease-based drain does not specify the atomicity primitive — exactly-once is unproven (§4.5, §7.4).** "atomic claim N pending → status: leasing" is asserted but the mechanism is absent. `src/lib/enrich/index.ts` is SQLite-backed (better-sqlite3). A claim is only atomic if it's a single `UPDATE ... WHERE status='pending' ... LIMIT N RETURNING` (or a transaction with the right isolation). Two download workers doing read-then-write will double-claim. Worse: the finalizer writes transcripts to FTS — if a stale-lease reclaim reprocesses an item whose first owner *already wrote the transcript but hadn't released the lease*, you get a double-write/duplicate FTS row unless the FTS insert is keyed and idempotent by tweetId. The PRD claims "idempotent by input" but never states the dedup key or the write guard. **Could cause:** duplicate transcripts / data corruption in FTS.

4. **`notify.py --target` failure on alert routing is unhandled — failures can go silent (§3 Phase 1).** The whole point of Phase 1 is loud failure alerts. But `sendDiscordAlert` (evidence: lines 188-196) calls `spawnAndWait` which throws on non-zero exit, and the success-heartbeat path adds a *second* notify call inside the cron. If the `--target` channel ID is wrong, revoked, or the bot lacks post permission to `#alerts`, the failure alert itself fails — and there's no fallback to the Home channel or a secondary alert. A mis-routed/permission-denied `#alerts` post means the daily ingest can fail with **zero notification**. The PRD live-verifies the channel IDs exist but not that the notify bot can post to them. **Could cause:** silent prod failure (the exact thing Phase 1 is meant to prevent).

5. **Migration on the live prod DB for tweet-cache is gated behind an unresolved OQ (§3 Phase 3, §7.6).** The store choice (SQLite table + `prisma/schema.prisma` migration vs `unstable_cache`) is left "lean SQLite… revisit if migration friction" — i.e., a schema migration against the **live 3,547-item prod DB** is in a worker's write scope but the decision isn't made. A Prisma migration is irreversible-ish on prod data and is config-class-adjacent (it mutates the prod corpus DB), yet it's dispatched as a normal worker task with no backup/rollback gate. **Could cause:** prod DB migration without approval/backup.

## Required Changes

1. **Reframe the kill-switch test (Blocker 1).** Make `PF_WEIGHT=0` produce a prompt that is *literally byte-identical to the pre-Wave-4 prompt* — i.e., the Step 4.5 block is conditionally absent, not present-but-zero-weighted. Implement as two prompt variants (or a templated include that is empty when the knob is 0) and assert byte-equality of the *rendered prompt file*, not just the score arithmetic. Add a dry-run comparison that diffs actual *brief output text*, not just numeric deltas.

2. **Pin dry-run isolation (Blocker 2).** Require: (a) dry-runs operate on a copy/branch of the prompt, never the live file; (b) the live cron is disabled (or the prompt edit is uncommitted to the cron git repo) until all ≥3 dry-runs pass and Ace approves; (c) an explicit "no scheduled cron may fire against an edited-but-unproven prompt" invariant in §6. State the commit/promote order: dry-run on copy → review → commit to cron repo → verify next live run.

3. **Specify the lease atomicity primitive and the idempotency key (Blocker 3).** Require a single-statement atomic claim (`UPDATE ... SET status='leasing', owner=?, leasedAt=? WHERE status='pending' ... RETURNING id`, or equivalent transaction) and state the dedup key (tweetId) plus an idempotent FTS upsert (`INSERT … ON CONFLICT(tweetId) DO NOTHING/UPDATE`). The adversarial test (§4.5 Eval) must specifically cover: owner wrote transcript → died before release → reclaim must NOT create a second FTS row. Add a lease-TTL value and clock-source note (wall vs monotonic) to the PRD.

4. **Add an alert-delivery fallback and a permission precheck (Blocker 4).** Phase 1 eval must include a live check that the notify bot can actually post to `#alerts` AND `#logs` *before* go-live. Add fail-safe behavior: if the `--target` post fails, fall back to `--channel discord` (Home) and/or `--channel all` so a failure is never swallowed. Wrap the heartbeat call so a heartbeat failure cannot mask or abort the real run/alert.

5. **Resolve the tweet-cache store decision now and gate any prod migration (Blocker 5).** Pick one before dispatch. Strong recommendation: a **separate cache DB/table outside the prod corpus schema** (or `unstable_cache`), so no migration touches the 3,547-item prod DB. If SQLite-in-prod-schema is chosen, move the migration to a main-agent/config-class gate with a DB backup, not a worker write scope.

6. **State the syndication-cache privacy/TTL policy (Lens: Security/Privacy).** `react-tweet` fetches from X's public syndication API and you're caching tweet JSON keyed by ID with `fetched_at`. Specify: cache only public tweets (the fallback already handles `TweetNotFound`/private), a max TTL/refresh so deleted/edited tweets don't render stale indefinitely, and that no auth tokens or user-context data are written to `tweet_syndication_cache`. "Stale-OK, refetch on miss" with no eviction will render deleted tweets forever.

7. **Add an objective eval for the launchd reboot claim (§3 Phase 2, §8).** "survives reboot" is in acceptance criteria but the eval only tests `launchctl kickstart` respawn, not an actual reboot (or a `bootout`/`bootstrap` cycle simulating boot). Either soften the criterion or add a real boot-survival check.

## Lens Notes
- **Product:** Personalization risk/reward is sound and additive; the echo-chamber guard (origin: brief-surfaced) is the right instinct — but verify the feedback loop (§4.4d) can't double-count an item that's both surfaced and organically saved.
- **Architecture:** Scopes are genuinely disjoint at the file level; the only real seam is T5→T4 JSON shape (declared) and Phase 3's potential prod-DB migration (Blocker 5).
- **Security:** No new scopes, secrets via `with-secrets.sh` — good; gap is syndication cache privacy/TTL (Required Change 6) and confirming the notify bot's post permissions (Blocker 4).
- **Infra:** launchd job design is reasonable; PATH-hardening noted; reboot survival is asserted but not tested (Required Change 7).
- **DevOps/SRE:** Alert routing has a single point of silent failure (Blocker 4); add fallback + heartbeat-can't-abort-run isolation.
- **Implementation:** Lease atomicity is the make-or-break detail and is currently hand-waved (Blocker 3); demand the exact SQL/transaction.
- **QA:** "Byte-identical" test as written validates math, not prompt/output equivalence (Blocker 1); fail-safe tests for pf-score are well-specified and should be kept as the model for the others.

## Open Questions
1. Is the daily-ingest cron paused (or the prompt edit kept off the cron git repo) for the entire dry-run window, and who enforces that ordering — Apollo manually?
2. What is the lease TTL, and does stale-reclaim use a monotonic clock or wall-clock `leasedAt` (clock skew across the 3 backends / Mac host)?
3. Does the Hermes notify bot actually have post permission in both `#alerts` and `#logs`, verified before go-live (not just channel ID existence)?
4. For Phase 3, is the quote-unfurl cache allowed to touch the prod Prisma schema at all, or must it be an isolated store? (Pick before dispatch.)
5. Does `pf-score.py`'s 30s timeout include vec0 extension load time (cold start), or only scoring? A cold vec load could eat the budget and trip the fail-safe on every first call.
6. Heartbeat verbosity (§7.5) — fine to defer, but confirm a heartbeat-send failure is logged and non-fatal to the ingest run.
7. Does the feedback loop's "surfaced-but-never-saved = weak negative" have a time window? Without `saved_at`, how is "never saved" bounded so recent surfaced items aren't prematurely penalized?