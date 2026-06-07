# PRD Lifecycle Suite v4 — Pass 1 Review

## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None. The three new artifacts are well-bounded and the high-risk surfaces (/handoff secrets/location, prd-docs/prd-closeout leak, 5-way trigger collision) are each named with a mitigation. Issues below are required fixes, not blockers.

## Required Changes

1. **§4.4 / §4.3 boundary leak: prd-docs duplicates closeout's docs+Obsidian item with no shared source of truth.** Closeout item 3 ("project docs current") and item 4 ("Obsidian overview exists & current") are *exactly* prd-docs's whole job. The cross-pointer prevents the wrong skill *firing*, but it does not say closeout *delegates* its docs slice to prd-docs. Right now both skills independently encode "how to update AGENTS.md + README + Obsidian + linking + Portability Rule." That's a maintenance fork: fix the Obsidian linking convention in one, it drifts in the other. Add one sentence: closeout's items 3–4 should *invoke prd-docs's procedure* (or reference its checklist), so the docs mechanics live in one place. Otherwise you've split the doc logic across two skills that must stay in lockstep.

2. **§4.0 grill-me over-ask is mitigated; under-ask / never-terminate is not.** The risk table catches over-ask (asking discoverable facts). The opposite failure — the interview never reaching a stop, looping on "force concreteness" re-asks, or the user wanting to bail mid-interview — has no escape hatch. The stop condition (§4.0 "no blocking open questions") can be gamed by an agent that keeps an open question alive. Add: (a) a user-invokable early-exit ("good enough, draft it"), and (b) a turn/round cap after which the interview emits the Snapshot-as-is and hands to authoring with explicit gaps flagged. Without this, the worse user-facing failure is an interview that grills forever.

3. **§4.5 /handoff temp-dir choice is itself a portability/discoverability risk.** Writing the baton to `$TMPDIR`/`/tmp` means: (a) the receiving fresh agent must be *told the path* — but the handoff doc is the very thing carrying that info, so how does agent #2 find it? The PRD never states the path-discovery mechanism. (b) `/tmp` is world-readable on shared hosts; a redacted-but-still-sensitive handoff (internal architecture, in-flight decisions) sits in a world-readable location. State the path-return contract (command prints the path) and either set restrictive perms (0600) or justify why `/tmp` exposure is acceptable given redaction.

4. **§4.5 redaction is asserted, not specified.** "Redacts secrets (API keys, passwords, tokens, PII)" with a single planted-fake-secret negative test (Phase 3.6) is thin for a security-relevant feature. One planted secret proves the happy path, not coverage. Either (a) reference the existing home secret/redaction policy's mechanism rather than implying /handoff reinvents detection, or (b) scope redaction explicitly to "references-not-duplicates means secrets rarely transit anyway; redaction is belt-and-suspenders on the live-session-state slice." Don't let "redacts secrets" read as a solved detection problem it isn't.

5. **§1.1 / §4 third-party attribution: confirm license posture, not just "influence vs adopt."** The disposition table sensibly separates "influence, don't adopt" (awesome-copilot) from "adopt the mechanics" (grill-me, handoff). But "adopt the mechanics/core line" from named third-party repos raises an attribution/license question the table doesn't touch. One line stating these are MIT/permissive and that adopted patterns are reimplemented (not copied verbatim) closes it. As written it's defensible but unstated.

## Lens Notes (Product / Composition / Triggering / Security / QA)

**Product.** The interview→author→review→build→closeout spine is coherent and the parakeet-transcribe motivation is real (§1). prd-docs and /handoff as orthogonal is the right call. Good.

**Composition.** The seams are mostly explicit and bidirectional (writing-plans §4.1, prd-docs↔closeout §4.4). The *one* gap is the docs-logic fork above (Required #1). The prd-interview→authoring handoff is clean. §2 Non-Goals correctly fences off prd-review-pipeline and writing-plans.

**Triggering.** Five skills + one command. The collision the PRD *names* (interview/authoring/docs/closeout) is handled by distinct phrasings + self-correct. The collision it *misses*: "write up what we built" (§4.4 prd-docs trigger) vs "we're done — finish it properly" (§4.3 closeout) vs "document this" — a user who says "we built X, document and wrap it up" hits docs AND closeout phrasings simultaneously. The "names its neighbor so a mis-fire self-corrects" mechanism is the safety net, but verify in dogfood that the *combined* phrasing resolves to closeout (the superset), not docs (the subset that would silently skip the gate). Add this case to Phase 3.5/3 dogfood. Separately: /handoff as a command (not phrase-triggered) is correctly reasoned (§4.5) — that removes it from the collision surface, good.

**Security.** /handoff is the only real security surface among the three new artifacts. Covered by Required #3 (location/perms) and #4 (redaction spec). No other new artifact touches secrets, isolation, or trust boundaries.

**QA.** Phase 3 cleverly resolves the mock-trap/test-authoring confound by using parakeet's *pre-existing* passing 11-test suite to prove closeout in isolation (§5 Phase 3) — this is genuinely good adversarial design, it stops closeout's dogfood from secretly being a test-writing task. The FAIL-on-no-evidence negative case is present. Gap: no dogfood asserts the prd-docs/closeout *combined-phrasing* resolution (see Triggering), and no test for the interview never-terminating case (Required #2).

## Open Questions

1. Does prd-closeout call prd-docs for its docs slice, or reimplement it? (Drives Required #1; affects whether this is two skills or one-and-a-half.)
2. How does fresh-agent #2 discover the `/tmp` handoff path — printed return value, fixed filename, or out-of-band? Unspecified in §4.5.
3. Open Q2 (§7) — closeout auto-running description-optimizer — interacts with skill-creator; "lean optional" is fine for v1 but note it so it isn't silently dropped.

## Strengths
- Phase 3's use of parakeet's pre-existing suite to isolate closeout-vs-test-authoring (§5) is sharp confound-elimination.
- §4.2 keeps the swarm patch genuinely surgical: one §2.6 promotion, explicitly *not* re-asserting §2.8, with a clear "new/changed real path" trigger distinct from "repo happens to be runnable."
- The §1.1 disposition table correctly resists adopting awesome-copilot's product/stakeholder schema while taking its measurable-requirements discipline — right instinct on what to take vs leave.
- §4.1's writing-plans seam being mandated in *both* bodies as one sentence each is the correct anti-double-trigger pattern.