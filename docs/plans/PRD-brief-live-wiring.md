# PRD — siftly-ace Brief Live-Wiring (gatherers + output features + ops)

- **Status:** v5 (Pass-1 v4 APPROVE WITH CHANGES from 3 independent Opus reviewers — all blockers fixed:
  preflight-paradox purged, per-source Reddit time box + day-seeded rotation, bounded per-fetch timeout +
  black-hole test, zero-exit-bad-output schema validation, pool-identical canary, rotation-aware aggregate
  silent-block, OQ-2 gated. Re-review (Pass 2) before build.)
- **Project:** siftly-ace (`Kyzcreig/siftly-ace`)
- **Owner:** Apollo
- **Scope:** wire the built-but-unwired discovery + output features into the LIVE morning-digest brief,
  plus the two ops loose ends (silent-block warn, Starlink proxy uptime) and the cosmetic curl-warn.
- **Supersedes:** the "deferred to the future live-wiring PRD" loose-ends list from
  `docs/closeout/reddit-rss-lanes-closeout.md` and `reddit-rss-pivot-closeout.md`.

---

## 1. Summary & Goal

Five things are built, tested, and unwired. This PRD wires them into the live brief **safely**, behind
shadow-evidence + explicit config gates, smallest-blast-radius first:

1. **Discovery gatherers** (Reddit RSS + github-trending) → add their candidates to the morning-digest
   gather step, deduped + scored like every other source.
2. **Output-changing features** (cross-brief dedup, MMR diversity, surfaced-provenance) → wire into the
   posted-set path after their shadow window proves them safe.
3. **Silent-block warn** — alert when Reddit `fetched==0` for N consecutive days (a silent RSS block
   must not masquerade as "nothing hot" forever).
4. **Starlink proxy uptime at cron time** — ensure the SOCKS lane the gatherer round-robins onto is up
   when the cron fires, or degrade loudly-enough-to-notice.
5. **Cosmetic** — the proxy-down warn echoes the full curl argv; trim to a clean message.

**Goal:** the morning-digest brief gains Reddit + github-trending discovery inflow and the dedup/
diversity quality features, with **zero regression** to the load-bearing daily post, each change
individually reversible, and each gated on evidence + Ace approval.

## 2. Non-Goals

- **No new scoring model / ranker rewrite.** Gatherer candidates flow through the EXISTING
  score→select→render path; they are just more candidates.
- **No X-feed-brief gather change.** The X-feed brief (7:30am) sources X only; gatherers go into the
  morning-digest only (the general-news brief). (Cross-brief *dedup* still spans both — that's feature 2.)
- **No new gatherer sources** beyond Reddit + github-trending (both already built).
- **No always-on daemon** for the proxy — lane health is the first-real-fetch signal (D-4/D-11), not a
  new service or a separate probe.
- **No auto-flip of any gate.** Every prompt.md / plist / go-live edit is an explicit Ace-approved gate.
- **No backfill / ingestion change** — this is the *brief* path, not the bookmark ingestion path.

## 3. Constitution / Invariants

- **Invariant: the morning-digest brief NEVER regresses.** A gatherer failure, a dedup/diversity bug,
  or a proxy outage must not produce an empty digest, a crash, a double-post, or a worse post than
  today. Every new source/feature degrades to "as if it weren't there."
  - *Why:* the 7:00am digest is load-bearing and Ace-visible daily.
  - *Closeout proof:* dry-run the full brief with each new source forced to fail → digest still posts a
    valid set; ≥3 live shadow runs show no posted-set regression before any go-live gate.
- **Invariant: config-class edits are GATED, backed up, and reversible.** Any edit to
  `~/.hermes/state/cron/morning-digest/prompt.md` or a launchd plist is shown as a diff, `.bak`-ed
  (timestamped, matching the existing `prompt.md.bak-*` convention), Ace-approved, and one-command
  rollback (restore the `.bak`).
  - *Why:* the prompt is the brief's program; an unilateral edit is the highest-blast-radius action here.
  - *Closeout proof:* each gate (G1/G2/G3) records the diff + `.bak` path + Ace's approval.
- **Invariant: one run = one post (idempotency preserved).** Adding sources/features must not break the
  existing PT-day post-marker short-circuit (Step 0) or cause a second post.
  - *Why:* the multi-post bug (2026-06-09) is a known, fixed failure mode; wiring must not reopen it.
  - *Closeout proof:* dry-run twice with the same RUN_ID → second run short-circuits, no second post.
- **Invariant: gatherer candidates merge-back-by-id, no value invention.** A gatherer candidate that
  reaches the digest carries its real title/url/author; engagement stays honest-zero (Reddit RSS) — the
  scorer must not fabricate engagement for it.
  - *Why:* honest-data rule; a zero-engagement reddit item is correct, not a hole to fill.
  - *Closeout proof:* a wired dry-run shows reddit candidates with `engagement=0` flowing through scoring.
- **Invariant: alerts follow fleet routing.** Failures → `#alerts` (`1480528231286181948`); quiet/
  healthy ticks → `#logs` (`1480525090331561984`) or silent. No success-noise in `#alerts`.
  - *Closeout proof:* the silent-block warn routes to `#alerts`; the healthy path is silent.

## 4. Resolved Decisions (carried from prior work + this scope)

- **D-1 — Gatherers go into morning-digest only**, as additional gather sources (`gather_reddit`,
  `gather_github`), parallel to the existing `gather_hn`/`gather_x` blocks. They flow through the same
  dedupe→score→select→render path.
- **D-2 — Shadow-evidence gate with PRE-COMMITTED ceilings + a canary that can FAIL (B1/RC-A/RC-C).**
  Cross-brief dedup + MMR + surfaced-provenance wire in only after the shadow window meets ceilings
  **committed here, before seeing the data** (G3 may TIGHTEN, never loosen): cross-brief dedup
  suppresses **≤20%** of a run's posted set; **≤2** author-cap-driven reorders/run; posted-set-size
  shrink **≤30%** (>30% = auto-block pending Ace). Fitting the bar to the observed numbers is forbidden
  — that's a circular gate. Because `output_shadow.ts` does NOT exercise live pool-replacement, the
  **canary is the real gate**: wire → run ONE real brief over a **frozen candidate pool**, scored once,
  then run select/render **twice over that identical pool** — features OFF (the frozen baseline) vs
  features ON — and diff the two. The baseline MUST be the same-pool features-OFF artifact, NOT a prior
  day's digest (the digest changes day to day regardless of features; a cross-day diff proves nothing —
  Pass-1 f2-B-1). **Canary FAIL condition (RC-C):** any posted item dropped that the shadow did NOT
  predict, OR set-size shrink beyond the ceiling, OR a brand-new item the scorer didn't rank → **rollback
  the `.bak` + re-shadow**. Only a clean pool-identical canary leaves the features on.
- **D-2b — ≥3 runs incl. a DEFINED high-volume day (B1 residual).** "High-volume" = a run whose
  **post-normalization** candidate count (NOT raw — raw is confounded by which subs the rotation drew
  that day, Pass-1 B-2) is ≥ the 75th percentile of the observed window, OR an absolute floor that MUST
  be closed from Phase-1 perf data before G3 fires — not a judgment call a quiet week silently satisfies.
- **D-5b — github-trending gets the SAME silent-block treatment (RC5).** An HTML-scrape source can drift
  to 0-results-forever just like Reddit can block. The silent-block watchdog (D-5) covers BOTH sources:
  alert if github `fetched==0` for N consecutive days too.
- **D-3 — Gatherers can wire BEFORE the output features.** Adding a source is lower-blast-radius than
  changing the posted-set algorithm. Sequence: gatherers first (G1), output features second (G3), after
  their shadow window. They're independent gates.
- **D-4 — Lane health = the first real gather fetch itself, no separate preflight (B2/RC-B).** A
  separate preflight fetch would burn one of Reddit's ≈1-fetch/window/IP budget and *cause* the 429 it's
  trying to detect (the preflight paradox). So there is NO separate probe: the gatherer's **first real
  per-lane fetch IS the health signal** — its candidates are kept if 200, and a non-200/throw on a lane
  marks that lane down for the rest of the run (remaining subs go to a healthy lane or direct). The
  gatherer already does bounded 429-retry + never-throw + graceful `[]`, so a dead lane self-degrades
  without spending budget twice. (Drop the "preflight" concept entirely — it was the lying proxy signal.)
- **D-4b — Seen-list semantics for new sources (RC3) + rotation interaction (Pass-1 B-2).** Reddit/github
  candidates get written to a **dedicated per-source seen-list** (`reddit-brief-seen.json`,
  `github-brief-seen.json`, same shape as `x-brief-seen.json`) so the same item doesn't resurface day
  after day. Cross-brief dedup (feature 2, its own DB) is orthogonal and additive. A reddit item
  crossposted from HN is also caught by the existing URL-dedupe across sources. **Because D-10 rotates
  ~5-of-9 subs/day, a sub not scheduled today is EXPECTED to contribute 0 — this is not a block.** The
  seen-list is keyed by item id (not sub), so a sub rotating back in after 1-2 days surfaces its genuinely
  new hot items and correctly suppresses ones already posted.
- **D-5 — Silent-block warn = a no_agent watchdog with STALENESS detection (RC4) + rotation-aware metric
  (Pass-1 B-2).** A small daily `no_agent` cron reads the gatherer-probe artifacts; alerts `#alerts` if
  EITHER (a) **aggregate Reddit** `fetched==0` (i.e. ZERO across ALL scheduled subs that day — any single
  sub >0 = healthy; a per-sub zero is expected under rotation and must NOT alert) for N=3 consecutive
  RUN days, OR (b) the newest probe artifact is older than N days (a dead probe/cron is NOT health —
  missing ≠ zero, but a stale input is its own alert). Asserts the probe-artifact shape it parses
  (version/keys) and alerts on a schema mismatch rather than silently mis-reading. N=3 default,
  tunable; tie N to measured lane uptime once Phase 1 has data.
- **D-6 — Cosmetic curl-warn fix is a 1-line change** in `scripts/gather/reddit.ts`: the proxy-down
  catch emits `reddit gather <sub> via <lane>: proxy unreachable (<short msg>)` instead of echoing the
  full curl argv. Ships with the gatherer-wire phase (it's the same file).
- **D-7 — No new dep, honest-zero engagement, never-throw** — all carried from the gatherer PRD; the
  wiring must not violate them.
- **D-8 — Fallback-on-throw AND on-bad-output lives IN the prompt block (RC-D + Pass-1 B-3).** The output
  features are TS modules invoked from a prompt.md shell step — a throw there does NOT auto-degrade. The
  Phase-3 block MUST (a) capture the module's exit code and, on non-zero, pass through the **pre-feature
  (un-deduped) candidate set**; AND (b) **validate the module's stdout** (parse JSON + assert the expected
  shape/count) before trusting the deduped set — a zero-exit-with-truncated/garbage payload (OOM mid-write,
  partial JSON, half-flushed lane timeout) MUST also trigger the un-deduped fallback. Exit-code capture
  alone is insufficient. Both paths are part of the G3 diff and required Phase-3 E2Es (forced throw →
  un-deduped; forced zero-exit-garbage-stdout → un-deduped).
- **D-10 — Per-source Reddit time box + day-seeded rotation (Pass-1 B-1/B-2, f1-B-1).** Live-measured
  budget (§5.2) means the Reddit step must be bounded: (a) each run fetches a **day-seeded rotating
  ~5-of-9-sub subset** (`subset = rotate(SUBS, dayOfYear)[:5]`, deterministic, full 9-sub coverage over a
  ≤2-day cycle); (b) the two lanes fetch **concurrently** (Spectrum direct ‖ Starlink SOCKS), not
  serialized; (c) the Reddit step has a hard wall-clock cap (≤180s) independent of the global 20-min
  AbortController, so a slow/throttled Reddit never starves enrich/embed/export/score. The **high-volume-day**
  definition for the shadow/G3 gate uses **post-normalization candidate count** (or an absolute floor from
  Phase-1 perf data), NOT raw count — so the rotation schedule can't confound it (D-2b's "absolute floor
  TBD" MUST close with Phase-1 perf data before G3 fires).
- **D-11 — Bounded per-fetch lane timeout (f1-B-2).** Every gather fetch (direct + SOCKS) uses a bounded
  connect+read timeout (≤8s). A black-hole proxy (connects, never responds) fails that one fetch within
  the timeout → lane marked down for the run → remaining subs route to the healthy lane/direct. Required
  Phase-1 test: a black-hole proxy degrades within the time box, not a hang. (R2 mentioned a ~2s preflight
  check — that preflight is DELETED per D-4; this timeout is on the real gather fetch.)
- **D-9 — The watchdog must be able to report its own death (RC-E).** The silent-block watchdog reads
  artifacts from a *different* cron; if both die (sleep, launchd unload) it can't alert. Backstop
  (preferred, quiet): cover the watchdog with the **cron-observability stack** (`cron.ace` ledger /
  `cron-observability-ops`) that already flags a job that stops checking in — so its silence is detected
  WITHOUT success-noise in `#alerts`. (A `#logs` heartbeat is the fallback only if the obs stack can't
  cover a `no_agent` job.) "The watchdog that can't report its own death" is a known fleet failure mode,
  explicitly closed here.

## 5. Architecture / Design

### 5.1 Current state (ground-truthed 2026-06-14)
- Morning-digest gathers via prompt-driven shell blocks (`gather_perplexity`, `gather_hn`,
  `gather_smol_latent`, `gather_x`) in `~/.hermes/state/cron/morning-digest/prompt.md`. Candidates are
  deduped (incl. against `x-brief-seen.json`), scored (`score_digest.py`), selected
  (`select_digest.py`), rendered (`render_digest.py`), posted once (PT-day marker short-circuit).
- The TS gatherers (`scripts/gather/reddit.ts`, `github-trending.ts`) are referenced ONLY by
  `scripts/gatherer_probe.ts` + their tests — **not** by any brief or by select_digest.
- Output features (`scripts/lib/cross-brief-dedup.ts`, `diversity-rerank.ts`, `surfaced-provenance.ts`)
  are exercised ONLY by `scripts/output_shadow.ts` (offline) — **not** wired into the posted path.
- `wave6-output-shadow-watch` (daily 9am no_agent) accumulates shadow evidence; silent until ≥3 runs/brief.

### 5.2 Phase 1 — gatherer wire-in (feature 1 + cosmetic, gate G1)
- Add a `gather_reddit` + `gather_github` step to the morning-digest prompt: invoke the TS gatherers
  (`tsx scripts/gather/reddit.ts --subreddit … --lane '' --lane socks5://192.168.1.217:1080` +
  `tsx scripts/gather/github-trending.ts`), emit candidates in the same shape the other gather blocks
  produce, dedupe against the seen-list, feed into scoring.
- **Lane health (D-4, no separate preflight):** the gatherer's first real per-lane fetch IS the health
  signal — a non-200/throw marks that lane down for the run (remaining subs → healthy lane or direct),
  via the gatherer's existing never-throw + graceful-`[]`. No separate probe (it would double-spend the
  per-IP budget and cause the 429 it detects). Lane-down is noted in the perf log.
- **Cosmetic (D-6):** the proxy-down warn in `reddit.ts` becomes a clean message.
- **Subreddit set (LOCKED with Ace, OQ-1 resolved):** a curated 9-sub AI set, technically-literate /
  builder-aligned, spread across the two lanes (round-robin by index):
  `LocalLLaMA`, `MachineLearning`, `artificial`, `singularity`, `OpenAI`, `AI_Agents`, `LLMDevs`,
  `ChatGPTCoding`, `StableDiffusion`. Rationale: open-model + research + agent-builder + AI-coding +
  image-gen niches; marketing-heavy/low-signal subs (`r/ChatGPT`, general `r/ArtificialIntelligence`)
  deliberately excluded to keep candidate quality high. List is config (CLI `--subreddit` flags in the
  prompt block), trivially tunable post-launch.
- **RSS budget ground-truth (LIVE-MEASURED 2026-06-14, all 9 subs):** every sub returns HTTP 200 and is
  real (none 404). BUT the per-IP RSS budget is tighter than the `DEFAULT_DELAY_MS=2500` assumed: 9 subs
  across 2 lanes (~4-5 fetches/IP) **mass-429 at 2.5-3s gaps**; reliable 200s needed **~45-60s spacing
  per IP** in testing. Implication for Phase 1 (no spec change to the never-throw design, but a tuning +
  honesty requirement): (a) a 429'd sub contributes `[]` that run — correct, not a crash, but with 9
  subs and a 20-min-budget cron we must NOT serialize at 60s/sub (that's 9-10 min just on Reddit). So
  Phase 1 MUST either (i) raise `DEFAULT_DELAY_MS` AND cap subs-per-run to a rotating subset (e.g. 4-5
  subs/day, rotated by day-of-year so all 9 get covered over ~2 days), or (ii) accept partial coverage
  per run as designed. Decision: **rotating subset of ~5 subs/run across the 2 lanes**, day-seeded, so
  no single run exceeds the budget and the cron stays well inside 20 min. This is now an AC (AC-7).
- **github-trending (LOCKED with Ace, OQ-3 resolved): IN from Phase 1**, alongside Reddit (both built,
  both wired same gate). github-trending is the more reliable source (HTML scrape, no per-IP RSS budget).
  LIVE-VERIFIED 2026-06-14: returns 15 real candidates, exit 0, honest normalized engagement. Note it is
  general trending (not AI-filtered) — candidates flow through the existing scorer like any other source.

### 5.3 Phase 2 — silent-block + staleness watchdog (additive cron)
- New `no_agent` cron `siftly-gatherer-silentblock-watch` (daily): read the last N gatherer-probe
  artifacts; alert `#alerts` if (a) Reddit OR github `fetched==0` for N=3 consecutive days, OR (b) the
  newest artifact is older than N days (dead probe/cron), OR (c) the artifact shape doesn't match the
  asserted schema. Else silent. Pure stdlib, exits 0 always, can't touch the brief. Additive (new
  watchdog), install is a launchd plist (G2 plist-gate).

### 5.4 Phase 3 — output-feature wire-in (feature 2, gate G3 + canary, AFTER shadow window)
- Precondition: the shadow window meets the **numeric thresholds** (D-2: ≤X% dedup-suppress, ≤Y
  reorders, ≤Z% shrink) over ≥3 runs **including ≥1 high-volume day** (D-2b). Ace reviews the numbers.
- Wire cross-brief dedup + MMR diversity + surfaced-provenance into the posted-set path (the single
  gated `prompt.md` edit the shadow harness was built to de-risk). Back up, diff, Ace-approve.
- **Canary (D-2: shadow can't prove pool-replacement):** after wiring, run ONE real brief, diff its
  posted set vs the un-wired baseline + the shadow prediction; Ace reviews the live diff; THEN leave on.
- Rollback = restore the `.bak`.

### 5.5 The gates (your G1/G2/G3 pattern)
- **G1 — gatherer prompt edit + ≥3 dry-runs.** Show the `prompt.md` diff + `.bak`; dry-run the brief 3×
  (no post) proving reddit+github candidates flow through, the digest still posts a valid set, and a
  forced gatherer failure degrades cleanly. Ace approves → live.
- **G2 — launchd plist installs** (silent-block watchdog; any cron change). Show the plist; install;
  verify loaded.
- **G3 — output-feature go-live (numeric + canary).** After the shadow window: show the `prompt.md`
  diff + the accumulated shadow evidence **against the numeric thresholds** (D-2) over ≥3 runs incl. a
  high-volume day; Ace approves → wire → **canary**: one real brief, posted-set diff vs baseline +
  shadow prediction reviewed → leave on; watch the next real run.

## 6. Implementation Phases

- **Phase 1 — Gatherer wire-in + lane health-via-first-fetch + cosmetic warn (gate G1).**
  - *Unit/script check:* `reddit.ts` proxy-down warn is the clean message (assert in the existing test);
    a gather-block dry-run helper emits reddit+github candidates in the digest candidate shape; the
    day-seeded rotation selector has a deterministic unit test (full 9-sub coverage over the rotation).
  - *E2E/integration check:* **required** — dry-run the FULL morning-digest brief (no post) 3×: (a)
    reddit+github candidates appear in `_debug_candidates.json`; (b) a forced reddit failure
    (bad lane + bad direct) → digest still posts a valid set; (c) second same-RUN_ID run short-circuits
    (no double-post); (d) **github off-topic check** — confirm a trending NON-AI repo (e.g. a game
    engine, an IPTV list) scores BELOW the post gate, i.e. the existing scorer rejects un-filtered
    github-trending noise (Pass-2 residual #4). **The perf log MUST be captured and inspected for the actual Reddit-step wall time
    and per-IP fetch spacing across all 6 sources (D-10) — recorded before G1, not promised.**
  - *Negative/adversarial:* Starlink lane down → its first real gather fetch returns non-200/throws
    within the bounded per-fetch timeout (D-11), that lane is marked down for the run, remaining subs go
    to the healthy lane/direct, logged, brief unaffected. Includes a **black-hole proxy** case (connects,
    never responds) that must degrade within the per-fetch timeout, not hang.
  - *Verify with:* the 3 dry-runs' `_debug_candidates.json` + perf log show reddit/github source counts
    AND Reddit-step wall time under the per-source time box with zero 429s; `git diff` of `prompt.md` +
    `.bak` recorded.

- **Phase 2 — Silent-block + staleness watchdog (gate G2 for the plist).**
  - *Unit/script check:* synthetic probe artifacts → 3 consecutive `fetched==0` (reddit OR github)
    emits an `#alerts` line; single nonzero in window → silent; newest artifact older than N days →
    staleness alert; shape mismatch → schema alert.
  - *E2E/integration check:* **required** — run against the REAL probe artifact dir → correct decision;
    routes to `#alerts` channel id.
  - *Negative/adversarial:* empty/missing dir → **staleness alert (NOT silent)** — a dead input is not
    health; malformed artifact → schema alert, not a silent mis-read.
  - *Verify with:* `python3 <watchdog>.py` on real + synthetic dirs (zero-streak, stale, malformed);
    plist `launchctl list`.

- **Phase 3 — Output-feature wire-in (gate G3 + canary, shadow-gated).**
  - *Unit/script check:* the wired path applies cross-brief dedup + MMR + provenance (modules already
    unit-tested; assert the wire-in calls them on the posted set).
  - *E2E/integration check:* **required** — (a) dry-run post-wire: posted set reflects dedup/MMR vs the
    un-wired baseline; (b) **canary live run**: real posted set diffed vs baseline + shadow prediction,
    proving the live pool-replacement behavior the shadow harness can't.
  - *Negative/adversarial:* **forced module non-zero exit (D-8)** → the prompt block catches the exit
    code and passes through the pre-feature un-deduped set; the brief still posts (never an empty/aborted
    digest from a dedup/MMR throw).
  - *Verify with:* dry-run diff + canary live diff reviewed against the numeric thresholds; ≥3 shadow
    runs incl. a high-volume day.

## 7. Security, Privacy, Ops, Observability

- **Credentials:** none new. Gatherers use no creds; lanes use the existing SOCKS proxy.
- **Alerts:** silent-block → `#alerts`; healthy → silent. Gatherer-failure-in-brief → existing digest
  footer source-count (`0 Reddit`) + perf log, not a noisy alert (a source being empty one day is normal).
- **Observability:** perf log gains `raw_reddit`/`raw_github` + `sources_reddit`/`sources_github`
  counts (mirroring the existing per-source dedupe stats), so inflow is visible in `digest-perf.jsonl`.
- **Rollback:** every gate is a `.bak` restore. Phase 2 watchdog = `launchctl unload` + remove plist.
- **Config-gate compliance:** G1/G2/G3 each = diff + backup + Ace approval (Hard Config Rule).

## 8. Risks & Mitigations

- **R1 — Gatherer inflow drowns/saws the digest** (too many low-value reddit stickies). *Mitigation:*
  small curated sub list; gatherer candidates compete in the same scorer (no special weight); AutoMod
  sticky filter if needed (observed in dry-runs before go-live).
- **R2 — A down/black-hole lane adds latency to the brief.** *Mitigation (D-11):* every per-fetch on
  the SOCKS lane (and direct) has a bounded timeout (≤8s connect+read); a black-hole proxy (connects,
  never responds) fails that one fetch within the timeout, the lane is marked down for the run, remaining
  subs route to the healthy lane/direct. There is **NO separate preflight** (see D-4 — a preflight would
  burn the per-IP budget and cause the 429 it's checking for); the first real fetch IS the health signal.
- **R3 — Output features change the posted set in a way Ace dislikes.** *Mitigation:* that's exactly
  what the ≥3-run shadow window + G3 review is for; reviewed with real numbers before go-live.
- **R4 — Reddit RSS budget (≈1 fetch/window/IP) limits multi-sub at cron time.** *Mitigation:* a
  **day-seeded rotating ~5-of-9-sub subset** (D-10) spread across Spectrum + Starlink lanes, with raised
  inter-fetch spacing, so a single run never exceeds the budget; full coverage over a ≤2-day rotation.
  The silent-block watch (rotation-aware, aggregate-Reddit) catches a persistent zero.
- **R5 — A wiring bug empties the digest** (the 2026-06-09 class). *Mitigation:* the never-regress
  invariant + 3 dry-runs at G1 + forced-failure degrade test; gatherers omit-on-failure like every source.

## 9. Open Questions

- **OQ-1 [RESOLVED with Ace]:** subreddit list LOCKED — `LocalLLaMA`, `MachineLearning`, `artificial`,
  `singularity`, `OpenAI`, `AI_Agents`, `LLMDevs`, `ChatGPTCoding`, `StableDiffusion` (9 subs, lane
  round-robin). See §5.2.
- **OQ-2 [must close before Phase 2]:** Silent-block N (consecutive aggregate-zero RUN days before alert)
  — default 3. This is a binding constant gating AC-5/AC-11; confirm with Ace at the G2 gate before the
  watchdog is built, OR tie N to measured lane uptime from Phase-1 perf data. Do NOT build the watchdog
  with an unconfirmed N.
- **OQ-3 [RESOLVED with Ace]:** github-trending IS included in the morning-digest from Phase 1,
  alongside Reddit. Both wired the same gate.
- **OQ-4:** Output-feature go-live (G3) timing — driven by the shadow watcher's READY signal, not a date.

## 10. Acceptance Criteria

- [ ] **AC-1** WHEN the morning-digest runs THEN reddit + github-trending candidates appear in the
  candidate pool. Evidence: dry-run `_debug_candidates.json` shows nonzero reddit/github sources.
- [ ] **AC-2** WHEN a gatherer (or the Starlink proxy) fails THEN the digest still posts a valid set.
  Evidence: forced-failure dry-run posts normally; perf log shows `0 Reddit`.
- [ ] **AC-3** The one-run-one-post invariant holds. Evidence: double dry-run, second short-circuits.
- [ ] **AC-4** Gatherer engagement stays honest-zero through scoring. Evidence: dry-run shows reddit
  candidates `engagement=0`.
- [ ] **AC-5** Silent-block watch alerts on N consecutive **aggregate-zero** RUN days **for Reddit OR
  github** (a per-sub zero under rotation does NOT alert; only zero-across-all-scheduled-subs does),
  silent otherwise. Evidence: unit (synthetic) + live (real dir) runs.
- [ ] **AC-6** Lane health is the FIRST REAL gather fetch (NO separate preflight — D-4): a down/black-hole
  lane's first fetch fails within the bounded per-fetch timeout (D-11), the lane is marked down for the
  run, remaining subs route to the healthy lane/direct. Evidence: lane-down AND black-hole-proxy dry-runs
  log the fallback and degrade within the time box (no hang); brief unaffected.
- [ ] **AC-7** Cosmetic: proxy-down warn is a clean message (no curl argv). Evidence: test asserts the
  message shape.
- [ ] **AC-8** Output features wired only after the shadow window meets the numeric thresholds over ≥3
  runs incl. a high-volume day, AND a canary live run is reviewed; posted set matches expectations.
  Evidence: G3 shadow numbers + canary live diff.
- [ ] **AC-9** Every config gate (G1/G2/G3) recorded a diff + `.bak` + Ace approval. Evidence: gate records.
- [ ] **AC-10** Full `npm run verify` green; no regression. Evidence: exit 0.
- [ ] **AC-11** The watchdog alerts on a STALE input (newest probe artifact older than N days) and a
  schema mismatch — a dead probe/cron is not health. Evidence: stale-dir + malformed-artifact unit runs
  both alert (not silent).
- [ ] **AC-12** Output-module degrade is robust to BOTH failure modes (D-8): (a) forced non-zero exit →
  un-deduped set posts; (b) forced **zero-exit-with-garbage/truncated stdout** → stdout fails schema
  validation → un-deduped set posts. Evidence: two Phase-3 E2Es each post a valid digest.
- [ ] **AC-13** G3 uses the PRE-COMMITTED ceilings (≤20% dedup-suppress, ≤2 reorders, ≤30% shrink) —
  tightened-not-loosened — and the canary has a defined FAIL→rollback condition. Evidence: G3 record
  cites the ceilings + the canary diff decision.
- [ ] **AC-14** The watchdog's own silence is detectable (D-9, via the cron-obs stack). Evidence: the
  watchdog job appears in the `cron.ace` ledger / obs coverage.
- [ ] **AC-15** RSS budget respected (Pass-1 B-1/f1-B-1/f2-B-3): each morning-digest run fetches a
  **day-seeded rotating subset** (~5 of the 9 subs) across the two lanes **concurrently**, all 9 covered
  over a ≤2-day rotation. The dry-run perf log MUST show (a) the Reddit step under its hard ≤180s time box
  (D-10), (b) actual per-IP inter-fetch spacing ≥ the measured-safe floor, AND (c) **zero 429s** across a
  real rotation run — not just deterministic coverage. The full 6-source dry-run completes enrich+embed+
  export+score within the 20-min cron budget. Evidence: deterministic selector unit test (full coverage)
  + a real dry-run perf log meeting (a)/(b)/(c) + total wall-clock under budget.
- [ ] **AC-16** The canary diff is **pool-identical** (Pass-1 f2-B-1): the same frozen scored candidate
  pool run through select/render with features OFF (baseline) vs ON, NOT a cross-day comparison. Evidence:
  the canary record cites one pool hash used for both arms.

## 11. Rollback

Each phase is independently reversible: restore the timestamped `prompt.md.bak-*` (Phase 1, 3) or
`launchctl unload` + remove the plist (Phase 2). Nothing here is irreversible; the brief can return to
its current behavior in one command per phase.

## 12. Phase roadmap (ship order)

| Phase | Ships | Gate | Trigger |
|---|---|---|---|
| 1 | gatherer wire-in + lane health-via-first-fetch + cosmetic | G1 (prompt diff + 3 dry-runs) | now |
| 2 | silent-block watchdog | G2 (plist install) | with/after Phase 1 |
| 3 | output features (dedup/MMR/provenance) | G3 (prompt diff + shadow evidence) | when shadow-watch says READY (≥3 runs/brief) |
