# PRD Lifecycle Suite v8 — Pass 2 Review

## Verdict
APPROVE

## Pass-1 Fix Verification

- **RC1 (within-run gate): resolved.** §4.6 mode 3 now states the dispatcher does NOT pause; the gate is modeled *in the graph* via `kanban_block(reason="review-required")` instead of auto-complete, plus the verifier task gating the synthesizer (`{"gate":"pass"}`/block). Explicitly disentangles the within-run gate from the plan→load→run transition gating (L13). This is the (a)+(b) answer the blocker demanded, named precisely. The mechanism is the worker skill's block behavior, not a dispatcher feature — correct.

- **RC2 (cycle rejection): resolved, with live evidence.** §4.6 "Cycle safety" cites `_would_cycle()` raising at link time in `kanban_db.py` (verified). The "(or by plan-review)" parenthetical is now correctly reframed as **two real guards** — link rejects at write-time, plan-review catches earlier as defense-in-depth — rather than the ambiguous one-or-two framing Pass 1 flagged. Open Q1 is closed by verification.

- **RC3 (swarm isolation): resolved.** L17 now constrains the fast-path to "flat fan-out → verifier → synthesizer **AND** workers get isolated workspaces," backed by the live finding that `swarm` applies **one `workspace_kind` to all workers** — so the directive is "pass `scratch`/`worktree`, never a shared `dir:`." This directly closes the collision-undercuts-linter concern. Open Q2 closed. Note: because swarm applies one kind to all, isolation is all-or-nothing per swarm — fine, and correctly stated.

- **RC4 (plan-review ordering / assignee-exists): partially addressed — see Remaining.** The bootstrapping ordering bug (plan-review at 2.5 checks "assignees exist on disk," Daedalus created at 2.6) is **not explicitly resolved in the spec text**. §4.7 still lists "assignees exist on disk" as a hard check; §4.8/Phase 2.6 still lands after 2.5. Neither the reorder nor the "degrade-to-warning-for-known-pending-profile" note was added. This is the one Pass-1 required change without a visible fix.

- **RC5 (cost routing mechanism): resolved.** §4.8 now makes routing a **real `prd-swarm-plan-review` lint** ("flag any task assigned to `daedalus` whose body looks trivial… suggest a cheaper profile") AND honestly states the residual: no aggregate ceiling, only `--max-runtime` × `--max N`, accepted-for-v1 with a task-count sanity flag as the named mitigation. This is exactly option (a)+honest-(b) the blocker asked for — claim now matches a built mechanism.

- **Daedalus token-absence: resolved.** §4.8 config-gatekeeping now requires the diff to show Apollo's telegram/discord tokens are **removed/nulled, not merely overridden**, and Phase 2.6 negative asserts Daedalus's config does NOT resolve Apollo's 1Password entries. The "absent, not shadowed" language is verbatim the lens-note ask. Also adds the behavioral double-dispatch assertion (below).

- **gpt-5.5 resolvable: resolved, with live evidence.** §4.8 states `openai-codex/gpt-5.5` is "already a configured provider/model in Apollo's config (not aspirational)" (verified). Open Q4 closed; the Daedalus phase won't block on an unresolvable route.

- **worker-context (Q5): resolved.** §4.8 adds the explicit caveat that the ETH "agents find architecture independently" finding assumes full-repo + real session, which a Kanban worker (minutes, worktree/scratch slice) lacks — so the **task body** must carry the non-inferable per-task context, tying back to L16. This is the sentence-in-the-SOUL-design the question asked for, and it's coherent with the rest of the design.

## Remaining Required Changes

1. **RC4 ordering bug is still unaddressed (§4.7 routing check vs §4.8/Phase 2.6 sequencing).** plan-review (2.5) hard-checks "assignees exist on disk"; Daedalus is created at 2.6. The first dogfood of plan-review on any plan routing to `daedalus` will either fail the assignee check or the check is toothless until 2.6. Pick one and write it in:
   - **(a)** Reorder: move Daedalus (2.6) before the plan-review dogfood, OR
   - **(b)** One sentence in §4.7: "the assignee-exists check degrades to a WARNING (not FIX-THESE/block) when the assignee is a known-pending fleet profile (e.g. `daedalus` before its Phase 2.6 provisioning), and hardens to a blocking check once provisioned."
   
   (b) is the lower-friction fix and is consistent with the existing PASS/FIX-THESE output model. This is the only item gating APPROVE-clean; it is a one-line edit, not a redesign — hence APPROVE rather than APPROVE WITH CHANGES is *not* warranted; correcting myself: **this single unaddressed required change means the honest verdict is APPROVE WITH CHANGES.** Make this edit before build.

*(Verdict corrected to APPROVE WITH CHANGES on account of Required Change 1 above — the other four RCs, all three lens-notes, and all five open questions are genuinely resolved with evidence.)*

## Strengths

- **Live verification did real work this pass, not decoration.** Three Pass-1 open questions (cycle rejection, swarm isolation, gpt-5.5 resolvability) were answered by reading actual source/config (`_would_cycle` in `kanban_db.py`, swarm's single `workspace_kind`, the configured model route) — and each finding *changed the spec text*, not just appended a footnote. The cycle case even flipped from "maybe one guard" to a confirmed two-guard defense-in-depth.
- **RC5's resolution is intellectually honest.** Rather than inventing a difficulty classifier, it built the one real check it can (trivial-task-routed-to-xhigh lint) and *explicitly states the unbounded-aggregate-cost gap* as accepted-for-v1. Claiming only the control you built is exactly the discipline Pass 1 asked for.
- **RC1's graph-modeled gate is the correct mental model** and now clearly separated from transition gating — a reader can no longer expect the dispatcher to halt for approval.
- **Token-absence-not-shadowing + behavioral double-dispatch assertion** closes both real multi-gateway failure modes (token bleed, WAL contention) at the level of *verified behavior*, not just config flags.

Apart from Required Change 1, this is build-ready. Apply the one-line plan-review-warning degrade (or reorder 2.6) and ship.