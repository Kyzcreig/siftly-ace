# Ace X Knowledge Base PRD — Senior Review (Pass 1)

## Verdict
BLOCK

## Critical Blockers

1. **§3 D9 / §5.1 / §10 Q1 — The OAuth2 token does not exist yet, and the proposed source for it can break the live briefs.** Ground truth: the active X app `forge` has `oauth2:(none)`. Bookmarks/likes endpoints HARD-require OAuth2 user-context (app-only bearer 403s — confirmed). So the *entire* ingestion layer rests on an unverified capability. Worse, §10 Q1 floats reusing `forge` — adding an OAuth2 client config to a load-bearing app risks invalidating/rotating the existing oauth1+bearer that x-feed-brief and morning-digest depend on. **Required fix:** Make "register a DEDICATED `siftly-ace` X app, prove OAuth2 PKCE grant returns 200 on `/2/users/56282605/bookmarks`, with ZERO mutation to `forge`'s credentials" a hard Phase-0 gate that must pass before any other phase is funded. Resolve Q1 to "dedicated app" in the PRD, not left open. If the grant fails, the project does not proceed past Phase 1 — say so explicitly.

2. **§5.1 / §7 / §9 — Shared pay-per-use X token + a backfill of 3–5k reads is a direct threat to the load-bearing daily briefs.** You acknowledge 402=CreditsDepleted has been seen before. A $15–25 backfill burst can deplete the shared credit pool the morning of a brief run. The 402-trap "alert and stop" protects *ingestion*, but does nothing to protect the briefs that run at 7:00/7:30am — if backfill drains credits at 6:30am, both briefs 402 the same morning. **Required fix:** (a) Dedicated app/billing isolates this entirely — another reason Q1 must resolve to dedicated. (b) If shared billing is unavoidable, mandate a credit-floor check before any ingest run (read remaining credits; abort + alert if below a reserve threshold sized for both briefs' daily reads). (c) Schedule the *one-time backfill* for a window that cannot collide with the 7am/7:30am brief runs, and run it credit-gated in small batches, not one paginated burst.

3. **§5.8 / §6 Phase 8 — Editing the live `x-feed-brief` and `morning-digest` prompt.md files is described but the safety mechanism is underspecified and self-contradictory.** §5.8 says patch `~/.hermes/state/cron/x-feed-brief/prompt.md` Step 5 directly; §9 says "never edit live prompt without a tested copy." These conflict on whether the live file is edited in place. There is no defined rollback for the prompt files (the §4.2/§8 rollback only covers DB + Obsidian folder). A bad patch silently degrades or breaks the daily brief with no revert path. **Required fix:** Version the prompt files (git-tracked copy or timestamped backup) before any edit; define explicit prompt-rollback in §8; require N consecutive successful dry-runs comparing patched-vs-unpatched brief output before the live prompt is touched; gate go-live behind a kill-switch (`PF_WEIGHT=0` must fully no-op the personal-fit layer so the brief degrades to current behavior, not failure).

4. **§5.8 — New runtime dependency injected into the LLM crons with no failure isolation.** The brief crons will call `scripts/pf-score.py`. If that script errors, hangs, or sqlite-vec fails to load (§9 lists this as a real risk), what happens to the brief? Nothing in the PRD says the brief must survive a pf-score failure. A load-bearing daily job must not be able to be taken down by this project's new helper. **Required fix:** Specify that pf-score failure/timeout is non-fatal to the brief — brief falls back to base_score only, logs the degradation, and continues. Add a timeout budget.

## Required Changes

1. **§5.7 signal #6 / §5.9 — Feedback loop and preference model have a circular/temporal dependency that's not addressed.** "later-bookmarked-brief-items" are positives feeding the contrast set, but the brief that surfaced them was itself influenced by the preference model. This is a self-reinforcing loop — exactly the echo chamber §12/risks worries about — and audit logging *observes* it but doesn't *break* it. Define how the feedback loop avoids treating its own influence as independent signal (e.g., tag brief-surfaced bookmarks distinctly; exclude them from topic-affinity reinforcement, or weight them separately).

2. **§5.9 / §10 Q3 — Feedback loop reads morning-digest archives that may not exist in parseable form.** This is flagged as an open question but the feedback loop's design *assumes* it works. Resolve before build: confirm what (if anything) morning-digest archives, and make the feedback loop degrade cleanly (skip unparseable sources, don't crash the cron).

3. **§5.1 — `saved_at`/`liked_at` are assumed but X API may not expose them.** §5.2 schema hedges ("if exposed; else null") but §5.7 signal #5 (novelty calibration from `saved_at` spread) and dedupe tie-breaking depend on them. If the API doesn't return bookmark/like timestamps, novelty calibration is dead and "bookmark wins" has no temporal basis. Verify field availability in Phase 1 and state the fallback for signal #5.

4. **§5.1 incremental short-circuit assumes chronological ordering.** "stop paginating once it hits already-seen IDs" only works if bookmarks/likes return newest-first reliably. X bookmark ordering is not guaranteed stable. Confirm ordering or use a full-diff reconciliation for incremental, else you'll silently miss items.

5. **§4.2 / §8 — Rollback is incomplete.** It covers DB + Obsidian folder but NOT: the prompt.md patches (Blocker 3), the brief-config.json, the cron registration, and the OAuth2 token state. Define full teardown.

6. **§5.4 — Hardcoded category list for segmentation contradicts D7 ("corpus composition is unknown, discovering it is the point").** You're segmenting against a fixed taxonomy before you know what's in the corpus. Either derive segments after the composition report, or explicitly mark the v1 taxonomy as provisional and re-derivable.

7. **§3 D11 / §5.2 — OpenAI embeddings ship the corpus text off-host, contradicting §7 "keep DB + profile local."** Tweet text (public) leaving is arguably fine, but the privacy section claims local-only. Reconcile: state that embedding API calls send tweet text to OpenAI, or use the documented ACE-AI local model now for true local-first.

8. **§5.10 — Cron at 6:30am, briefs at 7:00/7:30am: 30-minute margin for a 5-stage pipeline that includes enrichment + embeddings is thin.** If ingest+enrich runs long (or retries on 429), it overlaps the brief window AND competes for the shared X token. Either move ingestion earlier with a hard time budget, or decouple ingestion from the brief-critical window entirely.

## Lens Notes
- **Product:** Goals are coherent and well-prioritized (A>B>C), but "boil the ocean" + 11 phases + live-cron surgery in one deliverable is high blast-radius for a v1.
- **Arch:** Fork-and-replace-ingestion is sound; idempotent re-runnable stages are a genuine strength. sqlite-vec single-file is the right call.
- **Security:** Scope minimization good; but OpenAI egress contradicts local-first claim (§7), and shared-token reuse risk (Q1) is the real security/availability issue.
- **Infra:** Web UI localhost-bind is fine; tunnel auth noted; sqlite-vec macOS build is a flagged risk with a fallback — acceptable.
- **SRE:** Failure routing to #alerts exists, but no protection for the briefs from this project's failures (Blocker 4), no credit-floor guard (Blocker 2), and incomplete rollback (RC5).
- **Impl:** Phasing is disciplined with smoke tests; PF_WEIGHT / DEFAULT_CATEGORIES naming is opaque — document what these placeholders map to.
- **QA:** Acceptance criteria are testable, but missing: "briefs survive pf-score failure," "backfill does not deplete brief credits," "prompt patch is reversible."
- **ConfigDrift:** brief-config.json + prompt.md edits + xurl token are mutable state touching a load-bearing system with no version control specified — drift risk on the most dangerous files.
- **Cost:** Backfill estimate ($15–25) reasonable; the trap is *timing* of that spend against the shared brief token, not the magnitude.

## Open Questions
1. Q1 must be answered "dedicated app" unless you can prove reusing `forge` cannot alter its existing oauth1/bearer — only Ace/ops can confirm billing-setup tradeoff.
2. Does morning-digest write a parseable archive at all? (Q3 — blocks the feedback loop design.)
3. Does the X API expose bookmark `saved_at` / like timestamps for this app tier? (Affects novelty calibration + dedupe.)
4. PF_WEIGHT semantics: ±30 raw points vs 0.30 multiplier (Q4) — must be pinned before Phase 8.
5. What is the actual shared-token credit balance/reserve policy, so backfill batching can be sized safely?

## Strengths
- Idempotent, re-runnable, individually-rollbackable stages (§4.2) — strong reversibility discipline.
- Mandatory base-vs-fit audit logging (§5.8) as an explicit echo-chamber tripwire is exactly right; don't regress it.
- Correctly rejects speculative "why bookmarked" enrichment (§2) and keeps personal-fit additive, not a rubric rewrite.
- Cost-gating with `--confirm` before backfill (§5.3) and tiered enrichment show real cost awareness.
- Treating corpus composition as a deliverable to discover (D7) rather than an assumption is honest and correct.