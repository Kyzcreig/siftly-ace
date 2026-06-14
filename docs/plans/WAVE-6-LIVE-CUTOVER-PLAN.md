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
