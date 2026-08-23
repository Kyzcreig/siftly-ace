# Independent Senior Review (Opus)

## Verdict: APPROVE WITH CHANGES

The pass-1/pass-2 folds are real and complete, not rubber-stamped: **§5.5a** is a genuine fetch fence (raw.githubusercontent allowlist, no redirects, 64 KB/10 s caps, DATA-fenced, verdicts final before stage 2, Phase-3 injection negative test); **§5.4** covers all three discovery mechanisms + a canonical-tree pin; **§5.3** fully specifies post-seen (key/TTL/write-point); **§5.2** hard-requires the embed tier for any asserted gap and downgrades otherwise. B3's `run_id` key is a verified real field. The design is read-only (I2), human-gated (I1), kill-switched, owns no shared state. One concrete item — surfaced by probing the live tree — must correct a stated default before Phase 0/4 arm; everything else is residual.

## Critical Blockers (severity-ordered, cite section/evidence)

None. The design shape is approvable. The item below is a pre-arming correction, not an architectural hole.

## Required Changes

1. **The stash default (`~/.hermes/skills-stash/`, §5.4) is already invalidated by the live filesystem, and the guard must compare *realpath-canonicalized* roots — not string literals (§5.4, I4, AC2).** Evidence: the pool file resolves identically under both `~/.hermes/…` and `~/.hermes/…` (same `run_id`), i.e. the two trees are aliased; the evidence pack + CWD + git (`../../../skills-shared/…`) place the *live* skills roots under `~/.hermes/skills*`, while the PRD writes everything in `~/.hermes/…`. §5.4's own escape clause ("if the probe finds symlinked/aliased tree roots … the stash moves outside any ancestor of the skills roots") is therefore the branch that *actually applies* — the "sibling default, relocation conditional" framing is backwards for this filesystem. Two concrete fixes: (a) make relocation-outside-any-skills-root-ancestor the **default**, since the alias condition is already known-true; (b) require the Phase-0 probe and `test_stash_inert.py` to `realpath`-normalize both the stash dir and every scan root and compare *resolved* paths — a literal `~/.hermes/skills-stash` non-discovery assertion proves nothing when the loader globs a `~/.hermes/skills*` tree the alias also feeds. Without (b), a symlink-following/recursive loader change loads the stash while the suite stays green.

## Lens Notes (one line each)

- **Architecture:** Read-only second consumer + two-bar funnel is clean; B1's pointer/bytes split is the correct ingestion boundary.
- **Security/isolation:** §5.5a fence and B1 catalogue-only auto-path close the supply-chain limbs; residual surface is the aliased-tree stash guard (Req 1).
- **DevOps/SRE:** `run_id` freshness (verified), config-corrupt→disabled+page, 3-day zero-survivor floor, and delete-cron+state rollback are solid.
- **Implementation/maintainability:** Enum-coerced verdicts, fail-safe-to-drop, `gpt-5.6-sol` fallback with server-echo recording — right; README raw-URL branch guess (main/master) is fail-safe, fine.
- **QA:** AC1/3/5/8/9 are real mechanical gates; AC7 is de-circularized (Ace-only labels) but ships-while-INCONCLUSIVE, so no *quality* bar blocks launch — acceptable only because proposal-only + human-gated.
- **Config-drift:** the `.hermes`↔`.hermes` path family is unpinned across the *entire* PRD (Req 1); model/effort config discipline (I5, server-echo truth) is good.

## Residual Risks / Open Questions

- **Stage 0 is a lossy Apollo-labeled gate with no live recall monitor** — real candidates vanish irrecoverably; only guards are a 30-item fixture + the R4 *total*-death floor, so a 50% recall regression is invisible. §11's post-30-day 👍/👎 spot-check is the right trigger; confirm it actually ships.
- **Injection persists into stored catalogue strings** (`description`/notes, model-generated from untrusted text) re-read by roll-up/vendoring; §5.5a hygiene rule says re-fence on later read — verify the downstream consumers honor it, not just declare it.
- **`evidence_strength` early-re-eligibility (§5.3) keys on an LLM value derived from tweet hype** — gameable by launch language; mitigated only by Ace as final gate.
- **Confirm at Phase 0:** does `~/.hermes` symlink to `~/.hermes` (Req 1), and does the loader recurse / follow symlinks — if yes, Req 1(a) is mandatory, not preferred.
- **Verify run-log consumers are implemented, not just named** (weekly roll-up + liveness floor, §7).