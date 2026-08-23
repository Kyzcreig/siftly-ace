# Independent Senior Review (Opus)

## Verdict: APPROVE WITH CHANGES

The four pass-1 blockers are genuinely resolved, not rubber-stamped: B1 decouples pointer-stash (auto) from byte-vendoring (gated) — the supply-chain limb is gone; B3's `run_id` key is a real field (verified, `_last_run_scored.json:2`); B4 moves labels to Ace-only with a stated ≥12-positive floor; B2 adds a committed guard test. R1–R5 are all folded. Remaining items are pre-arming hardening, not architectural — the lane is read-only (I2), human-gated (I1), kill-switched (§5.6), owns no shared state. But two genuine gaps must close before Phase 3 arms, and one is newly introduced by the revision's own Phase-3 scope.

## Critical Blockers (severity-ordered, cite section/evidence)

None that block the design. The two items below are hard prerequisites to *arming* (Phase 3/4), not to approving the shape.

## Required Changes

1. **NEW — the Phase-3 README fetch is an unfenced untrusted-content + SSRF surface (§2 bullet 6, §5.1 Stage 2, §5.5).** The revision's own scope adds "one cheap fetch of a directly-linked GitHub README per finalist," feeding attacker-controlled bytes (any tweet can link any repo) into **opus-5**, the most-privileged model, whose card Ace acts on. §7's injection story explicitly fences only *post text* — it never extends to the fetched README. No URL allowlist, host pin (github raw only?), size cap, redirect/SSRF handling, or timeout is specified. Defense-in-depth (conversational gate + `external-code-ingest-audit` on vendoring) contains the blast radius, which is why this is a required change not a blocker — but until it's fenced + allowlisted + treated as untrusted data with a negative test, Phase 3 must not arm.

2. **B2 residual — inertness guard must target the *real* loaded tree and *every* discovery path, and the sibling location was kept against the reviewer's stronger advice (§5.4, I4, AC2; Evidence: loader scans `~/.hermes/skills` + `~/.hermes/skills-shared`, stash-ignore UNPROVEN).** Two concrete holes: (a) **Path-tree ambiguity** — the PRD writes everything under `~/.hermes/...` while the evidence pack + environment CWD say the live tree is `~/.hermes/...`. They appear to be the same tree (I `Read` the pool via `.hermes` and it exists where the pack lists `.hermes`), but the PRD leaves this to inference; a guard asserting non-discovery of `~/.hermes/skills-stash` proves nothing if the loader globs `~/.hermes/skills*` and the trees ever diverge. Pin the canonical tree and point the test at the loader's *actual* Phase-0-probed roots. (b) **Coverage** — the evidence pack names **three** discovery mechanisms (runtime loader, `qmd` index, `finding-agent-skills`-style discovery, §5.4 recall). The test as written exercises "the real skill loader/indexer"; it must assert non-discovery across all three, or a `qmd`-index widening loads the stash while the suite stays green. The reviewer's stronger fix (store vendored bytes *outside any ancestor* of the skills roots) was declined in favor of sibling+guard — defensible, but it maximizes blast radius; at minimum document why sibling was kept.

3. **`post-seen` store still undefined (§5.1 Stage 0; carried from pass-1 lens note, not folded).** Stage 0 dedups "vs concept-memory & post-seen," but no section defines the post-seen key, TTL, or write point. Concept-memory got a full §5.3; post-seen got nothing. Specify it or fold it into concept-memory.

4. **Gap-claim reliability degrades silently when the embed index is absent (R1, §5.2).** The wider pass is "K×4 + synonyms + embed **if available**." A second lexical pass shares the first's vocabulary blind spots; when qmd/embed is unavailable, "no existing coverage — gap" rests on lexical-only recall across 954 skills. Either require the embed tier for any *asserted* gap, or soften an embed-less gap to "no inventory match found — verify" so a false gap can't confidently sell Ace something already owned.

## Lens Notes (one line each)

- **Architecture:** Read-only second-consumer + two-bar funnel is clean and well-isolated; B1's pointer/bytes split is the correct boundary.
- **Security/isolation:** I2 sound and B1 fixed; residual surface is now the Phase-3 README fetch (Req 1) and the stash guard's tree/coverage (Req 2), not auto-vendoring.
- **DevOps/SRE:** `run_id` freshness (verified), config-corrupt→disabled, 3-day zero-survivor floor, and clean rollback are all solid.
- **Implementation/maintainability:** Enum-coerced verdicts + fail-safe-to-drop + fallback model (gpt-5.6-sol) are right; post-seen store under-specified (Req 3).
- **QA:** AC1/3/5/8/9 are real mechanical invariants; AC7 is genuinely de-circularized but ships-while-INCONCLUSIVE, so no quality bar actually blocks launch — acceptable only because the lane is proposal-only + human-gated.
- **Config-drift:** `.hermes`↔`.hermes` path family is unpinned across the whole PRD (Req 2a); model/effort config discipline (I5) is good.

## Residual Risks / Open Questions

- **Prefilter is a lossy Apollo-labeled gate with no live recall monitor.** Stage 0 is the one place real adoption candidates vanish irrecoverably (stages 1–2 see only survivors); its only guards are a 30-item Apollo-authored fixture (§Phase 1) and the R4 *total*-death floor — a 50% recall regression is invisible. Consider periodic recall spot-checks against Ace 👍/👎.
- **Injection persists into stored strings.** Catalogue `description`/`activation-cost`/`effort` are model-generated from untrusted post/README text and re-read later by Apollo during roll-up/vendoring; fencing stops at verdict-parsing (§7). Low severity (data, human-gated) but the downstream read isn't addressed.
- **`evidence_strength` early-re-eligibility (§5.3) keys on an LLM value derived from tweet hype** — gameable by launch-language; mitigated only by Ace being the final gate.
- **Confirm at Phase 0:** does `.hermes` symlink to `.hermes` (Req 2a), and does the loader recurse/follow symlinks — if either, Req 2 escalates.
- Run-log consumers are now named (weekly roll-up + liveness floor, §7) — good; verify they're actually implemented, not just declared.