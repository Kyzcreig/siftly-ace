# PRD — PRD Lifecycle Skill Suite (authoring · swarm evals · closeout)

**Version:** v3 (Pass-2 APPROVE WITH CHANGES applied: boundary language aligned, writing-plans seam scheduled, closeout e2e applicability fixed)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo
**Type:** Three coordinated changes to the `software-development` PRD skill family
**Status:** DRAFT — pending 2-pass PRD review

---

## 1. Summary & Goal

Close the gaps in our PRD lifecycle so every spec is born testable and dies documented. Three coordinated changes:

1. **NEW skill `prd-authoring`** — writes a good PRD that *always* bakes in thorough testing + evals **per step/phase**, in a shape that drops cleanly into `prd-swarm-planner`.
2. **PATCH `prd-swarm-planner`** — make thorough **e2e testing + evals a hard, explicit part of the review/integration gates** (it has a §2.6 eval bar; strengthen it to require real end-to-end + a named reviewer gate, not just unit checks).
3. **NEW skill `prd-closeout`** — the standard "we're done" ritual: verify e2e tests pass, confirm project docs + Obsidian overview exist and are current, commit/push, update memory/mem0.

**Why now:** We just hit all three gaps live. parakeet-transcribe was "fully built" but had no test suite, no Obsidian overview, and no closeout ritual until Ace asked. The fix is to encode the lifecycle so it's automatic, not prompted.

**The lifecycle these three complete:**
```
author (prd-authoring: testable PRD)
  → review (prd-review-pipeline: N passes = review+fix)
    → plan/build (prd-swarm-planner: e2e evals enforced)
      → close out (prd-closeout: tests green + docs + Obsidian + commit + memory)
```

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
| L1 | Three artifacts | 1 patch (`prd-swarm-planner`), 2 new skills (`prd-authoring`, `prd-closeout`), all under `software-development/`. |
| L2 | Per-step testing in PRDs | `prd-authoring` mandates each phase carry: ≥1 unit/script check, an e2e/integration check when the phase touches a real boundary, ≥1 negative/adversarial case for trust boundaries, and a named verification command. (Mirrors swarm §2.6 so they compose.) |
| L3 | Evals vs tests | Distinguish **tests** (pass/fail correctness) from **evals** (quality/behavior measurement, e.g. accuracy %, latency, regression deltas). PRDs for ML/heuristic/model work must specify evals, not just tests. |
| L4 | Closeout scope | tests-green + project docs current + Obsidian overview exists/current + committed/pushed + memory/mem0 updated. A checklist with verification, not vibes. |
| L5 | Closeout is evidence-backed | Each closeout item requires real proof (test output, file exists, git log), echoing Ace's "prove it" standard. No item is checked on assertion. |
| L6 | Swarm patch | Strengthen §2.6 to REQUIRE a real end-to-end test (not just "integration check when…") when the integrated output exercises a new or changed real path, and make the senior e2e/eval review an explicit named gate in the output contract. |
| L7 | Composition | `prd-authoring` output → feeds `prd-review-pipeline` → feeds `prd-swarm-planner` → ends with `prd-closeout`. Each skill names the next in its body. |

---

## 4. Design

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

---

## 5. Implementation Phases

Each phase ends with verification, then commit. (These skills are docs, so "tests" = structural validation + a real dogfood run.)

- **Phase 1 — `prd-authoring` skill.** Write SKILL.md + `references/prd-template.md` + `references/testing-vs-evals.md`.
  - *Unit/script check:* `skill_view(name='prd-authoring')` loads; frontmatter valid.
  - *E2E check:* **dogfood** — regenerate the *structure* of an existing good PRD (e.g. parakeet) from the template; confirm every phase has a Verification block.
  - *Verify with:* skill loads + a sample PRD authored from it has per-phase verification on every phase.
- **Phase 2 — patch `prd-swarm-planner`.** Apply the 3 edits (§2.6, §5/output, §6 handoff).
  - *Unit:* skill still loads; edits present (grep for the new gate language).
  - *Negative:* confirm the patch didn't break the existing §2.6/§2.8 structure (skill renders, sections intact).
  - *Verify with:* `skill_view` + grep for "E2E + eval gate" and "prd-closeout".
- **Phase 3 — `prd-closeout` skill.** Write SKILL.md + `references/closeout-checklist.md`.
  - *Unit:* skill loads; frontmatter valid.
  - *E2E check:* **dogfood — run the closeout on parakeet-transcribe itself.** parakeet's 11-test e2e suite **already exists and passes** (written before this PRD), so this dogfood cleanly proves *closeout* in isolation — it verifies tests green (✓ 11), Obsidian doc exists (✓), committed/pushed (✓), mem0 updated (✓) — it is NOT also a test-authoring task. Produce the closeout report with evidence per item.
  - *Verify with:* a real closeout report for parakeet with evidence per item, and a FAIL correctly raised if any item lacked evidence.
- **Phase 4 — cross-link + docs.** Each skill names the next in the lifecycle; update any index. Brief Obsidian note on the PRD lifecycle suite. Patch `writing-plans/SKILL.md` to add the upstream seam sentence: "If you do not have an authored PRD yet, start with `prd-authoring`; `writing-plans` expands an approved PRD phase into bite-sized TDD implementation steps." This completes the two-way seam from §4.1.
  - *Verify with:* grep each skill for the handoff pointer to the next, and grep `writing-plans` for the upstream seam sentence.

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

---

## 7. Open Questions

1. Should `prd-authoring` and `writing-plans` eventually merge? (Lean no — different jobs; revisit if overlap causes confusion in practice.)
2. Should closeout *auto-run* the description-optimizer (skill-creator) for new skills? (Lean: mention it as optional, don't mandate — not every closeout is a skill.)
3. Does `prd-closeout` need a machine-readable report (JSON) for any downstream consumer, or is the markdown report enough? (Lean markdown for v1.)

## 8. Acceptance Criteria

- [ ] `prd-authoring` skill loads; produces a PRD where **every phase has a Verification block** (unit + e2e-when-boundary + negative-for-trust + evals-if-ML + verify-command).
- [ ] `prd-authoring` includes the template + testing-vs-evals reference.
- [ ] `prd-swarm-planner` §2.6 now **requires real e2e** when the integrated output exercises a new or changed real path (not mock-only), with a named E2E+eval review gate in the output contract, and names `prd-closeout` as the handoff.
- [ ] `prd-closeout` skill loads; its checklist requires **evidence per item**.
- [ ] `prd-closeout` dogfooded: a real closeout report produced for parakeet-transcribe with evidence (tests 11-green, Obsidian doc, commits, mem0).
- [ ] All three skills cross-link the lifecycle (author → review → swarm → closeout).
- [ ] Obsidian note documents the PRD lifecycle suite.
