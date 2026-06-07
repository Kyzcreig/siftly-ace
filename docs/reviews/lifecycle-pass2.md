# PRD Lifecycle Skill Suite — Pass 2 Review

## Verdict
APPROVE WITH CHANGES

## Pass-1 Fix Verification
- RC1: resolved — §4.2 is now three numbered edits; explicitly states "§2.8 (mock-trap) is unchanged and NOT re-asserted here." Clean surgical delta.
- RC2: partially resolved — §4.2 correctly uses "new or changed real path exercised" with explicit carve-outs for pure-refactor/doc-only. However, L6 still says "any PRD that ships a runnable artifact" and AC3 still says "requires real e2e for runnable artifacts." The old language survives in the two places that get enforced at review and closeout.
- RC3: partially resolved — §4.1 describes the seam clearly and specifies the exact one-sentence handoff for both directions. But no implementation phase schedules the edit to `writing-plans/SKILL.md`. The seam is designed in both directions, delivered in one.
- RC4: resolved — dedicated failure-semantics paragraph: no evidence = FAIL/BLOCK, inapplicable items require a one-line reason, never silently dropped.
- RC5: resolved — Phase 3 states "parakeet's 11-test e2e suite already exists and passes (written before this PRD)" and "it is NOT also a test-authoring task." Dogfood cleanly isolates closeout.

## Remaining Required Changes

**RC-A — L6 and AC3 still say "runnable artifact(s)"; align with §4.2's refined boundary.** L6 and AC3 are what get checked at review and closeout. §4.2 deliberately narrowed the trigger to "integrated output exercises a new or changed real path" and explicitly rejected "the repo happens to be runnable." If the resolved-decision and acceptance-criterion still say the old thing, the old thing gets enforced. Fix: swap "runnable artifact" → "swarm whose integrated output exercises a new or changed real path" in both L6 and AC3.

**RC-B — Schedule the `writing-plans` seam patch in Phase 4.** §4.1 specifies the exact sentence `writing-plans` should carry ("if you don't have an authored PRD yet, start with `prd-authoring`"), but Phases 1–4 never schedule that edit, and the Type/L1 scope ("three coordinated changes") doesn't include it. Phase 4 ("cross-link + docs") is the natural home. Add one bullet: "Patch `writing-plans/SKILL.md` to add the upstream seam sentence pointing to `prd-authoring`." Without this, RC3 is half-delivered — `prd-authoring` points to `writing-plans` but not vice versa.

**RC-C — Closeout checklist item #1 is unconditional; contradicts §4.2 applicability boundary.** Item 1 ("E2E tests exist & pass") has no conditional marker, yet §4.2 explicitly says "a pure-refactor or doc-only swarm with no new real surface" doesn't require e2e. The failure-semantics paragraph only marks row 7 as `(if applicable)`. A doc-only project running closeout would FAIL on item 1 with no escape. Fix: make item 1 conditional on the same trigger as §4.2 — required when integrated output exercises a new/changed real path; otherwise subject to the one-line-reason inapplicability rule already defined in the failure-semantics paragraph.

## Lens Notes
- Phase 1 e2e says "regenerate the *structure* of an existing good PRD (e.g. parakeet) from the template." Slightly ambiguous whether output is a full rewrite or a structural skeleton. The verify-with line anchors it sufficiently for build — just note during Phase 1 that the goal is a skeleton demonstrating per-phase Verification blocks, not a rewrite of parakeet's actual design content.
- "parakeet" vs "parakeet-transcribe" is used interchangeably (Phase 3, AC5). Minor — but pick one name within the PRD for grep-ability.
- Closeout items 2–8 describe evidence less concretely than item 1 (which gives an exact command + anti-pattern). Fine at PRD level since `references/closeout-checklist.md` is the right venue for full per-item verification commands — just flag it during Phase 3 authoring.

## Strengths
- The swarm patch (§4.2) is genuinely surgical — three numbered edits with a clear "what stays untouched" statement. A reviewer diffing the skill sees exactly what moved and what didn't.
- Failure semantics paragraph converts closeout from a feel-good checklist into a real gate. "No evidence = FAIL, not N/A" plus "inapplicable still needs a reason" are exactly the teeth this needed to prevent the parakeet-style gap from recurring.
- The `writing-plans` seam description is the clearest ownership boundary in the doc — "spec + verification intent" vs "bite-sized TDD steps" is a clean cut a model can route on without ambiguity.
- Phase 3 dogfood isolation is clean: proving closeout-the-process works, not conflating it with test-authoring. The "11 tests already exist and pass" fact pins it.
- Build approach note (author directly, not via swarm, per §1.2) is good self-consistency — the PRD practices what it preaches about when *not* to dispatch workers.
- The lifecycle composition diagram in §1 makes the four-stage flow immediately legible and each skill's handoff explicit.

## Post-pass fixes applied
- RC-A fixed in L6 and AC3.
- RC-B fixed by scheduling the `writing-plans` seam patch in Phase 4.
- RC-C fixed by making closeout checklist item #1 conditional on the same real-path boundary.
