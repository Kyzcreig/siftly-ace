# Wave 6 — Live Cutover Plan (P1)

**Status:** ready to execute · **Owner:** Apollo · **Date:** 2026-06-13
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

## Rollback
- Step 1/3: `git revert`.
- Step 2: restore the `.bak` prompt.md files (kept per edit).
- Nothing changes what posts (shadow returns keyword), so rollback risk is ~0 — the dedup/gatherer/diversity changes alter the candidate SET, which is the one real-output change; if a brief looks off, revert 2a/2b prompts.
