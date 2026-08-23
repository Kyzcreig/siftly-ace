# Independent Senior Review (Opus)

## Verdict: BLOCK

## Critical Blockers (severity-ordered, cite section/evidence)

1. **Auto-vendoring untrusted code with "zero asks" is an unattended supply-chain path (D3, D5, §5.4, I4).** The system pulls third-party skill source from arbitrary tweets/linked repos and writes it to disk daily with *no human in the loop* ("auto-vendored dormant, zero asks"). The `external-code-ingest-audit` gate — a fleet human/judgment gate — is being run *automatically by a model* on hostile input. "No-exec at stash time" does not make inbound arbitrary code safe; it makes it dormant-until-something-reads-it. This directly stresses I1 (human gate on activation) because *ingestion itself* is the boundary the fleet convention guards, and I1 only covers *activation*. **Required:** catalogue-only by default; vendoring actual code files requires Ace's explicit go, same as activation. Decouple "stash a pointer" (safe, automatic) from "pull the bytes" (unsafe, gated).

2. **Stash inertness (I4) rests on an unproven negative owned by external code, with no ongoing guard (Evidence: "loader ignores skills-stash UNPROVEN"; §5.4).** `~/.hermes/skills-stash/` is a sibling of the scanned `~/.hermes/skills-shared` (note `~/.hermes`→`~/.hermes`; CWD confirms the `.hermes` tree). The entire "inert" claim = "the loader happens not to glob this sibling today." The closeout proof is a one-time fresh-session check. There is **no CI guard** that fails if a future loader change (recursive scan, symlink follow, glob widening) starts loading stash content — at which point auto-vendored hostile skills become live agent capability with zero review. **Required:** a committed regression guard asserting stash-dir exclusion against the *real* loader, run in CI — not a one-shot Phase-0 eyeball. Better: store vendored code outside any ancestor of the skills roots entirely.

3. **Staleness guard does not do what §5.6 claims — off by hours (§5.6).** Brief writes ~03:56 PT; triage reads at 09:00 PT. A one-day brief *failure* leaves yesterday's file aged **~29h04m** at 09:00 — **under the 30h threshold** — so the guard *passes* and the lane re-triages yesterday's pool, the exact failure it's advertised to prevent. Wall-clock age can't distinguish "fresh" from "one run missed." **Required:** key on `run_id` identity (skip if `run_id == last_triaged_run_id`), not age; the 30h number is unusable.

4. **The only real quality gate (AC7) is circular and underpowered (D9, §6 Phase 2 evals, AC7; Evidence: "session-mined gold coverage UNPROVEN").** Apollo authors the PRD, builds the system, *and* (fallback path) labels the 40-item gold set — so precision/recall measure Apollo-rubric vs Apollo-labels, with only 10 Ace spot-checks. At ≤4 proposals/day a 40-item set yields a handful of positives; a 0.6-precision "pass" is 2–3 items — statistical noise, not an acceptance gate. Every other AC (I3 cap 20→4, mtime, kill-switch, enum-parse) is a mechanical-invariant check, not a quality gate. **Required:** the gold set must be Ace-labeled (or mined-then-Ace-confirmed) before it can gate; state minimum positive count; treat AC7 as advisory until the mine is proven non-thin.

## Required Changes

- **False-gap blindness in the merit anchor (I7, §5.2).** I7's validator only rejects *hallucinated* skill names; it does nothing when the lexical top-K slice *misses* an existing skill that uses different vocabulary than the tweet — yielding a confident "no existing coverage — gap" for something the fleet already owns (954 skills, lexical recall holes). The core value prop ("does this beat what we have?") has an unguarded false-negative. Add a stronger retrieval for gap-claims (broaden K / second-pass embed lookup) before a card may assert "gap."
- **Specify grok-4.6 fallback (D8, Phase 0 probe b, Evidence UNPROVEN).** Phases 1–4 all sit on an unproven model lane with no named fallback if the probe fails. Name the fallback model and its config default.
- **Config-absent fail-safe (I5, §5.6).** Define behavior when `config.json` is missing/corrupt — must fail to `enabled:false`/skip, never boot on hardcoded defaults against an unproven lane.
- **Liveness ≠ non-empty (D10, §5.6).** A Stage-0 bug that silently drops everything posts "nothing cleared the bar" daily — indistinguishable from a healthy quiet day for up to a week. Add a floor alert on `survivors==0` for N consecutive days.
- **Quantify lane contention (§7).** The SuperGrok/xAI lane already carries the x-feed brief (462 calls/332s) and morning-digest; "finite shared budget" is acknowledged but the interaction with the two production briefs is not quantified. Confirm daily-cap headroom, not just concurrency.

## Lens Notes (one line each)

- **Architecture:** Clean read-only second-consumer shape; two-bar funnel is justified — but the "auto-vendor code" limb is the one piece that breaks the otherwise-safe isolation.
- **Security/isolation:** I2 (read-only) is sound; I4 (stash inertness) + auto-ingest is the hole — untrusted code lands unattended in a sibling of the loaded skills root on an unproven negative.
- **DevOps/SRE:** Kill switch + self-contained state + clean rollback are good; staleness guard is buggy (Blocker 3) and liveness signal is false-negative-prone.
- **Implementation/maintainability:** Enum-coerced verdicts + fail-safe-to-drop are the right reflexes; `post-seen` store is under-specified vs concept-memory.
- **QA:** Suite is mostly invariant-checks; the single quality gate (AC7) is circular/underpowered — not a real acceptance bar.
- **Config-drift:** Good config-swap discipline (I5), but stash-isolation and model-lane both depend on external state with no committed guard.

## Residual Risks / Open Questions

- Does `~/.hermes` resolve to `~/.hermes` as assumed, and does the loader ever follow symlinks or recurse — if either, Blocker 2 escalates immediately.
- Token-overlap concept dedup (§5.3) will leak paraphrased repeats; "stronger evidence" re-eligibility keys on an LLM-emitted `evidence_strength` derived from tweet hype — gameable by launch-language.
- Who actually reads `runs/<date>.json`? Observability that nobody consumes is not observability (§7).
- Stash-catalogue rot: greppable + weekly roll-up is thin mitigation for a write-mostly graveyard; no eviction/TTL specified.
- If the D9 mine is thin (Evidence: UNPROVEN), the entire Phase-2 gate collapses to Apollo self-labeling — confirm the mine before committing to the ≤4/day bar.