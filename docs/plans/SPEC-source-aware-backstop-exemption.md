# SPEC — Source-Aware Backstop Exemption (don't floor topic-curated thin-text items)

**Status:** v2 — specced 2026-06-15. Shadow-only scorer code (NO config gate, NO live behavior change)
until the deterministic-engine cutover. Companion to `SPEC-label-trust-backstops.md`.
**Owner:** Apollo. **Repo:** `Kyzcreig/siftly-ace`.
**Surfaces:** `scripts/score_digest.py` (shadow scorer) + `scripts/gather/github.ts` (gatherer enrichment).
**Trigger:** the cutover-window finding — github-trending + curated-AI-subreddit items whose only text is
a repo slug or short title get force-floored by the fragment / off-topic backstops, producing false
off-topic / false-fragment exclusions.

---

## 1. The over-fire (ground-truthed 2026-06-15, live 633-candidate pool)

Of **116** github/reddit candidates in today's real pool, **40 are floored by a backstop**:
- **24 fragment-floored → BASE 0** (`is_bare_fragment` true on the thin title): `trycua/cua`,
  `NVIDIA/SkillSpector`, `shiyu-coder/Kronos`, `music-assistant/server`, "Diffusion Gemma Jailbreak",
  "Testing multi agents", …
- **16 off-topic-floored → −penalty** (`python_on_topic="off"`, no exact `ON_TOPIC_TOKEN`): "I built a
  TUI to review worktree changes", "Choosing a document parser in 2026", "Quick SCAIL-2 test in ComfyUI", …

Every one was labeled `on_topic=core` by the model AND comes from a topic-curated source.

### Why the backstops misfire here
The fragment + off-topic backstops were tuned for **X tweets**, where thin text = a bare reply with no
standalone substance (the @elonmusk "scumbag and traitor" miss). They encode *"thin text ⇒ noise,"* which
is **false for github-trending and curated-AI-subreddit items**, where thin text is normal: a repo slug
is the legitimate identity of dev content; a 3-word r/LocalLLaMA title is still an AI post.

### The hard asymmetry discovered during analysis (the reason this is a 2-part fix)
The two sources are **NOT symmetric**, and a naive "trust the source" exemption is wrong for one of them:

- **Reddit (curated AI subs):** the *subreddit itself* is a genuine TOPIC signal. We hand-picked 9 AI subs
  (LocalLLaMA, MachineLearning, …). A post in r/LocalLLaMA is AI content by construction, regardless of
  how terse its title is. The sub vouches for **topicality**. → cleanly exemptable.

- **GitHub (trending):** "trending" vouches for **popularity, NOT topicality**. GitHub trending is
  topic-agnostic — it surfaces `iptv-org/iptv`, `freeCodeCamp/freeCodeCamp`, `Raphire/Win11Debloat`
  (genuinely off-topic for Ace) right next to `NVIDIA/SkillSpector`, `shiyu-coder/Kronos` (on-topic).
  **Proven indistinguishable from the slug alone:** the model labels EVERY github item
  `on_topic=core, content_type=news, substance=concrete` (verified on the live pool — identical labels
  for freeCodeCamp and SkillSpector), and the slug tokens (`iptv`, `skillspector`) carry no reliable
  topic signal. A blanket source-vouch for github lets off-topic repos (scored ~59–60) sit one slow-news
  day away from Also-Noted. **GitHub cannot be fixed by a scoring heuristic — it needs more DATA.**

---

## 2. Design principle (extends SPEC-label-trust-backstops §2)

> The model's labels are a HINT (Python verifies). **The SOURCE can be a topic signal — but only when the
> source actually guarantees topicality.** A curated AI subreddit does; GitHub-trending does not. Where the
> source can't vouch, fetch the data that can (the repo description) rather than guess from the slug.

Stays **fail-toward-exclusion**: every change only relaxes a Python *force-floor* and never upgrades an
`off` to `core`, never rescues a politics/insult item, never touches X/HN.

---

## PART A — Reddit (scoring exemption, shadow scorer) — ship with the cutover

### A.1 Curated-source predicate (`scripts/score_digest.py`)
`is_topic_curated_source(item)` → True when `source == "reddit"` AND the subreddit parsed from the URL
(`reddit.com/r/<sub>`) is in `CURATED_AI_SUBREDDITS` (the same 9 the G1 reddit gatherer uses:
localllama, machinelearning, artificial, singularity, openai, ai_agents, llmdevs, chatgptcoding,
stablediffusion). A reddit item from ANY OTHER sub is NOT exempt (defensive: a future wider gatherer set
doesn't silently inherit the vouch). **GitHub is deliberately NOT curated-for-topic here** (Part B).

### A.2 Off-topic backstop — reddit source vouch (modifies Backstop 2)
In `python_on_topic`, before returning the zero-tech-token `"off"`: if `is_topic_curated_source(item)` AND
the body carries **no OFF_TOPIC_MARKER**, return `(None, "source-curated-vouch")` — don't force off; let
the model label stand. If an OFF_TOPIC_MARKER is present, the exemption does NOT apply → still force `off`
(a curated AI sub can still carry a political rage-thread; the vouch is for topicality, never a pass past
the politics/insult guard — preserves the load-bearing @elonmusk-class protection).

**Token-vs-marker precedence (explicit decision).** The existing flow returns `(None, None)` — "let the
model label stand" — the instant ANY on-topic token is found, BEFORE the OFF_TOPIC_MARKER force-off is
ever evaluated. So a post containing both a tech token AND an insult marker (e.g. an r/singularity rant
"this AI policy is communist garbage") is NOT force-floored by Python — it's left to the model label. This
is **unchanged, pre-existing X behavior** (a real tech token already lets the model label govern on X),
and the model-label prompt itself classifies political/insult content as `off`. The reddit vouch does NOT
make this worse: the vouch only fires on the ZERO-token path, AFTER the token short-circuit, and is itself
gated on no-OFF_TOPIC_MARKER. So the politics guard's strength is identical to today's X path — the vouch
adds no new bypass. (If we ever want Python to force-off a tech-token-bearing insult, that's a separate
change to the X path too, out of scope here.)

### A.3 Fragment backstop — source-aware threshold (modifies Backstop 1)
`is_structural_fragment(item)`: for a curated source, an item is a fragment ONLY if it has literally no
usable title/text (empty/whitespace) — a 2–3 word AI-thread title is NOT a fragment. For all other sources
(X, HN, Perplexity, **and github** in Part-A-only state) behavior is unchanged (`is_bare_fragment`).
Backstop 1 calls `is_structural_fragment`; for non-curated sources the two are identical → X/HN
byte-identical.

### A.4 What Part A deliberately does NOT do
- Does not force any item on-topic or boost it. Does not touch X/HN (predicate false → both backstops
  unchanged; morning-digest X byte-identity preserved). Does not bypass the politics/insult guard, the
  low-reach cap, forced distribution, or the author cap.

---

## PART B — GitHub (read the description already in the dump) — the real topic signal

### B.1 Root cause restated (CORRECTED after ground-truth)
GitHub on-topic vs off-topic IS separable — but only from the repo **description**, not the slug. Critical
finding (verified on the live dump): **the description is ALREADY present.** The trending gatherer
(`scripts/gather/github-trending.ts`, `extractSummary`) already scrapes the repo's `<p>` description into
the candidate `summary` field, and the scored dump carries it (`NVIDIA/SkillSpector` →
"Security scanner for AI agent skills…"; `iptv-org/iptv` → "Collection of publicly available IPTV
channels"). The ONLY reason github items get floored is that the scorer's `_item_text(item)` reads
`title` (the opaque slug) and **never falls through to `summary`** for these items — so the on-topic token
check runs against `iptv-org/iptv` instead of the real description. **No gatherer change, no API call, no
new ingestion — the data is in hand; the scorer just isn't looking at it.**

### B.2 The fix: a DEDICATED topic-check accessor (`scripts/score_digest.py`)
**Do NOT edit the shared `_item_text`** — it has multiple callers (`python_on_topic`,
`is_bare_fragment`/`is_structural_fragment`, `_substance`, the renderer's text path, the x-feed
`text_snippet` fallback). Broadening it would change base/actionability/rendering for every story source
including **HN** (which CAN carry a `summary`), breaking byte-identity.

Instead add a NEW, narrowly-scoped accessor `_topic_text(item)`, used **only** by `python_on_topic` and
`is_structural_fragment`:
- For a **github** item (`source == "github"`/`github-trending`): return `title + " " + summary` (the
  description). This is the only source whose slug-title is opaque and whose summary is the real signal.
- For **every other source** (X, HN, reddit, smol, Perplexity): return exactly what `_item_text` returns
  today (title/tweet_text/etc.). **HN is explicitly NOT broadened** — `_topic_text` keys on
  `source=="github"`, not on "has a summary", so HN/smol topic + fragment verdicts are byte-identical.
- `_item_text` itself is **left untouched**; every other caller (substance, base scoring, renderer) keeps
  reading it unchanged. Acceptance enumerates `_item_text`'s callers and asserts none changed.

Scope: the richer github text is used ONLY for the on-topic token check and the structural-fragment check
— never for base/actionability scoring (those read the model labels, unchanged) and never for rendering.

### B.2a OFF_TOPIC_REPO_MARKERS — close the generic-token leak NOW (not deferred)
Feeding the description fixes most repos, but a few off-topic ones ride GENERIC tokens
(`open`/`source`/`tool`/`server`): `freeCodeCamp` ("open-source codebase"), `optimizerDuck`,
`music-assistant/server`, `chatwoot` ("live-chat"). **Verified on the live pool these score 59–60 — ABOVE
both ALSO_GATEs (45/50)** — so on a thin-pool day (a source dies, X→0) they CAN surface. That makes the
deferral unsafe; ship the guard now.

Add a small `OFF_TOPIC_REPO_MARKERS` set (consumer/utility domains that are off-topic for Ace: iptv,
playlist, m3u, "tv channel", debloat, wallpaper, "study plan", curriculum, interview, tesla,
"self-hosted data logger", "windows optimization", "media library", "live-chat", "omni-channel",
"autonomous robots", …). In `python_on_topic`, for a **github** item: if `_topic_text` contains an
OFF_TOPIC_REPO_MARKER, force `("off", "github-offtopic-repo-marker")` BEFORE the generic-token check —
so an "open-source IPTV tool" floors on `iptv`, not rides `open`. Verified on the live pool this cleanly
separates: all genuine AI/dev repos (cua, SkillSpector, Kronos, Agent-Reach, meshery) stay ON; all
off-topic (iptv, Win11Debloat, freeCodeCamp, teslamate, chatwoot, optimizerDuck, music-assistant,
autonomous-robots) go OFF. Markers match as case-insensitive substrings of the description; the set is
data-driven and easily extended.

### B.3 Effect (verified on the live pool, _topic_text + markers)
Off-topic repos floor correctly (description marker or no-token): iptv-org, Free-TV/IPTV, teslamate,
Win11Debloat, freeCodeCamp, chatwoot, optimizerDuck, music-assistant, Introduction-to-Autonomous-Robots,
coding-interview-university → OFF. Genuine on-topic recover: NVIDIA/SkillSpector, trycua/cua, Agent-Reach,
shiyu-coder/Kronos, meshery → ON.

### B.4 Empty-description fail-safe
A github repo with an empty/whitespace `summary` → `_topic_text` = just the slug → no tokens → floored by
the off-topic backstop (and a slug-only structural check). This is the **intended** fail-safe (empty
description ⇒ floor is correct, never a crash). Acceptance includes a selftest: github item with empty
summary → still floors.
### B.5 GitHub stays NON-curated in the scorer
`is_topic_curated_source` returns False for github (Part A). GitHub flows through the normal
ON_TOPIC_TOKEN path — which now reads the description (B.2). The curated-source vouch is reddit-only.

---

## 3. Effect on today's real pool (acceptance evidence, filled at build)
Re-score the live pool (exemption OFF = today, Part-A ON, Part-B simulated with real descriptions):
- **Reddit:** genuine on-topic thin titles ("I built a TUI…", "Testing multi agents") escape the floor;
  any with an OFF_TOPIC_MARKER or empty title still floor. X/HN slice diff = **0**.
- **GitHub:** with descriptions, `NVIDIA/SkillSpector`/`shiyu-coder/Kronos` recover; `iptv-org/iptv`,
  `freeCodeCamp/freeCodeCamp`, `Raphire/Win11Debloat` stay floored (off-topic descriptions). No off-topic
  repo reaches a posting gate.
- No politics/insult item rescued anywhere.

## 4. Acceptance
- [ ] **Part A:** `is_topic_curated_source` (reddit-only) + `is_structural_fragment` in score_digest.py,
      pure + selftested. Backstop 1 uses structural fragment; Backstop 2 honors reddit vouch + OFF_TOPIC
      carve-out. Selftests: curated-sub thin title NOT floored; OFF_TOPIC post from curated sub STILL
      forced off; NON-curated-sub thin title STILL floored. `_breakdown` records
      `source_curated_vouch` / `structural_fragment_exempt`.
- [ ] **Part B (dedicated accessor):** NEW `_topic_text(item)` — github → `title+summary`, every other
      source → `_item_text` unchanged. **`_item_text` itself NOT edited.** Acceptance: grep-enumerate all
      `_item_text` callers and assert none changed behavior; `_topic_text` used ONLY by `python_on_topic`
      + `is_structural_fragment`.
- [ ] **Part B (HN byte-identity, re-derived):** a selftest proving an HN item's topic + fragment verdict
      is identical with vs without a summary present (HN is NOT github → `_topic_text` returns title-only).
      Separate assertion from the Part-A predicate-false case.
- [ ] **Part B (OFF_TOPIC_REPO_MARKERS, shipped now):** github item whose description contains a marker
      (iptv/playlist/debloat/tesla/curriculum/…) → forced off BEFORE the generic-token check. Selftests:
      iptv/freeCodeCamp/optimizerDuck/music-assistant → OFF; cua/SkillSpector/Kronos/meshery → ON.
- [ ] **Part B (empty-description fail-safe):** github item with empty/whitespace summary → `_topic_text`
      = slug → floored (no crash). Selftest.
- [ ] **Thin-pool probe (closes the fake-green):** re-score a DEGRADED pool (X removed, github+HN+smol
      only) and assert NO github off-topic repo (generic-token or marker) clears ALSO_GATE at either gate
      regime (45 morning / 50 x-feed). This replaces the rich-pool-only "never reaches a gate" claim.
- [ ] **Token-vs-marker precedence:** selftest that a curated-sub post with BOTH a tech token and an
      OFF_TOPIC_MARKER behaves identically to the X path (token short-circuit → model label governs),
      documenting that the vouch adds no new politics bypass.
- [ ] **Provenance (`_breakdown`):** record `topic_text_source` (`title` vs `title+summary`) and
      `offtopic_repo_marker` so a post-cutover audit can prove which github items had topicality decided
      by the description vs the slug (term-by-term explainability is the engine's design premise).
- [ ] Re-score today's real pool: reddit false-negatives recover; github separates correctly with
      descriptions+markers; **X/HN slice diff = 0** (proven, not asserted); no politics rescued; no
      off-topic repo clears a gate on rich OR thin pool.
- [ ] Existing score_digest + select_digest + render selftests green; full `npm run verify` green.
- [ ] Shadow-only: NO config gate, NO prompt edit, NO live scoring change until the deterministic-engine
      actually supports. Narrow, fail-safe (politics/empties still excluded), source-scoped (X/HN untouched),
      shadow-gated (no live risk until cutover).

      ---

      ## 6. Review resolution (Opus 2-pass: BLOCK → APPROVE WITH CHANGES) — binding build decisions
      Pass-1 BLOCK (3 blockers) all closed in v3 above. Pass-2 APPROVE-WITH-CHANGES raised 4 implementation-level
      correctness nits in the new marker machinery; build MUST honor these (they are not optional):

      - **RC1 — word-boundary marker match, not raw `in`.** `OFF_TOPIC_REPO_MARKERS` matches on token/phrase
        word-boundaries (regex `\b…\b` or whole-token membership), never raw substring, so a future short marker
        can't silently floor an AI repo (no `tv`⊂`…`, no `chat`⊂`chatbot`). Selftest: `meshery`, `SkillSpector`,
        and a hypothetical "chatbot agent" repo are NOT collided by `chatwoot`/`live-chat`/`tv` markers.
      - **RC2 (the one not to guess) — control-flow placement.** For a **github** item, the
        `OFF_TOPIC_REPO_MARKERS` force-off runs **BEFORE the `has_on_topic_token` short-circuit**, so an
        "open-source IPTV tool" floors on `iptv` and does NOT escape via the incidental `open` token. Order for
        github: (1) politics/insult `OFF_TOPIC_MARKERS` force-off [unchanged, still applies to descriptions];
        (2) `OFF_TOPIC_REPO_MARKERS` force-off [NEW]; (3) `has_on_topic_token` short-circuit; (4) zero-token
        → off. For non-github sources the flow is unchanged (token short-circuit first, then reddit vouch, then
        marker/zero-token).
      - **RC3 — thin-pool probe must prove markers, not ranking.** The degraded-pool probe asserts each known
        generic-token repo (freeCodeCamp, optimizerDuck, music-assistant, chatwoot) is floored **by a marker**
        (`offtopic_repo_marker` set in `_breakdown`), not by losing a ranking race; AND includes one synthetic
        no-marker generic-token off-topic repo to bound/acknowledge the residual leak (accepted, shadow-only).
      - **RC4 — state the github fragment-recovery mechanism.** `is_structural_fragment` for a github item reads
        `_topic_text` (title+summary); that is what makes a populated-description repo non-fragment (recovery)
        while an empty-summary repo (`_topic_text`=slug) still floors. Selftest asserts each recovered repo
        passes the fragment check via `_topic_text`, not only the off-topic check.
      - **OQ5 — provenance granularity.** `_breakdown.offtopic_repo_marker` records the MATCHED marker string
        (not just a boolean) so marker-set tuning stays auditable/explainable.

      Pass-2 confirmed (independently, against the evidence-pack control flow): no path upgrades off→core
      (fail-toward-exclusion preserved); reddit vouch's no-marker gate is airtight; X/HN byte-identity holds
      structurally via `_topic_text` keying on `source=="github"`. Review artifacts:
      `docs/reviews/backstop-exemption-pass{1,2}.md.reject-claude-api-proxy.txt`.

      ---

      ## 5. Why this split is correct (vs. one blunt exemption)
Reddit's curated subs genuinely vouch for topic → a scoring exemption is right and safe. GitHub trending
vouches only for popularity → a scoring exemption would let off-topic repos leak in; the honest fix is to
ingest the repo description so the existing topic check has real text. Same north star (recover genuine
indie-builder/AI false-negatives now that the gatherers are live), but each source gets the fix its data
actually supports. Narrow, fail-safe (politics/empties still excluded), source-scoped (X/HN untouched),
shadow-gated (no live risk until cutover).
