# Wave 6 — Live Cutover Plan (P1)

**Status:** EXECUTED (pf shadow live 2026-06-13; output-feature staging live 2026-06-14); embed promotion + output live-wire deferred to data-gated follow-ups · **Owner:** Apollo · **Date:** 2026-06-13/14
**Principle:** ship the PLUMBING (shadow-mode, dedup, gatherers, diversity) which is byte-identical-safe; do NOT flip `embed` (no shadow data yet — AC#9 gate has zero evidence). `embed` promotion auto-surfaces to Ace in ~3+ days once shadow data accrues.

## What the cutover IS today (all safe / byte-identical)
1. **Provision embed env in the pf-score chain** so shadow mode genuinely computes the embed delta + telemetry every live run.
2. **Hard-Config `prompt.md` edits** (gated — diff below): pf-score stays SHADOW; wire cross-brief dedup; add discovery gatherers (morning-digest); MMR diversity at select; trim x-feed interest searches.
3. **Start shadow accumulation + provenance logging** → the AC#9 ≥3-run ≤10% gate becomes evaluable.
4. **CI follow-up:** pin the vec extension so the shadow byte-identity guard can't silently skip.

## What the cutover is NOT (correctly deferred, no evidence yet)
- `PF_AFFINITY_MODE=embed` promotion — needs ≥3 shadow runs ≤10% per-brief gate-cross + the saw-didn't-save eval (~14d provenance). **Zero shadow runs exist today.** Promoting now = rubber-stamping an evidence-free gate. DEFERRED.

## Proven on the real chain (2026-06-13, before any wiring)
With `OPENAI_API_KEY` + `SIFTLY_SQLITE_VEC_EXTENSION_PATH` set, a shadow run through `pf-audit.py → pf-score.py → tsx embed helper → vec0 KNN`:
- **Brief gets:** `affinity_source=keyword_fallback`, keyword delta (byte-identical to today). ✓
- **Audit channel gets:** real embed data — `vec_metric=l2norm`, `embedding_affinity=0.5002`, `shadow_personal_fit_delta=11.87`. ✓
- The embed path genuinely ran (real OpenAI embeddings), live output unchanged.

## The wiring GAP found (real, must fix)
`pf-audit.py` spawns `pf-score.py` with bare `os.environ` (no `env=` provisioning). In the live cron, `OPENAI_API_KEY`/`SIFTLY_SQLITE_VEC_EXTENSION_PATH` are absent → shadow silently keyword-falls-back with NO embed audit data (confirmed: first dry-run had `shadow_delta=None`). **Fix = pf-audit provisions the embed env before spawning** (repo code change, NOT a plist edit).

---

## Step 1 — pf-audit.py provisions embed env (repo code, no approval needed)
`pf-audit.py run_pf_score`: build a child env that loads `OPENAI_API_KEY` (1Password, via the same `with-secrets.sh` op path the project already uses) + sets `SIFTLY_SQLITE_VEC_EXTENSION_PATH=.local/vec0.dylib`, and pass `env=` to the subprocess. Fail-OPEN: if the secret can't load, run pf-score anyway (it keyword-falls-back — brief never breaks). This keeps shadow data flowing in cron without putting secrets in the plist.

## Step 2 — HARD-CONFIG prompt.md edits (GATED — exact diffs below, await Ace confirm)
### 2a. morning-digest/prompt.md
- Set `PF_AFFINITY_MODE=shadow` in the pf-audit invocation env (explicit; default is already shadow).
- After gather/dedupe, call the cross-brief dedup store (`cross-brief-dedup.ts`) to suppress stories already surfaced by x-feed-brief same PT-day.
- Add discovery gatherers (Reddit + GitHub-Trending) to the gather block, normalized via `engagement-normalize.ts`.
- Apply MMR diversity (`diversity-rerank.ts`) at the select step.
- Log surfaced items via `surfaced-provenance.ts` (starts the saw-didn't-save clock).
### 2b. x-feed-brief/prompt.md
- Set `PF_AFFINITY_MODE=shadow`.
- Consult + update the SAME cross-brief dedup store.
- TRIM interest-searches to the minimum (discovery is morning-digest's job now).
- Log surfaced items via `surfaced-provenance.ts`.

(Each edit: backup the prompt.md, show diff, apply, verify.)

## Step 3 — CI guard (repo code)
Pin `SIFTLY_SQLITE_VEC_EXTENSION_PATH` in `npm run verify` (or document the provisioned-CI requirement) so the A1 shadow byte-identity guard arms instead of silently skipping.

## Step 4 — Observe
After ≥3 daily shadow runs: read the pf-audit artifacts, compute the per-brief gate-cross % (AC#9), and surface the promotion decision + 3-run diff to Ace. Only then, with evidence, flip `embed` (a one-line `brief-config.json` change, gated).

### Step 4a — DETERMINISTIC-SCORER cutover gate (label_coercion_count) — ✅ RESOLVED / MOOT (2026-06-18)

**CORRECTION (2026-06-18, verified):** the deterministic scorer is NOT pending — it has driven live posting since **2026-06-11**. Both briefs run `select_digest.py --engine deterministic`, which calls `score_digest.py:select_shadow()` (a misleadingly-named LIVE path, not shadow) as the selection authority. The `e1d3ee5` backstop fix is reachable from that path (`select_shadow → score_item → python_on_topic → _topic_text/off_topic_repo_marker`) and `e1d3ee5` is an ancestor of live HEAD, so the "shadow-only" label on that commit was inaccurate — it has been in production since it landed. Proven three ways: (1) call-graph reachability; (2) `git merge-base --is-ancestor e1d3ee5 HEAD` = true on a clean tree; (3) re-running the deterministic engine on today's real 173-item pool byte-matches the set that actually posted to #daily (incl. 3 Reddit + 1 HN item — so the Reddit/GitHub gatherers of Step 2b are live too, 403 solved via RSS).

**Therefore the `label_coercion_count == 0` streak is NOT a pre-cutover gate** — the cutover already happened. `coercion == 0` remains a useful *health* invariant (the live engine's labels still agree), but it gates nothing. The original gated-wait text is struck below for history.

~~The deterministic scoring engine (`score_digest.py`) has a SECOND, independent cutover gate from the `embed` flip above. Do NOT wire deterministic scoring into the live `prompt.md` until `label_coercion_count == 0` for 4–6 consecutive daily runs.~~ — moot; deterministic scoring was already wired 2026-06-11.

**Still genuinely pending (unchanged):** the `PF_AFFINITY_MODE` shadow→embed *personal-fit* promotion — that IS still shadow and still needs its ≥3-run ≤10% gate-cross evidence (Step 4 above). Don't conflate it with the scorer cutover, which is done.

### Step 4b — PF embed-promotion gate: MEASURED (2026-06-18) + weekly auto-eval wired

Collection is automatic (pf-audit logs keyword vs embed deltas per item every run; 5+ clean runs/brief accrued by Jun 18). The ≥3-run count bar is met; the ~14d saw-didn't-save provenance window matures ~Jun 28.

**Rigorous gate-cross MEASURED (not the delta-diff proxy):** `scripts/pf_gatecross_eval.py` re-runs the LIVE deterministic selection twice over each brief's real pool (keyword delta vs embed delta) and counts true posted↔not-posted flips. Result on Jun 18 real pools (100% id-match):
- morning-digest: **72.7% gate-cross** (4 drop / 4 enter of 11-union) — FAIL ❌ (>10%)
- x-feed-brief: **75.0% gate-cross** (6 drop / 6 enter of 16-union) — FAIL ❌ (>10%)

**Root cause (fixable, NOT a bad embed signal):** the embed delta is a large near-uniform **+10.6** offset (range +8.7…+13.0), vs the keyword delta's discriminating mean **+0.4** (range −3.6…+8.2). `PF_CAP=12` then compresses the embed scores together. This is a **`PF_BASELINE` miscalibration** for the embed-affinity distribution (affinity−baseline is positive for nearly every item) — recalibrate the baseline to the embed affinity median before any promotion. Promoting as-is would churn ~3/4 of the posted set, not refine it.

**Weekly auto-eval:** no_agent cron `siftly-pf-gate-eval` (job `4a72b4560fa5`, Mondays 9:30am PT, script `~/.hermes/scripts/siftly-pf-gate-eval.py`) runs the evaluator and posts a decision card to the #daily thread ONLY when the gate-cross passes (≤10%) — silent otherwise (alert hygiene). When both gate-cross AND the matured provenance window pass, it surfaces the one-line `PF_AFFINITY_MODE=embed` flip for Ace's go. Verified through the real scheduler (SILENT now — gate fails).

**Daily side-by-side preview (Ace's call 2026-06-18 — judge by eye, not by %):** no_agent cron `siftly-pf-preview` (job `54ca29c4343e`, daily 8:00am PT, script `~/.hermes/scripts/siftly-pf-preview.py`) renders BOTH briefs keyword-vs-embed from each morning's real pool and posts a compare card to the #daily / Twitter-Bookmark-Job thread (`1513211118573584495`). PREVIEW ONLY — never posts to #daily, never mutates seen-lists/render_input/brief state; reads pools + pf-audit, writes only /tmp + one Discord message. Morning uses the real `render_digest.py` contract; x-feed uses a ranked-list (no deterministic renderer exists for it). Purpose: accumulate a few days of eyeball comparisons, then Ace picks **refinement** (recalibrate `PF_BASELINE`, keep churn ≤10–20%) / **taste-forward** (accept churn, change the gate) / **hybrid** (embed → Also Noted first) / **stop**.

**Watchdog status:** `siftly-coercion-gate-watch` (job `581751ef427a`) was PAUSED 2026-06-18 because its "GATE MET → go cut over" message is now misleading (cutover already live). Kanban `wave6` task `t_b32e3b4d` closed as moot. If a coercion-regression alarm is wanted, repurpose the script to fire to #alerts on coercion > 0 instead.

## Rollback
- Step 1/3: `git revert`.
- Step 2: restore the `.bak` prompt.md files (kept per edit).
- Nothing changes what posts (shadow returns keyword), so rollback risk is ~0 — the dedup/gatherer/diversity changes alter the candidate SET, which is the one real-output change; if a brief looks off, revert 2a/2b prompts.

---

## UPDATE 2026-06-14 — output-changing features STAGED (not yet wired)

Step 2's output-changing pieces (cross-brief dedup, MMR diversity, discovery gatherers) were **NOT** wired into the live `prompt.md` at cutover — same reason `embed` wasn't flipped: they change the posted SET and had zero validation evidence. Instead they're now in a shadow/validation window mirroring the pf-score discipline (commit `a3f9e8f`):

- **`scripts/output_shadow.ts`** — offline, read-only over both briefs' real run dumps using the REAL modules. Reports cross-brief would-suppress dedups + within-posted MMR author-cap drops/reorders + starts the saw-didn't-save provenance clock. Idempotent. Artifacts → `~/.hermes/state/x-bookmarks/output-shadow/`.
- **`scripts/gatherer_probe.ts`** — live reddit+github-trending inflow probe; reports volume + net-new-vs-briefs. **Finding: reddit JSON = HTTP 403 from this host (datacenter-IP block); github-trending healthy.** Final placement deferred to the gated live-wire.
- **`wave6-output-shadow-watch`** (no_agent cron, daily 9am, job `d8ff8fbce6b1`) drives both daily + reports staging-readiness once ≥3 runs/brief accrue. Silent until then.
- Tests: `scripts/__tests__/output-shadow.test.ts` (8). `npm run verify` exit 0.

**The gated live-wire (Step 2a/2b, the dedup/MMR/gatherer half) remains OUTSTANDING** — it waits on the staging window's evidence + Ace's sign-off, and (for reddit) on solving the 403. When ready: ONE `prompt.md` edit per brief, back up the `.bak` first, restore-the-`.bak` to roll back.

Status line: **shadow live (pf + output-staging); both promotions/wire-ins evidence-gated and auto-surfacing.**
