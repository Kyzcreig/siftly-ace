# PRD — PRD Lifecycle Skill Suite (authoring · swarm evals · closeout)

**Version:** v6 (Pass-2 of re-review: APPROVE — folded the two test-coverage notes: round-cap/early-exit dogfood + deterministic combined-phrasing resolution)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo
**Type:** Six coordinated changes to the `software-development` PRD skill family (4 new skills, 1 patch, 1 slash command)
**Status:** APPROVED to build (2-pass re-review of v4→v6: APPROVE WITH CHANGES → APPROVE)

---

## 1. Summary & Goal

Close the gaps in our PRD lifecycle so every spec is born testable and dies documented. The full suite:

1. **NEW `prd-interview`** — a "grill me" front-end: research-first, batched judgment-call questions, running snapshot, stops at a concrete problem statement + success criteria. Feeds `prd-authoring`.
2. **NEW `prd-authoring`** — writes a good PRD that *always* bakes in thorough testing + evals **per step/phase**, with measurable requirements (no "fast/easy"), in a shape that drops cleanly into `prd-swarm-planner`.
3. **NEW `prd-docs`** — documentation-only updates to project docs + Obsidian, **without** adding tests/build work. The lightweight "keep the docs current" tool, distinct from full closeout.
4. **PATCH `prd-swarm-planner`** — make thorough **e2e testing + evals a hard, explicit part of the review/integration gates**.
5. **NEW `prd-closeout`** — the full "we're done" ritual: tests pass + docs + Obsidian + commit/push + memory/mem0.
6. **NEW `/handoff` slash command** — compact the current session into a handoff doc for a fresh agent (temp dir, references-not-duplicates, suggested-skills, redacted).

**Why now:** We hit the testing/docs/closeout gaps live on parakeet-transcribe ("fully built" but untested + undocumented until asked). Encode the whole lifecycle so it's automatic, not prompted.

**The lifecycle:**
```
interview (prd-interview: grill to a concrete problem + success criteria)
  → author (prd-authoring: measurable, testable PRD)
    → review (prd-review-pipeline: N passes = review+fix)
      → plan/build (prd-swarm-planner: e2e evals enforced)
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
| L1 | Six artifacts | 1 patch (`prd-swarm-planner`), 4 new skills (`prd-interview`, `prd-authoring`, `prd-docs`, `prd-closeout`), 1 slash command (`/handoff`), all under `software-development/` (handoff is a command def). |
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
- **Phase 2 — patch `prd-swarm-planner`.** Apply the 3 edits (§2.6, §5/output, §6 handoff).
  - *Unit:* skill still loads; edits present (grep for the new gate language).
  - *Negative:* confirm the patch didn't break the existing §2.6/§2.8 structure (skill renders, sections intact).
  - *Verify with:* `skill_view` + grep for "E2E + eval gate" and "prd-closeout".
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
- **Phase 4 — cross-link + docs.** Each skill names the next/adjacent in the lifecycle; update any index. Brief Obsidian note on the PRD lifecycle suite. Patch `writing-plans/SKILL.md` to add the upstream seam sentence: "If you do not have an authored PRD yet, start with `prd-authoring`; `writing-plans` expands an approved PRD phase into bite-sized TDD implementation steps." This completes the two-way seam from §4.1.
  - *Verify with:* grep each skill for the handoff pointer to its neighbor(s), and grep `writing-plans` for the upstream seam sentence.

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

---

## 7. Open Questions

1. Should `prd-authoring` and `writing-plans` eventually merge? (Lean no — different jobs; revisit if overlap causes confusion in practice.)
2. Should closeout *auto-run* the description-optimizer (skill-creator) for new skills? (Lean: mention it as optional, don't mandate — not every closeout is a skill.)
3. Does `prd-closeout` need a machine-readable report (JSON) for any downstream consumer, or is the markdown report enough? (Lean markdown for v1.)

## 8. Acceptance Criteria

- [ ] `prd-interview` skill loads; dogfood shows research-first, judgment-calls-only (with recommended answers), force-concreteness, and a stop-with-success-criteria exit.
- [ ] `prd-authoring` skill loads; produces a PRD where **every phase has a Verification block** (unit + e2e-when-boundary + negative-for-trust + evals-if-ML + verify-command), and **bans subjective-adjective requirements** (L11).
- [ ] `prd-authoring` includes the template + testing-vs-evals reference, and points to `prd-interview` when the ask is vague.
- [ ] `prd-swarm-planner` §2.6 now **requires real e2e** when the integrated output exercises a new or changed real path (not mock-only), with a named E2E+eval review gate in the output contract, and names `prd-closeout` as the handoff.
- [ ] `prd-closeout` skill loads; its checklist requires **evidence per item**.
- [ ] `prd-closeout` dogfooded: a real closeout report produced for parakeet-transcribe with evidence (tests 11-green, Obsidian doc, commits, mem0).
- [ ] `prd-docs` skill loads; docs-only scope verified (updates docs WITHOUT running/gating tests); cross-pointer to `prd-closeout` present in both.
- [ ] `/handoff` is invocable; dogfood produces a temp-dir handoff doc that references artifacts by path, has a suggested-skills section, lives outside the workspace, and redacts secrets.
- [ ] All skills cross-link the lifecycle (interview → author → review → swarm → closeout; prd-docs and /handoff cross-referenced).
- [ ] `writing-plans` carries the upstream seam sentence pointing to `prd-authoring`.
- [ ] Obsidian note documents the PRD lifecycle suite (all six artifacts).
