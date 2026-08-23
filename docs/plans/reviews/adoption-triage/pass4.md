# Independent Senior Review (Opus)

## Verdict: APPROVE

The single pass-3 required change (P3-R1) is genuinely folded, and I falsified — against the live box, not on trust — the two assumptions prior passes deferred to closeout. The fold is sound *because* of the alias I confirmed, not despite it.

## Critical Blockers (severity-ordered, cite section/evidence)

None.

## Required Changes

None required to ship Phase 0. The P3-R1 fold verifies:
- **§5.4 / I4 / §6 Phase 0 — vendored dir relocated + realpath-canonicalized.** Ground-truthed: reading `_last_run_scored.json` under `~/.hermes/state/cron/x-feed-brief/` returns the same bytes the evidence pack indexes under `~/.hermes/…` → `.hermes`/`.hermes` are aliases of one tree (correcting the prior review's `.hermes`↔`.hermes` typo). The live skills roots are `…/skills` + `…/skills-shared` (evidence pack); the vendored dir `…/state/adoption-triage/vendored/` sits under `state/`, outside both roots after `realpath` on *either* spelling — so relocation-as-default is structurally correct and the old `skills-stash/` sibling (which a `skills*` glob could catch) is retired. The realpath-both-sides guard requirement (§5.4) is exactly what this alias demands.
- **§5.6 / AC9 — B3 freshness key is real.** `_last_run_scored.json:2` carries a top-level `run_id`. Note it is a microsecond timestamp (`==ts`), so equality-as-identity holds (no wall-clock *age* math), and a failed brief leaving yesterday's file → unchanged `run_id` → skip+page. B3 is sound as written.

## Lens Notes (one line each)

- **Architecture:** read-only second consumer on `all_scored` + catalogue/bytes split (B1) is the correct ingestion boundary; owns no shared state (clean rollback §7).
- **Security/isolation:** §5.5a raw.githubusercontent allowlist + no-redirects + DATA-fence + verdicts-final-before-stage-2 closes the untrusted-README limb; auto-path writes zero third-party bytes (AC2).
- **DevOps/SRE:** `run_id` identity (verified), config-corrupt→disabled+page, 3-day zero-survivor floor, `enabled:false` kill — real gates, not prose.
- **Implementation/maintainability:** enum-coerced verdicts→drop-on-malformed, `gpt-5.6-sol` fallback with server-echo truth (I5/R2), single-README budget — maintainable.
- **QA:** AC1/3/5/8/9 are mechanical; AC7 de-circularized to Ace-only labels but ships-while-INCONCLUSIVE — tolerable *only* because proposal-only + human-gated (I1), no quality bar guards launch.
- **Config-drift:** the whole PRD writes `.hermes/…` while the live canonical is `.hermes/…`; both resolve today (verified) so it's cosmetic, but pin one spelling before a maintainer hardcodes literals against a tree the alias could someday drop.

## Residual Risks / Open Questions

- **Stage 0 is a lossy, Apollo-fixture-labeled gate with no live recall monitor** — dropped real candidates vanish silently; only the R4 *total*-death floor + a 30-item fixture guard it. §11's post-30-day 👍/👎 recall spot-check is the right trigger — confirm it actually ships, don't let it stay a roadmap line.
- **Injection persists into stored catalogue strings** (`description`/notes, LLM-authored from tweet text) re-read by roll-up/vendoring; §5.5a says re-fence on later read — verify the downstream consumers *honor* it at closeout, not just declare it.
- **`evidence_strength` early-re-eligibility (§5.3) keys on an LLM value derived from launch hype** — gameable; only Ace-as-final-gate mitigates.
- **Pin the path spelling** (`.hermes` vs `.hermes`) once, PRD-wide, so a future alias removal can't strand the lane's own state/config/stash paths — realpath saves the guard comparison, not a hardcoded write target.
- **Closeout:** confirm the run-log consumers (weekly roll-up + liveness floor, §7) are implemented, not just named.