# Spec — Per-job `reasoning_effort` override for cron jobs

**Status:** DRAFT (awaiting Ace approval → then fork PR + safe gateway restart)
**Repo:** `~/.hermes/hermes-agent` (the hermes-agent fork, `Kyzcreig`)
**File:** `cron/scheduler.py` (the one cron run path)
**Type:** small additive harness change — privileged (touches the run path + needs a gateway restart)

---

## 1. Summary & Goal

Ace wants the two Siftly brief crons (`morning-digest`, `x-feed-brief`) to run on
`claude-app/claude-opus-4-8` at **reasoning `medium`** — opus is much better at the
"synthesize, don't paste" Landscape/Timeline writing, but xhigh is more reasoning
(slower/pricier) than these jobs need.

**The blocker today:** the cron run path resolves `reasoning_effort` **globally** from
`config.yaml` `agent.reasoning_effort` (currently `xhigh`) — there is **no per-job
field**. `cron/scheduler.py:2404-2406`:

```python
from hermes_constants import parse_reasoning_effort
effort = str(_cfg.get("agent", {}).get("reasoning_effort", "")).strip()
reasoning_config = parse_reasoning_effort(effort)
```

So setting the jobs to opus (already done, reversibly) means they run **opus@xhigh**,
not opus@medium. Lowering the global key would drop *every* live session and *every other
cron* to medium too — unacceptable.

**Goal:** add a per-job `reasoning_effort` override that mirrors the **existing per-job
`model` override pattern** (line 2346), so a cron job can pin its own reasoning level
without touching global config. Then set both brief jobs to `medium`.

## 2. Non-Goals

- **No change to the global default** — `agent.reasoning_effort: xhigh` stays; live
  sessions and all other crons are byte-for-byte unaffected.
- **No new `config.yaml` key, no new `HERMES_*` env var** — the override rides the
  existing per-job storage (`cron/jobs.json`), set via the `cronjob` tool.
- **No precedence change for jobs that DON'T set it** — they keep resolving from
  `config.yaml` exactly as today.
- **No CLI/`hermes cron` surface change** — the value is set through the existing
  `cronjob(action="update", job_id=..., reasoning_effort=...)` path if the tool already
  threads arbitrary job fields; otherwise it's set by writing the job field (see §8 Open Q).

## 3. Constitution / Invariants

- **Invariant — global default unchanged for every non-opted job.**
  - *Why:* a silent global reasoning flip would change cost/latency/quality for Ace's
    live sessions and ~40 other crons.
  - *Closeout proof:* a job with NO `reasoning_effort` field resolves identically to
    today (unit test: job-without-field → `reasoning_config` == `parse_reasoning_effort(config.yaml value)`); `grep` shows `config.yaml agent.reasoning_effort` still `xhigh`.

- **Invariant — invalid/empty per-job value falls back, never crashes.**
  - *Why:* a typo'd effort (`"med"`, `""`, `None`) must not break a load-bearing daily brief.
  - *Closeout proof:* `parse_reasoning_effort` already returns `None` for unrecognized
    input (verified: `hermes_constants.py:797-812`); test that an invalid per-job value
    falls through to the config.yaml value (or global default), and the job still runs.

- **Invariant — precedence is explicit and matches the `model` override.**
  - *Why:* consistency with the established per-job pattern (per-job > env > config.yaml).
  - *Closeout proof:* per-job value, when valid, wins over the config.yaml value (unit test).

- **Invariant — cache/alternation untouched.**
  - *Why:* the project's sacred prompt-cache rule.
  - *Closeout proof:* reasoning_config is consumed exactly where it is today (passed to
    the agent run at line ~2590); we only change how the *value* is resolved, not where
    it's applied. No new tool, no system-prompt change.

## 4. Resolved Decisions

- **D-1 — Mirror the `model` override pattern, don't invent a new mechanism.** The cron
  path already does per-job `model` resolution (`model = job.get("model") or os.getenv(...) or config`). Add the identical shape for reasoning: per-job field wins, else fall to the
  current config.yaml resolution. Lowest-surprise, lowest-risk.
- **D-2 — Validate through the existing `parse_reasoning_effort`.** It already encodes the
  valid set (`none/minimal/low/medium/high/xhigh`) and returns `None` on bad input → free
  fail-safe. Per-job value is parsed with the same function; only a non-`None` parse
  overrides.
- **D-3 — Value lives in `cron/jobs.json` per-job, set via the `cronjob` tool.** No
  config.yaml edit (that's the global). Field name: `reasoning_effort` (matches the
  config.yaml key name for grep-ability).
- **D-4 — Default value to set after the patch lands: `medium` for both brief jobs.**
  Reversible anytime via `cronjob action=update`.

## 5. Architecture / Design

**One change, in `cron/scheduler.py`, immediately at the existing reasoning block
(2403-2406).** Replace:

```python
# Reasoning config from config.yaml
from hermes_constants import parse_reasoning_effort
effort = str(_cfg.get("agent", {}).get("reasoning_effort", "")).strip()
reasoning_config = parse_reasoning_effort(effort)
```

with (additive — per-job override first, else the existing config path, unchanged):

```python
# Reasoning config: per-job override (mirrors the per-job `model` override above)
# wins when it parses to a valid effort; otherwise fall back to config.yaml
# agent.reasoning_effort exactly as before. Re-read from job storage every tick so a
# `cronjob action=update reasoning_effort=...` takes effect on the next tick.
from hermes_constants import parse_reasoning_effort
reasoning_config = None
_job_effort = str(job.get("reasoning_effort") or "").strip()
if _job_effort:
    reasoning_config = parse_reasoning_effort(_job_effort)  # None if invalid → fall through
if reasoning_config is None:
    effort = str(_cfg.get("agent", {}).get("reasoning_effort", "")).strip()
    reasoning_config = parse_reasoning_effort(effort)
```

Control flow is otherwise identical; `reasoning_config` is consumed unchanged at the
agent-run construction (~line 2590). **Total diff: ~6 lines, one file.**

**Why the cron path is the only edit site:** the CLI/oneshot/gateway paths resolve
reasoning separately and are out of scope — this is a cron-only feature (Ace's ask is
two cron jobs). If those paths ever want per-invocation reasoning, that's a separate spec.

## 6. Implementation Phases

- **Phase 1 — Add the per-job override (TWO edits, per OQ-1).**
  - **1a `cron/scheduler.py`:** the ~6-line per-job reasoning resolution (§5).
  - **1b `tools/cronjob_tools.py`:** add an optional `reasoning_effort` param to the cronjob
    tool's create/update handlers (+ schema), threaded into `updates`, validated via
    `parse_reasoning_effort` (unknown → `tool_error`). Mirrors the `model` param.
  - *Unit/script check:* new tests — three resolution cases:
    (a) job with `reasoning_effort="medium"` + config `xhigh` → resolved effort is `medium`;
    (b) job with NO field + config `xhigh` → resolved is `xhigh` (unchanged);
    (c) job with `reasoning_effort="garbage"` + config `xhigh` → resolved is `xhigh` (fail-safe);
    plus a tool test: `cronjob(action="update", reasoning_effort="medium")` persists the field;
    `reasoning_effort="garbage"` returns a `tool_error` and does NOT write.
  - *E2E/integration check:* run one brief job via `hermes cron run <id> --wait` after
    setting `reasoning_effort=medium` on it, and confirm from the run's agent trace/usage
    that reasoning ran at medium, not xhigh. (Real path, real provider.)
  - *Negative/adversarial:* the `"garbage"` case proves invalid resolution fails safe; the
    tool-side `"garbage"` proves the param validates and rejects; empty-string and missing-key
    both fall through.
  - *Verify with:* `cd ~/.hermes/hermes-agent && python -m pytest tests/cron/ tests/tools/test_cronjob_tools.py -q` → new cases pass; live `hermes cron run` shows medium reasoning.

- **Phase 2 — Set both brief jobs to `medium` + safe gateway restart.**
  - *Unit/script check:* `cronjob(action="update", job_id=7a94d27271af, reasoning_effort="medium")` (and `e021c7bee158`); read back `cron/jobs.json` shows the field on both.
  - *E2E/integration check:* after a **safe gateway restart** (the privileged gate — show Ace
    the diff+impact+rollback, get explicit go, use the `safe-gateway-restart` skill), force-run
    morning-digest and confirm it (a) posts, (b) the Landscape reads coherently, (c) usage trace
    shows opus@medium.
  - *Negative/adversarial:* confirm a DIFFERENT cron (e.g. a no_agent or a different LLM cron)
    is unaffected — its reasoning still resolves from config.yaml `xhigh`.
  - *Verify with:* the live force-run + a read of another cron's resolved effort.

## 7. Security, Privacy, Ops, Observability

- **Privileged change:** edits the harness run path (`cron/scheduler.py`) AND requires a
  gateway restart to load → both halves of the §7 SOUL gate. Ship as a fork PR
  (`hermes-fork-pr-contribution` skill), show Ace the exact diff + rollback, get explicit
  go, restart via `safe-gateway-restart`.
- **Rollback:** revert the ~6-line diff (or `git revert` the PR) + `cronjob action=update`
  removing the per-job field → behavior returns to global-only. The jobs already carry a
  `model` override that's independently reversible.
- **Observability:** none added; reasoning effort already shows in the per-run usage/agent
  trace.

## 8. Risks & Mitigations

- **R1 — the `cronjob` tool may not thread an arbitrary `reasoning_effort` field into
  `jobs.json`.** If `cronjob action=update` only accepts a known field set, the value can't
  be set through the tool. *Mitigation / Open Q (§10):* verify whether the tool passes
  through unknown kwargs; if not, the smaller-surface fix is to also accept `reasoning_effort`
  in the cron update handler (a second tiny edit), OR set the field by a guarded direct
  `jobs.json` write (back up first; scheduler re-reads per tick). Decide at build time after
  grounding the tool's accepted-field list.
- **R2 — upstream fork drift.** The reasoning block could move in a future rebase.
  *Mitigation:* the change is anchored to the existing `parse_reasoning_effort` call; a
  rebase conflict is obvious and self-contained.
- **R3 — opus@medium quality regression vs xhigh on a thin-news day.** *Mitigation:* the
  Landscape prompt fix (shipped) does the heavy lifting; medium is Ace's explicit call and
  is one `cronjob update` away from xhigh if a brief reads weak.

## 9. Open Questions

- **OQ-1 — RESOLVED (ground-truthed 2026-06-30).** The `cronjob` tool builds its `updates`
  dict from an **explicit named-parameter whitelist** (`tools/cronjob_tools.py` ~790-844:
  `workdir`, `no_agent`, `repeat`, `schedule`, `model`/`provider`, …) — there is **no
  `reasoning_effort` parameter**, so `cronjob(action="update", reasoning_effort=...)` is
  silently dropped before it reaches `update_job`. (`update_job` itself merges arbitrary
  fields via `{**job, **updates}` and only blocks `id`, so storage is not the constraint —
  the tool surface is.) **Therefore the build is TWO small edits, not one:**
  1. `cron/scheduler.py` — the ~6-line per-job reasoning resolution (§5).
  2. `tools/cronjob_tools.py` — add an optional `reasoning_effort` parameter to the cronjob
     tool's `create`/`update` handlers that threads into `updates` (mirrors how `model` is
     threaded), validated with `parse_reasoning_effort` (reject unknown with a clear
     `tool_error`, same as other validated params). ~8-12 lines + the schema entry.
  Both are still small, additive, and in-scope. (Alternative if we wanted to avoid the tool
  edit: a guarded direct `jobs.json` write — but adding the proper tool param is cleaner,
  testable, and reusable, so that's the chosen path.)
- **OQ-2 — Want this for cron only, or also CLI/oneshot per-invocation reasoning?** Recommend
  **cron-only** (matches the ask; smallest surface). CLI per-invocation reasoning would be a
  separate, larger spec.

## 10. Acceptance Criteria

- [ ] A cron job with `reasoning_effort="medium"` resolves to medium while config.yaml stays `xhigh`. Evidence: new pytest case (a) passes.
- [ ] A cron job with no field resolves identically to today. Evidence: pytest case (b) passes + global key still `xhigh`.
- [ ] An invalid per-job value fails safe to the config value. Evidence: pytest case (c) passes.
- [ ] Both brief jobs run opus@medium live. Evidence: force-run usage trace shows opus + medium; brief posts; Landscape coherent.
- [ ] No other cron/session changed. Evidence: another cron's resolved effort still `xhigh`.
- [ ] Shipped as a fork PR + gateway restart via the privileged-gate process. Evidence: PR link + `safe-gateway-restart` run.
