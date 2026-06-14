I'll review this v2 PRD against the prior Pass-1 findings and apply the adversarial lenses. Let me work through whether each claimed resolution genuinely holds.

# Independent Senior Review (Opus)

## Verdict: APPROVE WITH CHANGES

## Critical Blockers (severity-ordered, cite section/evidence)

**B1 (CARRIED, severity-reduced) — The G3 numeric thresholds are still undefined placeholders, so the central safety gate remains unfalsifiable on paper.** Pass-1 B1 demanded numeric acceptance + shadow coverage of pool-replacement. v2 *names* the variables (D-2/§5.4/AC-8: "≤X% suppressed, ≤Y reorders, ≤Z% shrink") but **X/Y/Z are explicitly deferred to "set with Ace at G3 from the accumulated data."** That is a circular gate: the threshold is derived from the same data it is supposed to judge. If you fit the bar to the observed shadow numbers, every shadow window passes by construction — the gate cannot fail. A real acceptance gate sets the bar *before* seeing the data (e.g. "dedup must not suppress >20% of the posted set; set-size shrink >30% is an auto-block pending Ace") with the post-hoc tightening as a refinement, not the definition. **Required: commit a default ceiling for each of X/Y/Z in the PRD now**, with G3 allowed to tighten (never loosen) them. As written, AC-8 is still partly theater — the canary (below) is what actually saves it.

**B2 (GENUINELY RESOLVED, with one residual) — Real-fetch preflight correctly replaces the port-ping.** D-4/§5.2/AC-6 now specify a bounded 1-item real fetch through the lane, non-200 → direct-only, citing `lanectl test` as a real egress probe. This is the right fix and directly answers Pass-1 B2. **Residual:** the preflight itself consumes one of Reddit's ≈1-fetch/window/IP budget (R4/§7). A preflight fetch + the real gather fetch on the *same* Starlink egress is two fetches in one window → the second is the 429 you were trying to avoid. The PRD must state the preflight either (a) targets a *different* cheap endpoint than the gather subs, or (b) the preflight result IS the first candidate (fold the probe into the fetch, don't spend budget twice). Otherwise the preflight causes the failure it detects.

## Required Changes

**RC-A (from B1) — Hard-code default numeric ceilings for X/Y/Z in the PRD** before G3, with G3 permitted to tighten only. Without a pre-committed bar, AC-8's "meets the numeric thresholds" is satisfiable by any data set.

**RC-B (from B2 residual) — Resolve preflight-vs-gather budget double-spend.** Specify that the preflight does not burn the same per-IP/window budget the gather needs (fold probe into first fetch, or probe a distinct endpoint). §5.2/D-4/R4.

**RC-C — The canary (D-2/§5.4/G3) is now load-bearing but underspecified as a gate.** It correctly fills the shadow-can't-prove-pool-replacement hole (the genuine fix for B1's structural flaw). But "Ace reviews the live diff, THEN leave it on" has no *fail* path: what posted-set divergence aborts the canary and rolls back? Define the canary's reject condition (e.g. "any posted item dropped that the shadow did NOT predict → rollback + re-shadow"), else it's a review ritual, not a gate. AC-8.

**RC-D — Phase-3 fallback ("a dedup/diversity throw → un-deduped set") is asserted, not located.** §5.4/Phase-3-negative/R3 promise graceful degradation, but the wire-in is a *prompt.md shell block* calling TS modules, not typed code — a throw in `diversity-rerank.ts` invoked from a shell step does not automatically "fall back to the un-deduped set" unless the prompt block explicitly catches non-zero exit and uses the pre-feature pool. Specify *where* that try/fallback lives (the prompt block must capture the module's exit code and pass through the un-deduped set on failure) and add it to the Phase-3 required E2E.

**RC-E — RC4 staleness resolution is good but has a self-exemption gap.** D-5/§5.3/AC-11 correctly add staleness + schema-mismatch alerts (resolving Pass-1 RC4). But the silent-block watchdog *reads gatherer-probe artifacts produced by a different cron* — if the probe cron and the watchdog cron both die (machine asleep, launchd unloaded), the watchdog can't alert on its own death. State the backstop: either the existing launchd safety-net plists cover these jobs, or a heartbeat/`#logs` healthy-tick makes watchdog silence itself detectable. (Minor — but "the watchdog that can't report its own death" is the recurring fleet failure mode.)

## Lens Notes (one line each)

- **Architecture:** Blast-radius ordering (gatherers → watchdog → output features) and shadow-before-live are sound; the canary (RC-C) is now the real load-bearing gate since shadow structurally can't prove pool-replacement.
- **Security/identity-isolation:** Clean — no new creds/egress identity; SOCKS lane pre-existing; honest-zero engagement preserved; nothing new to isolate.
- **DevOps/SRE:** Per-phase `.bak`/`launchctl unload` rollback is genuinely one-command (strongest part); B2 preflight fixed but budget-double-spend (RC-B) and watchdog-self-death (RC-E) are open.
- **Implementation/maintainability:** Reuses real modules (good); but the fallback-on-throw lives in an untyped 44K prompt.md shell surface (RC-D) — assert it, don't assume it.
- **QA:** Dry-run forced-failure + double-post + staleness + schema-mismatch tests are *real* adversarial gates; G3 remains the weak joint until X/Y/Z are pre-committed (RC-A) and the canary has a fail path (RC-C).
- **Config-drift:** Gating discipline strong; subreddit list (OQ-1) and N (OQ-2) still unpinned — commit them to version-controlled files (like `primary-handles.txt`), not inline prompt/cron, or they drift.

## Residual Risks / Open Questions

- **B1 not fully closed:** the canary saves G3 in practice, but data-fitted thresholds (RC-A) mean the numeric gate alone can't fail — fix the ordering (bar before data) or rely honestly on the canary as the real gate and demote the numeric gate to advisory.
- **Preflight budget paradox (RC-B):** an un-resolved preflight double-spend turns the safety check into the failure cause on exactly the constrained Starlink lane it protects.
- **High-volume-day requirement (D-2b) is correct but unenforced:** "must include ≥1 high-candidate-volume day" has no definition of "high-volume" — pin a candidate-count floor or it's a judgment call that a quiet week silently satisfies.
- **Cross-brief directionality** (morning-digest gains gatherers, both briefs share dedup DB): confirm a reddit item in morning-digest correctly suppresses a later same-day X-feed duplicate, and that suppressing X-feed in favor of morning-digest is the *desired* direction — untested in this PRD.
- **Prompt.md as 44K program:** every wire-in compounds an untyped shell-in-prose surface; the fallback-on-throw (RC-D) is exactly the logic that's hard to get right in that medium — flag a TS gather-orchestrator for the next refactor.
- **N=3 twitchiness vs Reddit's 1-fetch/window budget** (OQ-2): one bad-egress day already yields zero; tie N to measured lane uptime after Phase 1, and confirm the preflight double-spend (RC-B) isn't itself manufacturing zero-days.