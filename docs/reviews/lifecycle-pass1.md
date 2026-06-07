# PRD Lifecycle Skill Suite — Senior Review

## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None. Low blast radius (docs/process skills), scoping is mostly sound, and the dogfood proof is concrete (parakeet) rather than hand-waved.

## Required Changes

1. **§4.2.1 vs swarm §2.6/§2.8 — the patch partially duplicates what already exists.** §2.6 already has "integration-when-boundary" + §2.8 already has the mock-trap rule. The *new* substance is only: "promote e2e from conditional to mandatory for any runnable artifact." Cut the cross-reference padding and state the patch as a single delta: §2.6's conditional clause becomes unconditional **for runnable artifacts**, with §2.8 unchanged. As written, L6/§4.2.1 reads like it's re-asserting mock-trap, which it isn't adding. Make the diff surgical or the reviewer of the *next* PRD can't tell what changed.

2. **§4.2.1 — "any PRD that ships a runnable artifact" needs a boundary, or §1.2 conflict.** A swarm split into pure-refactor or doc-only subtasks still "ships a runnable artifact" at the repo level but has no new e2e surface. Define the trigger as "the swarm's integrated output exercises a new/changed real path," not "the repo is runnable." Otherwise you mandate e2e where §2.6 correctly already says "when boundary."

3. **§4.1 vs writing-plans — the overlap is real and under-resolved.** writing-plans already has "smoke test as a plan step" and the "v0.1 cut vs full PRD" pattern. prd-authoring's per-phase Verification block is conceptually the same testability discipline applied one stage earlier. §6 risk-row says "each names the other" — that's the *mitigation text*, but the actual SKILL bodies must state the **handoff seam in one sentence**: prd-authoring stops at "phase + its verification intent"; writing-plans owns "break phase into TDD steps." Without that line in both skills, a model facing "spec + plan this" will trigger both and produce two overlapping breakdowns.

4. **§4.3 / L5 — closeout evidence rule is the rubber-stamp risk; tighten the failure semantics.** "Each item requires real proof" is good, but the checklist has no rule for *what a model does when an item can't be evidenced*. Add: an item with no evidence is **FAIL/BLOCK**, not "N/A" — and "(if applicable)" items (rows 6,7) must state *why* they're inapplicable, not be silently skipped. Otherwise the dodge is marking everything "if applicable → skip."

5. **§5 Phase 3 dogfood — closing out parakeet *now* mixes test surfaces.** parakeet had "no test suite" (§1). The Phase 3 dogfood claims "tests green (11-green)" in Acceptance §8. If those 11 tests don't exist yet, the closeout dogfood is also a test-authoring task and will conflate "did closeout work" with "did I just write parakeet's tests." Name explicitly: does parakeet have tests *before* this PRD runs, or does Phase 3 inherit test-writing? If the latter, the dogfood doesn't prove closeout in isolation.

## Lens Notes
- **Product:** Real gap, named live failure (parakeet), lifecycle framing is coherent — entry-gate/exit-gate symmetry is the right mental model.
- **Skill-design:** Sound (why-not-MUSTs noted in §6); main risk is prd-authoring encoding judgment that writing-plans already partly owns.
- **Composition:** L7's "each names the next" is necessary but not sufficient — the authoring↔writing-plans *seam* (not the linear handoff) is the unresolved one.
- **Triggering:** prd-closeout's proactive language is decent, but "we're done" is exactly the moment a model declares victory and *stops* — proactive trigger on "acceptance criteria met" must be load-bearing; verify it fires in dogfood, not just asserted.
- **QA:** Phase 2 negative check (sections intact) is good; Phase 1/3 dogfoods are real proof — strongest part of the PRD — pending the parakeet-tests-exist question above.

## Open Questions
- §7.2 (closeout auto-runs description-optimizer): lean-optional is fine; don't mandate.
- Does prd-closeout trigger compete with any existing "ship/commit" reflex the agent already has? If memory/mem0 update is already habitual, row 6 may double-fire — worth a dogfood check, not a blocker.
- Q3 (JSON report): markdown for v1 is right; no consumer named, so don't build it.

## Strengths
Concrete live-failure motivation (§1, parakeet); tests-vs-evals distinction (L3) is a genuinely useful clarification most PRDs blur; evidence-backed closeout (L5) and the §5 "author directly, not swarm" call (correctly citing swarm §1.2) show the family's own rules are being applied to itself. Dogfood phases produce real artifacts, not assertions.