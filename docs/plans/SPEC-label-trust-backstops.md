# SPEC — Label-Trust Backstops (don't trust the model's on_topic/content_type)

**Status:** v1 — specced 2026-06-11, shadow-only code (no config gate). Triggered by a real shadow miss.
**Owner:** Apollo. **Repo:** `Kyzcreig/siftly-ace`. **Surface:** `scripts/score_digest.py` (shadow scorer).
**Companion Hard-Config edit (separate, gated):** prompt label-definition tightening (Diff below — needs Ace approval).

---

## 1. The miss (ground-truthed 2026-06-11)

@elonmusk reply "`@IterIntellectus @ZackPolanski Yes, he is a scumbag and traitor`" (5,264 likes):
- **Old scorer (posted):** base 71 + pf 7.2 = **78** → B+ in #daily.
- **New deterministic scorer (shadow):** base 52 + engagement 15 + author 8 + pf 7 − off_topic 0 = **92** — even higher.

**Root cause:** the MODEL mislabeled it `content_type=field_report`, `on_topic=core`, `substance=mixed`. It is a bare political reply fragment. The deterministic scorer's topic-gate and off-topic penalty are CORRECT — but they read the model's `on_topic` label, and the model lied (`core`). Garbage label in → garbage score out.

This is the central risk the PRD review flagged (B4/§3): moving the *number* to Python doesn't help if Python blindly trusts the *labels*. The scorer needs **independent Python signals that can OVERRIDE a bogus label**, exactly like the existing `is_bare_fragment` / `low_reach_cap` backstops.

---

## 2. Design principle

> **The model's labels are a HINT. Python verifies the cheap, objective ones and overrides on conflict.**

Two label claims are cheaply falsifiable from the raw text without an LLM:
1. **"this is a substantive post" (`content_type != reply_fragment`, `substance != vague`)** — falsifiable: a leading-@mention reply with few standalone words is a fragment regardless of the label.
2. **"this is on-topic" (`on_topic = core/adjacent`)** — partially falsifiable: a post with ZERO tech/AI/builder tokens AND political/insult markers is almost certainly `off`, regardless of the label.

We add Python backstops that DOWNGRADE the label (never upgrade — fail safe toward exclusion) when the text contradicts it.

---

## 3. Backstops (all in score_digest.py, pure + selftested)

### 3.1 Fragment backstop (reuse existing `is_bare_fragment`)
If `is_bare_fragment(text)` is True (leading @mentions stripped → < 4 standalone words OR < 15 chars), FORCE `content_type=reply_fragment` (→ BASE 0) regardless of the model's label. The Elon reply: after stripping `@IterIntellectus @ZackPolanski`, "Yes, he is a scumbag and traitor" = 6 words — NOT caught by word-count alone. So 3.1 is necessary but not sufficient here → need 3.2.

### 3.2 Off-topic backstop (independent topic check)
Compute `python_on_topic(item)` from raw text, independent of the model:
- **on-topic tokens** (any present → not forced off): a curated set of AI/builder/tech terms (ai, model, agent, llm, gpu, code, ship, launch, api, open source, benchmark, prompt, fine-tune, inference, repo, etc.) + tracked-project names + the existing `signals.topic_hits` non-news labels.
- **off-topic markers** (politics/insult/culture-war): a curated set (scumbag, traitor, migrant, election, woke, communist, fascist, vaccine, ivermectin, etc.) — NOT used to force-off by themselves (too blunt), but used as a TIE-BREAKER.
- **Rule:** if the post has ZERO on-topic tokens → `python_on_topic = "off"`. If it ALSO carries an off-topic marker, that's just confirmation. The Elon reply has zero AI/tech tokens → forced `off`.
- **Conflict resolution:** `effective_on_topic = "off" if python_on_topic=="off" else model_on_topic`. Python can force OFF; it never forces a model `off` back to `core` (fail-safe toward exclusion). A logged `_on_topic_overridden` flag records when Python overrode the model.

### 3.3 Effect on the score
`effective_on_topic` (not the raw model label) drives BOTH:
- the **author-tier gate** (TL/tracked bump only if `effective_on_topic != off`), and
- the **off-topic penalty** `OFF_TOPIC_PEN[effective_on_topic]`.
So the Elon reply: author bump → 0, off_topic penalty → −40. New final collapses from 92 to ~27 (52 base + 15 eng + 7 pf − 40 − 0 author − low-reach-exempt-no). Below ALSO_GATE. Correct.

### 3.4 Why this is safe (fail-toward-exclusion)
Python ONLY downgrades (core→off, real→fragment). A genuine on-topic post the model correctly labeled `core` and that carries AI tokens is untouched. Worst case of a Python false-positive: a real tech post with weirdly zero recognizable tech tokens gets excluded from ONE digest — recoverable, and rare. The opposite failure (political rage-bait in #daily) is the one Ace actually cares about.

---

## 4. Companion Hard-Config prompt edit (separate approval)
Tighten the label definitions in morning-digest prompt.md so the model stops calling insults `core/field_report`:
- `on_topic=off`: "ANY political attack, personal insult, dunking, culture-war, health/vaccine, or non-AI-news post — even from a thought-leader. A reply calling someone a name is `off`."
- `content_type=reply_fragment`: "a short reply with no standalone substance, INCLUDING insults/agreement (\"Yes, he is a scumbag\")."
This reduces how often the backstops fire, but the backstops are the load-bearing guarantee (the model will keep mislabeling some).

---

## 5. Acceptance
- [ ] `python_on_topic` + override in score_digest.py, pure + selftested.
- [ ] Gold-set case added: the exact Elon "scumbag and traitor" reply → new_final < ALSO_GATE.
- [ ] Re-score today's real 92-item pool: the Elon reply drops below the gate; no genuine on-topic item is wrongly forced off (manual spot-check of the overridden set).
- [ ] Existing selftests still green (no regression to the legit cases).
- [ ] Logged `_on_topic_overridden` / forced-fragment flags in the breakdown for auditability.
