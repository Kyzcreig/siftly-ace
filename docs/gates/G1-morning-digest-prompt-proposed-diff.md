# G1 GATE — proposed morning-digest prompt.md edit (Reddit + github-trending wire-in)

**Target:** `~/.hermes/state/cron/morning-digest/prompt.md`
**Gate:** G1 (Hard Config Rule — diff + `.bak` + Ace approval BEFORE it goes live).
**Backup cmd (run at apply time):** `cp prompt.md prompt.md.bak-g1-reddit-github-$(date +%Y%m%d-%H%M%S)`
**Rollback:** restore that `.bak`.
**NOT YET APPLIED.** This file is the proposal; the live brief is untouched.

After apply: 3 dry-runs (no post) prove AC-1/2/3 + github off-topic check (d) + Reddit-step perf under 240s box.

---

## Edit 1 — perf_step list (after line 26 `- \`gather_x\``)
```diff
 - `gather_x`
+- `gather_reddit`
+- `gather_github`
 - `filter_dedupe`
```
(and add `sources_reddit`/`sources_github` counters to the total summary line — `RCT`/`GCT`.)

## Edit 2 — Step 2, append after the X block (after line ~220 "Tag each candidate with one source")

````markdown
Reddit (AI discovery via RSS, day-seeded rotating subset, dual-lane):
```bash
# Day-seeded rotation of the curated 9-sub AI set (~5/run), spread across Spectrum
# (direct) + Starlink (SOCKS) lanes concurrently, with a hard 240s step budget so it
# can't starve the rest of the pipeline. Reddit's per-IP RSS limiter is non-deterministic;
# a 429'd sub returns [] for the run (graceful) — NOT a failure to investigate.
cd ~/Projects/siftly-ace && npx tsx scripts/gather/reddit.ts \
  --rotate \
  --lane '' \
  --lane socks5://192.168.1.217:1080 \
  --limit 25
```
Parse `.candidates[]`: each has `title`, `url`, `summary`, `authorHandle`, `created_at`,
`engagement_raw` (honest-zero — RSS carries no metrics; a 0 is correct, not a bug).
Tag source `reddit`. If the command errors or returns 0 candidates, report `0 Reddit` and CONTINUE.

github-trending (daily trending repos):
```bash
cd ~/Projects/siftly-ace && npx tsx scripts/gather/github-trending.ts
```
Parse `.candidates[]` (same shape; `engagement_raw.starsToday` is the real signal).
Tag source `github`. It is GENERAL trending (not AI-filtered) — let the scorer reject
off-topic repos (a trending game engine / IPTV list should score below the post gate).
If it errors or returns 0, report `0 GitHub` and CONTINUE.
````

## Edit 3 — dedupe (Step 4) — add per-source seen-lists
- Dedupe `reddit` candidates against `reddit-brief-seen.json`; `github` against `github-brief-seen.json`
  (same shape/load as `x-brief-seen.json`, loaded in Step 1; created empty on first run).
- Existing cross-source URL-dedupe already catches reddit↔hn crossposts.

## Edit 4 — Step 8 (Update Seen List) — write reddit/github ids to their seen-lists (posted items only).

## Edit 5 — language updates
- "ALWAYS run ALL FOUR gather steps" → "ALL SIX" (perplexity, hn, swyx, x, reddit, github).
- Add reddit/github to the "If one source fails, omit and continue" list + footer source counts.

---

## Decisions baked in (from PRD v5, all reviewed)
- Subreddits: LocalLLaMA, MachineLearning, artificial, singularity, OpenAI, AI_Agents, LLMDevs,
  ChatGPTCoding, StableDiffusion (rotation picks ~5/day; all 9 covered over ≤2 days).
- Starlink SOCKS lane: `socks5://192.168.1.217:1080`.
- Honest-zero engagement preserved; gatherers compete in the existing scorer with no special weight.
- This is gatherer wire-in ONLY (Phase 1). Output features (dedup/MMR/provenance) are Phase 3 (G3).
