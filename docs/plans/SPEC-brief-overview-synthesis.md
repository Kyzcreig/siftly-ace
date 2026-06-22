# SPEC — Brief "Overview" synthesis section (morning-digest + x-feed-brief)

**Status:** PROPOSED — for Ace's review before build
**Author:** Apollo · **Date:** 2026-06-21
**Project:** siftly-ace (Ace X Knowledge Base)
**Related:** Obsidian `AI/Ace X Knowledge Base — System Overview.md` § Ranking; live prompts `~/.hermes/state/cron/{morning-digest,x-feed-brief}/prompt.md`

---

## 1. The ask (Ace's words)

> "It would be nice to also have a general overview of what's going on on twitter based on my feed,
> or what's going on in AI news based on all the stories — as opposed to looking at specific news
> stories and x.com posts. Maybe like an overview of everything going on, as an additional part of
> the morning AI news brief and x feed news brief respectively."

Today each brief is a **ranked list of individual items** (Top Stories + Also Noted). Ace wants an
added **synthesis paragraph** at the top: the forest, not just the trees. Two flavors:

- **morning-digest** → "State of AI news today" — the big themes across ALL gathered stories.
- **x-feed-brief** → "What's happening on your timeline" — the mood/themes of Ace's actual feed.

## 2. Design principle — synthesize the WHOLE pool, not just the posted items

The key insight: the synthesis should read the **full scored candidate pool** (~170–1,700 items/day
that we already gather, label, and score), not only the ~7 items that clear the gate. That's the
entire point — "what's going on across everything," including the 95% that never makes the Top list.
The pool is already on disk every run:

- morning-digest: `~/.hermes/state/cron/morning-digest/_last_run_debug.json` → `all_scored[]`
- x-feed-brief: `~/.hermes/state/cron/x-feed-brief/_last_run_scored.json` → `all_scored[]`

Each item already carries: `tweet_text`/`title`, `authorHandle`, `content_type`, `on_topic`,
`base_score`, `final_score`, `signals.topic_hits`, engagement. **No new gathering, no new API cost** —
we're summarizing data we already produce and throw away.

## 3. What the overview contains (proposed)

A 2–4 sentence synthesis + optional theme bullets, placed ABOVE Top Stories. Concretely:

**morning-digest — "🗞️ The Landscape"**
- 2–3 sentences naming the day's dominant AI themes (e.g. "Open-weights momentum: three separate
  GLM/Llama-class releases; the agent-harness war keeps escalating with Claude Code vs Codex tooling;
  one big funding story.").
- Optionally 2–4 one-line theme clusters with counts ("• Open-weights models — 6 items", "• Agent
  tooling — 9 items", "• AI policy/safety — 4 items").
- Grounded in `topic_hits` + `content_type` aggregation over `all_scored`, then the LLM writes the prose.

**x-feed-brief — "📡 Your Timeline"**
- 2–3 sentences on what Ace's feed is actually talking about today — the vibe, recurring topics, who's
  loud, any notable shift ("Your feed is heavy on harness-building today — Pocock, Berman, and three
  others all shipping agent-loop tooling; a side-current of open-weights hype; @levelsio doing
  @levelsio things.").
- This is genuinely different from morning-digest: it's *Ace's curated graph*, not global AI news.

## 4. How it's built (the mechanics)

This is a **prose-generation** step, so unlike scoring it stays with the LLM — but fed a
**deterministic aggregation** so it's grounded, not hallucinated:

1. **New deterministic helper `scripts/overview_digest.py`** (mirrors the score/select tooling):
   reads `all_scored[]`, computes a compact, factual aggregate:
   - topic histogram (from `signals.topic_hits` / `on_topic` / keyword clusters), top N themes + counts
   - content-type mix (how many launches vs opinions vs field-reports)
   - loudest authors (by frequency + engagement) — x-feed especially
   - a few representative item titles per theme (for the LLM to anchor on)
   Emits `~/.hermes/state/cron/<brief>/_overview_input.json`. Pure stdlib, fast, no network.
2. **Prompt step (new "Step 5.5 — Overview"):** the brief feeds that aggregate to the model with a
   tight instruction: "Write a 2–4 sentence synthesis of the day's themes from THIS aggregate. Name
   specific topics/models/people. No filler, no 'the AI world is buzzing'. ≤60 words." Same anti-
   boilerplate rules as the per-item summaries.
3. **Render:** prepend the overview block above Top Stories in the existing deterministic renderer.

## 5. Why this shape (design rationale)

- **Grounded, not vibes** — the LLM summarizes a real histogram of the actual pool, so it can't invent
  themes that aren't there. The deterministic aggregate is the guardrail (same philosophy as labels-
  drive-scoring).
- **Free** — reuses data already gathered/scored; zero new API reads.
- **Cheap LLM cost** — one extra short generation per brief (~60 words), not a re-scan.
- **Honest about the two briefs being different** — morning = global AI news, x-feed = Ace's graph.
  Same mechanism, different input pool, naturally different output.
- **Fails safe** — if `overview_digest.py` errors or the model step times out, SKIP the overview and
  post the brief exactly as today. The overview is additive; it must never block or delay the list.

## 6. Open questions for Ace

1. **Length / format** — 2–4 sentence paragraph only? Or paragraph + the theme-cluster bullets with
   counts? (I lean: paragraph + 2–4 bullets for morning-digest; paragraph only for x-feed.)
2. **Placement** — top of the brief (above Top Stories) ✓ assumed. Or a separate follow-up message?
3. **x-feed "who's loud"** — OK to name-drop the accounts dominating your feed that day, or keep it
   topic-only?
4. **Scope of morning-digest overview** — only the AI/core items, or include the adjacent/off-topic
   pool too (so it can say "and your feed had a lot of politics today")? I lean core+adjacent only.
5. **Trial mode** — ship it as a shadow line first (computed + logged, not posted) for a couple days so
   you can eyeball the synthesis quality before it goes into the live brief? Given the briefs are
   load-bearing, I'd recommend yes — same discipline as the fused rollout.

## 7. Effort / risk

- **Build:** ~1 helper script + 1 prompt step + 1 renderer tweak per brief. Small, isolated, additive.
- **Risk:** low — fail-safe-skip means it can never break the existing brief; no new data sources.
- **Gated:** the prompt edits are live-brief changes → show-diff + backup + ≥3 dry-runs + Ace's go,
  same as every brief change.

---

*Decision needed: approve the shape (esp. §6 Q1/Q5), then I build it behind a shadow line, show you the
synthesis on real pools for ~2 days, and wire it live on your OK.*
