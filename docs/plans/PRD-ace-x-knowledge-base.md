# PRD — Ace X Knowledge Base (Siftly-Ace)

**Version:** v5 (video transcription → NVIDIA Parakeet on ACE-AI via composable `parakeet-transcribe` skill; Whisper demoted to last-resort)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo (orchestrator)
**Status:** DRAFT — pending PRD review pipeline (Opus, 2 passes min)
**Repo (planned):** fork of `viperrcrypto/Siftly` → `Kyzcreig/siftly-ace` (or `ANG-Ventures/siftly-ace`)
**Local project root:** `~/Projects/siftly-ace`
**Host:** Mac Studio M3U (always-on, Apollo's host)

---

## 1. Summary & Goal

**Goal:** Turn Ace's entire X/Twitter bookmark + like history into (a) a searchable, Obsidian-backed personal knowledge base and (b) a preference signal that personalizes the daily `x-feed-brief` and `morning-digest` crons.

Three user objectives, in priority order:

1. **Precision search** — "I know I saved something about X, find it." (Ranked: A)
2. **Rediscovery** — surface things Ace forgot he saved. (Ranked: B)
3. **Browse/cluster by theme** — explore the corpus visually. (Ranked: C)

Plus two systemic objectives:

4. **Refine the briefs** — use the corpus as ground-truth taste data to re-rank brief candidates toward what Ace actually saves.
5. **Discover corpus composition** — find out what Ace's saved content *actually* looks like (a deliverable, not an assumption).

**Approach (build vs buy):** Fork the open-source `Siftly` (Next.js + SQLite + Prisma + FTS5 + AI enrichment + Obsidian export + mindmap UI). Keep its storage/enrichment/search/UI/export engine. **Replace its fragile cookie-based ingestion with the official X API via `xurl` OAuth2.** Add: real semantic search (`sqlite-vec` embeddings), a corpus-wide preference model, brief integration, a passive feedback loop, and an Apollo-driven chat search surface.

**Boil-the-ocean directive (from Ace):** Build the full system, not a v0.1 slice. Implementation is still phased internally for sane build/test order, but the deliverable is the complete system.

---

## 2. Non-Goals

- **No per-item "inferred reason why Ace bookmarked it."** Explicitly rejected by Ace as speculation-on-speculation that pollutes the signal. Enrichment is **factual/observable only**: topic, format flags, entities, domain, media tags, OCR text.
- **No posting/writing to X.** Read-only ingestion. (Twitter posting stays in the separate `twitter-inspo` pipeline.)
- **No replacement of the existing brief rubric.** Personal-fit is an *additional* layer on top of the current scoring, not a rewrite.
- **No standalone vector DB** (Chroma/Qdrant). `sqlite-vec` in the existing SQLite file.
- **No system-wide changes to the briefs' sourcing** in this project beyond the optional bookmark-derived watchlist (which is built but additive).
- **No multi-user / cloud-hosted SaaS.** Single-user, local-first, Mac Studio.

---

## 3. Resolved Decisions (from planning conversation)

| # | Decision | Value |
|---|---|---|
| D1 | Ingest bookmarks AND likes | Both, **deduped**: if a tweet is bookmarked AND liked → `source=bookmark`. Like-only → `source=like`. |
| D2 | Preference weighting | Weighted: **bookmark = 1.0, like = 0.3** (tunable). |
| D3 | Preference model scope | **Full corpus**, not daily/weekly window. Recomputed after ingestion when corpus changes; no rolling-window framing. |
| D4 | Corpus size | "Low thousands." Enrichment is cost driver. Cost-estimate gate before backfill. |
| D5 | History cap | Unknown → discover at import. Report actual ceiling. |
| D6 | Search priority | **A > B > C** (precision known-item lookup is #1). |
| D7 | Corpus mix | Unknown — *discovering it is part of the point*. Composition report is a deliverable. |
| D8 | Host | **Mac Studio** (for now). |
| D9 | Ingestion auth | **Official X API via `xurl` OAuth2 PKCE** (user-context, auto-refresh). NOT Siftly's `auth_token`/`ct0` cookies. Cookie path = documented fallback only. |
| D9a | X app for OAuth2 | **DEDICATED `siftly-ace` X app** (NOT the briefs' `forge` app). Isolates OAuth2 client config, scopes, and billing from the load-bearing briefs. Resolves Q1. The `forge` app's oauth1/bearer must NOT be mutated. |
| D9b | Billing isolation | **Dedicated billing/credit pool for `siftly-ace`** where possible. If billing must be shared with the briefs, the credit-floor guard (D9c) is mandatory. |
| D9c | Credit-floor guard | Before ANY ingest run, read remaining X API credits; abort + alert if below a reserve sized to cover both briefs' daily reads. Backfill runs in small credit-gated batches, never one paginated burst. |
| D10 | Credentials storage | Tokens in `~/.xurl` (xurl-managed, auto-refresh). Any extra secrets → 1Password Engineering vault. |
| D11 | Embeddings | **OpenAI `text-embedding-3-small` (API)**. Swappable provider; ACE-AI local model = documented future swap. |
| D12 | Personal-fit impact | **Big (~30%)** = **±30 raw points** on the 0–100 base score (NOT a 0.30 multiplier). Single tunable knob (`PF_WEIGHT`, default 30). **`PF_WEIGHT=0` MUST fully no-op** the layer (kill-switch → brief degrades to exact current behavior). Mandatory audit logging of base-vs-fit delta. Dial back on evidence. Resolves Q4. |
| D13 | Segmentation | **Built but not enforced.** Compute "brief-relevant" vs "everything else" segments for the report + future filtering, but **all segments feed brief scoring for now** (memes included). Flip exclusion later without rebuild. |
| D14 | Feedback loop | **Yes.** Local tweet-ID matching: brief surfaced → later bookmarked = positive; ignored = weak negative. |
| D15 | Scope | **Full build** (boil the ocean), phased implementation. |
| D16 | Repo | Fork Siftly to our GitHub. |
| D17 | Vision/OCR enrichment | **Enabled, tiered**: vision/OCR on images only, cheap text model for text, cost-gate before backfill. |
| D18 | Vector store | **`sqlite-vec`** (in-DB). Hybrid: sqlite-vec semantic + FTS5 exact + AI rerank. |
| D19 | Daily cron | **~6:30am PT** on Mac Studio, `no_agent`. sync→enrich→export→refresh-profile. Failure alert → Discord **#alerts** (`1480528231286181948`). |
| D20 | Search surface | Apollo in-chat ranked links (primary) **+** Siftly web UI (included for now, removable later). |
| D21 | OAuth2 setup | Apollo drives it (browser skill on Mac Studio); Ace clicks authorize if his logged-in session is needed. One-time. |
| D22 | Documentation | System well-documented in **Obsidian overview** + project docs. |

---

## 4. Architecture

```
                         ┌─────────────────────────────────────────┐
                         │           X.com (official API)            │
                         │  GET /2/users/:id/bookmarks               │
                         │  GET /2/users/:id/liked_tweets            │
                         └───────────────────┬───────────────────────┘
                                             │ xurl OAuth2 (user-context, auto-refresh)
                                             ▼
                    ┌────────────────────────────────────────────────┐
                    │  INGESTION LAYER  (new — replaces cookie scraper)│
                    │  scripts/ingest.ts:                              │
                    │   - paginate bookmarks + likes                   │
                    │   - dedupe (bookmark wins over like)             │
                    │   - upsert into Siftly DB (source field)         │
                    │   - track saved_at / liked_at, pagination cursor │
                    └───────────────────┬──────────────────────────────┘
                                        ▼
                    ┌────────────────────────────────────────────────┐
                    │  SQLite (Prisma)  — single file, Mac Studio      │
                    │   ~/Projects/siftly-ace/prisma/siftly.db         │
                    │   + sqlite-vec extension (embeddings)            │
                    │   + FTS5 (existing)                              │
                    └───────────────────┬──────────────────────────────┘
                                        ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  ENRICHMENT  (incremental — only un-enriched items)             │
        │   - entities (hashtags, urls, mentions, tools)  [free]         │
        │   - semantic tags (cheap text model)                           │
        │   - format flags (has_code, is_thread, is_launch, is_benchmark)│
        │   - categories + confidence                                    │
        │   - vision/OCR on images (tiered, cost-gated)                  │
        │   - embeddings (OpenAI text-embedding-3-small → sqlite-vec)    │
        │   - segment tag (brief-relevant | everything-else)            │
        └───────────────────┬───────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  OUTPUTS                                                                │
   │                                                                         │
   │  (1) Obsidian export → Content/X Bookmarks/*.md + _index/              │
   │  (2) Hybrid search → Apollo chat + Siftly web UI + CLI                 │
   │  (3) Preference model → preference-profile.json + Obsidian profile.md  │
   │  (4) Corpus composition report → Obsidian                             │
   │  (5) Brief integration → x-feed-brief + morning-digest personal_fit   │
   │  (6) Feedback loop → brief-surfaced vs later-bookmarked tracking      │
   └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Component boundaries

| Component | Keep from Siftly? | Change |
|---|---|---|
| SQLite + Prisma schema | Keep | Extend: `savedAt`, `likedAt`, `segment`, `embedding` (via sqlite-vec table), `formatFlags` |
| FTS5 search | Keep | Unchanged; becomes the "exact" half of hybrid |
| Entity extraction | Keep | Unchanged |
| Semantic tagging | Keep | Unchanged |
| Categorization | Keep | Adjust `DEFAULT_CATEGORIES` for Ace; add segment computation |
| Vision/OCR | Keep | Tier it; cost-gate |
| Obsidian exporter | Keep + heavily patch | Richer frontmatter, signal fields, index notes, Ace vault path |
| Mindmap UI | Keep | Unchanged (browse use case C) |
| Web UI / search page | Keep | Unchanged |
| CLI | Keep + extend | Add `ingest`, `embed`, `profile`, `report`, `search-json` |
| **Cookie ingestion (`twitter-api.ts`, `x-sync.ts`)** | **Replace** | New `xurl`-based `ingest.ts`; old cookie path kept as documented fallback, disabled |
| Embeddings | **Add (new)** | `sqlite-vec` + OpenAI embeddings |
| Preference model | **Add (new)** | `profile.ts` |
| Brief integration | **Add (new)** | Patches to `x-feed-brief` / `morning-digest` prompts + a corpus query helper |
| Feedback loop | **Add (new)** | tweet-ID matching against brief archives |

### 4.2 Data flow — reversibility

Every stage is re-runnable and idempotent:
- Ingestion upserts by `tweetId` (dedupe).
- Enrichment only touches `enrichedAt IS NULL` items.
- Embeddings only touch items missing a vector.
- Obsidian export skips existing notes unless `--overwrite`.
- Preference model is a pure function of the corpus → fully regenerable.

Rollback = stop the cron, restore the SQLite file from backup, delete the Obsidian `Content/X Bookmarks/` folder.

---

## 5. Detailed Design

### 5.1 Ingestion (xurl OAuth2)

**Auth (one-time):** `xurl auth oauth2 --app siftly-ace angalexg` grabs a user-context token with scopes `bookmark.read like.read tweet.read users.read offline.access`. `offline.access` enables refresh-token auto-rotation. Apollo drives the browser flow; Ace authorizes if needed. **The `siftly-ace` app is dedicated (D9a) — the briefs' `forge` app credentials are never touched.**

**Credit-floor guard (D9c):** before every ingest run (backfill batch or daily incremental), check remaining X API credits. If below the reserve threshold (sized ≥ both briefs' combined daily read budget), **abort and alert #alerts** rather than risk depleting the pool. Backfill is chunked into small credit-gated batches. **Caveat (Pass-2 OQ1):** a pay-per-use token may NOT expose a queryable remaining-credit balance. If it doesn't, the guard reduces to **timing-isolation + hard batch-caps** (backfill off the brief window, small bounded batches, daily incremental capped at a few pages) — which is adequate on its own. Phase 0 confirms whether a balance read exists; the guard implementation branches on that finding.

**Endpoints:**
- `GET /2/users/:id/bookmarks?max_results=100&pagination_token=…&tweet.fields=created_at,public_metrics,entities,attachments&expansions=author_id,attachments.media_keys&user.fields=username,name&media.fields=url,preview_image_url,type`
- `GET /2/users/:id/liked_tweets?…` (same shape)

**`:id`** = Ace's user ID (resolve once via `xurl whoami` → `data.id` = `56282605` per the briefs).

**Pagination:** loop `pagination_token` until absent or page ceiling (configurable; default 60 pages = ~6k items, raise if needed). Report actual pages/items pulled and whether the API truncated.

**Cost:** `$0.005/post read`, deduped within 24h UTC window. Backfill ~3–5k items ≈ $15–25. Daily incremental = pennies (only new). Reads cap 2M/mo — irrelevant.

**Backfill timing (Blocker 2 fix):** the one-time backfill runs in a window that **cannot collide with the 7:00/7:30am brief runs** (e.g. midday or evening, on-demand with Ace), credit-gated in small batches. The *daily incremental* cron (D19) is moved to **5:30am** with a **hard 20-minute time budget** and credit-floor guard, so it completes well before the briefs and cannot starve their credits or overlap their window.

**Incremental ordering (Required Change 4):** X bookmark/like ordering is NOT guaranteed newest-first or stable. The incremental sync does **not** rely on "stop at first seen ID." Instead it pulls the recent window (bounded pages) and **upserts by `tweetId`** (full set-reconciliation against existing IDs), so reordering never causes silently-missed items. A periodic (weekly) full re-page catches anything missed.

**`saved_at`/`liked_at` availability (Required Change 3):** these timestamps may NOT be exposed by the API. Phase 1 verifies field availability. If absent: dedupe "bookmark wins" is determined by **source precedence** (bookmark > like), not timestamp; and novelty calibration (§5.7 signal #5) falls back to using `tweet_created_at` spread relative to ingestion date, or is disabled with a logged note. The system must not assume these fields exist.

**Rate limits:** 100/page, 15-min rolling windows; throttle on 429 honoring `x-rate-limit-reset`. **402 `CreditsDepleted`** handling (shared with briefs' token billing): trap, alert #alerts, stop.

**Dedupe rule (D1):** Pull bookmarks first → mark `source=bookmark`. Pull likes → for each, if `tweetId` already exists (bookmarked) skip the source downgrade; else insert `source=like`. Bookmark always wins.

**State:** persist last-sync cursor + timestamp in a `Setting` row. Daily incremental pulls a **bounded recent window** (capped pages) and reconciles by `tweetId` upsert per the Incremental-ordering rule above — it does **NOT** short-circuit on first-seen-ID (X ordering isn't guaranteed stable). The cursor bounds how many pages the incremental walks; the weekly full re-page is the safety net for anything reordered out of the window.

### 5.2 Schema extensions (Prisma)

```prisma
model Bookmark {
  // ... existing fields ...
  savedAt       DateTime?  // bookmark saved_at if exposed; else null
  likedAt       DateTime?  // like timestamp if exposed; else null
  segment       String?    // "brief-relevant" | "everything-else" (computed)
  formatFlags   String?    // JSON: {is_thread,has_code,has_link,is_launch,is_benchmark,has_image,has_video,link_domains[]}
  videoTranscript String?  // Whisper transcript of bookmarked video audio (null if no video / not yet processed / silent)
  // source already exists: "bookmark" | "like"
}
```

Embeddings via sqlite-vec virtual table (not a Prisma model — raw SQL):
```sql
CREATE VIRTUAL TABLE bookmark_vec USING vec0(
  bookmark_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]   -- text-embedding-3-small dim
);
```

### 5.3 Enrichment tiers (cost control — D17)

| Tier | Applies to | Model | Cost |
|---|---|---|---|
| 0 — entities | all | none (regex/parse) | free |
| 1 — text tags + format flags + categories + segment | all | cheap text model (e.g. `gpt-5.x-mini` / haiku-class) | low |
| 2 — vision/OCR | items with images **OR video thumbnails** | vision model | medium (the expensive part) |
| 3 — embeddings | all (text composite, **incl. video transcript**) | OpenAI `text-embedding-3-small` | <$1 total |
| **V — video** | items with **video** (see §5.3.1) | `yt-dlp` + **local Whisper** (free) → vision frames only if silent | **$0 compute** (local) + bandwidth | 

**Cost-estimate gate:** before the backfill enrichment run, the CLI prints `N items, M with images, V with video, est. $X.XX` and requires `--confirm` (or Apollo relays the estimate to Ace for approval). Daily incremental skips the gate (only new items, pennies). Video transcription is local/free so it doesn't add API cost, but it adds *time* — handled out-of-band (§5.3.1).

### 5.3.1 Video enrichment (tiered, lazy, local-first)

X posts with video are a real gap: Siftly's vision step only sees the **thumbnail**, never the audio/motion — so the substance of a bookmarked demo/talk/tutorial (which lives in what's *said*) is invisible to search. Fix with three sub-tiers, cheapest-first, run **out-of-band** from the brief-critical daily cron:

| Sub-tier | What | Tool | Cost | When |
|---|---|---|---|---|
| V0 — thumbnail | vision/OCR on cover frame | Siftly vision (Tier 2) | cheap | every video |
| **V1 — transcript** | audio-only pull → speech-to-text | `yt-dlp -x` + **`parakeet-transcribe` skill** (NVIDIA Parakeet on ACE-AI GPU, Mac `parakeet-mlx` fallback) | **free** (local GPU) | every video with audio (the main win) |
| V2 — frame sampling | sample N frames, vision-analyze | `ffmpeg` + vision | medium | only when V1 transcript is empty/near-silent (silent memes, b-roll) |

**Rules:**
- **Transcription is a COMPOSABLE skill, not inline.** A standalone `parakeet-transcribe` skill (specced separately) owns "audio/video → transcript." Siftly's video tier is a thin caller. Primary backend: **NVIDIA Parakeet (`parakeet-tdt-0.6b-v3`) on ACE-AI** (`192.168.1.216`, RTX PRO 6000 96GB — ~10x faster + more accurate than Whisper). Fallback: **`parakeet-mlx` on the Mac Studio** when ACE-AI is unreachable; Whisper as last resort. Backend is provider-swappable.
- **yt-dlp on X:** supports X/Twitter natively; rewrite `x.com`→`twitter.com` in the URL before download (known reliability quirk). Protected/age-gated → fall back to V0+V2.
- **Local + free.** Audio is **transient** — extract → transcribe → discard. We store only `videoTranscript` text (joins the embedding composite + FTS5).
- **Non-blocking.** Video transcription does **NOT** run inside the 5:30am daily cron's 20-min budget. New videos enter a **persistent transcription queue** (`scripts/video-queue.py`, backed by a `VideoQueue` table/JSONL so it survives reboot and is idempotent — never double-transcribes a `tweetId`). Drained by a **separate low-priority cron** (e.g. hourly, off-peak) that processes a bounded number of items per run; a podcast-length clip can never blow the brief window.
- **Long-video cap + chunking.** Parakeet v3 handles up to ~24 min full-attention / ~3 hr local-attention; cap per-video duration (configurable) and chunk longer clips so one 90-min video can't dominate the corpus.
- **Graceful failure.** If `yt-dlp` can't fetch or both transcription backends are down, fall back to V0 thumbnail + V2 frames; never crash. Log skipped videos for retry.

### 5.4 Segmentation (D13)

After Tier-1 tagging, each item gets `segment`:
- **brief-relevant**: categories in {AI/ML, dev-tools, crypto/web3, startups/business, security, productivity, finance} OR format flags {is_launch, is_benchmark, has_code}.
- **everything-else**: memes, personal, health, sports, music, etc.

**Provisional taxonomy (Required Change 6):** the category list above is **provisional**. Per D7, the corpus composition is unknown — so the taxonomy is **re-derivable after the Phase 6 composition report** reveals what's actually in the corpus. The segment field is re-computable at any time without re-enrichment (it's a pure function of tags/categories). Do not treat the v1 taxonomy as final.

**Enforcement: none for now.** All segments feed brief scoring. `segment` is stored + reported so Ace can later flip `--exclude-segment everything-else` via config without re-enriching.

### 5.5 Hybrid search

```
query
 ├─ embed(query)              → sqlite-vec top 100 (semantic)
 ├─ extractKeywords(query)    → FTS5 top 100 (exact: handles, tools, hashtags)
 ├─ merge + dedupe (reciprocal rank fusion)
 ├─ AI rerank top ~30 (existing Siftly rerank, model-pinned)
 └─ return ranked: text, author, url, obsidian_path, why_matched, score
```

Optimized for **A (precision known-item)**: exact entity hits (FTS5) are boosted so "that thread by @karpathy about X" lands. Semantic half covers vocabulary drift. Rerank does final ordering.

### 5.6 Obsidian export (patched)

**Target:** `/Users/alexgierczyk/Obsidian/Ace Place/Content/X Bookmarks/`
**Filename:** `YYYY-MM-DD - @author - tweetId.md`

**Frontmatter:**
```yaml
type: x-bookmark
tweet_id: "..."
url: "https://x.com/handle/status/..."
author: "handle"
author_name: "..."
tweet_created_at: 2026-06-07
saved_at: 2026-06-07
source: bookmark            # or like
segment: brief-relevant     # or everything-else
categories: [...]
semantic_tags: [...]
entities: { hashtags: [...], tools: [...], mentions: [...] }
format_flags: [is_thread, has_code]
media_types: [photo]
```

**Body:** tweet text → media (with OCR text as caption) → extracted signals → source link. **No "why bookmarked" section** (non-goal).

**Index notes** (`_index/`): Authors, Categories, Tools, Segments, plus a top-level corpus README. Backlinks for Obsidian graph.

### 5.7 Preference model (D2, D3, D12)

`scripts/profile.ts` → reads full corpus → writes:
- `~/.hermes/state/x-bookmarks/preference-profile.json` (machine-readable, consumed by briefs)
- `Content/X Bookmarks/Ace Bookmark Preference Profile.md` (human-readable, Obsidian)

**Six signals (from handoff, reconciled with non-goals):**
1. **Topic affinity** — cluster corpus (embeddings → k-means/HDBSCAN or LLM topic tags); weight by frequency × source-weight.
2. **Source affinity** — rank authors by save frequency (bookmark 1.0 / like 0.3). Personalizes "Source Quality."
3. **Format affinity** — which formats Ace saves (threads, code, benchmarks, launches). **Factual flags only** — no speculative intent.
4. **Format/topic intent (factual)** — observable classes only (has-code, is-launch, is-benchmark, is-thread). *Reconciled: dropped the handoff's "infer why saved."*
5. **Novelty calibration** — evergreen-vs-breaking ratio from `saved_at` vs `tweet_created_at` spread.
6. **Negative/contrast set** — positives = bookmarks/likes/accepted-video-ideas/later-bookmarked-brief-items; negatives = discarded brief candidates, auto-zeroed topics, brief items never saved.

**Circularity guard (Required Change 1):** "later-bookmarked-brief-items" are positives, but the brief that surfaced them was itself personal-fit-influenced — a self-reinforcing loop. To avoid the model treating its own influence as independent signal: brief-surfaced-then-bookmarked items are **tagged distinctly** (`origin: brief-surfaced`) and **excluded from topic/source-affinity reinforcement**; they only count toward the feedback loop's *direct* "did the brief surface something Ace wanted" metric, weighted separately. Organic bookmarks (not surfaced by a brief) are the only items that reinforce topic/source affinity.

Weighting: bookmark contributions ×1.0, like contributions ×0.3.

**Output JSON shape:**
```json
{
  "updated_at": "...",
  "corpus_size": {"bookmarks": 0, "likes": 0},
  "top_topics": [{"name": "...", "weight": 0.0, "segment": "brief-relevant"}],
  "high_signal_authors": [{"handle": "...", "saves": 0, "weight": 0.0}],
  "favorite_formats": ["..."],
  "downrank_patterns": ["..."],
  "novelty_profile": {"evergreen_ratio": 0.0},
  "scoring_guidance": "..."
}
```

### 5.8 Brief integration (D12) — personal-fit layer

**Mechanism (per handoff, scaled up per D12):**
```
final_score = base_score (0–100 from existing rubric) + personal_fit_delta
personal_fit_delta = personal_fit_raw (−1..+1) × PF_WEIGHT
PF_WEIGHT default = 30   # ≈30% swing, single tunable knob
```

`personal_fit_raw` per candidate = weighted blend of:
- semantic similarity to corpus clusters (sqlite-vec query against bookmark embeddings)
- author affinity (is this author frequently saved?)
- format affinity match
- topic affinity match
- minus contrast-set penalty (matches downrank patterns)

**Mandatory audit logging:** the brief archive frontmatter records, per item:
```yaml
base_score: 84
personal_fit_raw: 0.42
personal_fit_delta: +12.6
final_score: 96.6
pf_signals: {author_affinity: high, topic: agent-workflows, similar_bookmarks: 3}
```
This is how we *see* whether personal-fit helps or creates an echo chamber. Dial `PF_WEIGHT` from a config file (`~/.hermes/state/x-bookmarks/brief-config.json`) — no code change.

**Integration points:**
- `~/.hermes/state/cron/x-feed-brief/prompt.md` Step 5 → add personal-fit after base score; new "Step 4.5: load preference profile + corpus query helper."
- `~/.hermes/state/cron/morning-digest/prompt.md` → same layer (its candidates summarized → embedded → matched).
- A helper script the brief crons call: `scripts/pf-score.py <candidates.json>` → returns per-item pf signals (so the LLM cron doesn't do vector math itself; cheap + deterministic).

**Live-brief safety (Blockers 3 & 4 — non-negotiable):**
1. **Prompt versioning + rollback.** The live `prompt.md` files are **git-tracked** (a small repo or the project's own `state-snapshots/`) BEFORE any edit. Every patch is committed with a revert path. §8 rollback explicitly covers prompt files. A timestamped backup (`prompt.md.bak-YYYYMMDD-HHMMSS`) is written immediately before each edit as belt-and-suspenders.
2. **Dry-run gate.** Before the patched prompt goes live, run **≥3 consecutive dry-runs** comparing patched-vs-unpatched brief output (the brief produces output but does NOT post — a `DRY_RUN=1` flag short-circuits the Discord post + seen-list write). Go-live only after dry-runs look sane.
3. **Kill-switch.** `PF_WEIGHT=0` MUST make the personal-fit layer a **complete no-op** — the brief degrades to *exactly* its current behavior (byte-identical scoring path), not a degraded/error state. This is the instant-revert.
4. **pf-score failure isolation.** `pf-score.py` is called with a **hard timeout** (e.g. 30s). If it errors, times out, returns malformed data, or sqlite-vec fails to load, the brief **falls back to base_score only**, logs the degradation (one line to #alerts or the brief's own log), and **continues to completion**. The personal-fit helper can NEVER take down or block a load-bearing brief. This is a tested failure path, not an aspiration.

**Sourcing bonus (built, additive):** `scripts/watchlist.py` derives high-save authors → optional watchlist the briefs can pull as a targeted high-signal check (ties into the open full-24h-vs-capped A/B test).

### 5.9 Feedback loop (D14)

`scripts/feedback.py` (runs in daily cron, after ingestion):
- Read recent brief archives (`Content/X Feed Brief/*.md`, `Content/Morning Digest/*` **if archived — see below**) → extract surfaced tweet IDs + dates.
- Cross-reference against the bookmark corpus: a brief-surfaced tweet later found in bookmarks = **positive**; surfaced but never saved after N days = **weak negative**.
- Write to `~/.hermes/state/x-bookmarks/feedback.jsonl` → feeds the contrast set on next profile rebuild (subject to the §5.7 circularity guard).

**morning-digest archive (Required Change 2 / Q3):** x-feed-brief archives a parseable per-item file; morning-digest may NOT. Phase 1 verifies. The feedback loop **degrades cleanly**: it parses whatever archives exist, skips unparseable/missing sources with a logged note, and never crashes the cron over a missing morning-digest archive. (If morning-digest has no parseable archive, a tiny archive-write step can be added to it as a separate, optional change — not a blocker for the rest of the system.)

### 5.10 Daily cron (D19)

`no_agent` launchd/cron on Mac Studio, **~5:30am PT** (moved earlier per Blocker 2; **hard 20-min time budget**, must finish before the 7:00/7:30am briefs):
```
1. ingest (incremental, xurl)      → new bookmarks + likes
2. enrich (only new items)         → tiers 0–3
3. export-obsidian (only new)      → notes + refresh indexes
4. profile (regenerate)            → preference-profile.json
5. feedback (match brief archives) → feedback.jsonl
```
Pure script (`scripts/daily.sh`). Empty stdout on success (silent). Non-zero exit OR trapped 402/auth-failure → `notify.py --send "<first error line>" --channel discord --target 1480528231286181948`.

### 5.11 Search surfaces (D20)

1. **Apollo in-chat (primary):** Ace asks "find my bookmarks about X" → Apollo calls `siftly-ace search "<q>" --json` → returns ranked: `@handle · one-line gist · <x-link> · [[obsidian-note]]`.
2. **Siftly web UI (included):** Apollo can start it (`npm run dev` / a small launchd service + tunnel) for visual browse/mindmap. Removable later.
3. **CLI:** `npm run siftly search …` for power use.

---

## 6. Implementation Phases (internal build order — full system is the deliverable)

Each phase ends with a **smoke test** (real input, verify output), then commit + push.

- **Phase 0 — Fork & scaffold + OAuth2 HARD GATE.** Fork Siftly → `siftly-ace`, clone to `~/Projects/siftly-ace`, `npm install`, init DB, `AGENTS.md`. **Register a DEDICATED `siftly-ace` X app (type: Web/automated), run the OAuth2 PKCE grant, and PROVE `xurl /2/users/56282605/bookmarks` returns 200 with data (not 403) — with ZERO mutation to the `forge` app's oauth1/bearer.** This is a hard gate: **if the grant fails or scopes aren't grantable on the plan, the project does not proceed past here** (fall back to documented cookie path only with Ace's explicit OK). Smoke: `npm run build` clean, `siftly stats` returns 0, `forge` app's `xurl auth status` unchanged before/after.
- **Phase 1 — xurl OAuth2 ingestion.** One-time auth grant; `scripts/ingest.ts` (bookmarks + likes + dedupe + pagination + state). Smoke: pull a small page, verify rows + dedupe + source field.
- **Phase 2 — Full backfill + cost gate.** Cost estimate → Ace approval → full paginated backfill. Smoke: report total items, pages, truncation, bookmark/like split.
- **Phase 3 — Enrichment tiers + segment + video.** Entities, tags, format flags, categories, vision/OCR (gated), segment, **and video tier V (yt-dlp + local Whisper transcript, out-of-band queue)**. Smoke: spot-check 5 enriched items incl. a meme (OCR text present) **and a bookmarked video (transcript present, searchable by spoken content)**.
- **Phase 4 — Embeddings + sqlite-vec + hybrid search.** Embed corpus, build vec table, hybrid retrieval + rerank. Smoke: run 3 known-item queries (A use case), verify the known tweet is top-3.
- **Phase 5 — Obsidian export.** Patched exporter + indexes. Smoke: export, open a note in vault, verify frontmatter + backlinks + meme OCR caption.
- **Phase 6 — Preference model + composition report.** `profile.ts` + report. Smoke: profile.json populated, composition report shows segment split.
- **Phase 7 — Apollo chat search + web UI.** `search --json` wired to Apollo; web UI launchable. Smoke: Apollo answers a real "find my bookmarks about X" with ranked links.
- **Phase 8 — Brief integration + audit logging + SAFETY.** `pf-score.py` (with 30s hard timeout + base-score fallback), prompt patches (git-tracked + `.bak` before edit), `PF_WEIGHT=30` with `=0` kill-switch no-op verified, audit frontmatter. Smoke: (a) dry-run a brief with `DRY_RUN=1`, verify base/fit/final logged per item AND no Discord post / no seen-list write; (b) **kill-switch test** — `PF_WEIGHT=0` produces byte-identical scoring to the unpatched brief; (c) **failure-isolation test** — force `pf-score.py` to error/timeout, verify the brief completes on base_score only and logs the degradation. Go live only after ≥3 clean dry-runs.
- **Phase 9 — Feedback loop + daily cron.** `feedback.py`, `daily.sh`, cron registration, #alerts failure routing. Smoke: run `daily.sh` manually, then via scheduler (`hermes cron run --wait`), confirm output + alert path.
- **Phase 10 — Documentation.** Obsidian overview + project docs + mem0 conclude + memory pointer.

---

## 7. Security & Privacy

- **Tokens:** OAuth2 user-context token in `~/.xurl` (xurl-managed, auto-refresh). No raw secrets in code/docs/memory/chat. Any extra secret → 1Password Engineering vault.
- **Scope minimization:** request only `bookmark.read like.read tweet.read users.read offline.access`.
- **Data sensitivity:** corpus = public tweets Ace saved. Low sensitivity, but the *set* reveals Ace's interests → keep DB + profile local; do not publish the corpus or profile third-partyly.
- **Embedding egress (Required Change 7 — honest reconciliation):** with D11 (OpenAI embeddings), **tweet text IS sent to OpenAI's API** to compute vectors. This is the one place data leaves the host. Tweets are public, so sensitivity is low, but "local-first" is therefore **"local-storage-first, with embedding compute via API."** Stated plainly here so the claim isn't misleading. The embedder is a swappable provider (D11) — switching to the ACE-AI local embedding model makes the system fully local-compute with zero egress; that's the documented path if Ace wants true local-first later.
- **Obsidian:** notes live in the private vault. No secrets in notes.
- **Web UI:** bind to localhost; if tunneled, auth the tunnel. Never expose the UI publicly.
- **Brief token billing:** ingestion shares the pay-per-use X billing with the briefs — trap 402 to avoid silently starving the briefs of credits.

---

## 8. Observability & Ops

- Daily cron: silent on success, #alerts on failure with first error line embedded.
- Ingestion logs: items pulled, pages, dedupe count, cost estimate, 402/429 events.
- Enrichment logs: items enriched per tier, vision calls, embedding count, cost.
- Brief audit: base/fit/final per item in archive frontmatter (the echo-chamber tripwire).
- Backups: SQLite file + Obsidian folder covered by existing fleet backup (verify inclusion).
- Rollback: stop cron → restore DB from backup → optionally delete Obsidian folder.

**Full teardown / rollback (Required Change 5 — complete list):**
1. **Prompt patches:** `git revert` (or restore `prompt.md.bak-*`) for both `x-feed-brief` and `morning-digest` prompt.md → briefs return to pre-project behavior. (Or instant: set `PF_WEIGHT=0`.)
2. **brief-config.json:** delete `~/.hermes/state/x-bookmarks/brief-config.json` → defaults/no-op.
3. **Cron:** `hermes cron remove <id>` (or unload the launchd job) → no more ingestion.
4. **OAuth2 token:** `xurl auth apps remove siftly-ace` → revoke the dedicated app's token. (Briefs' `forge` app untouched throughout.)
5. **DB:** restore/delete `~/Projects/siftly-ace/prisma/siftly.db`.
6. **Obsidian:** delete `Content/X Bookmarks/`.
7. **State:** delete `~/.hermes/state/x-bookmarks/`.
Each step is independent; partial rollback (e.g. just disable brief integration via kill-switch, keep search) is supported.

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OAuth2 grant fails (app type/scope not grantable on pay-per-use) | Med | High (blocks ingestion) | Verify app is "Web/automated" type; if scopes ungrantable, fall back to documented cookie path; test grant in Phase 1 before building on it |
| Bookmarks API truncates history (can't get full backfill) | Med | Med | Discover at Phase 2; if capped, document ceiling, supplement with cookie scrape one-time if needed |
| Personal-fit at 30% creates echo chamber | Med | Med | Mandatory audit logging; single knob to dial back; contrast set; segment data |
| Enrichment cost blows past estimate | Low | Med | Cost-gate with `--confirm`; tiered models; vision only on images |
| 402 CreditsDepleted starves briefs | Low | High | Trap 402, alert, stop; ingestion is incremental/cheap after backfill |
| sqlite-vec build/install issues on macOS | Low | Med | Verify extension loads in Phase 4 before relying on it; fallback to brute-force cosine if needed |
| Siftly upstream schema drift on fork merge | Low | Low | Pin fork; cherry-pick upstream fixes deliberately |
| Brief prompt patches break the live brief | Med | High | Dry-run gate in Phase 8; never edit live prompt without a tested copy; the briefs are load-bearing daily |

---

## 10. Open Questions

**Resolved in v2:** Q1 → dedicated `siftly-ace` app (D9a). Q4 → PF_WEIGHT = ±30 raw points, `=0` no-op (D12).

**Still open (verify in Phase 0/1, not blockers to approving the plan):**
1. Does the X API expose bookmark `saved_at` / like timestamps for this app tier? (Affects novelty calibration + has a defined fallback in §5.1.)
2. Does morning-digest write a parseable archive? (§5.9 degrades cleanly either way; may add a tiny archive step.)
3. Actual shared-vs-dedicated billing setup + credit reserve number for the credit-floor guard (D9c) — confirm at Phase 0.
4. Topic clustering method — LLM topic tags (simpler, explainable) vs embedding clustering. Lean LLM tags for v1; revisit after composition report.
5. Likes backfill ceiling — same as bookmarks unless likes >> bookmarks; flag at Phase 2.

---

## 11. Acceptance Criteria

- [ ] OAuth2 user-context token works; `xurl /2/users/56282605/bookmarks` returns data (not 403).
- [ ] Full backfill: bookmarks + likes ingested, deduped (bookmark wins), source field correct.
- [ ] Corpus enriched: every item has entities + tags + format flags + segment; images have OCR/vision; **videos have Whisper transcripts (or documented fallback) and are searchable by spoken content**.
- [ ] Embeddings: every item has a vector; hybrid search returns known item in top-3 for 3 test queries (A).
- [ ] Obsidian: notes exported with full frontmatter + indexes + meme OCR captions; re-export doesn't dup.
- [ ] Preference profile JSON + Obsidian profile generated from full corpus, bookmark/like weighted.
- [ ] Composition report shows segment split + top topics/authors/formats (answers D7).
- [ ] Apollo answers "find my bookmarks about X" in-chat with ranked X + Obsidian links.
- [ ] Siftly web UI launchable for browse.
- [ ] Brief dry-run logs base/fit/final per item; PF_WEIGHT tunable from config.
- [ ] Feedback loop matches brief-surfaced vs later-bookmarked.
- [ ] Daily cron runs end-to-end via scheduler; failure alerts to #alerts.
- [ ] **Phase 0 OAuth2 gate passed**: dedicated `siftly-ace` app returns 200 on bookmarks; `forge` app credentials provably unchanged.
- [ ] **Briefs survive pf-score failure**: forced pf-score error/timeout → brief completes on base_score, logs degradation.
- [ ] **Kill-switch verified**: `PF_WEIGHT=0` → byte-identical scoring to unpatched brief.
- [ ] **Prompt patches reversible**: git-tracked + `.bak`; revert restores pre-project brief behavior.
- [ ] **Backfill does not deplete brief credits**: credit-floor guard aborts below reserve; backfill timed off the brief window.
- [ ] Documentation: Obsidian overview + project docs + mem0 + memory pointer.
```
