# Wave-scoring Review Evidence Pack — GROUND TRUTH (trust this code)

## Current SHIPPED scorer: scripts/select_digest.py (key functions, lines 60-300)
```python
DIGEST_DIR = os.path.expanduser("~/.hermes/state/cron/morning-digest")
DEFAULT_IN = os.path.join(DIGEST_DIR, "_last_run_debug.json")
DEFAULT_OUT = os.path.join(DIGEST_DIR, "_render_input.json")
THOUGHT_LEADERS_FILE = os.path.expanduser("~/.hermes/digest/thought-leaders.txt")
TRACKED_PROJECTS_FILE = os.path.expanduser("~/.hermes/digest/tracked-projects.txt")

# ── Gates / boost config (mirror prompt.md Step 5/6) ─────────────────────────
TOP_GATE = 83
ALSO_GATE = 77
THOUGHT_LEADER_BOOST = 10
TRACKED_PROJECT_BOOST = 8
MAX_BOOST = 15
MAX_TOP = 5
MAX_ALSO = 2

# Forced distribution (anti-inflation, Step 5): at most 2 final >=90, at most 1 ==100.
MAX_GE_90 = 2
MAX_EQ_100 = 1

# Topic-gate (#2): the thought-leader boost only fires when a post carries a
# real AI/builder signal. We BLOCKLIST the off-topic topic labels rather than
# allowlist builder ones, so a meme tagged "entertainment" (Ace likes memes)
# still counts as on-topic and keeps its boost — only pure news/politics loses it.
OFF_TOPIC_LABELS = {"news", "news-and-politics", "politics"}

# Low-reach handling (#3 — base-score inflation guard). The model flat-rates
# almost every X item at base 80 regardless of quality, so spam bots
# (@bitnewsbot "#bitcoin #cryptonews") and zero-reach rants clear the gate on
# inflated base+pf alone (no boost involved). Engagement is the only real
# quality signal available, so an X post from an UNKNOWN handle (not a
# thought-leader) with engagement below the floor is CAPPED at a hard ceiling
# below the Also gate.
#
# WHY A CAP, NOT A FIXED SUBTRACTION (review Required #3 / Open-Q1): pf_delta is
# NOT bounded near 10. pf-score.py: delta = clamp(affinity-baseline,-1,1)*weight,
# weight normalized to max 60; with affinity 1.0, baseline 0.18 → delta ≈ 0.82*30
# = 24.6 TODAY (PF_WEIGHT=30), and up to ~49 if PF_WEIGHT is raised toward 60. A
# flat base-80 + high pf would survive any fixed −N subtraction that races pf. A
# hard CAP is robust to pf magnitude by construction: a low-reach unknown-handle
# post can never exceed the ceiling no matter how high base/pf/boost inflate it.
# Still a DOWN-RANK not a discard (the item keeps its slot if nothing better
# exists, and is ranked by its real final among other low-reach items).
#
# TIMING ASSUMPTION (review Pass-2): the cap leans on "real content earns >=
# LOW_REACH_ENGAGEMENT_FLOOR engagement". True for the current ~daily ingest
# (tweets are hours old by scoring time). If the digest ever moves to
# near-real-time ingest (scoring a tweet seconds after it posts, before
# engagement accrues), a genuinely good fresh post from an unknown handle could
# read as zero-reach and be capped — revisit the floor/exemption then.
    return any(a in hay for a in tl_aliases)


def compute_boost(item, tl_handles, tl_aliases, tracked):
    """Deterministic, topic-gated boost. Thought-leader boost is GATED on
    on-topic; tracked-project boost is content-keyword based (not gated).
    Returns (boost, reasons)."""
    boost, reasons = 0, []
    if _is_thought_leader(item, tl_handles, tl_aliases):
        if is_on_topic(item):
            boost += THOUGHT_LEADER_BOOST
            reasons.append("thought-leader")
        else:
            reasons.append("thought-leader(off-topic→no boost)")
    if _matches_tracked(item, tracked):
        boost += TRACKED_PROJECT_BOOST
        reasons.append("tracked-project")
    return min(boost, MAX_BOOST), reasons


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _engagement(item):
    """likes+retweets. Verified on live data: every X row carries literal `likes`
    and `retweets` keys (0/98 missing). Defensive fallback to X v2
    public_metrics if a future ingest nests them, so the low-reach guard can't be
    silently defeated by a field rename (review Required #1)."""
    likes = item.get("likes")
    rts = item.get("retweets")
    if likes is None and rts is None:
        pm = item.get("public_metrics")
        if isinstance(pm, dict):
            likes = pm.get("like_count")
            rts = pm.get("retweet_count")
    return _num(likes) + _num(rts)


def _is_x(item):
    """X/tweet item. Source-driven: a real tweet has source 'x' (or 'twitter').
    We do NOT infer X from tweet_id/tweet_text alone — non-X rows can carry an id
    field, and misclassifying a story as X would wrongly subject it to the
    X-only low-reach penalty."""
    src = str(item.get("source") or "").lower()
    if src in ("x", "twitter"):
        return True
    # no explicit source: fall back to tweet-shaped fields, but only when there's
    # NO story-shaped field (title/hn_points) present.
    if not src:
        has_story = item.get("title") or item.get("hn_points") is not None
        return bool((item.get("tweet_text") or item.get("authorHandle")) and not has_story)
    return False


def low_reach_cap(item, tl_handles, tl_aliases):
    """#3 base-score-inflation guard: an X post from an UNKNOWN handle (not a
    thought-leader) with engagement below the floor is almost certainly
    flat-rated spam/noise — cap its final score at LOW_REACH_SCORE_CAP (< the
    Also gate). Returns (cap_or_None, reason).

    A hard CAP (not a fixed subtraction) so it's robust to pf magnitude: pf_delta
    can reach ~24 today and ~49 if PF_WEIGHT is raised, which would defeat any
    fixed −N. Tracked-project mention is deliberately NOT an exemption (spam
    universally name-drops a big lab — verified on real data: every base≥77
    unknown-handle zero-engagement item a tracked-exemption would 'save' was junk,
    none a genuine project update; tracked-projects still get their +8 boost).
    Thought-leaders, non-X items, and posts with real engagement are exempt
    (don't suppress a 0-like Karpathy gem)."""
    if not _is_x(item):
        return None, None
    if _is_thought_leader(item, tl_handles, tl_aliases):
        return None, None
    if _engagement(item) >= LOW_REACH_ENGAGEMENT_FLOOR:
        return None, None
    return LOW_REACH_SCORE_CAP, f"low-reach-cap(eng<{LOW_REACH_ENGAGEMENT_FLOOR},unknown-handle)"


def score_item(item, tl_handles, tl_aliases, tracked):
    """final = base + pf_delta + GATED boost, then CAPPED if low-reach. 0..100."""
    base = _num(item.get("base_score"))
    pf = _num(item.get("personal_fit_delta"))
    boost, reasons = compute_boost(item, tl_handles, tl_aliases, tracked)
    final = max(0.0, min(100.0, base + pf + boost))
    cap, cap_reason = low_reach_cap(item, tl_handles, tl_aliases)
    capped = False
    if cap is not None and final > cap:
        final = float(cap)
        capped = True
    if cap_reason:
        reasons.append(cap_reason)
    out = dict(item)
    out["_boost"] = boost
```

## render_digest.py event-dedup primitives (reused by guard)
```python
138:def _distinctive_bigrams(text):
157:def _shared_distinctive(a_bgs, b_bgs):
219:def _assign_event_groups(pool):
277:def dedup_and_rank(selected, also, per_event_cap=PER_EVENT_CAP, primary_handles=None):
```

## prompt.md Step 5 (the prose rubric this spec SUPERSEDES), lines 274-310
```
## Step 5 — Score
Score each metric 1-10, then apply boosts and caps. Weight sum is 10, so max raw score before boosts is 100.

- Personal Utility, 5x: Can Ace use this, try it, avoid a bug, change a workflow, or steal a tactic now?
- Builder Signal, 2x: Concrete field report, benchmark, repo, implementation detail, or unusually useful discussion.
- Agent/Coding Fit, 2x: Directly affects coding agents, personal AI, AI engineering, MCP/tool use, local models, automation, or Ace's tracked company interests.
- Recency, 1x: Today = 10, yesterday = 7, 2-3 days = 4, older = 2.

**CALIBRATION ANCHORS (MANDATORY — the scores were inflated; fix this).** The 1-10 metrics are NOT "is this vaguely AI-related." Anchor every metric against these:
- **10** = exceptional and directly actionable TODAY (a new model/tool/repo Ace can run, a benchmark that changes a routing decision, a concrete tactic he can copy). Reserve 10 for genuinely top-tier.
- **7-8** = solid, useful, specific (real launch, real field report, concrete number) but not a must-act.
- **4-6** = mildly interesting / context only; he'd nod and move on.
- **1-3** = engagement-bait, hype with no substance, reply fragments, "follow for more", generic opinion. (Most of these should already be HARD-DISCARDED in Step 3 — if you're scoring one, it's a 1-3.)

**FORCED DISTRIBUTION (anti-inflation — HARD RULE):** across the whole digest, **at most 2 items may have a final score ≥ 90**, and **at most 1 may be exactly 100** (reserve 100 for a genuine landmark — a major model launch, not a random tweet). If your raw scores cluster at the top (e.g. five 100s), you are miscalibrated — re-rank the candidates RELATIVE to each other and spread them out. A digest where everything is an A is a BUG. It is correct and expected for most items to land in the 70s-80s.

**Boosts (applied after raw scoring):**
- Thought-leader boost (+10): author/byline/X handle matches any entry in `thought-leaders.txt` (case-insensitive substring match).
- Tracked-project boost (+8): headline, URL, summary, or tweet text contains any entry in `tracked-projects.txt` (case-insensitive substring match).
- Boosts stack but max combined boost is +15.

**Caps (applied after boosts):**
- Corporate PR, enterprise procurement, platform availability, or partner-channel announcements: max 76, unless one of Ace's company/news triggers with concrete product/model/API significance.
- Generic framework release announcements: max 80.
- Abstract research / thought-leader essays with no implementation path: max 80. Research-only Hinton/LeCun posts: max 78.
- Supply-chain/security postmortems: max 82 unless directly relevant to Ace's active stack or includes immediate mitigation steps.
- Generic "AI writes code / future of programming" opinion: max 79 unless concrete workflow evidence or benchmarks.
- Roundups, aggregator summaries, or reposts: max 70.

Final score = min(100, max(0, raw + boosts)), then apply caps.

**Score items quickly — don't write long per-item reasoning.** Just emit the final score with a 1-line note like `B+ (87) — tracked-project boost (claude code)`.

**However: when writing the digest body in Step 7, the "1 sentence why it matters" MUST be specific to the post content. NO BOILERPLATE SUFFIXES.**

### Banned summary patterns (HARD BAN — if you write any of these, replace the whole summary):
**Banned phrases (case-insensitive):**
```

## Ground-truth facts (verified live this session)
- pf_delta TODAY max ~24.6 (affinity 1.0, baseline 0.18, PF_WEIGHT=30); up to ~49 if PF_WEIGHT→60. PF_WEIGHT hard limit 60.
- TOP_GATE=83, ALSO_GATE=77, LOW_REACH_SCORE_CAP=70, LOW_REACH_ENGAGEMENT_FLOOR=5.
- select_digest.py = 710 lines, 15/15 selftests pass; render_digest 57/57; replay 8/8.
- DB: prisma/dev.db 3,553 rows fully enriched/embedded/vision-tagged.
- The model currently emits base_score (0-100) in prose; spec moves it to enum LABELS only.
- thought-leaders.txt / tracked-projects.txt are the author-tier lists.
- Cutover edits ~/.hermes/state/cron/morning-digest/prompt.md = a Hard-Config-Rules surface (diff→backup→approve).
