# PRD Lifecycle Suite v7 — Pass 1 Review

## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None. The new surface is low-blast-radius (docs/skills + one config-gatekept profile), the native-Kanban claims match the verified ground truth, and the gatekeeping discipline on Daedalus is sound. The issues below are correctness gaps, not stop-the-line risks.

## Required Changes

1. **`run` mode's claimed STOP-at-review-gate isn't a native primitive — name how it's actually enforced (§4.6 mode 3, §5 Phase 2).** §4.6 says RUN "→ STOP at the review/verifier gate," but native `dispatch`/`daemon` just work ready tasks until the DAG drains. The verifier/synthesizer are *tasks in the graph*, not a dispatcher pause. So "stop at the gate" only happens if (a) review-required tasks are modeled as terminal leaves with no auto-merge, or (b) the human reads `kanban list` after the pass. State which. As written, a reader could expect the dispatcher to halt for approval, and it won't. (The L13 "each step gated on Ace's go" is about plan→load→run transitions, which IS enforceable — but the *within-run* gate is conflated with it.)

2. **`load`'s cycle-rejection claim over-credits native `link` (§5 Phase 2 Negative, §6 row).** "a plan with a dependency cycle is rejected at load (or by plan-review)" — verify whether `kanban link` actually refuses to create a cycle, or whether it happily builds one and `claim` simply never returns those tasks (silent deadlock, not rejection). If `link` doesn't validate acyclicity, then **plan-review is the ONLY cycle guard** and the "(or by plan-review)" parenthetical must become "plan-review MUST catch this because load won't." Don't let the spec imply two independent guards when there may be one.

3. **`kanban swarm` fast-path (L17/§4.6 load) collides with the disjoint-write-scope discipline.** Native `swarm` is flat fan-out→verifier→synthesizer. The whole reason plan-review lints disjoint write scopes is that parallel coding workers smashing the same files is the §2.8 failure. But `swarm`'s fan-out workers run in parallel by construction — does it isolate them (worktree-per-worker) or share a workspace? If shared, the fast-path is exactly the collision case plan-review is supposed to prevent, and offering it as a convenience undercuts the linter. Add a one-line constraint: swarm fast-path only when workers have isolated workspaces.

4. **plan-review's "assignees exist on disk" check has a bootstrapping ordering bug (§4.7, §5).** plan-review runs between PLAN and LOAD (Phase 2.5). Daedalus is created in Phase 2.6 — *after*. So the first real plan-review of a coding plan that routes to `daedalus` will fail the "assignee exists" check, OR the check is toothless until 2.6 lands. Either reorder (Daedalus before plan-review dogfood) or note that the routing-sanity check degrades to a warning when the assignee is a known-pending profile.

5. **Daedalus cost-routing is asserted but has no mechanism (§4.8, §6 cost row).** "xhigh reserved for genuinely hard coding tasks (route simple ones to a cheaper profile)" — *who* routes? There's no rule in plan-review or the compiler that classifies task difficulty and picks a profile. As written, every coding task → Daedalus → xhigh → max cost. Either (a) make this an explicit plan-review check ("flag trivial tasks routed to xhigh") or (b) drop the claim and accept all-Daedalus-coding as v1, with cost bounded only by `--max-runtime`/`--max N`. Don't claim a cost control you didn't build.

## Lens Notes (Kanban-integration / Daedalus-provisioning / Cost / Composition / QA)

**Kanban-integration:** The reframe is the right call and the verified-primitive table (L12, §4.6) maps cleanly to real commands. Good. Two seam gaps beyond the blockers: (i) the swarm-plan schema's `goal: bool` and `--goal-max-turns` are mentioned but plan-review doesn't lint goal-mode tasks for runaway-turn risk — a goal-mode coding task to Daedalus xhigh is the worst-case cost vector; add a check. (ii) §4.6 says native does "claims, retries, isolation" — confirm the swarm-plan `workspace` field values (`scratch|worktree|dir`) round-trip to `kanban create --workspace` exactly; a mismatch silently drops isolation.

**Daedalus-provisioning:** Identity separation (own tokens, `dispatch_in_gateway: false`, separate profile dir) is correct and matches the multi-gateway ground truth (only one gateway dispatches). Gatekeeping (show diff → approve → apply → `doctor` → verify) is solid. One real risk: §4.8 clones "from Apollo's config EXCEPT" — a clone-then-diff inherits Apollo's *gateway token references* unless explicitly nulled. The diff review must show tokens are **removed/replaced, not just overridden**, or Daedalus's config could still resolve Apollo's 1Password entries. Make "Apollo's tokens absent, not just shadowed" an explicit Phase 2.6 verification, not just "uses its own."

**Cost:** Covered in Required Change 5. Add: the GPT-5.5 research correctly notes xhigh is expensive-but-worth-it for hard tasks and cites the hallucination flag — but the PRD's only cost bound is per-task runtime × concurrency, with no aggregate ceiling. For a multi-dozen-task PRD all routed to xhigh, that's unbounded in total. A `dispatch.max_concurrency` cap limits *parallel* burn, not *total*. Note this as accepted-for-v1 or add a task-count sanity flag.

**Composition:** The prd-review vs plan-review separation (L15, §4.7) is genuinely non-redundant — different artifact (DAG file vs prose), different failure modes (deadlock/collision vs vague-requirements). This is well-argued and not the redundancy I was sent to catch. The prd-docs/prd-closeout single-source-of-truth (RC1) and the writing-plans two-way seam are clean. The eight-surface triggering collision risk is acknowledged with the right mitigation (neighbor-naming self-correct + the combined-phrasing determinism test in Phase 3.5).

**QA:** Phase dogfoods are concrete and real (live scratch board, `dispatch --dry-run`, parakeet closeout on a pre-existing passing suite — good isolation of *closeout* from *test-authoring*). The RC2 evasive-answerer cap test and the broken-plan (cycle + collision) plan-review test are the right adversarial cases. Gap: no test that **two profiles attempting dispatch** is actually prevented — Phase 2.6 negative asserts `dispatch_in_gateway: false` as config, but doesn't prove the daemon refuses to double-dispatch. A config flag and a runtime behavior aren't the same; if cheap, assert the behavior.

## Open Questions

1. Does `kanban link` validate acyclicity, or is a cycle a silent claim-starvation deadlock? (Determines whether plan-review is the sole cycle guard — Required Change 2.)
2. Does `kanban swarm` isolate its fan-out workers' workspaces, or share one? (Determines whether the L17 fast-path is safe — Required Change 3.)
3. Is the within-`run` "stop at review gate" a dispatcher behavior or just "the human reads the board after the pass"? (Required Change 1.)
4. Is `openai-codex/gpt-5.5` a real, resolvable model id in this Hermes build *today* (2026-06-07), or aspirational? Phase 2.6's `doctor` will catch it, but if the model route doesn't exist yet, the whole Daedalus phase blocks — worth pre-verifying like the other live claims were.
5. The GPT-5.5 SOUL says "skip architecture overviews (agents find them independently)" per the ETH study — but Daedalus is a *Kanban worker* with a fresh workspace per task and no session continuity. Does "find independently" hold when the worker has minutes, not a session, and a worktree, not the full repo context? Worth a sentence in the SOUL design.

## Strengths

- The native-Kanban reframe (L12, §4.6) is the highest-leverage decision in the PRD: deleting a from-scratch executor in favor of verified primitives, keeping all the *slicing judgment* (§1.1/1.2/2.6/2.7/2.8 fed into task bodies) while discarding the plumbing. The "we wire, we don't rebuild" framing is disciplined.
- The GPT-5.5 research was applied *critically*, not as marketing: encoding the hallucination flag (Artificial Analysis) and the "not best at every benchmark / Opus leads SWE-Bench Pro" caveat into a *hard verify-before-claim SOUL constraint* (§4.8) is exactly the right synthesis — autonomy paired with empirical guardrails, not blind trust.
- Daedalus identity hygiene (own tokens, no second dispatcher, separate profile dir) directly addresses the two real multi-gateway failure modes (token bleed, WAL contention) and ties each to a Phase 2.6 negative test.
- plan-review's checks are genuinely *mechanical and verifiable* (topological sort, write-scope disjointness, acceptance-criteria-in-body) — it's a linter, not a second opinion, which is exactly what keeps it from being prd-review redundancy.
- The acceptance-criteria-in-body alignment with verified Kanban reality (L16: no eval column → lint the body) shows the live verification actually changed the design rather than being decoration.