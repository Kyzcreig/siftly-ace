# Engine vs. Procedure — `kanban decompose` and `prd-swarm-planner` Are Not Redundant

**Version:** v1
**Status:** REFERENCE
**Owner:** Apollo
**Date:** 2026-06-08
**Audience:** Ace + future fleet sessions deciding how to run a swarm

---

## The question

> Is the `prd-swarm-planner` skill redundant now that native Hermes Kanban has `kanban decompose`
> (auto-slice a task into a child DAG)?

**No.** They live at two different layers. One is a *mechanical engine*; the other is the *operating
procedure that drives the engine safely*. Deleting the skill because the engine exists is like
deleting the pre-flight checklist because the plane has an autopilot.

---

## The two layers

### Layer 1 — the engine: `kanban decompose` (and the rest of native Kanban)

A **runtime executor feature** (verified live on Hermes v0.15.1). Given a task, it:

- mechanically slices it into a child DAG (`children` carry `parents:[indices]`, fan-out runs in
  parallel, the root wakes when all children complete);
- **auto-assigns each child** by an auxiliary LLM matching the child's task text against each
  installed profile's `description`;
- hands the DAG to the native dispatcher (`dispatch --max N` / `daemon`), which handles atomic
  claims, dependency ordering, retries, runtime caps, and workspace isolation.

It is **fast, automatic, and judgment-light.** That last property is the whole point — and the whole
risk.

### Layer 2 — the procedure: `prd-swarm-planner` (the skill)

A **human/orchestrator discipline** wrapped around the engine. It does the judgment the engine can't:

1. **Premise verification (§1.1/§1.2)** — probe the live system for every load-bearing factual claim
   the spec makes *before* slicing. "Already migrated / already done" is the single highest-value
   claim to verify; it's usually *partially* done in a way that silently breaks the build. Also
   decides *whether to swarm at all* (don't dispatch workers at an already-built, green tree).
2. **Disjoint write scopes (§2)** — each task owns a non-overlapping set of files, so parallel
   workers can't clobber each other.
3. **Objective eval criteria in each task body (§2.6)** — every task names concrete pass/fail checks,
   including a real end-to-end test for any new/changed real path and a hard-fail gate that can't
   silently skip itself.
4. **Model routing (§2.5)** — pin coding to the Daedalus profile (gpt-5.5 xhigh); pin review to Opus.
5. **The mandatory 2-pass senior diff-review (§2.8.1/§2.8.5)** — independently re-run every gate
   (don't trust worker self-reports), then a senior Opus review of the *integrated diff* catches the
   data-destructive bugs that all-green tests structurally cannot see.

The skill itself is explicit that it should **not rebuild the executor**:
> "WIRE INTO NATIVE KANBAN FIRST — don't rebuild the executor… this skill becomes a PRD→Kanban
> task-DAG compiler (plan→load→run)."

So the skill *uses* the engine. It is the checklist, not a second autopilot.

---

## Why the distinction is load-bearing, not academic

This is exactly how a real bug shipped (2026-06-08). A triage task was **auto-decomposed**, and the
decomposer's assignment LLM matched a *"wire the live infra hop"* child to **Aegis** — the
break-glass recovery agent — because Aegis's profile description read "versatile generalist
devops/coder." Aegis then ran the child and **committed straight to `main`, bypassing the pass-2
review gate** the rest of the swarm went through. The green suite hid a HIGH bug it introduced.

The engine did exactly what it was built to do (slice + route by description match). It had no way to
know that build/code work must be pinned to Daedalus and that break-glass agents must never receive
routine children. **That knowledge is the procedure.** The skill encodes precisely this rule:

> "the decomposer's per-child assignee is an **untrusted guess** — after any `decompose`/`specify`,
> `kanban show <child>` and confirm the assignee before dispatch."

Root-cause fixes applied (config, gatekept): `kanban.default_assignee: daedalus`, and the break-glass
profile description now leads with "BREAK-GLASS RECOVERY ONLY — never auto-assign routine build/code/
devops tasks" + `description_auto: false`.

---

## Decision rule

| You have… | Use the engine | Use the procedure |
|---|---|---|
| A task to mechanically fan out into parallel children | `kanban decompose` / `swarm` | — |
| An approved PRD/spec to turn into a *safe* build swarm | as the executor | **yes — drives the whole thing** |
| A "this is already done" claim in the spec | — | **premise-check before slicing** |
| Workers reporting green | as the runner | **independent re-verify + senior diff-review** |
| Auto-assigned children | as the router | **audit every assignee before dispatch** |

**Bottom line:** the decomposer is the *engine*; the swarm-planner skill is the *operating procedure
that keeps the engine from shipping bugs*. Always run `decompose`'s mechanical fan-out **through** the
skill's premise-check → assignee-audit → eval-bar → 2-pass-review gates. Engine vs. procedure — not
duplicates.
