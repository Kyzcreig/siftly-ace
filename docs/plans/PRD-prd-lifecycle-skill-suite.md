# PRD — PRD Lifecycle Skill Suite (authoring · swarm evals · closeout)

**Version:** v10 (added Phase-4 Obsidian overview deliverable: `AI/PRD Skills & Kanban Orchestration — System Overview.html`, per Ace request)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo
**Type:** Eight coordinated artifacts in the `software-development` PRD skill family + fleet (5 new skills, 1 reframed-patch, 1 slash command, 1 new agent profile)
**Status:** APPROVED to build (Kanban/Daedalus expansion: 2-pass re-review APPROVE WITH CHANGES → APPROVE; live-verified)

---

## 1. Summary & Goal

Close the gaps in our PRD lifecycle so every spec is born testable and dies documented. The full suite:

1. **NEW `prd-interview`** — a "grill me" front-end: research-first, batched judgment-call questions, running snapshot, stops at a concrete problem statement + success criteria. Feeds `prd-authoring`.
2. **NEW `prd-authoring`** — writes a good PRD that *always* bakes in thorough testing + evals **per step/phase**, with measurable requirements (no "fast/easy"), in a shape that drops cleanly into `prd-swarm-planner`.
3. **NEW `prd-docs`** — documentation-only updates to project docs + Obsidian, **without** adding tests/build work. The lightweight "keep the docs current" tool, distinct from full closeout.
4. **PATCH `prd-swarm-planner` → PRD→Kanban-graph compiler** — `plan`/`load`/`run` modes: slice an approved PRD into a small-task **DAG written to a reviewable file**, load it onto the **native Hermes Kanban board** (`kanban create`+`link`), and let the **native dispatcher** run N dependency-aware workers. We wire into native Kanban; we don't rebuild the executor.
5. **NEW `prd-swarm-plan-review`** — a mechanical Kanban-viability linter for the swarm-plan file (slice size, disjoint write scopes, acyclic DAG, acceptance-criteria-in-body, routing). Runs between plan and load.
6. **NEW `prd-closeout`** — the full "we're done" ritual: tests pass + docs + Obsidian + commit/push + memory/mem0.
7. **NEW `/handoff` slash command** — compact the current session into a handoff doc for a fresh agent (temp dir, references-not-duplicates, suggested-skills, redacted).
8. **NEW agent `Daedalus`** — a GPT-5.5 xhigh coding-specialist profile (own identity, not Apollo's) used as the `coder` assignee for Kanban coding tasks. SOUL authored via Opus-4-8 high.

**Why now:** We hit the testing/docs/closeout gaps live on parakeet-transcribe ("fully built" but untested + undocumented until asked), and the planning convo surfaced that native Hermes Kanban already provides the parallel-worker orchestration. Encode the whole lifecycle so it's automatic, not prompted; wire the planner into native Kanban rather than rebuilding it.

**The lifecycle:**
```
interview (prd-interview: grill to a concrete problem + success criteria)
  → author (prd-authoring: measurable, testable PRD)
    → review (prd-review-pipeline: N passes = review+fix)
      → plan (prd-swarm-planner PLAN: slice PRD → swarm-plan FILE = task DAG)
        → plan-review (prd-swarm-plan-review: Kanban-viability lint)
          → load (prd-swarm-planner LOAD: kanban create+link → native board)
            → run (prd-swarm-planner RUN: kanban dispatch --max N / daemon → N workers, Daedalus codes)
              → close out (prd-closeout: tests green + docs + Obsidian + commit + memory)

orthogonal: prd-docs (docs-only refresh, any time)   ·   /handoff (compact session → handoff doc, any time)
```

### 1.1 Disposition of the third-party references Ace surfaced

| Source | Verdict | What we take |
|---|---|---|
| `github/awesome-copilot` PRD skill | **Influence, don't adopt** | The measurable-requirements diff (ban "fast/easy/intuitive" → require thresholds like "<200ms", "≥85% P@10"), the AI-evaluation-strategy section, and "ask ≥2 clarifying questions before drafting." Bake into `prd-authoring`. Keep our engineering-PRD shape, not their product/stakeholder schema. |
| `mattpocock/grill-me` | Adopt the core line | "Interview relentlessly, one branch at a time, recommend an answer per question, explore the codebase instead of asking discoverable facts." |
| `tkersey/grill-me` | Adopt the mechanics | Research-first; batched judgment-call questions (prefer 2–3 independent, 1 when sequenced); running Snapshot (facts/decisions/open-Qs); follow-up derivation rules; stop-before-implementation. This is the spine of `prd-interview`. |
| `mattpocock/handoff` | Adopt as `/handoff` | Compact session → handoff doc in OS temp dir; reference existing artifacts by path/URL (don't duplicate); "suggested skills" section; redact secrets; optional arg = next session's focus. |

**License/attribution (RC5):** all three referenced repos are MIT/permissive. We **reimplement the patterns** (the discipline, the loop shape, the section structure) in our own words for our own toolchain — we do not copy SKILL.md text verbatim. This keeps attribution clean and lets the skills fit Hermes conventions.

---

## 2. Non-Goals

- **Not replacing `prd-review-pipeline` or `writing-plans`.** Those stay. `prd-authoring` produces the document the review pipeline then critiques; `writing-plans` remains the task-breakdown skill. `prd-authoring` focuses on the *testing/eval scaffolding* a PRD must contain.
- **No new review transport/model machinery.** Reuse the existing F1-bridge/proxy Opus path documented in `prd-review-pipeline`.
- **Not a CI system.** `prd-closeout` runs the project's existing tests + checks docs; it doesn't build pipelines.
- **No auto-publishing to public surfaces.** Closeout commits to our repos and updates Obsidian/mem0; it does not post anywhere public.

---

## 3. Resolved Decisions

| # | Decision | Value |
|---|---|---|
| L1 | Eight artifacts | 1 patch (`prd-swarm-planner` → PRD→Kanban-graph compiler), 5 new skills (`prd-interview`, `prd-authoring`, `prd-docs`, `prd-closeout`, `prd-swarm-plan-review`), 1 slash command (`/handoff`), 1 new agent profile (`Daedalus`, GPT-5.5 xhigh coder). |
| L12 | Wire into native Kanban, don't rebuild | Verified live (Hermes v0.15.1): `hermes kanban` already provides `create`/`link`(deps)/`claim`(atomic)/`dispatch --max N`/`daemon`/`swarm`/`decompose`/`specify`/`--max-runtime`/`--max-retries`/`--goal`/workspace isolation. `prd-swarm-planner` becomes a **PRD→Kanban task-DAG compiler** that emits a plan file then loads it via `kanban create`+`link`; the **native dispatcher** runs N dependency-aware workers. We wire, we do not rebuild the executor. |
| L13 | Plan is a written artifact | `prd-swarm-planner` PLAN mode writes a reviewable/editable **swarm-plan file** (the task DAG) and STOPS. LOAD mode ingests it → board. RUN mode = `kanban dispatch/daemon`. Default chains plan→review→load→run on Ace's go; each step gateable. |
| L14 | Model routing = profile = assignee | Verified: `kanban create/assign` have NO `--model`; a worker runs **as its assignee profile**, which carries the model (default→opus, aegis→claude-proxy). "Use codex gpt-5.5 coding agents" = assign coding tasks to a GPT-5.5 profile (**Daedalus**). |
| L15 | `prd-swarm-plan-review` (named per Ace) | A narrow, mechanical **Kanban-viability linter** for the swarm-plan file — distinct from `prd-review-pipeline` (which reviews prose specs). Checks: slices worker-sized; write scopes disjoint; DAG acyclic (no deadlock); each task body carries concrete acceptance-criteria checklist + verify command; assignee/model routing sane; leaf→verifier→synthesizer shape holds. Runs between PLAN and LOAD. |
| L16 | Acceptance criteria live in the task BODY | Verified: Kanban has no separate "eval" column — `specify`/`decompose` flesh out "goal, approach, **acceptance criteria** (checklist of concrete, verifiable conditions)" in the task body. So `prd-swarm-plan-review` lints the body, not a field. |
| L17 | `kanban swarm` vs `create+link` | LOAD prefers **`create`+`link`** (arbitrary multi-layer DAG — real PRDs have layered deps). Offer `kanban swarm` as a fast-path **only when the DAG is flat fan-out → verifier → synthesizer AND workers get isolated workspaces** (verified: `swarm` applies one `workspace_kind` to all workers; pass `scratch`/`worktree`, never a shared `dir:`, or parallel coders collide — the exact §2.8 failure plan-review guards). |
| L18 | subagent-router seam | Optional, not load-bearing. Router (v0.1, harness-axis only) lives *inside* a dispatched worker as a per-task harness chooser (codex vs claude-code vs hermes-native) for cost arbitrage — NOT a peer of the dispatcher. `kanban-codex-lane` already covers the main codex case. Note in spec; don't build. |
| L19 | Daedalus = new GPT-5.5 xhigh coder agent | A new Hermes profile cloned from Apollo's config EXCEPT: model = `openai-codex/gpt-5.5` reasoning `xhigh`; its OWN gateway tokens (NOT Apollo's telegram/discord); a coding-specialist SOUL. Used as the `coder` assignee for Kanban coding tasks. **Authored via Opus-4-8 high (Ace's instruction).** Config creation is gatekept — show diff, get approval, apply, verify. |
| L8 | `prd-interview` exists | A research-first "grill me" skill (adapted from grill-me) that converges on a concrete problem statement + measurable success criteria and STOPS before drafting. Feeds `prd-authoring`. |
| L9 | `prd-docs` is docs-only | A skill that updates project docs + Obsidian to match reality, explicitly WITHOUT adding tests or build work. It is NOT a slimmed closeout — it skips the test/commit-gate semantics; it's for "the docs drifted, fix them." |
| L10 | `/handoff` is a slash command | Compact the current session into a handoff doc in the OS temp dir, referencing existing artifacts by path (not duplicating), with a suggested-skills section, secrets redacted. Distinct from Hermes's own context-compaction. |
| L11 | Measurable requirements | `prd-authoring` bans subjective adjectives ("fast/easy/intuitive") in requirements/acceptance criteria — each must carry a threshold/metric/date (borrowed from awesome-copilot). |
| L2 | Per-step testing in PRDs | `prd-authoring` mandates each phase carry: ≥1 unit/script check, an e2e/integration check when the phase touches a real boundary, ≥1 negative/adversarial case for trust boundaries, and a named verification command. (Mirrors swarm §2.6 so they compose.) |
| L3 | Evals vs tests | Distinguish **tests** (pass/fail correctness) from **evals** (quality/behavior measurement, e.g. accuracy %, latency, regression deltas). PRDs for ML/heuristic/model work must specify evals, not just tests. |
| L4 | Closeout scope | tests-green + project docs current + Obsidian overview exists/current + committed/pushed + memory/mem0 updated. A checklist with verification, not vibes. |
| L5 | Closeout is evidence-backed | Each closeout item requires real proof (test output, file exists, git log), echoing Ace's "prove it" standard. No item is checked on assertion. |
| L6 | Swarm patch | Strengthen §2.6 to REQUIRE a real end-to-end test (not just "integration check when…") when the integrated output exercises a new or changed real path, and make the senior e2e/eval review an explicit named gate in the output contract. |
| L7 | Composition | `prd-authoring` output → feeds `prd-review-pipeline` → feeds `prd-swarm-planner` → ends with `prd-closeout`. Each skill names the next in its body. |

---

## 4. Design

### 4.0 NEW skill: `prd-interview`

**Path:** `~/.hermes/skills/software-development/prd-interview/SKILL.md`

**Triggers:** "grill me", "interview me", "ask hard questions", "pressure-test this plan/design", "clarify scope/requirements", "help me figure out what I actually want" — and proactively when a request headed for `prd-authoring` is too vague to spec.

**Behavior (adapted from grill-me, both variants):**
- **Research first.** Never ask for a fact that's discoverable by reading the codebase, files, or context — go find it, record it in the Snapshot, move on. Asking discoverable facts is the #1 way to annoy the user.
- **Maintain a running Snapshot:** Facts (discovered) · Decisions (made) · Open Questions (ordered queue).
- **Ask only judgment calls**, one branch of the decision tree at a time, resolving dependencies in order. **Batch 2–3 independent questions per turn; use 1 only when a dependency forces sequence.** For each question, **provide a recommended answer** (this is the grill-me signature — don't just interrogate, advise).
- **Force concreteness:** if an answer is vague ("faster", "soon", "better"), re-ask the same question (same id) demanding a metric/date/scope boundary.
- **Priority order:** objective → constraints → non-goals → trade-offs → acceptance signal.
- **Stop before implementation.** Exit when the Snapshot has a one-line problem statement, measurable success criteria, and no blocking open questions. Output a clarification summary.
- **Termination guarantees (RC2 — never grill forever):** (a) a user early-exit always works — "good enough, draft it" / "stop, that's enough" immediately ends the interview and emits the Snapshot-as-is; (b) a **round cap** (default ~5 question-batches) after which the skill stops on its own, emits the Snapshot with any unresolved questions explicitly flagged as gaps, and hands to `prd-authoring` (which records them as Open Questions). Force-concreteness re-asks count toward the cap so a vague answerer can't trap the loop. The worse failure is an interview that never terminates — these two hatches prevent it.

**Handoff:** the summary feeds `prd-authoring` ("now author the PRD from this Snapshot"). The skill names that next step. Use the native question/clarify tool when available; else render a numbered fallback block.

**Why a skill, not just "ask questions":** it encodes the *discipline* (research-first, judgment-calls-only, recommend-an-answer, force-concreteness) that turns a vague ask into a specable problem — and prevents the agent from either under-asking (and guessing wrong) or over-asking (discoverable facts).

### 4.1 NEW skill: `prd-authoring`

**Path:** `~/.hermes/skills/software-development/prd-authoring/SKILL.md`

**Triggers:** "write a PRD", "spec this out", "draft a spec/proposal for X", "turn this into a PRD" — and proactively when Apollo is about to hand-write a spec headed for review/build.

**What it enforces (the core value):** a PRD template where **testing + evals are first-class per phase**, not an afterthought. Sections:

- Summary & Goal, Non-Goals, Resolved Decisions (the shape we already use)
- Architecture, Detailed Design
- **Implementation Phases — each phase MUST carry an explicit `Verification` block:**
  - `Unit/script check:` the narrow test that can fail fast
  - `E2E/integration check:` real end-to-end when the phase touches a boundary (network, persistence, GPU, third-party process, routing) — exercised with a real input, not a mock
  - `Negative/adversarial:` ≥1 for any trust/security/isolation boundary
  - `Evals (if ML/heuristic):` quality metric + target (accuracy %, latency budget, regression delta) — distinct from pass/fail tests
  - `Verify with:` the exact command + expected result
- Security & Privacy, Observability/Ops, Risks, Open Questions
- **Acceptance Criteria** — every criterion objectively checkable, each tracing to a phase's verification
- A closing pointer: "Run this through `prd-review-pipeline` (N passes), plan with `prd-swarm-planner`, finish with `prd-closeout`."

**Measurable requirements (L11, from awesome-copilot):** the skill bans subjective adjectives in requirements/acceptance criteria. "Fast" → "p95 < 200ms for a 10k-row set." "Accurate" → "≥ 95% citation match on the 50-question benchmark." "Easy" → a named, checkable behavior. The skill carries the BAD→GOOD diff as an example so the model internalizes the standard. Upstream of authoring, recommend `prd-interview` when the request is vague: "if the problem/success criteria aren't concrete yet, run `prd-interview` first."

**Bundled:** `references/prd-template.md` (the canonical fill-in template) + `references/testing-vs-evals.md` (when each phase needs unit vs e2e vs eval, with examples).

**Why a skill, not just a template:** it encodes *judgment* — which phases need e2e vs just unit, when evals (not tests) are the right tool, how to size adversarial cases — plus the composition handoffs. A bare template gets filled in mechanically and the testing rigor degrades.

**Seam with `writing-plans` (RC3 — must be one explicit sentence in BOTH skill bodies):** `prd-authoring` owns **the spec document + per-phase verification *intent*** ("this phase must be proven by an e2e run of X"). `writing-plans` owns **breaking an approved phase into bite-sized TDD implementation steps**. So: author the PRD with `prd-authoring`; once approved, if a phase needs a granular task breakdown, `writing-plans` expands it. They are sequential, not competing — `prd-authoring`'s body says "for step-level TDD breakdown, hand the approved phase to `writing-plans`," and `writing-plans` says "if you don't have an authored PRD yet, start with `prd-authoring`." This one-sentence seam in each prevents a model facing "spec and plan this" from triggering both and producing two overlapping breakdowns.

### 4.2 PATCH: `prd-swarm-planner`

Targeted edits (it already has a strong §2.6 eval bar — keep the diff surgical so the *next* spec's reviewer can see exactly what changed):

1. **§2.6 — one surgical delta:** the existing conditional "integration/e2e check **when** the task changes routing/persistence/third-party-process/isolation/health/rollout" becomes **unconditional for any swarm whose integrated output exercises a new or changed real path** (a runnable user-facing surface). The trigger is "new/changed real path exercised," NOT "the repo happens to be runnable" — a pure-refactor or doc-only swarm with no new real surface still falls under the existing "when boundary" clause (no conflict with §1.2). §2.8 (mock-trap) is unchanged and NOT re-asserted here — this edit only promotes e2e from conditional to mandatory for the new-real-path case.
2. **§5 Senior Review / Output contract:** add a named **"E2E + eval gate"** to the review plan — before APPROVE the reviewer must confirm (a) a real end-to-end run passed *with evidence* (actual run output), and (b) for ML/heuristic work, the eval metric hit its stated target. Add to the "Output" list: "6. E2E/eval evidence (real run output, not asserted)."
3. **Add a short §6 "Handoff to closeout":** when the swarm's work is integrated + reviewed + green, the next step is `prd-closeout` — name it so the lifecycle exit-gate is explicit.

### 4.3 NEW skill: `prd-closeout`

**Path:** `~/.hermes/skills/software-development/prd-closeout/SKILL.md`

**Triggers:** "close out", "wrap up", "finalize the project/PRD", "we're done — finish it properly", and proactively when a build's acceptance criteria are met and the next action is "ship/finish."

**The closeout checklist (each item evidence-backed):**

| # | Item | Evidence required |
|---|---|---|
| 1 | E2E tests exist & pass when the integrated output exercises a new/changed real path; otherwise mark inapplicable with a one-line reason | real test-run output (e.g. `pytest -v` → N passed); not "tests look fine" |
| 2 | Acceptance criteria met | each PRD criterion checked against reality |
| 3 | Project docs current | `AGENTS.md` / `README` reflect the built system; test README exists |
| 4 | Obsidian overview exists & current | a vault doc covering the system, linked appropriately; created/updated this closeout |
| 5 | Committed & pushed | `git log`/`git status` clean; pushed to remote (per home git policy) |
| 6 | Memory/mem0 updated | durable cross-session facts published (mem0_conclude) + memory pointer if warranted |
| 7 | Cron/alerts wired (if applicable) | scheduled jobs verified via scheduler, failure alerts routed |
| 8 | Loose ends named | any deferred items explicitly listed (not silently dropped) |

**Output:** a closeout report (the checklist with evidence per item) + a one-line status. Bundled `references/closeout-checklist.md` (the full checklist with "how to verify each" commands).

**Failure semantics (RC4 — this is what stops it being a rubber-stamp):** an item with **no evidence is FAIL**, not "N/A" — closeout is BLOCKED until it's resolved or the gap is explicitly accepted by Ace. The `(if applicable)` items (cron/alerts row 7) are NOT a skip-hatch: if marked inapplicable, the report must state *why* in one line (e.g. "no scheduled component in this project"), never silently dropped. A closeout report with hand-waved or missing-evidence items is an incomplete closeout, full stop.

**Why a skill:** it makes "done" mean the same thing every time and prevents the exact gaps we just hit (built but untested/undocumented). It's the dual of the review gate — review guards the *entry* to build, closeout guards the *exit*.

### 4.4 NEW skill: `prd-docs`

**Path:** `~/.hermes/skills/software-development/prd-docs/SKILL.md`

**Triggers:** "update the docs", "document this", "the docs are out of date", "refresh the project docs / Obsidian", "write up what we built" — when the ask is *documentation only*, not a full finish.

**What it does:** brings project docs (`AGENTS.md`, `README`, in-repo docs) and the Obsidian overview into agreement with the current reality of the system — and nothing else. It does **not** add tests, does **not** gate on a green suite, does **not** run the closeout commit/memory ritual. It's the lightweight tool for "the code/system moved on and the docs drifted."

**Steps:** (1) identify what changed vs what the docs say; (2) update project docs to match; (3) update/create the Obsidian overview doc and link it; (4) report what was updated. Commit is offered but not a gate (docs-only changes can be committed by the caller or folded into the next commit).

**Boundary with `prd-closeout` (this is the whole reason it's separate, per L9):** `prd-closeout` is the full exit-gate (tests + docs + commit + memory, evidence-required, can BLOCK). `prd-docs` is *just the docs slice*, no gating, no test/commit requirement. **Single source of truth for docs mechanics (RC1):** `prd-docs` OWNS the documentation procedure (how to reconcile project docs + Obsidian + linking + the Obsidian Portability Rule). `prd-closeout`'s checklist items 3–4 (project docs current / Obsidian overview current) **invoke `prd-docs`'s procedure** rather than re-encoding it — so the doc-update logic lives in exactly one place and can't drift between the two skills. Each names the other in one sentence: `prd-docs` says "if you're finishing a whole build, use `prd-closeout` instead — it includes docs plus tests/commit/memory"; `prd-closeout` says "for the docs slice I run `prd-docs`'s procedure; for a docs-only refresh with no build to verify, use `prd-docs` directly."

**Why a skill:** documentation updates have a recurring shape (project docs + Obsidian + linking + portability per the Obsidian Portability Rule) that's worth encoding once; and the explicit "no testing/gating" scope is what Ace asked for — a doc refresh that doesn't drag in the whole closeout ceremony.

### 4.5 NEW: `/handoff` slash command

**Path:** `~/.hermes/skills/software-development/handoff/` (command def + SKILL.md; invoked as `/handoff [focus]`).

**What it does (adapted from mattpocock/handoff):** compacts the *current* session into a handoff document a fresh agent can pick up from.
- **Writes to the OS temp dir** (e.g. `$TMPDIR`/`/tmp`), NOT the workspace — it's an ephemeral baton, not a project artifact. **Path-discovery + perms (RC3):** the command **prints the absolute path** of the written doc as its return value (that's how the human/next agent finds it — the path travels out-of-band via the user, not inside the doc). Write the file with **restrictive perms (0600)** since `/tmp` is world-readable on shared hosts and a handoff carries internal architecture + in-flight decisions even after redaction.
- **References, does not duplicate:** existing PRDs/plans/reviews/commits/diffs are linked by path/URL, not copy-pasted. The doc captures only the *live session state* not already on disk (current goal, in-flight decisions, what's done, what's next, gotchas hit).
- **"Suggested skills" section:** names the skills the next agent should load (e.g. "load `prd-closeout` to finish; `parakeet-transcribe` for the service").
- **Redaction (RC4 — scope it honestly):** redaction is **belt-and-suspenders, not a solved detection problem**. The primary protection is structural: references-not-duplicates means secrets rarely transit the doc at all (they live in 1Password / `.env`, referenced by name). On the small live-session-state slice, apply the **existing home secret/redaction policy's mechanism** (don't reinvent secret detection in `/handoff`); never paste raw key/token/password values — reference them as `[REDACTED]`/by location. The Phase 3.6 planted-secret test is a smoke check of this, not a proof of exhaustive detection.
- **Optional arg** = what the next session will focus on; tailor the doc to that.

**Why a command, not a skill (per Ace):** handoff is an explicit, user-invoked action ("`/handoff`, I'm switching sessions"), not something that should trigger on phrasing. A slash command is the right surface. Distinct from Hermes's own automatic context-compaction (that's internal; this produces a portable doc for a *different* agent/session).

**Note on Hermes slash-command mechanics:** verify the actual command-registration path in the live build before implementing (per the standing "verify the live system" rule) — if a native command-def surface exists, use it; otherwise implement as a skill whose description triggers tightly on "/handoff" and document the invocation.

### 4.6 PATCH: `prd-swarm-planner` → PRD→Kanban-graph compiler (plan/load/run)

**Live ground truth (verified, Hermes v0.15.1):** the native `hermes kanban` board already does the orchestration we were about to spec from scratch:
- `create` (task; `--assignee` profile, `--workspace scratch|worktree|dir`, `--skill`, `--max-runtime`, `--max-retries`, `--goal`/`--goal-max-turns`, `--parent`, `--triage`)
- `link`/`unlink` (parent→child **dependency** edges → a DAG)
- `claim` (atomic — only returns *ready* tasks whose parents are done; no double-grab)
- `dispatch --max N` (spawn up to N workers this pass; `--failure-limit` auto-blocks flaky tasks)
- `daemon --interval` (continuous dispatch loop — work tasks as they free up)
- `swarm` (built-in fan-out: N parallel workers → verifier → synthesizer)
- `decompose` / `specify` (auto-slice a triage task; flesh out body + acceptance criteria)
- workspace isolation (scratch tmp / git worktree / shared dir), `--max-runtime` SIGTERM+requeue

So `prd-swarm-planner` **stops being an executor** and becomes a **PRD→Kanban task-DAG compiler** with three explicit modes (this is the patch):

1. **`plan`** — read approved PRD → slice into many **small, worker-sized** tasks → write a **swarm-plan file** (the reviewable artifact, schema below) → **STOP**. Does NOT touch the board.
2. **`load`** — ingest a swarm-plan file → populate the native board via `kanban create` + `link` (or `kanban swarm` fast-path per L17). Prints the created task ids. → STOP.
3. **`run`** — `kanban dispatch --max N` (one pass) or `kanban daemon` (continuous). The **native dispatcher** does concurrency, dependency-ordering, claims, retries, isolation, runtime caps. **Within-run review gate (RC1 — how it's actually enforced):** the dispatcher does NOT pause for human approval; it works ready tasks until the DAG drains. The "review gate" is modeled *in the graph* — code tasks `kanban_block(reason="review-required: …")` instead of auto-completing (per the `kanban-worker` skill), and the verifier task gates the synthesizer (`metadata {"gate":"pass"}` or block). So "stop at the gate" = review-required tasks sit blocked for `hermes kanban unblock` + the human reads `kanban list` after the pass. The plan→load→run *transitions* are separately gated on Ace's go (L13); that is distinct from the within-run review gate.

**Cycle safety (RC2 — verified live):** `kanban link` **does reject cycles** — `_would_cycle()` raises "linking X → Y would create a cycle" at link time (verified in `kanban_db.py`). So `load` genuinely refuses to build a deadlocked board, and `prd-swarm-plan-review` catches cycles *earlier* (before any board writes) as defense-in-depth. Two real guards, not one.

Default (no mode) = `plan → prd-swarm-plan-review → load → run`, **each step gated on Ace's go** (matches the "slice it, let me look, then launch with N" model from the planning convo).

**Swarm-plan file schema** (extends the existing `references/swarm-plan-template.md`): per task — `id`, `title`, `body` (full spec + **acceptance-criteria checklist** + **verify command**, per L16), `deps: [ids]`, `assignee` (profile = model routing, per L14), `workspace` (scratch/worktree/dir), `skills: []`, `max_runtime`, `goal: bool`. Plus a top-level `dispatch: {max_concurrency, failure_limit}` and the verifier/synthesizer assignment.

The existing swarm-planner wisdom is **retained, not discarded**: §1.1/1.2 premise-verification gate, §2.6 eval bar (now fed into each task body), §2.7 file-size-vs-budget (now drives slice sizing), §2.8 mock-trap + §2.8.1 senior-diff-review (now the verifier task). The patch reframes "how do I spawn workers" (delete — native) into "how do I compile a PRD into a board DAG" (keep all the slicing judgment).

### 4.7 NEW skill: `prd-swarm-plan-review`

**Path:** `~/.hermes/skills/software-development/prd-swarm-plan-review/SKILL.md`

**Triggers:** "review the swarm plan", "is this plan ready to dispatch", "check the kanban slicing", and proactively between `prd-swarm-planner plan` and `load`.

**What it is (per L15):** a narrow, **mechanical Kanban-viability linter** for a swarm-plan file — NOT a prose critique (that's `prd-review-pipeline`'s job on the PRD upstream). Checks:
- **Slice size:** each task is one worker-sized outcome (§2.7) — not a 5-file mega-task that will time out.
- **Disjoint write scopes:** no two tasks that can run in parallel (no dep edge between them) write the same file → prevents the integration smashes §2.8 warns about.
- **DAG is acyclic:** the `deps` graph has no cycle (no deadlock). Mechanically checkable (topological sort succeeds).
- **Acceptance criteria present:** every task body has a concrete, verifiable checklist + a `verify` command (L16) — no "make it work" tasks.
- **Routing sanity:** coding tasks → a coding profile (Daedalus); review/verify → an Opus profile; assignees exist on disk. **Pending-profile degrade (Pass-2 RC4):** the "assignee exists on disk" check is a **WARNING (not FIX-THESE/block) when the assignee is a known-pending fleet profile** (e.g. `daedalus` before its Phase 2.6 provisioning), and **hardens to a blocking check once that profile is provisioned**. This prevents the bootstrap ordering bug where plan-review (Phase 2.5) runs before Daedalus exists (Phase 2.6).
- **Shape:** there's a verifier + synthesizer (or a documented reason there isn't).
- **Output:** PASS / FIX-THESE list with the specific offending task ids. FIX-THESE blocks `load`.

**Why separate from `prd-review-pipeline`:** different artifact (a structured DAG file vs a prose spec), different failure modes (deadlock/write-collision/oversized-slice vs vague-requirements/missing-risk), different check (a linter vs an adversarial reviewer). Sequential, not redundant: review the PRD → compile to plan → **lint the plan** → load.

### 4.8 NEW agent: `Daedalus` (GPT-5.5 xhigh coding specialist)

**What:** a new Hermes **profile** that serves as the dedicated **`coder` assignee** for Kanban coding tasks (L14/L19). Cloned from Apollo's config EXCEPT:
- **Model:** `openai-codex/gpt-5.5`, reasoning effort **`xhigh`** (Ace's spec).
- **Own gateway identity:** its OWN Discord/Telegram bot tokens (or none) — **NOT** Apollo's. Distinct profile dir `~/.hermes/profiles/daedalus/`.
- **`dispatch_in_gateway: false`** (Apollo's `default` gateway owns the single dispatcher, per the multi-gateway doc) — Daedalus is a worker identity, not a second dispatcher.
- **A coding-specialist SOUL** (authored fresh — see below).

**Authoring method (Ace's instruction):** the Daedalus SOUL/AGENTS content is **authored via Opus-4-8 on `high` reasoning**, synthesizing the research below + Apollo's coding-policy sections + best-practice agent files.

**Research-backed SOUL design (sources: ETH Zurich AGENTS.md study, Raschka "Components of a Coding Agent", OpenAI GPT-5.5 guidance, Verdent GPT-5.5 coding guide, r/codex reasoning-level findings):**
- **GPT-5.5 is built for messy, long-horizon, multi-file agentic coding** with internal self-verification and tool-error recovery — lean into autonomy ("give it a messy multi-part task and trust it to plan, use tools, check its work"). `xhigh` produced the best review/equivalence scores in independent testing (more expensive, worth it for hard tasks; the Kanban `--max-runtime`/`--max-retries` bound the cost). **Model route verified resolvable today:** `openai-codex/gpt-5.5` is already a configured provider/model in Apollo's config (not aspirational), so Daedalus's model resolves.
- **Cost routing (RC5 — make it a real check, not an assertion):** "route only hard tasks to xhigh" is enforced by a **`prd-swarm-plan-review` lint**: flag any task assigned to `daedalus` (xhigh) whose body looks trivial (e.g. a one-line/doc/config change) and suggest a cheaper profile. v1 honestly accepts "most coding → Daedalus xhigh"; the *only* hard cost bounds are `--max-runtime` × `dispatch --max N` (parallel burn) — there is **no aggregate ceiling** across a many-task PRD, so a big all-xhigh PRD is unbounded in total. Accepted for v1; a task-count sanity flag in plan-review is the mitigation if it bites.
- **Caveat to encode:** GPT-5.5 is strong but **not best at every benchmark** (Opus 4.7 leads SWE-Bench Pro) and **Artificial Analysis flagged notable hallucination** — so the SOUL must hard-enforce *verify-before-claim* and *instrument-before-fix* (Apollo already has these; inherit them).
- **AGENTS.md discipline (ETH study):** human-curated, **non-inferable** content only — exact build/test/lint commands with flags, counterintuitive conventions, hard constraints (never touch `vendor/`, which package manager). **Skip architecture overviews** (agents find those independently; they add cost, not accuracy). Structure for machine parsing, not prose. **Worker-context caveat (Pass-1 Q5):** the ETH "agents find architecture independently" finding assumes a full repo + a real session. A Kanban worker has *minutes* and possibly a *worktree/scratch* slice, not session continuity — so for Daedalus, the **task body** must carry the non-inferable per-task context (which files, the acceptance criteria, the verify command), since the worker can't always go discover it. This is exactly why `prd-swarm-planner` puts a full spec in each task body (L16).
- **Harness > model (Raschka):** Daedalus's strength is the *harness* — live repo context, cached stable prompt prefix, structured/validated tools, bounded subagents, transcript/memory. It inherits Apollo's harness; the SOUL tunes behavior, not plumbing.
- **Coding-loop rigor (inherit + sharpen Apollo's):** smallest viable diff; reproduce/instrument before fixing; narrow verification first; no unrelated refactors; every changed line traces to the task; tests before "done"; honest blocker-reporting over fabricated success.

**SOUL skeleton (final text written by Opus-4-8 high at build):** Identity (Daedalus, the fleet's coding specialist; Kanban worker, not user-facing) · Core coding truths (autonomy + verify-before-claim + smallest-diff + boil-the-ocean-but-scoped) · GPT-5.5 operating notes (use xhigh's planning; recover from tool errors; guard against hallucination via empirical checks) · Kanban-worker lifecycle (orient→work→heartbeat→block/complete; review-required for code) · Git discipline · Safety/secrets (inherit Apollo's). Voice: terse, technical, deadpan — but it's a worker, so its "voice" mostly lands in commit messages + task handoffs, not chat.

**Config gatekeeping (Hard Config Rules):** creating the profile = a config mutation. Build step shows Ace the exact profile `config.yaml` diff + token plan, gets explicit approval, applies, verifies (`hermes -p daedalus doctor`), reports. Tokens → 1Password Engineering vault, never inline. **Token-absence, not shadowing (Pass-1):** cloning "from Apollo's config EXCEPT" risks *inheriting* Apollo's gateway-token references. The diff review must show Apollo's telegram/discord tokens are **removed/nulled** in Daedalus's config, not merely overridden — and Phase 2.6's negative test asserts Daedalus's config does NOT resolve Apollo's 1Password token entries. Also assert the *behavior* not just the flag: confirm a second profile cannot double-dispatch (not just that `dispatch_in_gateway: false` is set).

---

## 5. Implementation Phases

Each phase ends with verification, then commit. (These skills are docs, so "tests" = structural validation + a real dogfood run.)

- **Phase 0 — `prd-interview` skill.** Write SKILL.md (research-first loop, Snapshot, batched judgment-call questions, recommend-an-answer, force-concreteness, stop-before-implementation; names `prd-authoring` as next).
  - *Unit:* `skill_view(name='prd-interview')` loads; frontmatter valid.
  - *E2E/dogfood:* run a short interview on a deliberately-vague ask and confirm it (a) researched discoverable facts instead of asking, (b) asked only judgment calls with recommended answers, (c) exited with a problem statement + measurable success criteria. **Also dogfood an evasive/vague answerer** to confirm the round-cap fires and emits Snapshot-with-flagged-gaps (exercises RC2, not just the happy-path exit).
  - *Verify with:* skill loads + a sample interview transcript shows the four behaviors.
- **Phase 1 — `prd-authoring` skill.** Write SKILL.md + `references/prd-template.md` + `references/testing-vs-evals.md`. Include the measurable-requirements BAD→GOOD diff (L11) and the "run `prd-interview` first if vague" pointer.
  - *Unit/script check:* `skill_view(name='prd-authoring')` loads; frontmatter valid.
  - *E2E check:* **dogfood** — regenerate the *structure* (skeleton, not a rewrite of design content) of an existing good PRD (e.g. parakeet-transcribe) from the template; confirm every phase has a Verification block and no subjective-adjective requirements.
  - *Verify with:* skill loads + a sample PRD authored from it has per-phase verification on every phase.
- **Phase 2 — patch `prd-swarm-planner` → plan/load/run compiler (§4.6).** Reframe the skill: add explicit `plan`/`load`/`run` modes; PLAN writes the swarm-plan file (extend `references/swarm-plan-template.md` with the §4.6 schema); LOAD emits `kanban create`+`link` (swarm fast-path per L17); RUN calls `kanban dispatch --max N`/`daemon`. Retain §1.1/1.2/2.6/2.7/2.8 wisdom (fed into task bodies + the verifier task). Name `prd-swarm-plan-review` (pre-load) and `prd-closeout` (post-run).
  - *Unit:* skill loads; grep for `plan`/`load`/`run` mode language + the schema.
  - *E2E/dogfood (real, on the live board):* take a tiny throwaway PRD → `plan` → swarm-plan file written; `load` → `hermes kanban create/link` actually creates the tasks on a scratch board (verify with `hermes kanban list`); `run --dry-run` (`kanban dispatch --dry-run`) shows the right spawn plan **without** spawning. Tear down the scratch board after.
  - *Negative:* a plan with a dependency cycle is rejected at load (or by plan-review) — never creates a deadlocked board.
  - *Verify with:* `hermes kanban list` showing the created DAG + a clean `dispatch --dry-run`.
- **Phase 2.5 — `prd-swarm-plan-review` skill (§4.7).** Write SKILL.md: the Kanban-viability linter (slice size, disjoint write scopes, acyclic DAG, acceptance-criteria-in-body, routing sanity, verifier/synthesizer shape).
  - *Unit:* skill loads; frontmatter valid.
  - *E2E/dogfood:* run it on a **good** swarm-plan (PASS) and a **deliberately-broken** one (write-scope collision + a dependency cycle) → confirm it emits FIX-THESE with the exact offending task ids and blocks load.
  - *Verify with:* both review reports (PASS + FIX-THESE); the cycle/collision are caught.
- **Phase 2.6 — `Daedalus` agent profile (§4.8).** **CONFIG-GATEKEPT.** (1) Author the Daedalus SOUL via **Opus-4-8 high** from the §4.8 research. (2) Prepare the profile `config.yaml` diff (model `openai-codex/gpt-5.5` xhigh, own/no gateway tokens, `dispatch_in_gateway: false`) + token plan. (3) **Show Ace the exact diff + token plan, get explicit approval.** (4) Apply, store tokens in 1Password, verify `hermes -p daedalus doctor`, report.
  - *Unit:* `hermes -p daedalus doctor` passes; profile resolves model = gpt-5.5 xhigh.
  - *E2E/dogfood:* create one trivial Kanban coding task `--assignee daedalus`, `dispatch --max 1`, confirm the worker spawns **as Daedalus on gpt-5.5**, does the task in isolation, and hands back via `kanban_complete`/review-required. Confirm it used Daedalus's identity, not Apollo's.
  - *Negative:* confirm Daedalus does NOT own the dispatcher (`dispatch_in_gateway: false`) and does NOT use Apollo's telegram/discord tokens.
  - *Verify with:* doctor output + the completed task's event log showing the Daedalus worker.
- **Phase 3 — `prd-closeout` skill.** Write SKILL.md + `references/closeout-checklist.md`.
  - *Unit:* skill loads; frontmatter valid.
  - *E2E check:* **dogfood — run the closeout on parakeet-transcribe itself.** parakeet's 11-test e2e suite **already exists and passes** (written before this PRD), so this dogfood cleanly proves *closeout* in isolation — it verifies tests green (✓ 11), Obsidian doc exists (✓), committed/pushed (✓), mem0 updated (✓) — it is NOT also a test-authoring task. Produce the closeout report with evidence per item.
  - *Verify with:* a real closeout report for parakeet with evidence per item, and a FAIL correctly raised if any item lacked evidence.
- **Phase 3.5 — `prd-docs` skill.** Write SKILL.md (docs-only scope, project-docs + Obsidian, no test/commit gating; names `prd-closeout` as the heavier alternative).
  - *Unit:* skill loads; frontmatter valid.
  - *E2E/dogfood:* run `prd-docs` on a small real doc-drift (e.g. confirm/refresh the parakeet Obsidian overview) and confirm it updated docs WITHOUT running tests or gating on a suite.
  - *Negative:* confirm `prd-docs` does NOT claim closeout semantics (no FAIL-gate on missing tests). **Combined-phrasing case (Pass-1 Triggering):** dogfood "we built X, document and wrap it up" — confirm it **deterministically** resolves to `prd-closeout` (the superset that includes the gate), NOT `prd-docs` (the subset that would skip it); the neighbor-naming self-correct must make closeout win reliably, not by luck.
  - *Verify with:* skill loads + a docs-only update report; grep both skills for the cross-pointer.
- **Phase 3.6 — `/handoff` slash command.** First **verify the live Hermes command-registration mechanism** (grep the running build / docs); then implement accordingly (native command-def if it exists, else tightly-triggered skill). Writes handoff doc to OS temp dir, references-not-duplicates, suggested-skills, redaction.
  - *Unit:* command/skill registers and is invocable as `/handoff`.
  - *E2E/dogfood:* run `/handoff "resume Siftly Phase 0"` and confirm it produced a temp-dir doc that references existing artifacts by path, has a suggested-skills section, and contains no secrets.
  - *Negative:* confirm the doc is in the temp dir, NOT the workspace, and that a planted fake secret would be redacted.
  - *Verify with:* the generated handoff doc + a redaction check.
- **Phase 4 — cross-link + Obsidian overview.** Each skill names the next/adjacent in the lifecycle; update any index. Patch `writing-plans/SKILL.md` to add the upstream seam sentence: "If you do not have an authored PRD yet, start with `prd-authoring`; `writing-plans` expands an approved PRD phase into bite-sized TDD implementation steps." This completes the two-way seam from §4.1.
  - **Authored deliverable — Obsidian overview doc** (Ace explicitly requested this): create **`AI/PRD Skills & Kanban Orchestration — System Overview.html`** in the vault (`/Users/alexgierczyk/Obsidian/Ace Place/`), dark-mode HTML matching the house style of the existing `Ace X Knowledge Base — System Overview.html` and `Parakeet Transcription — Fleet Architecture.html`. It MUST cover, for a future-me/Ace reader who has never seen this system:
    1. **What & why** — the PRD lifecycle suite exists to take an idea → reviewed spec → parallel build → verified close-out, repeatably, without re-deriving the workflow each time.
    2. **The eight artifacts** — one row each (`prd-interview`, `prd-authoring`, `prd-docs`, `prd-swarm-planner`, `prd-swarm-plan-review`, `prd-closeout`, `/handoff`, `Daedalus`): what it does, when it fires, what it hands to next.
    3. **The lifecycle diagram** — interview → author → (review) → plan → plan-review → load → run → closeout; with `prd-docs` and `/handoff` as cross-cutting tools.
    4. **Kanban orchestration** — plain-language explainer: native Hermes Kanban owns the board/DAG/scheduling (`create`/`link`/`dispatch`/`daemon`/`claim`/retries/isolation); `prd-swarm-planner` is a **PRD→DAG compiler**, not a re-implemented executor (cite the L12 "wire don't rebuild" decision). Explain DAG, leaf→verifier→synthesizer shape, and per-task isolation in one paragraph each.
    5. **Model routing** — profile = model axis (no `--model` flag, verified `config.py`); `default`→Opus drives review/dispatch, **Daedalus**→gpt-5.5 xhigh runs coding tasks (`--assignee daedalus`); `dispatch_in_gateway: false` on all non-Apollo profiles so only one dispatcher touches the board.
    6. **How to use it** — the 3 common entry points: "I have a vague idea" (`prd-interview`), "I have an approved PRD, build it in parallel" (`prd-swarm-planner` plan→review→load→run), "we're done" (`prd-closeout`).
    7. **Pointers** — link the PRD (`~/Projects/siftly-ace/docs/plans/PRD-prd-lifecycle-skill-suite.md`), the skills dir, the multi-gateway doc, and the Daedalus SOUL once authored. Per the Obsidian Portability Rule, this overview is the canonical human-readable home; skills stay the source of mechanics.
  - *Build via `prd-docs`* (dogfoods the docs skill on this very suite) once the skills exist; until then it's an authored HTML doc.
  - *Verify with:* grep each skill for the handoff pointer to its neighbor(s), grep `writing-plans` for the upstream seam sentence, and confirm the Obsidian overview file exists, renders, names all eight artifacts, and links the PRD + skills dir.

**Build approach:** these are skill-authoring tasks (judgment-heavy prose, not parallelizable code) → **author directly**, not via swarm. (Per swarm §1.2: don't dispatch workers when there's no parallel code to slice.)

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `prd-authoring` overlaps/conflicts with `writing-plans` | confusion about which to use | Clear scoping: `prd-authoring` = the spec doc + testing scaffold; `writing-plans` = task breakdown for implementation. Each names the other. |
| Skills become over-prescriptive (heavy MUSTs) | model follows rotely, degrades | Per skill-creator guidance: explain the *why*, not rigid MUSTs. Frame testing rigor as "so we don't ship built-but-broken," with the parakeet example. |
| Closeout becomes a rubber-stamp checklist | gaps slip through anyway | L5: every item requires real evidence (test output, file path, git log) — no assertion-only checks. |
| Triggering: `prd-closeout` under-fires (skills under-trigger) | closeout skipped | "Pushy" description per skill-creator; proactive-trigger language ("when acceptance criteria met and next action is finish"). |
| Swarm patch breaks existing structure | a working skill regresses | Phase 2 negative check; targeted edits only, verify sections intact. |
| `prd-interview` over-asks (asks discoverable facts) — the grill-me failure mode | annoys user, wastes turns | Research-first is the #1 rule; "never ask what you can read." Dogfood checks it researched before asking. |
| `prd-docs` mistaken for a closeout shortcut | gaps slip the real gate | L9 explicit boundary + cross-pointer; `prd-docs` states it is docs-only and points to `prd-closeout` for finishing a build. |
| `/handoff` writes to workspace / leaks secrets | repo clutter, secret exposure | Hard rule: temp dir only, references-not-duplicates, redaction; Phase 3.6 negative test plants a fake secret + checks location. |
| Five new triggering surfaces collide (interview vs authoring vs docs vs closeout) | wrong skill fires | Distinct trigger phrasings + the lifecycle diagram; each skill names its neighbor so a mis-fire self-corrects to the right one. |
| Rebuilding what native Kanban already does | wasted effort, divergent/buggy executor | L12: verified the native board does dispatch/deps/claims/retries/isolation. `prd-swarm-planner` only *compiles* a PRD→DAG and *loads* it; native runs it. |
| Oversized/colliding slices deadlock or smash at integration | failed dispatch, lost work | `prd-swarm-plan-review` lints slice size + disjoint write scopes + acyclic DAG before load; native `--max-runtime`/`--failure-limit` bound the blast radius. |
| Daedalus gpt-5.5 xhigh cost runs away | expensive | Per-task `--max-runtime` + `--max-retries`; xhigh reserved for genuinely hard coding tasks (route simple ones to a cheaper profile); Kanban dispatch `--max N` caps concurrency. |
| Daedalus hallucination (Artificial Analysis flag) | confident-wrong code | SOUL hard-enforces verify-before-claim + instrument-before-fix + tests-before-done (inherited from Apollo); the verifier task + review-required gate catch it before merge. |
| Daedalus mis-provisioned (uses Apollo's tokens / owns dispatcher) | identity bleed, double-dispatcher DB contention | Config-gatekept build: own/no tokens, `dispatch_in_gateway: false`, Phase 2.6 negative test asserts both. |
| Two dispatchers on one board | SQLite WAL contention | Only Apollo's `default` gateway dispatches; Daedalus and all other profiles set `dispatch_in_gateway: false` (multi-gateway doc). |

---

## 7. Open Questions

1. Should `prd-authoring` and `writing-plans` eventually merge? (Lean no — different jobs; revisit if overlap causes confusion in practice.)
2. Should closeout *auto-run* the description-optimizer (skill-creator) for new skills? (Lean: mention it as optional, don't mandate — not every closeout is a skill.)
3. Does `prd-closeout` need a machine-readable report (JSON) for any downstream consumer, or is the markdown report enough? (Lean markdown for v1.)

## 8. Acceptance Criteria

- [ ] `prd-interview` skill loads; dogfood shows research-first, judgment-calls-only (with recommended answers), force-concreteness, and a stop-with-success-criteria exit.
- [ ] `prd-authoring` skill loads; produces a PRD where **every phase has a Verification block** (unit + e2e-when-boundary + negative-for-trust + evals-if-ML + verify-command), and **bans subjective-adjective requirements** (L11).
- [ ] `prd-authoring` includes the template + testing-vs-evals reference, and points to `prd-interview` when the ask is vague.
- [ ] `prd-swarm-planner` reframed to **plan/load/run** modes: PLAN writes a swarm-plan file and stops; LOAD creates the DAG on the native board via `kanban create`+`link` (proven with `hermes kanban list`); RUN uses `kanban dispatch/daemon`. Retains §1.1/1.2/2.6/2.7/2.8 wisdom.
- [ ] `prd-swarm-plan-review` skill loads; catches a write-scope collision AND a dependency cycle in a broken plan (FIX-THESE with task ids) and PASSes a good one.
- [ ] `Daedalus` profile created (config-gatekept, Ace-approved diff): `hermes -p daedalus doctor` passes; model = gpt-5.5 xhigh; own/no gateway tokens (not Apollo's); `dispatch_in_gateway: false`. SOUL authored via Opus-4-8 high.
- [ ] Daedalus dogfood: a trivial Kanban coding task assigned to `daedalus` is dispatched, runs as Daedalus on gpt-5.5 in isolation, and hands back via `kanban_complete`/review-required.
- [ ] `prd-closeout` skill loads; its checklist requires **evidence per item**.
- [ ] `prd-closeout` dogfooded: a real closeout report produced for parakeet-transcribe with evidence (tests 11-green, Obsidian doc, commits, mem0).
- [ ] `prd-docs` skill loads; docs-only scope verified (updates docs WITHOUT running/gating tests); cross-pointer to `prd-closeout` present in both.
- [ ] `/handoff` is invocable; dogfood produces a temp-dir handoff doc that references artifacts by path, has a suggested-skills section, lives outside the workspace, and redacts secrets.
- [ ] All skills cross-link the lifecycle (interview → author → review → plan → plan-review → load → run → closeout; prd-docs and /handoff cross-referenced).
- [ ] `writing-plans` carries the upstream seam sentence pointing to `prd-authoring`.
- [ ] Obsidian overview doc **`AI/PRD Skills & Kanban Orchestration — System Overview.html`** exists, renders in dark mode, and covers all seven required sections (what/why, the eight artifacts, lifecycle diagram, Kanban orchestration explainer, model routing, how-to-use, pointers); names all eight artifacts and links the PRD + skills dir + multi-gateway doc.
