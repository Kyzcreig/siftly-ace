# Swarm Plan — Siftly-Ace Phase 1+ (Daedalus Kanban swarm)

> **Status: STAGED, NOT DISPATCHED.** This plan is GATED on Phase-0 OAuth proof
> (`xurl /2/users/56282605/bookmarks` → 200). Per `prd-swarm-planner` §2.9
> (spike/gate-gated specs) and §1.1 (verify premise before slicing): do NOT
> `kanban load`/`dispatch` any task below until the Phase-0 gate is green and the
> live ingestion fields (`saved_at`/`liked_at`, credit-balance readability) are
> confirmed against the real API. The first wave's premise (what the API returns)
> is only knowable post-OAuth.

- **PRD:** `docs/plans/PRD-ace-x-knowledge-base.md` (v5, approved)
- **Repo:** `~/Projects/siftly-ace` (fork of `viperrcrypto/Siftly`)
- **Coding worker / assignee:** `daedalus` (`openai-codex/gpt-5.5`, xhigh) — Kanban `--assignee daedalus`
- **Senior reviewer:** `claude-api-proxy/claude-opus-4-8` (F1 bridge fallback), `high`
- **Orchestration:** native `hermes kanban` board — `create` + `link` (DAG) → `dispatch --max N` / `daemon`
- **Worker cap:** 3 concurrent (write scopes below are disjoint within each wave)

---

## Premise gate (run FIRST, post-OAuth, in the main agent — NOT a worker)

Before loading any wave, confirm against the live API (these decide schema + guards):

1. `xurl --app siftly-ace /2/users/56282605/bookmarks` → **200 with data** (Phase-0 gate).
2. Field availability: does the bookmarks/likes payload expose `saved_at`/`liked_at`?
   → if NO, schema uses **source precedence** for dedupe + disables novelty calibration (PRD §5.1).
3. Credit-balance readability: is a remaining-credit value queryable?
   → if NO, credit-floor guard reduces to **timing-isolation + hard batch-caps** (PRD §5.1 D9c).
4. `forge` app `xurl auth status` **unchanged** before/after (isolation invariant).

Record findings in `AGENTS.md` and re-slice if any premise is false (skill §1.1).

---

## Wave 1 — Foundation (sequential; blocks everything)

### T1 — Ingestion + schema (Phase 1)
- **Owns (write scope):** `scripts/ingest.ts`, `prisma/schema.prisma` (additive only), `prisma/migrations/**`, `src/lib/xurl.ts`
- **Outcome:** `scripts/ingest.ts` pulls bookmarks + likes via `xurl --app siftly-ace`, dedupes by `tweetId` (bookmark wins), paginates, persists ingest state. Schema extensions per PRD §5.2.
- **Eval (objective):**
  - unit: dedupe — a tweet in both lists yields one row, `source=bookmark`.
  - unit: pagination state — second run with same cursor adds 0 dup rows.
  - e2e (real path): pull a small page from the live API → rows land with `source` + `tweetId`; `siftly stats` > 0.
- **Run:** `npm run build && npx vitest run scripts/ingest.test.ts`
- **Safety:** read-only against X API; no mutation of `forge` app; no secrets in code (token via `~/.xurl`).

> Wave-1 must land + pass review before Wave 2 dispatches (all downstream reads the schema T1 defines).

---

## Wave 2 — Parallel build on stable schema (3 disjoint workers)

### T2 — Enrichment tiers + segment + video (Phase 3)
- **Owns:** `scripts/enrich.ts`, `scripts/video-enrich.ts`, `src/lib/enrich/**`, `enrich.test.ts`
- **Outcome:** entities/tags/format-flags/categories; gated vision/OCR; segment field; video tier V (yt-dlp audio → local transcript via `parakeet-transcribe`, out-of-band queue).
- **Eval:** meme item → OCR text present; bookmarked video → transcript present + searchable by spoken word; video queue is non-blocking (doesn't run inside daily cron budget).
- **Run:** `npx vitest run scripts/enrich.test.ts`
- **Safety:** vision/OCR behind cost-estimate gate; video transcription out-of-band; discard audio/video after transcript.

### T3 — Embeddings + sqlite-vec + hybrid search (Phase 4)
- **Owns:** `scripts/embed.ts`, `src/lib/search/**`, `src/lib/vec.ts`, `search.test.ts`
- **Outcome:** embed corpus (OpenAI, swappable provider), build `sqlite-vec` table, hybrid = vec + FTS5 + rerank.
- **Eval:** sqlite-vec extension loads on macOS (else brute-force cosine fallback); 3 known-item (use-case A) queries return the known tweet top-3.
- **Run:** `npx vitest run src/lib/search/search.test.ts`
- **Safety:** none live; embeddings of public tweets only.

### T4 — Obsidian export (Phase 5)
- **Owns:** `scripts/export-obsidian.ts`, `src/lib/obsidian/**`, `export.test.ts`
- **Outcome:** patched exporter → notes with frontmatter + backlinks + meme OCR caption; index notes.
- **Eval:** export a sample → note opens in vault with correct frontmatter/backlinks; meme note has OCR caption.
- **Run:** `npx vitest run src/lib/obsidian/export.test.ts`
- **Safety:** writes only under `Obsidian/Ace Place/Content/X Bookmarks/` (scoped path).

> **Cross-worker seam (skill §2.8):** T2/T3/T4 all read T1's schema. At integration, build one
> no-mock seam test: ingest → enrich → embed → export a single real tweet end-to-end.

---

## Wave 3 — Corpus-dependent (sequential, after Wave 2 + a real backfill)

### T5 — Preference model + composition report (Phase 6)
- **Owns:** `scripts/profile.ts`, `scripts/composition-report.ts`, `profile.test.ts`
- **Outcome:** full-corpus preference model (bookmark 1.0 / like 0.3); composition report (segment split).
- **Eval:** `profile.json` populated; report prints segment distribution; weights configurable.

### T6 — Apollo chat search + web UI (Phase 7)
- **Owns:** `src/cli/search.ts` (`--json`), Siftly web UI wiring (separate dir)
- **Outcome:** `search --json` consumable by Apollo; web UI launchable.
- **Eval:** Apollo answers a real "find my bookmarks about X" with ranked links.

---

## Wave 4 — SAFETY-GATED (main-agent only for live; workers prep, never deploy)

### T7 — Brief integration + audit + safety (Phase 8) — **gated**
- **Owns:** `scripts/pf-score.py`, prompt-patch tooling (git-tracked, `.bak` before edit), `pf-score.test.py`
- **Outcome:** `pf-score.py` (30s hard timeout + base-score fallback); `PF_WEIGHT=30`, `=0` kill-switch no-op; audit frontmatter.
- **Eval (all required before any live edit):**
  - kill-switch: `PF_WEIGHT=0` → byte-identical scoring to unpatched brief.
  - failure-isolation: force `pf-score.py` to error/timeout → brief completes on base_score, logs degradation.
  - dry-run: `DRY_RUN=1` logs base/fit/final per item, **no Discord post, no seen-list write**.
- **SAFETY BOUNDARY:** workers build + test against a COPY of the live prompt. **The main agent performs the live prompt patch, only after ≥3 clean dry-runs.** No worker edits `~/.hermes/state/cron/*/prompt.md`.

### T8 — Feedback loop + daily cron (Phase 9)
- **Owns:** `scripts/feedback.py`, `scripts/daily.sh`, cron registration tooling
- **Outcome:** feedback loop (brief-surfaced → later bookmarked/liked, local tweetId match); `daily.sh`; 5:30am cron; #alerts failure routing.
- **Eval:** `daily.sh` runs manually + via `hermes cron run --wait`; failure routes to #alerts; degrades cleanly on missing morning-digest archive.
- **SAFETY:** cron registration via main agent (launchd/scheduler); credit-floor guard active.

---

## Wave 5 — Closeout

### T9 — Documentation (Phase 10)
- Run via `prd-document` + `prd-closeout`: Obsidian overview, project docs, mem0 conclude, memory pointer, acceptance-criteria sweep.

---

## Review plan (skill §5)

- After each wave: senior diff-review (Opus via F1 bridge) of the **integrated diff** + test output. Verify each finding empirically before fixing (skill §2.8.2 — reviewers hallucinate, esp. on redactor-masked identifiers).
- Hard gate before any live mutation (T7 prompt patch, T8 cron register): main-agent only, with Ace present for the first live brief.
- Final: `prd-closeout` on the whole PRD (§8 acceptance criteria → evidence).

## Safety gates that stay main-agent / manual only

1. Phase-0 OAuth grant + app registration (Ace, browser — already in flight).
2. Full backfill cost approval (Phase 2 — Ace approves the $ estimate).
3. Live brief prompt patch (T7 — after ≥3 clean dry-runs).
4. Cron registration + first live run (T8).
5. Any credit-spend backfill batch (credit-floor guard or batch-cap).
