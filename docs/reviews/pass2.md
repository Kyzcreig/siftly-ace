# Ace X Knowledge Base PRD — Senior Review (Pass 2)

## Verdict
APPROVE WITH CHANGES

## Blocker Resolution Map
- **B1 (OAuth2 token doesn't exist / forge-reuse risk)** — RESOLVED. §3 D9a pins a dedicated `siftly-ace` app; §6 Phase 0 is a HARD GATE proving 200 on `/2/users/56282605/bookmarks` with "ZERO mutation to forge's oauth1/bearer" + smoke test asserting `forge auth status` unchanged before/after; §10 Q1 marked resolved.
- **B2 (shared token + backfill depletes brief credits)** — RESOLVED. §3 D9b/D9c + §5.1 add a mandatory credit-floor guard (abort+alert below reserve sized ≥ both briefs' daily reads), backfill chunked into credit-gated batches off the brief window; daily cron moved to 5:30am with 20-min budget.
- **B3 (live prompt edit underspecified/self-contradictory, no rollback)** — RESOLVED. §5.8 now mandates git-tracking + timestamped `.bak` before edit, ≥3 dry-runs via `DRY_RUN=1` (no post / no seen-write), `PF_WEIGHT=0` byte-identical kill-switch; §8 teardown item 1 covers prompt rollback explicitly.
- **B4 (pf-score failure can take down brief)** — RESOLVED. §5.8 item 4 + §11 + Phase 8 smoke (c): 30s hard timeout, fallback to base_score-only on error/timeout/malformed/sqlite-vec-load-fail, logs degradation, brief continues — stated as a tested path.
- **RC1 (feedback loop circularity)** — RESOLVED. §5.7 tags brief-surfaced bookmarks `origin: brief-surfaced` and excludes them from topic/source-affinity reinforcement; only organic bookmarks reinforce affinity.
- **RC2 (morning-digest archive may not be parseable)** — RESOLVED. §5.9 degrades cleanly — skips missing/unparseable sources with logged note, never crashes; Phase 1 verifies; optional archive-write step deferred as non-blocker.
- **RC3 (saved_at/liked_at may not exist)** — RESOLVED. §5.1 verifies field availability in Phase 1; defines source-precedence dedupe fallback and novelty fallback to `tweet_created_at` spread or disable-with-note.
- **RC4 (incremental assumes chronological order)** — PARTIAL. §5.1 prose correctly switches to full set-reconciliation upsert-by-tweetId + weekly full re-page — but the same section's **State** bullet still says "stop paginating once it hits already-seen IDs," and §4.2 repeats the short-circuit. The contradiction Pass-1 flagged literally survives in the doc.
- **RC5 (rollback incomplete)** — RESOLVED. §8 now enumerates 7 independent teardown steps: prompt patches, brief-config, cron, OAuth2 token, DB, Obsidian, state dir.
- **RC6 (hardcoded taxonomy vs D7)** — RESOLVED. §5.4 marks the category list provisional, re-derivable after Phase 6 composition report, segment re-computable without re-enrichment.
- **RC7 (OpenAI egress vs local-first claim)** — RESOLVED. §7 plainly states tweet text IS sent to OpenAI, reframes as "local-storage-first," documents ACE-AI local swap for true zero-egress.
- **RC8 (6:30 cron / 30-min margin too thin)** — RESOLVED. §5.10 moved to 5:30am with hard 20-min budget, completing well before 7:00/7:30 briefs.

## New Blockers
(none)

## Remaining Required Changes
- **Fix the RC4 contradiction (must-land, doc edit).** Delete or correct the "stop paginating once it hits already-seen IDs" short-circuit in §5.1 **State** and in §4.2 to match the §5.1 set-reconciliation design. As written, an implementer could code the unsafe short-circuit and silently miss reordered items — the exact failure Pass-1 raised. One-line fix, but it must be made before build.
- **Pin the credit-floor reserve number (carry into Phase 0).** D9c/§5.1 size the reserve "≥ both briefs' combined daily read budget" but the actual number is still Open Q3. Acceptable as a Phase-0 deliverable, but the guard cannot be implemented until that integer (and the "remaining credits" read mechanism on a pay-per-use token) is confirmed — note that a pay-per-use token may not expose a queryable balance, which would force the timing-isolation + small-batch path to carry the full load.

## Open Questions
1. Does the pay-per-use X billing actually expose a *readable* remaining-credit value? If not, D9c's "read remaining credits, abort if below reserve" is unimplementable and B2 protection reduces to timing-isolation + batch-capping alone (still adequate, but the PRD should say so).
2. Is `siftly-ace` registerable as a second app under the same pay-per-use billing without disturbing `forge`, or does dedicated billing require a separate account/plan? (Phase-0 gate depends on this.)
3. Confirmed: `saved_at`/morning-digest-archive verifications are correctly deferred to Phase 1 with clean fallbacks — no longer blocking.

## Verdict Rationale
All four Pass-1 blockers and seven of eight required changes are genuinely resolved with concrete, testable mechanisms — Phase 0 hard gate, credit-floor guard, prompt versioning + kill-switch + dry-runs, and pf-score failure isolation are real safety controls, not hand-waving, and the v2 fixes introduced no new blockers. The one defect is RC4: the safe set-reconciliation design was added but the contradictory short-circuit language was left in §5.1/§4.2, so the doc still self-contradicts on the exact point Pass-1 flagged. That's a trivial doc edit, not a redesign, so this clears at APPROVE WITH CHANGES contingent on the RC4 wording fix and pinning the credit-reserve number in Phase 0.