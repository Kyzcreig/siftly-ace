# PRD — PRD Suite DRY Consolidation (v14)

**Version:** v14 (DRAFT — for Ace review; Pass-1 + Pass-2 BLOCKs resolved)
**Date:** 2026-06-10
**Author:** Apollo
**Owner:** Apollo
**Type:** Refactor of the existing (built, v11) `prd-*` skill family — single-source the cross-cutting rules, no new lifecycle stages
**Status:** BUILT (2026-06-11) — all 7 phases applied + verified in ~/.hermes/skills-shared/general/prd-*

---

## 1. Summary & Goal

The PRD lifecycle suite (v11, built + closed out 2026-06-07) works, but it was built as **9 independent skills that each carry their own copy of the cross-cutting rules.** Every time a shared rule changes, we hand-edit 3+ skills — proven live this session: tightening the *dual-format delivery rule* (chat=HTML, saved=Markdown) required manually editing `prd-plan`, `prd-document`, **and** `prd-closeout`, keeping the wording in sync by hand.

**Goal:** make every cross-cutting PRD rule live in **exactly one place**, and have the other skills **reference** it instead of restating it — so a rule change is a **one-file edit**, not a 3-file sweep. This is a maintainability refactor of existing skills; it adds **no new lifecycle stage, skill, or capability**.

**Non-vibe success test:** after this ships, changing the dual-format rule (or the verification-block schema, or the lifecycle diagram) touches **one file**, and a grep proves no skill restates the canonical text.

**One scoped behavioral change (Ace's call, 2026-06-10):** alongside the DRY work, `prd-closeout` becomes the **single orchestrating exit gate** — it *calls* `prd-harden` and `prd-document` (the way it already invokes `prd-document`'s procedure today), instead of *bouncing* the user to run `prd-harden` separately. So "close it out" means one skill drives the whole finish: hardened (e2e + failure paths + deploy-ready) → documented (project docs + Obsidian) → then closeout's own gate (GitHub push + changelog + memory + alerts + loose ends). See §4.6 + D9. This is the one place v14 changes behavior, not just text; it's small, additive, and called out explicitly so the rest of the PRD stays an honest refactor.

### 1.1 The duplication, measured (ground truth, 2026-06-10)

| Cross-cutting concern | Currently duplicated across | Canonical home today |
|---|---|---|
| **Dual-format delivery** (chat→HTML via doc-share/prd-share; every saved file→Markdown) | `prd-plan`, `prd-document`, `prd-closeout` | none — 3 hand-synced copies |
| **doc-share / sharing mechanics** | `prd-plan`, `prd-document`, `prd-closeout`, `prd-share` | `prd-share` (the tool) + `doc-share` (the renderer) |
| **Obsidian Portability Rule** (vault=canonical, point-don't-duplicate) | `prd-document`, `prd-closeout` | `prd-document` (mostly) |
| **"Position in the lifecycle" diagram** | `prd-interview`, `prd-plan`, `prd-closeout`, `prd-harden`, `prd-swarm-plan-review` (5 copies) | none — 5 hand-drawn variants |
| **Evidence-backed / "no evidence = FAIL" stance** | `prd-plan`, `prd-document`, `prd-closeout` | `prd-closeout` (the gate) |
| **Verification-block schema** (unit/e2e/negative/eval/verify-with) | `prd-plan` (canonical), echoed in `prd-swarm-planner` | `prd-plan` |
| **Constitution / Invariants format** | `prd-plan` (canonical), checked by `prd-closeout` | `prd-plan` |

Two failure modes this causes:
1. **Drift** — a fix lands in one copy, the others rot (we already hit this: `prd-plan`/`prd-document` had *different* wording about HTML-vs-gist before this session).
2. **Edit tax** — every cross-cutting change is N edits + an N-way consistency check by hand.

**Concern count = 7 rows, but only 6 get an independent canonical-owner + grep target.** Row 2 (**doc-share / sharing mechanics**) is **not** a separately-consolidated concern — it is *subsumed by Row 1 (dual-format delivery)* via D2 (prd-plan delegates sharing to prd-share). The publish mechanics already live canonically in `prd-share`/`doc-share` today; the only duplication is the *sharing-rule statement*, which travels with the dual-format rule when that moves to `prd-share`. So the acceptance proof is a **6-way single-source grep** (Rows 1,3,4,5,6,7), and Row 2 is verified *implicitly* by the dual-format check (once Row 1's rule lives only in `prd-share`, the sharing-mechanics statement does too). Every "7-way" reference elsewhere in this doc means "the 7 listed concerns, 6 of which carry an independent grep; Row 2 rides Row 1." This is called out so the table count (7) and the executable-check count (6) don't look like a discrepancy.

### 1.2 The fix, in one line

Create **one canonical reference doc per cross-cutting concern**, place it in the skill that legitimately *owns* that concern, and have every other skill **point at it in one sentence** instead of restating it. Where a concern has no natural owner skill (the lifecycle diagram, the dual-format rule), create a **single shared reference file** that all the prd-* skills link.

---

## 2. Non-Goals

- **No new lifecycle stage, skill, or agent.** This is consolidation of the existing 9 skills, full stop. (The one allowed behavioral change — D9, closeout calls harden — adds no new *stage*; it changes how an existing stage invokes an existing neighbor.)
- **Not changing any rule's *content*.** The dual-format rule, the verification schema, the closeout gate — their *meaning* stays identical. We move where the canonical text lives, not what it says. **Three called-out exceptions (explicit, not smuggled):** (1) **D9** changes closeout's *behavior* (it now calls `prd-harden` instead of bouncing to it); (2) **D10/D4** — the canonical **lifecycle diagram is a normalized superset** of 5 divergent existing variants, not a verbatim copy of any one (proven divergent 2026-06-10); (3) **D11** adds **one line** to `prd-harden`'s report format (a `Ran against: <SHA>` stamp) so closeout can check freshness — prd-harden's hardening *procedure* is untouched. All three are intentional deltas with a note; everything else is verbatim text relocation.
- **Not rewriting `prd-harden`'s procedure.** The only prd-harden change is the one-line SHA stamp in its report format (D11); its hardening logic, checklist, and gates are unchanged.
- **Not merging skills.** `prd-plan`, `prd-document`, `prd-share`, `prd-closeout` stay separate skills with distinct jobs (already validated this session: author / fix-docs / publish-tool / exit-gate). We de-duplicate their *shared rules*, not the skills themselves.
- **Not rewriting `prd-swarm-planner` or `prd-review-pipeline`** beyond trimming any duplicated cross-cutting text they carry. Their large bodies are mostly skill-specific and stay.
- **No mechanism/runtime change.** No new scripts, no config, no doc-share/prd-share code changes. Pure SKILL.md/reference-doc edits.

---

## 3. Resolved Decisions

| # | Decision | Value |
|---|---|---|
| D1 | **Single-source mechanism = shared reference docs + one-sentence pointers, resolved via `skill_view`** | Hermes skills can't `include` each other, so "single source" = a canonical `.md` (a `references/` file or the owning skill's section) that other skills **name and point at** in one sentence. **Resolution mechanism (verified ground truth, 2026-06-10):** an agent follows a pointer with **`skill_view(name='<owner-skill>', file_path='references/<file>.md')`** — the same name-keyed mechanism `prd-closeout` *already* uses to "invoke `prd-document`'s procedure." Cross-skill reference access works because `skill_view` is keyed by skill *name*, not by the reader's own directory — it is NOT a filesystem-relative include. **Therefore every pointer MUST name (a) the owner skill and (b) the exact `skill_view` target** (skill name + `references/...md` path, or "the `<Section Title>` section of `<skill>`"), never a bare prose mention or a line number. The pointer is short and stable; the rule lives once; the reader can always reach it. |
| D2 | **prd-plan delegates sharing to prd-share** (Ace's call) | `prd-plan` stops describing *how* to share; it says "present PRDs in chat via `prd-share` (HTML link); save them as Markdown — see the canonical delivery rule in `prd-share` → The delivery rule." `prd-share` already owns the publish mechanics; it absorbs the *rule* statement too. (This is what subsumes §1.1 Row 2.) |
| D3 | **Canonical owners** | dual-format delivery → **`prd-share`** (it's the delivery tool; natural home). Obsidian Portability + documentation procedure → **`prd-document`** (already mostly owns it). Verification-block schema + Constitution/Invariants → **`prd-plan`** (already canonical). Evidence-backed gate → **`prd-closeout`** (already canonical). Lifecycle diagram → **`prd-plan/references/lifecycle.md`** (a `references/` file under prd-plan, reached by every skill via `skill_view`; no single skill owns the whole lifecycle so it lives as a shared reference, not inline in one skill's body). |
| D4 | **Lifecycle diagram → one shared reference file (a NORMALIZED superset, not a verbatim copy)** | Create `prd-plan/references/lifecycle.md` (the canonical diagram + one-line role of each stage). The 5 skills that currently each draw their own diagram replace it with a one-line pointer (`skill_view(name='prd-plan', file_path='references/lifecycle.md')`) **plus** their own local upstream/downstream neighbor line. **IMPORTANT (resolves Pass-1 Blocker 5):** the 5 existing diagrams are **NOT identical** — verified 2026-06-10: prd-interview's includes the `interview` stage; prd-closeout/prd-harden include the `harden` stage; prd-plan's omits `harden`; prd-swarm-plan-review has the swarm sub-loop (`plan → plan-review → load → run`). So the canonical diagram is a **deliberate normalization to the full superset** (interview → plan → review → swarm-plan → swarm-plan-review → load/run → build → harden → closeout, with prd-document + handoff-doc as cross-cutting). This is an **approved semantic normalization**, explicitly NOT "verbatim relocation" — see D10 and the §2 exception. Host = `prd-plan` because it's the authoring entry point most readers hit first; standalone `prd-lifecycle` skill rejected as over-engineering for a static diagram. |
| D5 | **Pointer wording is itself standardized, and names the concrete `skill_view` target** | To avoid pointers drifting, each uses a fixed template: **"**<Concern>** follows the canonical rule in `<owner-skill>` — load it with `skill_view(name='<owner-skill>', file_path='references/<file>.md')` (or see its `<Section Title>` section); do not restate it here."** Naming the concrete `skill_view` target (not just a prose mention or a line number) makes resolution deterministic, not heuristic. A grep for the canonical phrase proves only the owner carries the full text; a grep for the pointer template proves the others carry only the pointer. |
| D6 | **Scope = the cross-cutting concerns in §1.1, nothing more** | Seven concerns, measured. We don't go hunting for more duplication mid-build; if more surfaces, it's a follow-up, not scope creep. |
| D7 | **Verification = grep-based single-source proof, with SPECIFIED strings + a positive-existence lower bound** | Each concern's acceptance check is mechanical and **both-sided**: (a) **positive** — `grep -l "<literal canonical string>" <owner>/SKILL.md` (or the reference file) exits 0 (the rule actually lives in its home — guards against "deleted everywhere, created nowhere"); (b) **negative** — the same string across the *other* `prd-*/SKILL.md` returns nothing (no surviving duplicate). The literal strings are **fixed in §10.1**, not left as `<canonical phrase>` placeholders, so the check is reproducible and can't be made tautological by phrase-picking. **File-scope domain:** the search set is `~/.hermes/skills-shared/general/prd-*/SKILL.md` and `prd-plan/references/lifecycle.md` ONLY — this PRD, the v11 PRD, changelogs, and status notes are explicitly excluded (they legitimately quote the rules). |
| D8 | **No behavioral regression** | After consolidation, an agent reading any prd-* skill must still reach the full rule (via the pointer) — the rule is one click away, not deleted. A dogfood (author→share→document→closeout on a throwaway PRD) proves the lifecycle still works end-to-end with the pointers in place. |
| D9 | **prd-closeout orchestrates harden + document** (Ace's call) | Closeout becomes the single "wrap it up" entry point. Today it *invokes* `prd-document`'s procedure but only *checks for* `prd-harden`'s output (item 0 bounces you to run harden yourself). Make them symmetric: closeout **calls `prd-harden`** (run it, or confirm a *current* run's report) the same way it calls `prd-document`. One skill drives the full finish: hardened → documented → GitHub'd → changelogged → memory/alerts. **Guardrail:** this does NOT weaken the gate — if harden surfaces uncovered failure paths, closeout still BLOCKs until they're closed; "called" means closeout *drives* harden, not that it rubber-stamps it. The harden *work* still lives in `prd-harden` (closeout doesn't inline it); closeout orchestrates. |
| D10 | **Multi-variant concerns get a RECONCILIATION step before consolidation** (resolves Pass-1 Blocker 5) | For any concern whose copies are not byte-identical today (the lifecycle diagram is the proven case — 5 divergent variants; dual-format is a suspected case — 3 "hand-synced" copies that already drifted once), Phase 1 must **diff all existing copies side-by-side, pick/compose the canonical text deliberately, and record the chosen wording + every delta** in a short "Reconciliation note" committed alongside. Where the canonical text is a *superset/normalization* (lifecycle) rather than a verbatim pick, that is an **approved semantic normalization** and is added to the §2 exception list next to D9 — it is NOT smuggled under "verbatim relocation." A concern whose copies *are* byte-identical needs no reconciliation note (just pick one). |
| D11 | **"Current harden report" has an objective freshness contract** (resolves Pass-1 Blocker 4; mechanism corrected Pass-3) | Closeout's D9 "run harden OR confirm a prior report" branch defines **current** as: **no source changes to the build between when harden ran and the closeout commit.** The harden report records the SHA it ran against; closeout verifies `git diff --quiet <report-SHA> -- <build paths>` (zero build-source diff since harden) **AND** the working tree is clean for those build paths. This is a **content-equivalence** check, deliberately NOT a rigid `SHA==HEAD`: closeout's own commit (docs/changelog/memory) advances HEAD without touching build source, so SHA-equality would fail by construction — content-equivalence is the correct invariant (it stays true across the closeout commit as long as that commit adds no build-source changes). **Any build-source change since the report → stale → closeout re-runs harden, it does NOT accept the old report.** This kills the rubber-stamp: "I hardened it three revisions ago" no longer satisfies the gate. (Non-git project → no stale-report shortcut: harden must be re-run this closeout. Implementation may use a tree-hash `git write-tree` instead of a path-diff where that's cleaner — same invariant.) |

---

## 4. Design

### 4.1 The canonical-owner map (what moves where)

```
Concern                         Canonical home (full text)         Pointer-only (one sentence each)
─────────────────────────────────────────────────────────────────────────────────────────────────
Dual-format delivery rule    →  prd-share  (NEW section)        →  prd-plan, prd-document, prd-closeout
Documentation procedure +    →  prd-document (already owns)     →  prd-closeout (already points; keep)
  Obsidian Portability Rule
Verification-block schema     →  prd-plan (already owns)        →  prd-swarm-planner (already echoes; slim to pointer)
Constitution/Invariants fmt   →  prd-plan (already owns)        →  prd-closeout (already points; keep)
Evidence-backed FAIL stance   →  prd-closeout (already owns)    →  prd-plan, prd-document (slim to pointer)
Lifecycle diagram             →  prd-plan/references/lifecycle.md (NEW)  →  prd-interview, prd-plan body,
                                                                            prd-closeout, prd-harden,
                                                                            prd-swarm-plan-review
```

Net new artifacts: **one new section in `prd-share`** (the dual-format rule) + **one new reference file** (`prd-plan/references/lifecycle.md`). Everything else is *deletion of duplicate prose, replaced by a one-line pointer.*

### 4.2 The dual-format rule moves to prd-share

`prd-share` gains a top section: **"The delivery rule (canonical)"** — the full chat=HTML / saved-file=Markdown rule (project docs AND Obsidian are Markdown; HTML is only the in-chat presentation), exactly as currently worded in `prd-plan`. Then:
- **`prd-plan`** — its current "Delivery & doc shapes" section collapses to: *"When presenting a PRD in chat, publish an HTML link with `prd-share`; save the PRD as Markdown in project `docs/` (and Obsidian if asked). Full rule: see `prd-share` → The delivery rule."* (Implements D2.)
- **`prd-document`** — its "Dual-format rule" section collapses to a one-line pointer to `prd-share`, keeping only the doc-specific nuance (vault note = `.md`).
- **`prd-closeout`** — its prd-document relationship note keeps the *delegation* but points the dual-format clause at `prd-share`.

### 4.3 The lifecycle diagram becomes a shared reference

New file `prd-plan/references/lifecycle.md`: the canonical ASCII diagram — the **normalized superset** (interview → plan → review → swarm-plan → swarm-plan-review → load/run → build → harden → closeout; with prd-document + `handoff-doc` as cross-cutting) per D4/D10 — + a one-line role for each stage + the "each stage names its neighbor" convention. (`handoff-doc` is an existing skill under `skills-shared/coding/`, referenced cross-cuttingly by the lifecycle — it is **not** one of the 9 prd-* skills being edited and is not modified; the "9 skills" count is unchanged.) **The closeout stage's one-liner reflects the post-D9 reality** ("closeout *calls* harden + document, then runs its own gate"), authored D9-aware from the start so the canonical diagram never ships stale. The 5 skills currently each drawing a "Position in the lifecycle" block replace the diagram with: *"This skill's place in the lifecycle: see `prd-plan/references/lifecycle.md` (`skill_view(name='prd-plan', file_path='references/lifecycle.md')`). Immediately upstream: X. Immediately downstream: Y."* (The **local** upstream/downstream pointer stays in each skill — it's skill-specific; only the **full diagram** is centralized.)

### 4.4 Evidence-backed stance + verification schema

- `prd-plan` and `prd-document` currently restate "no evidence = FAIL." They slim to: *"Closeout is evidence-backed (no evidence = FAIL) — see `prd-closeout`."*
- `prd-swarm-planner` echoes the verification-block schema; it slims to: *"Per-task verification uses the canonical Verification block — see `prd-plan` → Per-phase Verification block."* (Keep any swarm-specific additions inline.)

### 4.5 What explicitly does NOT move

- Each skill's **own job description, triggers, and skill-specific procedure** stay inline (those aren't cross-cutting).
- `prd-share`'s and `prd-swarm-planner`'s large bodies (publish pipeline, kanban-compiler) stay — they're skill-specific, not duplicated.
- The **local** upstream/downstream neighbor pointers stay in each skill (they're per-skill, and the self-correcting mis-fire behavior from v11 depends on them).

### 4.6 prd-closeout orchestrates harden + document (the one behavioral change, D9)

Today closeout treats its two upstreams asymmetrically:
- **prd-document** → closeout **invokes its procedure** (docs items 4–5 *call* prd-document; the doc mechanics live in one place).
- **prd-harden** → closeout only **checks for its output** (item 0: "if harden wasn't run, closeout does not start — go run it, then come back").

Make them symmetric. Closeout's procedure step 0 changes from *"stop and tell the user to run prd-harden"* to *"run `prd-harden` now (or confirm a current hardening report exists), then continue"* — the same call-the-skill shape used for prd-document. The result: **closeout is the single "wrap it up" door.** Knock once, and it drives:

```
prd-closeout  (one entry point for "we're done")
  ├── calls prd-harden    → e2e + failure-path coverage + lint/typecheck gates + deploy-ready
  ├── calls prd-document  → project docs + Obsidian overview current  (already does this)
  └── owns its own gate   → GitHub push + thorough changelog + memory/mem0 + cron/alerts + loose ends
```

**What does NOT change (the guardrails):**
- **The gate keeps its teeth.** "Calls harden" ≠ "rubber-stamps harden." If harden's pass finds uncovered failure paths, closeout still **BLOCKs** until they're closed. Item 0 stays a hard gate; it just *drives* the pass instead of bouncing to it.
- **The harden *work* stays in `prd-harden`.** Closeout doesn't inline the hardening procedure (no duplication — that would violate the whole point of v14). It orchestrates: it *loads and runs* prd-harden, exactly as it *loads and runs* prd-document's procedure.
- **prd-harden remains independently usable.** "Harden this" mid-build still loads prd-harden directly without closeout — closeout calling it doesn't make it closeout-only.

Concretely this is a small edit to `prd-closeout`'s **Procedure step 0** and the **prd-harden relationship note**: reword "stop and run prd-harden first, then resume" → "run prd-harden now (call the skill); BLOCK if it surfaces unclosed failure paths," mirroring the existing prd-document phrasing.

**One minimal `prd-harden` edit IS required (Pass-2 correction).** D11's freshness contract needs the harden report to record the commit SHA it ran against — and `prd-harden` does **not** record a SHA today (verified 2026-06-10). So `prd-harden`'s report format gains **one line**: `**Ran against:** <git rev-parse HEAD> (build paths clean: yes/no)`. That's the whole change to prd-harden — its hardening *procedure* is untouched; it just stamps the SHA so closeout (D11) can compare. This is added to the §2 exception list as the third intentional delta. (If the project isn't a git repo, the line records `not a git repo` and closeout's non-git fallback — re-run harden — applies.)

---

## 5. Implementation Phases

These are skill-authoring edits (prose), authored directly, not via swarm.

- **Phase 1 — Reconcile variants, then establish canonical homes (the two new artifacts).**
  - **Reconciliation FIRST (D10):** for each multi-variant concern, diff the existing copies and record the chosen canonical text + deltas in a `Reconciliation note` (committed with the change).
    - *Dual-format:* diff the 3 copies (`prd-plan`, `prd-document`, `prd-closeout`). If byte-identical, pick one; if drifted, pick the most-complete wording and note the delta.
    - *Lifecycle diagram:* diff the 5 variants (proven divergent). **Compose the canonical superset** — interview → plan → review → swarm-plan → swarm-plan-review → load/run → build → harden → closeout, with `prd-document` + `handoff-doc` as cross-cutting — and record that this is an **approved normalization** (the §2 exception), listing what each variant was missing.
  - Add "The delivery rule (canonical)" section to `prd-share/SKILL.md` (the reconciled dual-format text).
  - Create `prd-plan/references/lifecycle.md` with the canonical **superset** diagram + per-stage one-liner. **Its closeout stage description must reflect the post-D9 reality** ("closeout *calls* harden + document, then runs its own gate") so the canonical diagram doesn't ship already-stale (resolves Pass-1 OQ1). Phase 5 changes closeout's body; lifecycle.md is authored D9-aware from the start.
  - *Unit/script check:* both load — `skill_view(name='prd-share')` shows the new section; `skill_view(name='prd-plan', file_path='references/lifecycle.md')` loads and is valid Markdown (proves the cross-skill reference resolves — D1).
  - *Positive existence (D7a):* `grep -c "<dual-format literal from §10.1>" prd-share/SKILL.md` ≥1 — the canonical text is present BEFORE any deletions elsewhere (never delete a copy before the home exists).
  - *Verify with:* `skill_view prd-share` shows delivery rule; `skill_view prd-plan references/lifecycle.md` loads; reconciliation note committed.

- **Phase 2 — Slim the duplicators to pointers (dual-format).**
  - Replace the full dual-format text in `prd-plan`, `prd-document`, `prd-closeout` with the D5-template one-sentence pointer to `prd-share`.
  - *Unit:* all three skills still load.
  - *E2E/integration check:* `grep -rl "saved file gets Markdown\|every saved file → Markdown" prd-*/SKILL.md` returns **only `prd-share`** (the canonical phrase lives in exactly one SKILL.md; the others show only the pointer). This is the D7 single-source proof for this concern.
  - *Negative:* confirm each pointer names `prd-share` and is one sentence (no re-stated rule body leaked back in).
  - *Verify with:* the grep returns exactly one file.

- **Phase 3 — Slim the lifecycle-diagram duplicators.**
  - Replace the "Position in the lifecycle" diagram in the 5 skills with the local-neighbor pointer + a link to `prd-plan/references/lifecycle.md`.
  - *Unit:* all 5 skills load.
  - *E2E/integration check:* `grep -l "prd-plan → prd-review-pipeline\|interview.*author.*review.*closeout" prd-*/SKILL.md` returns **zero** SKILL.md files (the full diagram now lives only in the reference file). Each of the 5 still names its immediate upstream/downstream.
  - *Verify with:* the grep returns no SKILL.md; each skill shows a one-line lifecycle pointer.

- **Phase 4 — Slim the remaining duplicators to pointers (evidence-stance, verification-schema, Obsidian Portability, Constitution).**
  - **Evidence-backed FAIL stance (row 5):** `prd-plan`/`prd-document` → pointer to `prd-closeout`.
  - **Verification-block schema (row 6):** `prd-swarm-planner` → pointer to `prd-plan`.
  - **Obsidian Portability Rule (row 3):** `prd-closeout` currently restates it → slim to a pointer to `prd-document` (the full statement stays only in `prd-document`).
  - **Constitution/Invariants format (row 7):** `prd-closeout` restates the format while *checking* it → keep the *check* but slim the format *definition* to a pointer to `prd-plan` (closeout references the format, prd-plan defines it).
  - *Unit:* all touched skills load.
  - *Integration check (both-sided, §10.1 rows 3/5/6/7):* each locked definition-fragment string returns **only its owner**; `prd-closeout`/`prd-plan`/`prd-document`/`prd-swarm-planner` show only pointers for the concerns they don't own.
  - *Verify with:* the four locked strings each return exactly one owner.

- **Phase 5 — Closeout orchestrates harden + document (D9) + freshness contract (D11) + prd-harden SHA stamp.**
  - Edit `prd-closeout` **Procedure step 0** + the **prd-harden relationship note**: change "stop and tell the user to run prd-harden, then resume" → "**run `prd-harden` now** (call/load the skill), or confirm a **current** hardening report (per the D11 freshness contract: **no build-source changes since the report** — `git diff --quiet <report-SHA> -- <build paths>` AND clean working tree for those paths; stale → re-run, do NOT accept the old report); **BLOCK** if it surfaces unclosed failure paths" — mirroring the existing prd-document "invoke its procedure" phrasing. Keep item 0's gate teeth intact and add the freshness check.
  - **Add the SHA stamp to `prd-harden`'s report format** (the one prd-harden edit, D11/§2 exception 3): one line `**Ran against:** <git rev-parse HEAD> (build paths clean: yes/no)`. No other prd-harden change.
  - Remove the legacy "go run prd-harden separately, then come back" bounce wording everywhere in `prd-closeout` (don't just add the new phrasing — delete the contradictory old phrasing, per the partial-fix trap).
  - *Unit:* `prd-closeout` loads; `skill_view` shows step 0 now *calls* harden (verb changed from "tell the user to run" → "run") and states the freshness contract; `prd-harden` loads and its report format shows the `Ran against:` line.
  - *Negative/adversarial (discriminating, `grep -E` regex — explicitly noted, distinct from the literal §10.1 checks):* `grep -nE "BLOCK.*(unclosed|uncovered) failure" prd-closeout/SKILL.md` returns the gate line (teeth survive the reword); AND two literal `grep -F` checks — `grep -Fn "tell the user to run" prd-closeout/SKILL.md` and `grep -Fn "go run prd-harden" prd-closeout/SKILL.md` — each return **zero** (bounce wording gone); AND the freshness clause is present (`grep -Fn "rev-parse" prd-closeout/SKILL.md`).
  - *Verify with:* `skill_view prd-closeout` (orchestrating step 0 + BLOCK guardrail + D11 freshness clause + no bounce wording) and `skill_view prd-harden` (SHA stamp present).

- **Phase 6 — Docs edits (NOT the commit yet).**
  - Update the v11 PRD's status note to point at this v14 consolidation; update the Obsidian "PRD Skills & Kanban Orchestration — System Overview" to note the single-source refactor (as **Markdown**, per the rule we're consolidating — dogfood it via `prd-document`). **Stage these edits but do NOT commit/push yet** — the final harden+dogfood (Phase 7) must run against the *final* tree so the D11 freshness contract holds on what actually ships.
  - *Verify with:* docs updated on disk; working tree contains all skill edits + doc edits, uncommitted.

- **Phase 7 — Final gate: dogfood + cross-link audit + commit on the SAME tree (satisfies D11).**
  - Run the real lifecycle on a throwaway PRD: author (`prd-plan`) → share (`prd-share`) → document (`prd-document`) → closeout (`prd-closeout`) — confirm every pointer resolves via `skill_view` (the agent reaches the full rule one hop away) and nothing behaviorally regressed. **Confirm the D9 change fires:** invoking closeout actually *drives* `prd-harden` (loads it / produces or confirms a current report) rather than just telling the user to go run it.
  - **Exercise the OFF-main-path touched skills too** (they get pointer edits but aren't on the author→closeout path): `skill_view` `prd-interview`, `prd-harden`, `prd-swarm-planner`, `prd-swarm-plan-review` and confirm each one's lifecycle/verification pointer resolves to a live target — these are not covered by the dogfood and would otherwise ship unverified (Pass-1 QA finding).
  - Audit: every pointer names a skill/reference that actually exists; **resolve each pointer with its literal `skill_view` target** (no dangling pointers, no bare prose mentions).
  - *Unit:* `skill_view` each of the **9** touched skills — all load, no broken `references/` links.
  - *E2E/integration check:* a dogfood PRD goes author→share→document→closeout; the shared HTML link renders; the saved `.md` exists; closeout gate runs (and drives harden). **This exercises the real changed path** per the e2e-required rule.
  - *Negative/adversarial (D7, both-sided, §10.1 literals):* for each of the 6 grep-bearing concerns, run the **positive** check (string present in its owner, exit 0) AND the **negative** check (string absent from every other `prd-*/SKILL.md` in the scoped domain). A missing owner (zero hits) OR a surviving duplicate (second hit) = FAIL. Row 2 (sharing mechanics) verified implicitly via the dual-format result.
  - **THEN commit + push everything in one commit** (skill edits + doc edits), with a thorough changelog. **D11 freshness holds because the harden/dogfood ran against this exact tree and the commit is the first SHA change after it — no further source edits follow.** (If a fix is needed after the dogfood, re-run the dogfood before committing — never commit on top of a stale harden.)
  - *Verify with:* the §10.1 grep table all-green + a clean dogfood transcript + all 9 skills load + `git log` shows the legible commit; Obsidian overview updated; pushed.

---

## 6. Security, Privacy, Ops

- **No secrets, no public surface, no runtime.** Pure documentation edits to skills we own. doc-share/prd-share privacy scans are unchanged.
- **Rollback:** every phase is SKILL.md text edits under git — `git revert` restores any phase. Phase 1 (create canonical homes) lands *before* any deletion (Phase 2+), so there is never a window where a rule exists in zero places.
- **Observability:** the D7 grep table is the standing health check — it can be re-run any time to prove the suite stayed DRY (candidate for a cheap collision-guard cron later; not in scope here).

## 7. Constitution / Invariants

- **Invariant: no rule loses its full text.** Every cross-cutting rule remains fully readable in exactly one canonical location; pointers never replace the rule with a dead end.
  - *Why:* a pointer to nothing is worse than a duplicate.
  - *Closeout proof:* Phase 7 dogfood reaches each rule via its `skill_view` pointer; the §10.1 grep table shows each concern present in exactly one owner (the positive-existence check — one, never zero).
- **Invariant: meaning is preserved (verbatim where copies agree; an APPROVED NORMALIZATION where they diverge).** Single-copy/agreeing concerns move verbatim; divergent concerns are reconciled deliberately with a recorded note. The lifecycle diagram is the **proven** divergent case (D4/D10). Dual-format is checked at Phase 1: if its 3 copies are byte-identical it's verbatim; if Phase-1 diff finds drift, it gets the same reconciliation-note + §2-exception treatment as lifecycle (no hedge — the diff decides).
  - *Why:* this is a refactor, not a silent redesign — but the lifecycle copies were *already* divergent, so "verbatim" is impossible for it; honesty requires labeling the normalization, not pretending it's a byte-copy.
  - *Closeout proof:* for verbatim concerns, a diff of the canonical text vs the chosen source is wording-identical; for the lifecycle (and dual-format if Phase-1 finds it drifted), the Phase-1 **reconciliation note** records the composed text + every delta. The intentional behavioral/format changes are exactly the three §2 exceptions (D9 behavior, D4/D10 lifecycle superset, D11 harden SHA stamp).
- **Contract invariant: the lifecycle still composes.** Each skill still names its upstream/downstream; the full lifecycle is reachable.
  - *Closeout proof:* Phase 7 author→share→document→closeout dogfood succeeds.
- **Invariant: the closeout gate keeps its teeth (D9/D11).** Making closeout *call* `prd-harden` must not turn item 0 into a rubber stamp — if harden surfaces uncovered failure paths, closeout still BLOCKs; and a stale/dirty prior report is not accepted (D11 freshness contract).
  - *Why:* the whole point of closeout is to be the gate that *can't* be satisfied by a green happy-path or a months-old harden report; orchestrating harden must strengthen that, not soften it.
  - *Closeout proof:* `prd-closeout` step 0 still says BLOCK-on-unclosed-failure-paths AND requires no build-source change since the report (D11 content-equivalence; Phase 5 discriminating checks); the harden *work* still lives only in `prd-harden` (no inlined hardening procedure leaks into closeout — grep confirms).

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A pointer goes stale (target section renamed) | dead reference, worse than a duplicate | Pointers name a **skill + concrete `skill_view` target** (skill name + `references/...md` path or section title), not a line number; Phase 7 resolves every pointer via `skill_view`; the §10.1 positive-existence check catches a missing owner (zero hits = FAIL). |
| `skill_view` can't resolve a cross-skill `references/` path | every lifecycle pointer + the dual-format pointer become dead | **Verified false 2026-06-10:** `skill_view(name, file_path)` is keyed by skill *name*, not the reader's dir — `prd-closeout` already invokes `prd-document` this way. Phase 1 unit-check loads `prd-plan/references/lifecycle.md` via `skill_view` before anything depends on it. |
| Over-consolidation — centralizing something skill-specific | a skill loses needed inline context | D6 freezes scope to the 7 measured concerns; the local upstream/downstream neighbor pointers explicitly stay inline (§4.5). |
| Deleting a copy before the canonical home exists | a rule briefly lives nowhere | Phase ordering: Phase 1 creates canonical homes first; Phase 2+ only then deletes duplicates. The §10.1 positive-existence (D7a) check enforces "home exists, exit 0" before deletion. Rollback via git. |
| Silent semantic drift under a "verbatim" label (divergent variants) | a normalization ships unannounced | D10 reconciliation note + the §2 exception list make every non-verbatim move explicit and reviewable. |
| The pointer indirection annoys a reader/agent mid-task | rule is one hop away, mild friction | Acceptable tradeoff for DRY; the pointer is one sentence and names the exact `skill_view` call. Dogfood (Phase 7) confirms the agent still follows the rule. |
| An external consumer (cron, playbook, user doc) referenced a now-deleted inline location | dead pointer outside the suite | Pre-flight grep in Phase 1: `grep -rl "<concern keyword>" ~/.hermes/scripts ~/.hermes/skills-shared ~/Obsidian` for references to the inline rule locations; the suite's own cross-links are the only known consumers (the rules were never addressed by path). Note any external hit as a follow-up pointer-update. |
| Future new cross-cutting rule gets duplicated again | drift returns | The pattern itself (canonical home + `skill_view` pointer template, D5) is the durable fix; Ace declined the collision-guard cron (Q2), so the §10.1 grep table is a manual re-runnable check. |

## 9. Open Questions

1. ~~Should the lifecycle diagram live in `prd-plan/references/` or a tiny standalone `prd-lifecycle` reference skill?~~ **RESOLVED (Ace, 2026-06-10): `prd-plan/references/lifecycle.md`** — no need for a skill that holds one diagram.
2. ~~Worth adding a `prd-suite-dryness` collision-guard cron?~~ **RESOLVED (Ace, 2026-06-10): no** — not building the cron.
3. ~~Can `skill_view` resolve a cross-skill `references/` path?~~ **RESOLVED (probe, 2026-06-10): yes** — keyed by skill name; `prd-closeout` already invokes `prd-document` this way (Pass-1 Blocker 3).
4. ~~Are the 5 lifecycle copies semantically identical?~~ **RESOLVED (probe, 2026-06-10): no, they diverge** — so the canonical is a normalized superset (D4/D10), not a verbatim copy (Pass-1 Blocker 5).
5. ~~Do `prd-review-pipeline` / `prd-harden` carry cross-cutting duplication beyond the 7 measured?~~ **ACCEPTED RISK (Ace, 2026-06-10): yes, accepted.** Phase 7's grep is scoped to the 7 measured concerns; any undiscovered duplication inside those two skills survives v14 undetected and is a follow-up per D6 — not a v14 blocker.
6. ~~Is `handoff-doc` a 10th skill (affecting the "9 skills" count)?~~ **RESOLVED (probe, 2026-06-10): no** — it's an existing skill under `skills-shared/coding/`, referenced cross-cuttingly by the lifecycle diagram but not one of the 9 prd-* skills and not modified (§4.3).
7. ~~Does the dual-format concern need the §2-exception treatment (the "possibly diverges" hedge)?~~ **RESOLVED (Ace, 2026-06-10): the Phase-1 diff decides** — byte-identical → verbatim; drifted → same reconciliation-note + §2-exception as lifecycle. No standing hedge (§7).

## 10. Acceptance Criteria

### 10.1 The single-source grep table (literal strings — D7)

Search domain: `~/.hermes/skills-shared/general/prd-*/SKILL.md` + `prd-plan/references/lifecycle.md`. Each concern must pass **both** the positive (present in owner, exit 0) and negative (absent from every other SKILL.md) check. **The literal strings are LOCKED here pre-build** — they are body-content fragments from the canonical *definition*, deliberately chosen so they **cannot appear in a well-formed pointer** (a pointer names the concern + the `skill_view` target; it never restates the definition sentence). The only permitted build-time change: if Phase-1 reconciliation alters the canonical wording so a locked string is literally absent from its owner, the replacement substring must be (a) another fragment of the *definition body* (never the section title/concern name), (b) re-verified to not appear in any pointer, and (c) committed + recorded here **before** the negative checks run. No silently-mutated gate.

| # | Concern | Canonical owner | Locked grep string (a DEFINITION-body fragment, never a title) | Positive (≥1 in owner) | Negative (0 elsewhere) |
|---|---|---|---|---|---|
| 1 | Dual-format delivery | `prd-share` | `every saved file gets Markdown` | `prd-share/SKILL.md` | all other `prd-*/SKILL.md` |
| 2 | Sharing mechanics | *(rides #1)* | — | *(implicit via #1)* | *(implicit via #1)* |
| 3 | Obsidian Portability Rule | `prd-document` | `the vault is the canonical human-readable home` | `prd-document/SKILL.md` | all other `prd-*/SKILL.md` |
| 4 | Lifecycle diagram | `prd-plan/references/lifecycle.md` | `prd-plan → prd-review-pipeline` (the diagram arrow chain) | `references/lifecycle.md` | all `prd-*/SKILL.md` = 0 |
| 5 | Evidence-backed FAIL stance | `prd-closeout` | `No evidence = FAIL` | `prd-closeout/SKILL.md` | all other `prd-*/SKILL.md` |
| 6 | Verification-block schema | `prd-plan` | `Every implementation phase must end with a concrete Verification block` (the schema's defining sentence) | `prd-plan/SKILL.md` | all other `prd-*/SKILL.md` |
| 7 | Constitution/Invariants format | `prd-plan` | `credentials, auth boundaries, tenant/session isolation` (the Security-invariants definition line) | `prd-plan/SKILL.md` | all other `prd-*/SKILL.md` |

> **Why definition-body fragments, not titles (Pass-2 fix):** rows 3/6/7 owners hold the full *definition*; other skills legitimately hold a *pointer* that names the concern (e.g. prd-closeout says "Obsidian Portability — see `prd-document`"). If the negative check grepped the concern *name* (`Obsidian Portability Rule`, `Per-phase Verification block`, `Constitution/Invariants`), a compliant pointer would false-positive and the check would be unfalsifiable. So each negative target is a sentence fragment that exists **only where the rule is written out in full** — it can never appear in a one-line pointer. The build confirms each locked string returns exactly one owner BEFORE trusting the table (a string that accidentally matches a pointer is replaced per the locking rule above).

### 10.2 Acceptance checklist

- [ ] **Dual-format rule lives in exactly one SKILL.md** — §10.1 row 1 passes both ways (present in `prd-share`; absent elsewhere); `prd-plan`/`prd-document`/`prd-closeout` show a one-sentence `skill_view` pointer. Evidence: the paired grep + a read of each pointer.
- [ ] **prd-plan delegates sharing to prd-share** (D2) — `prd-plan`'s delivery section names `prd-share` + the `skill_view` target and does not restate the full rule. Evidence: `skill_view prd-plan`. (This also covers §1.1 Row 2.)
- [ ] **Lifecycle diagram lives in one reference file** — `skill_view(name='prd-plan', file_path='references/lifecycle.md')` loads; §10.1 row 4 negative returns zero SKILL.md; each of the 5 ex-duplicators shows a one-line `skill_view` pointer + its local neighbors; the **reconciliation note** records the superset normalization. Evidence: the grep + the file + the note.
- [ ] **Evidence-stance + verification-schema + Constitution each have one owner** — §10.1 rows 5/6/7 each pass both ways (discriminating substring, not the concern name). Evidence: the paired greps.
- [ ] **6-way single-source proof is all-green** (Rows 1,3,4,5,6,7; Row 2 implicit) — each concern present in exactly one owner AND absent from every other SKILL.md in the scoped domain. Evidence: the §10.1 table run at closeout.
- [ ] **prd-closeout orchestrates harden + document** (D9) — step 0 *calls/runs* `prd-harden`, parallel to prd-document; the BLOCK-on-unclosed-failure-paths guardrail is intact AND the D11 freshness clause (no build-source change since the report) is present; the legacy "bounce" wording is gone; the dogfood shows closeout actually driving harden. Evidence: `skill_view prd-closeout` (discriminating greps) + the Phase 7 dogfood transcript.
- [ ] **Harden freshness contract enforced** (D11) — `prd-closeout` defines "current report" as no-build-source-change-since-harden (git diff --quiet on build paths) + clean working tree; stale/dirty → re-run. Evidence: `skill_view prd-closeout`.
- [ ] **No behavioral regression** — a throwaway PRD goes author→share→document→closeout; the HTML link renders, the `.md` saves, the closeout gate runs, every pointer resolves via `skill_view` one hop away. Evidence: the dogfood transcript.
- [ ] **All 9 touched skills load** — `skill_view` each edited skill INCLUDING the off-main-path ones (`prd-interview`, `prd-harden`, `prd-swarm-planner`, `prd-swarm-plan-review`); no broken `references/` links. Evidence: load output.
- [ ] **Docs + commit** — v11 PRD status note updated to reference v14; Obsidian overview updated (as Markdown, via `prd-document`); committed with a legible changelog and pushed. Evidence: `git log` + the vault doc.
