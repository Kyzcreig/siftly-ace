# siftly-ace — Agent Notes

Fork of viperrcrypto/Siftly → Kyzcreig/siftly-ace. PRD: docs/plans/PRD-ace-x-knowledge-base.md (v5, approved).
Swarm plan: docs/plans/SWARM-PLAN-phase1plus.md. Coding worker = Daedalus profile (openai-codex/gpt-5.5 xhigh).

## 🔴 X SOURCING — BOTH briefs run on grok `x_search`, NOT the paid X API (2026-07-28)
Both the morning-digest AND x-feed-brief X gathers are migrated off `api.twitter.com` to xAI's
server-side `x_search` ($0 marginal on the SuperGrok sub; replaced ~$285/mo).
**morning-digest** production-proven 2026-07-26 (16 calls, 51 candidates, exit 0).
**x-feed-brief** production-proven 2026-07-28 on its first scheduled run: **462 calls, 362/362
handles, 0 failed, 528 candidates, 332s, `credential_sources: ['xai-oauth']`**, posted 5 top /
5 quick hits with real like counts. Head-15 recall vs a same-day paid corpus: **15/15**.

x-feed uses `scripts/xfeed_xsearch_gather.py` (ONE CALL PER HANDLE, 16-wide parallel, then a
FIVE-PASS recovery stack for capped handles: whole-window floor ladder → day-split →
per-day floor ladder → oldest-first ordering sweep → RECURSIVE middle-band NL time hints — a capped band splits
in half down to 45-min width, depth ≤2, worst case 7 band calls/pair); morning-digest calls
`xsearch_gather.py` directly at `--chunk-size 1`. x-feed's base floor is **150** (raised
from 100 on 2026-07-30: 98 sub-150 items in the scored pool, zero ever selected; NOTE the
margin is real — 3 of 10 posted items on 07-30 sat in the 150-249 band, so if a brief posts
thin, this floor is the first suspect and a one-character revert).
Both pipe every raw response through the SAME `xsearch_gather` adapter, which owns every guard —
**never reshape rows by hand.** Things that fail SILENTLY if changed:
- **ONE CALL PER HANDLE — never batch.** Measured vs a same-day paid corpus: 10 handles/call
  @min_faves:15000 → **56%** recall; @min_faves:5000 → **22%** (WORSE); 1 handle/call → **100%
  head recall**. The ~10-row budget is a relevance/**recency** mix, so a low floor fills it with
  recent chatter and EVICTS the headliners. Calls parallelize (xAI ceiling ~20 concurrent/team),
  so narrow calls are cheap; batching is not.
- **Escalate the FLOOR for a capped handle, don't slice the window below a day.** A handle
  returning exactly the cap gets re-queried at 1000 → 5000 → 20000 (`FLOOR_LADDER`), first
  whole-window, then PER (handle,day) pair after day-splitting; a higher floor shrinks the
  candidate set until nothing can be evicted. Proven on @RoyalSerf (29 posts, pinned at 10):
  his #1 at 12,838 likes was invisible at floor 100, returned at 1000. **Sub-day `since:`/
  `until:` times are ignored** — but there IS one sub-day lever: an **oldest-first ordering
  directive** pages the cap into the opposite end of the day (measured: zero overlap with the
  default recency slice), and a **middle-band NL time hint** ("posted between roughly HH:MM UTC
  and HH:MM UTC") reaches between the two frontiers — the NL layer honors intra-day bands the
  operators ignore (recovered 33k/32k-like posts invisible to both frontiers). Engagement-ordering
  directives are UNRELIABLE — tested, missed the real top posts. PLACEMENT + PHRASING are load-bearing — the directive must ride
  INLINE on the operator line and use the verbatim pinned string in
  `build_query(order="oldest")`; a paraphrase or separate paragraph is SILENTLY ignored.
  A (handle,day) pair is still-hot only if its HIGHEST-floor-tried response is capped —
  naive keying re-queries resolved pairs at every rung.
- **`until:` is day-granular AND EXCLUSIVE** → a rolling 24h window silently loses its newest day.
  QUERY WIDE (whole calendar days, +1 on the upper bound), FILTER NARROW locally. This is why a
  24h brief legitimately queries a 48h span.
- **Operator syntax, never prose** — `from:<h> min_faves:N since:<d> until:<d>`. Prose caps ~10
  rows/handle over ~3h and misses the day's top post. Handles go in BOTH `allowed_x_handles` AND
  the query text.
- **GROUP the handles; state each filter ONCE** (fixed 2026-07-27, was a live 6x recall loss).
  Correct: `(from:A OR from:B OR … OR from:J) min_faves:N since:S until:U`.
  WRONG: repeating the filters per handle (`from:A min_faves:N since:S until:U OR from:B …`) —
  measured on 10 handles @20000 that form returned **1 row and missed a 132,744-like post**, vs
  **6 rows including it** for the grouped form. The long repetition is truncated/mis-parsed
  upstream and fails SILENTLY (a short result looks like "nobody posted"). `build_query()` owns
  this; its selftest gates the form — and note the ORIGINAL selftest asserted the broken form,
  which is precisely how the bug shipped green.
- **Emit BOTH `tweet_text` AND `text`, BOTH `authorHandle` AND `authorName`** —
  `select_digest._item_text()` reads only `tweet_text|title|summary|line|text_snippet`, but
  x-feed's prompt documents timeline candidates as carrying `text`. Emitting only one → 100% of
  that brief's candidates SILENTLY discarded via `is_bare_fragment()`. One adapter, both briefs.
- **Emit flat `likes`/`retweets` ALONGSIDE `public_metrics`** — `overview_digest`/`render_digest`
  read only the flat keys (`select_digest` reads `public_metrics`). Omit either and the brief posts
  with no like counts and ranks all authors 0.
- **Union `citations` + `inline_citations`** — top-level `citations` is EMPTY on live calls;
  reading it alone rejects 100% of real rows.

The x-feed follow list (`~/.hermes/digest/xfeed-follows.txt`, 362 handles) is refreshed weekly
from X's own `/2/users/:id/following` by `~/.hermes/scripts/refresh_xfeed_follows.py` (cron
`7d67c85b3b74`, Mon 05:40). It was previously DERIVED from paid corpora and was missing **142
followed accounts** that simply hadn't posted in the sample window. Full doctrine: skill
**`xsearch-percall-row-ceiling`**.

`LOW_REACH_ENGAGEMENT_FLOOR` is now **100** (was 5) in both `select_digest.py` and
`score_digest.py`, env-overridable via `LOW_REACH_FLOOR`; `gold_set_eval.py` pins it to 5 because
the gold corpus was labeled at the old floor. Still a down-rank, never a discard.

**Test-running a brief:** `~/.hermes/scripts/brief-testrun.sh morning-digest [--background|--dry-run]`
— it handles the `--wait` requirement (without it `hermes cron run` forks and orphans), the PT day
lock, and seen-list restore. Full doctrine: Obsidian [[Morning Digest System — System Overview]] +
[[X Data Sourcing — Paid API vs Grok x_search]].

## ⭐ RANKING — CURRENT LIVE STATE (2026-06-21) — read this first
Both briefs (`morning-digest`, `x-feed-brief`) run the SAME deterministic engine: model emits 4 enum labels → `pf-score.py` adds a personal-fit delta → `score_digest.py` scores → `select_digest.py --engine deterministic` gates/selects → renderer posts. The model NEVER picks what posts.
- **Personal-fit is LIVE in `PF_AFFINITY_MODE=fused`** (shipped 2026-06-20, Ace-accepted 2026-06-21). `fused_delta = (keyword_delta + (embed_delta − pool_mean_embed))/2` — equal-weight blend of the keyword overlap scorer and the sqlite-vec embed scorer; centering cancels embed's ~+10.6 miscalibration. Code: `pf-score.py` `apply_fused_affinity()` + `affinity_mode="fused"`; `pf-audit.py` provisions the embed env for fused. Clamped to ±12 by `pf_points`/`PF_CAP`.
- **Kill-switch unchanged:** `PF_WEIGHT=0` in `brief-config.json` → base-score-only no-op. `pf-audit.py` fail-safes to base on any pf hiccup.
- **Cross-brief dedup (fixed 2026-06-21):** x-feed Step 2 now ALSO reads `morning-digest/ai-news-seen.json` so a tweet morning posts at 03:45 can't reappear in x-feed at 03:56. (Was one-directional before — the @emollick dup.)
- **A/B scaffolding RETIRED (2026-06-21):** crons `siftly-pf-preview`/`siftly-pf-gate-eval`/`siftly-fused-checkin`/`wave6-embed-shadow-watch`/`siftly-coercion-gate-watch` removed (scripts in `~/.hermes/scripts/retired/`). KEEP `siftly-gatherer-silentblock-watch` + its gatherer-probe feeder (trimmed `wave6-output-shadow-watch`). `prompt.md.bak.*-pre-fused` kept 1 wk then prune.
- Full as-built pipeline + the 36-cell BASE table + safety rails: Obsidian `AI/Ace X Knowledge Base — System Overview.md` § "Ranking — the complete pipeline".

## Overview synthesis section — LIVE (2026-06-22)
Both briefs now open with a **half-page "what's going on" synthesis** above the ranked list (Ace's ask: "big themes + big stories in less than half a page"). morning-digest = `🗞️ The Landscape` (global AI news), x-feed = `📡 Your Timeline` (Ace's feed mood + loud voices). Built from the FULL scored pool, not just the ~7 posted.
- **`scripts/overview_digest.py`** — deterministic aggregator over `all_scored[]` → `{themes (by salience), top_stories (by final_score), loud_authors, content_mix, pool/on/off counts}`. Robust to BOTH brief signal shapes (morning: `signals` dict w/ `topic_hits=[{topic}]`; x-feed: `signals` LIST w/ `topic_hits.hits=[kw]`). Fail-safe: emits minimal valid JSON on any error.
- **morning** (deterministic renderer path): prompt Step 6.9 runs the aggregator → LLM writes prose to `/tmp/morning-digest-overview.txt` → `scripts/inject_overview.py` attaches it as additive `data["overview"]` to `_render_input.json` (temp+rename, never hand-edited) → `render_digest.py` prepends it under the header. **x-feed** (LLM hand-composes body): Step 6.9 aggregator → LLM writes the `📡 Your Timeline` block into the template slot after the header.
- **Fail-safe + additive everywhere:** any error → SKIP the overview, brief posts exactly as before. Never blocks/delays/alters the Top/Also selection. Renderer selftest covers present/blank/missing overview (70/70). No shadow trial (Ace's call) — shipped live with `.bak.*-pre-overview` backups.
- **Overview SAFETY-NET (2026-06-29):** the overview is injected into `_render_input.json` by Step 6.9, but if the LLM runs Step 6.7 (`select_digest.py`, which REWRITES `_render_input.json`) AFTER 6.9, the injected overview is clobbered and the Landscape section silently vanishes (happened 2026-06-29 morning; Ace caught it). `build-report.sh` now re-injects the overview from the brief's linked tmp file if the render-input lacks it (fail-safe + idempotent), making the report build the LAST writer so step-ordering can't lose it.
- **Overview JUNK-EXCLUSION (2026-06-29):** the overview content was garbage even when present — it surfaced crypto/scam/fragment junk (`$Voicebox Thesis`, etc.) the MODEL mislabeled `core`, because `overview_digest.py` ranked/filtered by the model's RAW label + the dump's `final_score` and did NOT apply the Backstop-4 junk-demotion / off-topic guard that gate the ranked brief. FIX: `overview_digest._rescore_pool()` re-scores every pool item through `score_digest.score_item` (the single deterministic authority, incl. Backstop 4), stamps `_ov_final` + `_ov_excluded`, and `aggregate()` EXCLUDES junk/off-topic from themes+top_stories and ranks by the real deterministic score — so the overview can never disagree with what the brief gates. Fail-safe to dump values if score_digest can't import. `_label` also strips a leading t.co/bare URL. Proven on the live 231-item pool (81 excluded, junk gone). Both prompts note the aggregate is now junk-pre-filtered. NOTE: the Top/Also SELECTION is a separate gate — this only governs the Landscape synthesis.
- **Wikipedia-style story refs (2026-06-22):** the overview prose cites named stories as `[N]`, matching the `ref` numbers `overview_digest.py` now stamps on each `top_stories` item (with a guaranteed `url`). `scripts/resolve_overview_refs.py` replaces each cited `[N]` INLINE with a Discord masked link `[[N]](url)` (no footer line — Ace's call 2026-06-22). **URLs come from the deterministic aggregate, NEVER the LLM**; bogus `[N]` stay plain; idempotent. `.bak.*-pre-reflinks` backups.
- **Handle + URL linking (2026-06-22, Ace's ask):** `render_digest.py` now renders every `@handle` as a profile link `[@h](https://x.com/h)` and replaces bare URL lines with inline anchor text — story headlines ARE the link, tweets end with `[Read on X →](url)`, no naked `<url>` lines. `resolve_overview_refs.py` also linkifies bare `@handle` mentions in the overview prose (idempotent; skips already-linked/email/path). Safe through notify.py's embed-suppressor (masked links survive the `<>`-wrap). Renderer selftest 74/74 asserts the linked forms + "no bare angle url". `profile_link()`/`anchor()` helpers.
- **HTML report delivery — LIVE (2026-06-22, Ace picked "Refined Cards", full switch):** both briefs now post a **one-line link to a fresh HTML report** to #daily instead of the inline body. `scripts/html_report.ts` renders `_render_input.json` → Refined-Cards dark page (Sora, gradient bg, chip overview, hover cards): tweets hydrate via react-tweet `getTweet` (avatar/verified/full untruncated text/**height-capped cover-cropped media** so t.co image URLs become real inline images), non-tweet stories = link-cards w/ summary + source label (`GitHub +N★ today`/`Reddit`). `scripts/build-report.sh` = wrapper (render → doc-share fresh-slug-daily → prints URL on stdout; exits non-zero/empty on ANY failure). Both `prompt.md` Step 7 build the report + post `☀️/🐦 <Brief> — <date> → <url>`, with **fail-safe fallback to the inline render** (morning: `render_digest.py --post`; x-feed: inline `<body>`) so #daily is never empty. x-feed injects its overview into `/tmp/x-feed-select.json` before building. `.bak.*-pre-htmlreport` backups. Design exploration: `sketches/` (4 variants).
- **`_to_render_item` tweet-misclassification FIX (2026-06-22):** github/reddit items carry an `authorHandle` (org/user) and were routed through the X/tweet branch → **dropped their `summary`** (showing bare repo-slug stubs) AND faked `@org` X-profile links. Now classifies a tweet by REAL tweet identity (`source∈{x,twitter}` / `tweet_id` / `/status/` url), carries `summary`+`authorHandle`+`stars_today` for non-tweets, and renders proper `· GitHub +N★ today`/`· Reddit` suffixes. This was the root cause of Ace's "weak context-less stubs" — the context was always in the pool, just dropped at render.
- **Quote-tweet rendering FIX (2026-06-26, Ace caught it):** a tweet that QUOTE-TWEETS another post rendered only the parent's text+media — the **entire quoted post, incl. its article/link, was silently dropped** (real case: @hwchase17 quoting Jake Broekhuizen's X Article). react-tweet `getTweet` DID carry `quoted_tweet.entities.urls`; `html_report.ts` never read `quoted_tweet`. Fix: `quotedCard(q)` renders a nested hairline-boxed Noir sub-card (quoted author + body + media + outbound link); `primaryLink(t)` labels X `/i/article/` urls as "Read the article on X →" else the `display_url`; `tweetCard` embeds the quoted card after media AND surfaces a non-quote parent's own outbound link (also previously dropped); link-only quoted bodies de-dup (clean CTA, no raw url). `html_report.ts` now exports its pure render helpers behind an `import.meta`/argv entry-guard so they're unit-testable without auto-running `main()`. Regression test `__tests__/html-report-quoted.test.ts` (9 cases). Argus signed off PASS on the live render. `.bak.*-pre-quotetweet`.


## Incremental ingest EARLY-STOP — DONE (2026-06-15), live-verified
The daily incremental no longer re-scans a fixed window every run. PRD: `~/.hermes/plans/siftly-incremental-early-stop/PRD-incremental-early-stop.md` (Opus 2-pass APPROVED).
- **Core (`lib/xurl-ingest.ts` `fetchSourcePages`):** optional `knownTweetIds` probe + `earlyStopK` (default 3). Incremental stops paginating a source after **K consecutive already-known tweets** (newest→oldest ⇒ frontier passed). Collects the whole page before stopping (new items above the known run kept). Backfill (`resumeFromCursor:true`) NEVER early-stops (I2). Fail-open: a probe throw → full walk + `IngestResult.earlyStopError` + WARN (I7).
- **Wiring (`lib/incremental-early-stop.ts` + `scripts/ingest.ts`):** the incremental CLI branch builds a Prisma `knownTweetIds` over the shared `Bookmark` table (both sources, `tweetId @unique`) and decides per run: **kill-switch** (`SIFTLY_INCREMENTAL_EARLY_STOP=0`) > **safety-net** (full walk every `SIFTLY_INCREMENTAL_FULLWALK_EVERY_DAYS`, default 7, wall-clock via new `IngestState.lastFullWalkAt`) > early-stop on. `IngestResult.fullWalkReason` disambiguates a deliberate full walk from a probe failure (D-9).
  - **🔴 CADENCE-RESET BUGFIX (2026-06-26):** the safety-net originally stamped `lastFullWalkAt` ONLY when a source reached the ABSOLUTE frontier (`nextCursor === null`, Opus B1). But the daily job runs `--max-pages 5` against a corpus of 2,740 bookmarks / 913 likes — a safety-net walk can NEVER exhaust in 5 pages, so `lastFullWalkAt` froze (it sat at 6/15 for ~11 runs) and the full walk re-fired EVERY night (~950 reads for ~18 new). Fix: `scripts/ingest.ts` now stamps EVERY source whose budgeted safety-net sweep **completed cleanly** (ran to its page budget or exhausted), excluding only credit-depleted/interrupted walks. The "did it hit the absolute frontier" signal still lives in `perSource[s].nextCursor` for backfill logic; it's just no longer the gate for cadence reset. Live state was stamped to now so early-stop re-engaged immediately. **Why it shipped broken:** the bug was in the ORIGINAL feature commit `2d0c3da`, not a later regression — the B1 review finding (sound for backfill recovery) was over-applied to the daily bounded sweep. It hid for ~11 days because the heartbeat said "✅ OK" the whole time.
  - **🛡️ READ-AMPLIFICATION GUARD (2026-06-26):** the watchdog that was missing. `scripts/ingest.ts` emits `early-stop-telemetry: engaged=<bool> fullWalkReason=<reason>` on incremental runs; `scripts/daily-ingest.ts` `detectReadAmplification()` flags a run that read ≥60% of the full-walk ceiling (`ingestMaxPages×pageSize×sources`) with early-stop NOT engaged AND no legit reason (safety-net/kill-switch/probe-error are exempt) → fires a LOUD `sendAlert` to #alerts WITHOUT failing the run. Turns "a green run that's secretly expensive" into a visible alert within one night. Tests: `scripts/__tests__/daily-ingest-read-amplification.test.ts` (11).
- **Ceiling raised 2→5** (`DEFAULT_INGEST_MAX_PAGES`, env `SIFTLY_DAILY_INGEST_MAX_PAGES`): early-stop makes normal-day cost ceiling-independent; the higher cap absorbs a heavy bookmarking day. The old 2 silently dropped >~180 bookmarks/day overflow.
- **Migration:** additive nullable `IngestState.lastFullWalkAt` (`prisma/migrations/20260615000000_*`). A fresh `lastFullWalkAt=null` forces ONE baseline full walk per source, then early-stop engages.
- **Live before/after (dry-run, real corpus):** full window **10 pages / 948 reads → early-stop 2 pages / 190 reads (~80% cut)**. ~$1.89/day → ~$0.38/day on normal days; safety-net day reverts to ~378 weekly.
- **Tests:** `lib/__tests__/xurl-ingest-early-stop.test.ts` (12), `incremental-early-stop.test.ts` (helpers), `ingest-cli-early-stop.test.ts` (wiring), `credit-floor-raised-ceiling.test.ts`. Knobs: `SIFTLY_INCREMENTAL_EARLY_STOP`, `_EARLY_STOP_K`, `_FULLWALK_EVERY_DAYS`, `SIFTLY_DAILY_INGEST_MAX_PAGES`.

## Premise-gate findings (decide schema — verified against live payload)
- **No `saved_at` / `liked_at` timestamps** on bookmark/like tweets. → Dedupe "bookmark wins" = **source precedence** (bookmark > like), NOT timestamp. Novelty calibration (PRD §5.7 signal 5) falls back to tweet_created_at spread or is disabled with a logged note.
- Pagination: both endpoints use `meta.next_token` → `&pagination_token=`.
- Tweet keys available: attachments, author_id, context_annotations, conversation_id, created_at, edit_history_tweet_ids, entities, id, lang, possibly_sensitive, public_metrics, referenced_tweets, text.

## Auth note
- `forge` app left with a stray oauth2:angalexg token (Ace's call: leave it). Briefs use forge's bearer; do not rely on forge oauth2.
- siftly-ace is the ONLY app holding the intended user-context token for ingestion.


## 📜 Build history → docs/BUILD-HISTORY.md (moved 2026-08-23)
The dated completion logs (Phase 0, Waves 2–6, T3 embed seam, E2E gate, renderer/dedup/
selection-guard/deterministic-scoring build notes, reddit RSS pivot, long-tweet fix, brief-UX
batch) live in **docs/BUILD-HISTORY.md** — read it when you need the archaeology of HOW a
mechanism landed. The LIVE operating doctrine for all of those systems is the fleet skill
**`siftly-ace-operations`** (+ its references/) — load that, not the history, before touching
scoring, briefs, ingest, pf, or the HTML report. Rationale: always-loaded AGENTS.md pays its
token cost on every worker turn (measured 15.2k tok; backpass audit 2026-08-23).
