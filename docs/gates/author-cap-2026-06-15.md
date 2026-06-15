# Author-diversity cap — Wave 6 G3 live-wire — 2026-06-15

Trigger: Ace, reviewing the digest, saw 3 Ethan Mollick (@emollick) items in one
morning brief. "I don't want more than one of his posts specifically" + "2 per
author cap" generally.

## What shipped
The Wave 6 output-staging shadow had measured author-cap as the dominant diversity
effect (live brief dumps carry NO embeddings, so the offline TS "MMR" already
degrades to pure author-cap). So instead of plumbing the offline TS module
(`scripts/lib/diversity-rerank.ts`) into the live path, the same author-cap was
wired directly into the LIVE deterministic engine both briefs already call:
`score_digest.py :: select_shadow`.

Behavior: cap how many items ONE author holds across the COMBINED Top+Also output.
An over-cap item is skipped; the next-best DISTINCT author fills the slot (identical
to the shadow's `author_cap_drop`). Non-authored rows (HN/smol stories, no handle)
are never capped.

- General default cap = 2 (`DEFAULT_AUTHOR_CAP`).
- Per-handle overrides in `~/.hermes/digest/author-caps.txt` ("handle N" per line).
  Ace's call: `emollick 1`.
- Kill-switch: env `SIFTLY_AUTHOR_CAP=0` → no-op (mirrors PF_WEIGHT=0).
- Audit: `select_digest` one-line audit now prints `author_cap=N`; `select_shadow`
  meta carries `author_cap:{enabled,default,overrides,dropped}`.

## Why no risky prompt.md "wire-in"
Both briefs invoke `select_digest.py --engine deterministic`, which calls
`select_shadow`, which SELF-LOADS `author-caps.txt`. So the cap is live the moment
the engine runs — there is no flag to pass from the prompt. The prompt.md edits are
DOC-ONLY notes (so future edits know the cap exists), backed up:
- `morning-digest/prompt.md.bak-g3-author-cap-20260615-155449`
- `x-feed-brief/prompt.md.bak-g3-author-cap-20260615-155449`

## The other two staged features (NOT re-shipped — already covered)
- **Provenance log** — already LIVE: `docs/eval/surfaced-items/surfaced-items-*.jsonl`
  written daily by the output-shadow harness. Nothing to wire.
- **Cross-brief dedup** — both briefs already dedupe by URL/tweet-ID via seen-lists
  (`x-brief-seen.json` etc.). The TS module only adds marginal fuzzy-title dedup
  (shadow measured would-suppress 0–2/day). Held — wire later only if same-story-
  different-URL dupes actually show up.

## Proof on REAL data (live `_last_run_debug.json`, 633 candidates)
- CAP OFF (`SIFTLY_AUTHOR_CAP=0`): Top = [emollick, swyx, paulg, emollick, emollick]
  → THREE emollick (the exact complaint).
- CAP ON (default 2, emollick 1): Top = [emollick, swyx, paulg, <Yann LeCun story>,
  <Context Engineering story>] + 2 Also → exactly ONE emollick, full digest, freed
  slots filled by real stories. Audit: `author_cap=5` dropped.

## Tests / gate
- New `scripts/__tests__/author_cap_test.py` (6): emollick override caps at 1 +
  distinct author backfill; default cap 2 for non-overridden; non-authored never
  capped; kill-switch no-op; `_cap_for` override-beats-default; loader parses/skips
  garbage.
- Full gate green: 268 TS unit + 10 e2e + 48 Python; tsc clean; 0 lint errors.

## Wave 6 watchdog noise (fixed same session)
`wave6-shadow-watch.py` + `wave6-output-shadow-watch.py` were emitting daily PASS/
READY heartbeats to Ace's Discord (success-noise → violates alert hygiene). Both now
SILENT on healthy: embed-shadow speaks only on OVER TOLERANCE; output-shadow keeps
running its harness (feeds the G2 gatherer-probe watchdog + accrues evidence) but no
longer prints the daily status. Scripts live in `~/.hermes/scripts/` (not this repo).

## Rollback
- Behavior: `SIFTLY_AUTHOR_CAP=0` (instant no-op) or `git revert` this commit.
- Tuning (no code): edit `~/.hermes/digest/author-caps.txt`.
- Prompts: restore the two `.bak-g3-author-cap-*` backups.

## Verify next runs
- morning-digest (3:33am) + x-feed-brief (7:30am): no author appears >2× (and
  emollick never >1×) across Top+Also. Audit line shows `author_cap=N`.
