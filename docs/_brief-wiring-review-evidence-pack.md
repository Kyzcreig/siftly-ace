# Evidence Pack — Brief Live-Wiring PRD (ground truth, trust this)

## Ground-truthed live state (Apollo, 2026-06-14)
- **Morning-digest brief** = prompt-driven shell gather blocks in
  `~/.hermes/state/cron/morning-digest/prompt.md` (43.9K): `gather_perplexity`, `gather_hn`,
  `gather_smol_latent`, `gather_x`. Candidates → dedupe (incl. vs `x-brief-seen.json`) →
  `score_digest.py` → `select_digest.py` → `render_digest.py` → post once (PT-day marker short-circuit
  at Step 0). Known fixed bug: multi-post (2026-06-09) + empty-digest from a Python-3.7 inline crash
  mislabeled as curl error (the prompt has explicit guards against both).
- **Gatherers** (`scripts/gather/reddit.ts` RSS-Atom + `github-trending.ts`) are referenced ONLY by
  `scripts/gatherer_probe.ts` + their own tests. NOT consumed by score/select/render or any prompt.
  reddit.ts: lane round-robin (Spectrum direct + Starlink SOCKS `192.168.1.217:1080`), honest-zero
  engagement, never-throws, curl `--socks5-hostname` transport for proxied lanes (no npm dep).
- **Output features** (`scripts/lib/cross-brief-dedup.ts`, `diversity-rerank.ts`,
  `surfaced-provenance.ts`) exercised ONLY by `scripts/output_shadow.ts` (offline, read-only). NOT
  wired into the posted path.
- **`wave6-output-shadow-watch`** (no_agent cron, daily 9am, id `d8ff8fbce6b1`) accumulates output-shadow
  evidence; silent until ≥3 runs/brief, then reports STAGING-READINESS. Shadow artifacts so far:
  `~/.hermes/state/x-bookmarks/output-shadow/` (a couple runs) + gatherer-probe artifacts in
  `~/.hermes/state/x-bookmarks/gatherer-probe/`.
- **X-feed brief** (7:30am) sources X only; morning-digest (7:00am) is the general-news brief. Both have
  launchd safety-net plists (`ai.agent.{morning-digest,x-feed-brief}-safetynet.plist`).
- Fleet alert routing: failures → `#alerts` (`1480528231286181948`); quiet/healthy → `#logs`
  (`1480525090331561984`) or silent. `notify.py --target <channel_id>`.
- Hard Config Rule: never edit `prompt.md` / plist unilaterally — diff + `.bak` (timestamped, matching
  existing `prompt.md.bak-*` convention) + Ace approval. Many `.bak-*` files already exist as precedent.
- Reddit RSS measured limit: ≈1 fetch/rolling-window per IP → lane round-robin spreads subs across
  residential IPs. Reddit API is dead (Responsible Builder Policy); RSS is the only read path.
- No new dep allowed (gatherer invariant). `npm run verify` = tsc + lint + unit + e2e; current green at
  229 TS + 42 py + 10 e2e.

## Constraints
- The morning-digest is load-bearing + Ace-visible daily — zero-regression is the top invariant.
- Every config-class edit (prompt.md, plist) is gated (G1/G2/G3): diff + backup + Ace approval.
- Output features go live ONLY after ≥3 shadow runs/brief reviewed (the watcher exists for this).
- Gatherers can wire before output features (lower blast radius).
- Honest-zero engagement, never-throw, no-new-dep all carry from the gatherer PRD.
- Silent-block watch + proxy preflight must NOT be able to break the brief (decoupled watchdog + fast
  preflight with direct-lane fallback).

## ADDENDUM — live ground truth (2026-06-14, Apollo)
- All 9 locked subreddits return HTTP 200 (real, none 404): LocalLLaMA, MachineLearning, artificial, singularity, OpenAI, AI_Agents, LLMDevs, ChatGPTCoding, StableDiffusion.
- RSS per-IP budget MEASURED tighter than DEFAULT_DELAY_MS=2500: 9 subs / 2 lanes (~4-5 fetches/IP) mass-429 at 2.5-3s gaps; reliable 200 needed ~45-60s/IP spacing. PRD v4 §5.2 resolves via day-seeded rotating ~5-sub subset + raised delay, AC-15.
- github-trending.ts live run: 15 real candidates, exit 0, honest normalized engagement. General trending (not AI-filtered) — flows through existing scorer.
- gatherer never-throw -> [] design intact: a 429'd sub contributes nothing that run (not a crash).


## ADDENDUM — live ground truth (2026-06-14, Apollo)
- All 9 locked subreddits return HTTP 200 (real, none 404): LocalLLaMA, MachineLearning, artificial, singularity, OpenAI, AI_Agents, LLMDevs, ChatGPTCoding, StableDiffusion.
- RSS per-IP budget MEASURED tighter than DEFAULT_DELAY_MS=2500: 9 subs / 2 lanes (~4-5 fetches/IP) mass-429 at 2.5-3s gaps; reliable 200 needed ~45-60s/IP spacing. PRD v4 5.2 resolves via day-seeded rotating ~5-sub subset + raised delay, AC-15.
- github-trending.ts live run: 15 real candidates, exit 0, honest normalized engagement. General trending (not AI-filtered) -- flows through existing scorer.
- gatherer never-throw -> [] design intact: a 429'd sub contributes nothing that run (not a crash).
