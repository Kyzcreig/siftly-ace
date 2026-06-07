# PRD Lifecycle Suite v5 — Pass 2 Review

## Verdict
APPROVE

## Pass-1 Fix Verification

- **RC1 (docs single source of truth): RESOLVED.** §4.4 now states `prd-docs` **OWNS** the documentation procedure and that `prd-closeout` items 3–4 **"invoke `prd-docs`'s procedure" rather than re-encoding it.** The closeout cross-pointer was correspondingly rewritten ("for the docs slice I run `prd-docs`'s procedure"). This collapses the maintenance fork to one place. Evidence is consistent in both directions and the §8 acceptance criterion greps for the cross-pointer in both skills. Genuinely fixed.

- **RC2 (interview termination): RESOLVED.** §4.0 adds an explicit "Termination guarantees (RC2)" block with both hatches: (a) user early-exit ("good enough, draft it") emits Snapshot-as-is; (b) a ~5-batch round cap that stops on its own and hands unresolved questions to `prd-authoring` as flagged gaps. The subtle gaming vector I'd flag — force-concreteness re-asks keeping the loop alive — is closed explicitly ("Force-concreteness re-asks count toward the cap"). Strong fix.

- **RC3 (/handoff path+perms): RESOLVED.** §4.5 now states the command **prints the absolute path** as its return value and explains the discovery path travels out-of-band via the user, not inside the doc (closing the original "how does agent #2 find it" loop). Files written with **0600**, with the `/tmp` world-readable justification stated. Both halves of the original blocker addressed.

- **RC4 (redaction scope): RESOLVED.** §4.5 reframes redaction as **"belt-and-suspenders, not a solved detection problem,"** leans on references-not-duplicates as the primary structural protection, and delegates detection to the **existing home secret/redaction policy's mechanism** rather than reinventing it. The planted-secret test is now correctly downgraded to "a smoke check… not a proof of exhaustive detection." This is the honest scoping Pass-1 asked for.

- **RC5 (license): RESOLVED.** §1.1 adds the License/attribution line: all three repos MIT/permissive, patterns **reimplemented in our own words, not copied verbatim.** Closes the unstated attribution question.

## Remaining Required Changes

None blocking. Two minor notes for build, not gates:

1. **Round-cap default is soft ("~5 question-batches").** Fine for v1, but the dogfood (Phase 0 E2E) doesn't actually exercise the cap or the early-exit — it only checks the happy-path exit (research-first, judgment-calls, success-criteria stop). Consider adding one dogfood line that confirms a deliberately-evasive/vague answerer hits the cap and emits Snapshot-with-flagged-gaps. Without it, RC2's mechanism is specified but never tested. (Low priority; the spec is correct, the test coverage just lags it.)

2. **The combined-phrasing dogfood (Phase 3.5) asserts the desired resolution but not the mechanism that produces it.** It says "confirm it resolves to `prd-closeout` (the superset)… NOT `prd-docs`." The self-correct net relies on each skill naming its neighbor — verify in dogfood that the resolution is *deterministic* (closeout wins) and not just "happened to fire right this run." Same low-priority "test lags spec" pattern as #1.

Neither warrants holding the build.

## Strengths
- Every Pass-1 required change is addressed *at the mechanism level*, not papered over — each carries an inline `(RCn)` tag tracing back to the review, which makes verification fast and signals the author understood the *why*, not just the ask.
- The RC2 fix went one level deeper than requested by closing the force-concreteness gaming vector unprompted — that was the exact loophole in the original stop condition.
- RC4's reframe is the right kind of honesty: it stops "redacts secrets" from reading as a solved detection guarantee and correctly identifies references-not-duplicates as the *structural* protection with redaction as backstop.
- The Phase 3 confound-elimination (parakeet's pre-existing 11-test suite isolating closeout from test-authoring) survives v5 intact — still the sharpest piece of QA design in the doc.
- Scope discipline held: the author resisted expanding surface area between passes and made surgical edits exactly where flagged.