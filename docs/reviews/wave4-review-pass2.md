# Wave 4 PRD — Senior Review (Pass 2)

## Verdict
APPROVE WITH CHANGES

## Blocker-Resolution Verification

- **B1 (kill-switch byte-identical):** RESOLVED — §4.4c now uses "templated include that renders EMPTY when `PF_WEIGHT=0`" with the test asserting byte-equality of the *rendered prompt file* against the committed pre-Wave-4 baseline, not zeroed arithmetic. The dry-run also diffs actual brief output TEXT (§4.4c(c)). Genuine fix, not a relabel.

- **B2 (dry-run isolation):** RESOLVED — §4.4c states dry-runs operate on a copy, with explicit ordering invariant: live cron `launchctl bootout` OR prompt kept uncommitted; "no scheduled cron may fire against an edited-but-unproven prompt"; promote order spelled out. Echoed in §6.

- **B3 (lease atomicity + idempotency):** RESOLVED — §4.5 specifies single-statement `UPDATE…WHERE status='pending'…RETURNING id`, explicit "NO read-then-write claim," tweetId dedup, `INSERT…ON CONFLICT(tweetId) DO NOTHING` FTS write, 15-min TTL, wall-clock single-host clock note, and the owner-wrote-then-died adversarial test (§4.5 Eval). Strong fix.

- **B4 (alert single point of silent failure):** RESOLVED — §3 Phase 1 adds fallback to `--channel discord`/`--channel all` on `--target` failure, heartbeat wrapped best-effort non-fatal, and a one-time live bot-POST permission precheck to BOTH channels before Phase 1 done.

- **B5 (tweet-cache prod-DB migration):** PARTIAL — §3 Phase 3 *decides* the isolated `.local/tweet-cache.db` (good, no prod migration), but leftover contradictions remain — see New Issues. The decision is correct; the surrounding text was not fully cleaned up.

- **RC6 (cache privacy/TTL):** RESOLVED — §3 Phase 3: public-only, 30-day TTL with refetch on expiry, never write auth tokens/user-context. Matches the requirement.

- **RC7 (reboot eval objectivity):** RESOLVED — §3 Phase 2 Eval adds `bootout`→`bootstrap gui/$(id -u)` cold-load cycle as the objective proxy, literal reboot optional. Sound.

(OQ5 pre-warm and OQ7 14-day grace + double-count-once are both genuinely addressed in §4.4b/§4.4d.)

## New Issues

1. **B5 leftover contradiction (the classic "added the fix, left the wrong thing").** The decision text says isolated store, NO prod migration — but the same Phase 3 still carries the old migration path in three places that now contradict the decision:
   - §3 Phase 3 Write scope: `prisma/schema.prisma (only if SQLite cache table chosen) + migration`.
   - §4 table T3 Write scope: `schema/migration (if SQLite cache)`.
   - §7.6 Open Question still presents "SQLite table vs unstable_cache … Lean SQLite… revisit if migration friction" as **undecided**, and §3's parenthetical re-opens it ("If `unstable_cache` proves simpler in-build, it's an acceptable equivalent").
   These leave a worker a legitimate reading in which they edit `prisma/schema.prisma` and run a migration against the live `prisma/dev.db` — exactly what B5 was meant to foreclose. **Required:** delete the `prisma/schema.prisma + migration` entries from the Phase 3 and T3 write scopes, and close §7.6 (state the isolated `.local/tweet-cache.db` is final; if `unstable_cache` is used it is also non-prod-schema — neither path touches `prisma/`). As written, the blocker's *intent* is resolved but its *escape hatch* is still open.

2. **B4 eval not in §8 acceptance criteria.** The fallback-and-precheck fix lives in §3 Phase 1 prose and the Phase 1 Eval, but §8's first acceptance bullet only asserts failure→`#alerts` / success→`#logs`. The "bot can actually POST to both channels (live precheck)" and "fallback fires when `--target` fails" are the load-bearing B4 guarantees and should be acceptance-gated, not just narrative. Minor but worth adding a checkbox.

## Residual Risks

- **Templated-include mechanism is unspecified (B1).** The fix is correct in principle, but "templated include" implies a render/build step that produces the live `prompt.md` the cron consumes. If that rendering is itself a new, untested code path, the byte-identical guarantee depends on it. Acceptable since the test asserts against a committed baseline, but the diff-review must confirm the renderer's output is what the cron actually reads (no second un-rendered copy in the cron repo).
- **Single-host clock claim (B3)** is sound *only* while the queue file stays solely on the Mac Studio and the 3 backends never write `leasedAt`. The PRD states this; the e2e must assert no backend touches the queue, or the no-skew premise silently breaks if Phase 5 later moves the queue.
- **Heartbeat-can't-abort-run (B4)** is stated but the §3 wording ("logged and cannot abort or mask") needs the diff-review to confirm the heartbeat call is in its own try/catch *outside* the failure-alert path, not merely after it.

## Verdict rationale
Four of five blockers (B1–B4) and both required changes plus the two open questions are genuinely resolved in v2 text, not rubber-stamped. B5's decision is correct but the revision left the old prod-migration write-scope/OQ language intact — a real residual escape hatch that must be excised before dispatch; that single cleanup (plus the minor §8 B4 acceptance bullet) is the only thing standing between this and APPROVE.