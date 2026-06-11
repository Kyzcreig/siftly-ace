#!/usr/bin/env python3
"""
select_digest.py — deterministic boost-gating + selection for the morning digest.

WHY THIS EXISTS
---------------
This is the THIRD recurrence of the same model-adherence failure: gpt-5.5
applies the morning-digest's scoring *rules* in prose (prompt.md Step 5) and
ignores them when they're inconvenient. On 2026-06-10 it gave a +10
thought-leader boost (and personal-fit delta) to bare @elonmusk reply fragments
("True", "Yes", "💯") and off-topic political tweets ("Murderous migrants
beheading…"), pushing them from base_score 61 to 83-84 — clearing the Top gate
and producing a 7-tweet all-Elon political digest that actually posted to #daily.

The Step-3 "hard discard reply fragments" rule and the Step-5 boost rule are
both correct on disk; the model just didn't honor them against the boost. Prose
rules don't hold for this model — so, per the proven deterministic-guard pattern
(used for the echo bug, score inflation, and event-dedup), selection mechanics
move into tested Python:

  • MODEL still owns: the 1-10 rubric base_score and the personal-fit delta.
  • PYTHON now owns: (#1) hard-discard of bare/off-topic reply fragments BEFORE
    any boost, (#2) the thought-leader / tracked-project boost — but the
    thought-leader boost only fires on ON-TOPIC (AI/builder) posts, so an
    off-topic political tweet from a thought-leader gets NO boost — then final
    scoring, caps, forced distribution, and Top/Also selection.

Ace's explicit calls (2026-06-10):
  • KEEP the thought-leader boost (don't remove it, don't drop @elonmusk).
  • NO blanket politics filter and NO meme filter — memes stay.
  • Fix = (#1) hard-discard precedence over the boost + (#2) topic-gated boost.

INPUT  (default ~/.hermes/state/cron/morning-digest/_last_run_debug.json):
  The full scored pool the model already dumps in Step 6.5:
    { "all_scored": [ { base_score, personal_fit_delta, authorHandle, title,
                        summary, tweet_id, url, source, likes, retweets,
                        signals:{topic_hits:[{topic,...}]}, ... }, ... ], ... }

OUTPUT (default ~/.hermes/state/cron/morning-digest/_render_input.json):
  The render contract consumed by render_digest.py (selected / also / footer).

USAGE
  select_digest.py --in PATH --out PATH      # gate boosts, select, write render input
  select_digest.py --selftest                # run built-in checks (no I/O)
"""
from __future__ import annotations
import argparse, json, os, re, sys, datetime

# Reuse the renderer's TESTED event-dedup primitives so the guard is the single
# selection authority (event-collapse + boost-gate + select all happen here),
# and the renderer just renders the buckets as-given (run it with --no-dedup).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from render_digest import _assign_event_groups as _rd_assign_event_groups
    from render_digest import _distinctive_bigrams, _shared_distinctive
except Exception:  # pragma: no cover - render_digest should always be importable
    _rd_assign_event_groups = None
    _distinctive_bigrams = _shared_distinctive = None

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
LOW_REACH_ENGAGEMENT_FLOOR = 5     # likes+retweets strictly below this = "low reach"
LOW_REACH_SCORE_CAP = 70           # hard ceiling < ALSO_GATE(77); robust to pf size


def _load_list(path):
    out = []
    try:
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    out.append(ln.lower())
    except OSError:
        pass
    return out


def _load_thought_leaders(path=THOUGHT_LEADERS_FILE):
    """Handles (no spaces) used for author match; aliases (with spaces) for byline/text."""
    handles, aliases = set(), []
    for entry in _load_list(path):
        if " " in entry:
            aliases.append(entry)
        else:
            handles.add(entry.lstrip("@"))
    return handles, aliases


def _load_tracked_projects(path=TRACKED_PROJECTS_FILE):
    return _load_list(path)


# ── Text helpers ─────────────────────────────────────────────────────────────
_URL_RE = re.compile(r"https?://\S+", re.I)
_LEADING_MENTIONS_RE = re.compile(r"^(?:\s*@\w+)+\s*")
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\u2190-\u21FF\u2300-\u23FF\uFE0F\u200d]+"
)


def _item_text(item):
    return (item.get("tweet_text") or item.get("title") or item.get("summary")
            or item.get("line") or "")


def _substance(text):
    """Strip URLs, leading @mentions, emoji, punctuation → remaining word tokens.
    Used to detect bare reply fragments ('True', 'Yes', '💯', '@x @y nice')."""
    t = _URL_RE.sub(" ", str(text or ""))
    t = _LEADING_MENTIONS_RE.sub(" ", t)
    t = _EMOJI_RE.sub(" ", t)
    t = re.sub(r"[^\w\s]", " ", t)
    return [w for w in t.split() if any(c.isalnum() for c in w)]


def is_bare_fragment(text, min_words=4, min_chars=15):
    """#1: a post with almost no standalone substance after stripping
    mentions/URLs/emoji. These must be hard-discarded BEFORE any boost so the
    thought-leader boost can never rescue a 'True'/'Yes'/'💯'."""
    words = _substance(text)
    if len(words) < min_words:
        return True
    if len(" ".join(words)) < min_chars:
        return True
    return False


def _topic_labels(item):
    sig = item.get("signals") or {}
    return [str(t.get("topic", "")).lower() for t in (sig.get("topic_hits") or [])]


def is_on_topic(item):
    """#2: on-topic = carries at least one topic signal that is NOT pure
    news/politics. Empty topics => off-topic. Memes ('entertainment') count as
    on-topic by design (Ace keeps memes)."""
    labels = [l for l in _topic_labels(item) if l]
    if not labels:
        return False
    return any(l not in OFF_TOPIC_LABELS for l in labels)


def _handle(item):
    return str(item.get("authorHandle") or "").lstrip("@").lower()


def _matches_tracked(item, tracked):
    hay = " ".join(str(item.get(k) or "") for k in ("title", "summary", "tweet_text", "url", "line")).lower()
    return any(p in hay for p in tracked)


def _is_thought_leader(item, tl_handles, tl_aliases):
    h = _handle(item)
    if h and h in tl_handles:
        return True
    hay = " ".join(str(item.get(k) or "") for k in ("authorName", "title", "summary", "line")).lower()
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
    out["_low_reach_capped"] = capped
    out["_boost_reasons"] = reasons
    out["_final"] = final
    return out


def apply_forced_distribution(items):
    """Step 5 anti-inflation: at most 2 final>=90, at most 1 ==100. Demote
    excess by clamping just under the threshold, preserving order."""
    ge90 = 0
    eq100 = 0
    for it in items:  # items already sorted desc
        f = it["_final"]
        if f >= 100:
            if eq100 >= MAX_EQ_100:
                it["_final"] = 99.0
                f = 99.0
            else:
                eq100 += 1
        if f >= 90:
            if ge90 >= MAX_GE_90:
                it["_final"] = 89.0
            else:
                ge90 += 1
    return items


def _guard_event_groups(pool):
    """Group-ids for the pool, unioning by BOTH (a) exact model event_key AND
    (b) shared distinctive bigram — the bigram pass runs UNCONDITIONALLY (even on
    items that already carry an event_key). Rationale: the model assigns event_key
    UNRELIABLY (Fable-5 launch day → 6 different keys for one event because it
    slugged each tweet's opening words). event_key can only ADD merges, never
    un-merge, so layering the tested distinctive-bigram signal on top recovers the
    real clusters while staying conservative (no shared strong phrase => distinct).
    Falls back to render_digest's keyless grouping if primitives are unavailable."""
    n = len(pool)
    if n == 0:
        return []
    if _distinctive_bigrams is None or _shared_distinctive is None:
        return _rd_assign_event_groups(pool) if _rd_assign_event_groups else list(range(n))

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    # (a) exact event_key
    ek_first = {}
    for i, it in enumerate(pool):
        ek = (it.get("event_key") or "").strip().lower()
        if ek:
            if ek in ek_first:
                union(ek_first[ek], i)
            else:
                ek_first[ek] = i

    # (b) distinctive-bigram, UNCONDITIONAL (all items, keyed or not)
    bgs = [_distinctive_bigrams(_item_text(pool[i])) for i in range(n)]
    for i in range(n):
        if not bgs[i]:
            continue
        for j in range(i + 1, n):
            if bgs[j] and _shared_distinctive(bgs[i], bgs[j]):
                union(i, j)

    return [find(i) for i in range(n)]


def _collapse_events(scored):
    """Collapse same-event items to ONE winner (highest _final, then engagement,
    then stable text). Uses guard-local grouping (exact event_key ∪ unconditional
    distinctive-bigram). Returns (kept, event_dropped)."""
    if not scored:
        return scored, []
    group_ids = _guard_event_groups(scored)
    groups = {}
    for gid, it in zip(group_ids, scored):
        groups.setdefault(gid, []).append(it)
    kept, dropped = [], []
    for items in groups.values():
        ranked = sorted(items, key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)
        winner = ranked[0]
        kept.append(winner)
        for loser in ranked[1:]:
            d = dict(loser)
            d["_drop"] = "event_dup"
            d["_lost_to"] = winner.get("url")
            dropped.append(d)
    # preserve overall desc ordering after collapse
    kept.sort(key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)
    return kept, dropped


def select(pool, tl_handles, tl_aliases, tracked):
    """Returns (selected, also, discarded). Pure; no I/O.

    The guard is the SINGLE selection authority: hard-discard → boost-gate →
    score → event-collapse → forced-distribution → Top/Also gates+caps. The
    renderer must run with --no-dedup so it does NOT re-gate/re-rank this output.
    """
    scored, discarded = [], []
    for raw in pool:
        if is_bare_fragment(_item_text(raw)):
            d = dict(raw)
            d["_drop"] = "bare_fragment"
            discarded.append(d)
            continue
        scored.append(score_item(raw, tl_handles, tl_aliases, tracked))

    # Sort by final desc, engagement as tiebreak only (substance > virality already
    # baked into base/boost); stable on text for determinism.
    scored.sort(key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)

    # Collapse duplicate coverage of one event to a single winner BEFORE gating,
    # so 5 accounts reporting one launch can't fill all 5 Top slots.
    scored, event_dropped = _collapse_events(scored)
    discarded.extend(event_dropped)

    scored = apply_forced_distribution(scored)
    # forced distribution can reorder by value; re-sort once more for placement
    scored.sort(key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)

    selected, also = [], []
    for it in scored:
        f = it["_final"]
        if f >= TOP_GATE and len(selected) < MAX_TOP:
            selected.append(it)
        elif f >= ALSO_GATE and len(also) < MAX_ALSO:
            also.append(it)
        else:
            d = dict(it)
            d["_drop"] = "below_gate_or_cap"
            discarded.append(d)
    return selected, also, discarded


# ── Render-contract emission ─────────────────────────────────────────────────
def _to_render_item(it):
    src = str(it.get("source") or "").lower()
    out = {"score": int(round(it["_final"])), "url": it.get("url")}
    if it.get("event_key"):
        out["event_key"] = it["event_key"]
    if src == "x" or it.get("tweet_id") or it.get("authorHandle"):
        out["source"] = "X"
        out["authorHandle"] = it.get("authorHandle")
        out["tweet_text"] = it.get("tweet_text") or it.get("title") or it.get("summary") or ""
        for k in ("likes", "retweets"):
            if it.get(k) is not None:
                out[k] = it.get(k)
    else:
        out["source"] = it.get("source") or "HN"
        out["title"] = it.get("title") or it.get("line") or ""
        if it.get("summary"):
            out["summary"] = it.get("summary")
        for k in ("hn_points", "hn_comments"):
            if it.get(k) is not None:
                out[k] = it.get(k)
    return out


def build_render_input(data, tl_handles, tl_aliases, tracked, now=None, engine="legacy",
                       max_top=None, max_also=None, top_gate=None, also_gate=None):
    pool = data.get("all_scored") or []
    if engine == "deterministic":
        # CUTOVER (2026-06-11): the deterministic scorer (score_digest.py) owns the
        # `final`; this module stays the single render-contract authority but its
        # scoring is swapped. Lazy import avoids the score_digest<->select_digest cycle.
        import score_digest as _sd  # noqa: E402
        # #2 P2.1: per-brief caps/gates thread through as explicit kwargs (None →
        # module defaults), never via global mutation, so morning-digest is unaffected.
        selected, also, discarded, _meta = _sd.select_shadow(
            pool, tl_handles, tl_aliases, tracked, now=now,
            max_top=max_top, max_also=max_also, top_gate=top_gate, also_gate=also_gate)
    else:
        selected, also, discarded = select(pool, tl_handles, tl_aliases, tracked)
    now = now or datetime.datetime.now()
    footer = (data.get("footer") or "").strip()
    out = {
        "ts": now.isoformat(),
        "selected": [_to_render_item(x) for x in selected],
        "also": [_to_render_item(x) for x in also],
        "footer": footer or None,
        "empty_note": None,
        "_select_audit": {
            "pool": len(pool),
            "selected": len(selected),
            "also": len(also),
            "discarded_bare": sum(1 for d in discarded if d.get("_drop") == "bare_fragment"),
            "discarded_below_gate": sum(1 for d in discarded if d.get("_drop") == "below_gate_or_cap"),
            "discarded_event_dup": sum(1 for d in discarded if d.get("_drop") == "event_dup"),
            "low_reach_capped": sum(1 for x in (selected + also + discarded)
                                    if x.get("_low_reach_capped")),
            # Required #2: instrument the no-source _is_x fallback. On live data
            # this is 0 (every row has an explicit source); surface it so a future
            # unsourced slice is visible instead of silently guessed.
            "unsourced_items": sum(1 for x in pool if not str(x.get("source") or "").strip()),
            "boost_gated_off_topic": [
                {"handle": _handle(x), "text": _item_text(x)[:60]}
                for x in (selected + also + [d for d in discarded])
                if "thought-leader(off-topic→no boost)" in (x.get("_boost_reasons") or [])
            ][:10],
        },
    }
    if not selected and not also:
        n = len(pool)
        out["empty_note"] = f"🤷 Nothing cleared the bar today — {n} scanned, none on-topic ≥{ALSO_GATE}."
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Deterministic boost-gating + selection for morning digest.")
    ap.add_argument("--in", dest="inp", default=DEFAULT_IN)
    ap.add_argument("--out", dest="out", default=DEFAULT_OUT)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--engine", choices=["legacy", "deterministic"], default="legacy",
                    help="scoring engine: legacy prose base_score, or deterministic (score_digest.py)")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    with open(args.inp) as f:
        data = json.load(f)
    tl_handles, tl_aliases = _load_thought_leaders()
    tracked = _load_tracked_projects()
    render_input = build_render_input(data, tl_handles, tl_aliases, tracked, engine=args.engine)
    with open(args.out, "w") as f:
        json.dump(render_input, f, ensure_ascii=False, indent=2)
    aud = render_input["_select_audit"]
    print(f"select_digest[{args.engine}]: pool={aud['pool']} → top={aud['selected']} also={aud['also']} "
          f"| dropped bare={aud['discarded_bare']} event_dup={aud['discarded_event_dup']} "
          f"below_gate={aud['discarded_below_gate']} "
          f"| low-reach capped={aud['low_reach_capped']} unsourced={aud['unsourced_items']} "
          f"boost-gated off-topic={len(aud['boost_gated_off_topic'])}")
    return 0


# ── Self-tests (the regression net for this exact incident) ──────────────────
def _selftest():
    fails = []

    def check(name, cond):
        if not cond:
            fails.append(name)

    TL_H = {"elonmusk", "pmarca", "karpathy", "emollick"}
    TL_A = ["elon musk"]
    TRK = ["claude code", "anthropic", "openai", "grok"]

    # #1 bare-fragment discard (the literal incident items)
    check("frag:True", is_bare_fragment("True https://t.co/4c4QtDhInH"))
    check("frag:Yes", is_bare_fragment("Yes https://t.co/x"))
    check("frag:emoji", is_bare_fragment("💯 https://t.co/x"))
    check("frag:reply-mentions", is_bare_fragment("@DrewPavlou @x nice"))
    check("frag:real-tweet-survives",
          not is_bare_fragment("Murderous migrants beheading innocent people in their home town"))
    check("frag:substantive-reply-survives",
          not is_bare_fragment("@karpathy We measured 126x realtime on the RTX 6000 with batch size 8"))

    # #2 topic gate
    on = {"signals": {"topic_hits": [{"topic": "ai-ml"}, {"topic": "dev-tools"}]}}
    off = {"signals": {"topic_hits": [{"topic": "news-and-politics"}]}}
    empty = {"signals": {"topic_hits": []}}
    meme = {"signals": {"topic_hits": [{"topic": "entertainment"}]}}
    check("topic:on", is_on_topic(on))
    check("topic:off", not is_on_topic(off))
    check("topic:empty-off", not is_on_topic(empty))
    check("topic:meme-on", is_on_topic(meme))  # Ace keeps memes

    # boost gating: thought-leader on-topic gets +10; off-topic gets 0
    on_tl = dict(on, authorHandle="elonmusk", base_score=61)
    off_tl = dict(off, authorHandle="elonmusk", base_score=61)
    b_on, r_on = compute_boost(on_tl, TL_H, TL_A, TRK)
    b_off, r_off = compute_boost(off_tl, TL_H, TL_A, TRK)
    check("boost:on-topic-tl=10", b_on == 10)
    check("boost:off-topic-tl=0", b_off == 0)
    check("boost:off-topic-reason", any("off-topic" in x for x in r_off))

    # tracked-project boost is not topic-gated
    trk_off = dict(off, authorHandle="nobody", base_score=70, title="Anthropic ships Claude Code update")
    b_trk, _ = compute_boost(trk_off, TL_H, TL_A, TRK)
    check("boost:tracked=8", b_trk == 8)

    # boost cap
    both = dict(on, authorHandle="elonmusk", base_score=70, title="grok openai claude code")
    b_both, _ = compute_boost(both, TL_H, TL_A, TRK)
    check("boost:cap15", b_both == 15)

    # #3 low-reach cap (base-score-inflation guard)
    spam = {"source": "x", "authorHandle": "bitnewsbot", "base_score": 80, "personal_fit_delta": 0,
            "tweet_text": "OpenAI Sets IPO Goal, Preps 5.6 Model Release #cryptonews #bitcoin",
            "likes": 0, "retweets": 0, "signals": {"topic_hits": [{"topic": "ai-ml"}]}}
    c_spam, r_spam = low_reach_cap(spam, TL_H, TL_A)
    check("lowreach:spam-capped", c_spam == LOW_REACH_SCORE_CAP)
    check("lowreach:spam-below-gate", score_item(spam, TL_H, TL_A, TRK)["_final"] < ALSO_GATE)
    # WORST-CASE pf (review Required #3 / Open-Q1): pf_delta can reach ~24 today
    # (~49 if PF_WEIGHT raised). A fixed −N subtraction would let high-pf spam
    # survive; the CAP must hold regardless. base 80 + pf 24.6 + boost 15 = 100.
    spam_hi_pf = dict(spam, personal_fit_delta=24.6)
    check("lowreach:worstcase-pf-below-gate",
          score_item(spam_hi_pf, TL_H, TL_A, TRK)["_final"] < ALSO_GATE)
    spam_max = dict(spam, base_score=100, personal_fit_delta=49)
    check("lowreach:absolute-max-below-gate",
          score_item(spam_max, TL_H, TL_A, TRK)["_final"] <= LOW_REACH_SCORE_CAP)
    # near-zero engagement (1 rt) still low-reach
    rant = dict(spam, authorHandle="virtualcity69", likes=0, retweets=1,
                tweet_text="@DaveShapi And this is a recursively expanding psychosis issue")
    check("lowreach:near-zero-capped", low_reach_cap(rant, TL_H, TL_A)[0] == LOW_REACH_SCORE_CAP)
    # thought-leader exempt even at zero engagement (don't suppress a 0-like Karpathy gem)
    tl_zero = dict(spam, authorHandle="karpathy", likes=0, retweets=0)
    check("lowreach:tl-exempt", low_reach_cap(tl_zero, TL_H, TL_A)[0] is None)
    # tracked-project mention does NOT exempt (spam name-drops labs) — still capped
    trk_zero = dict(spam, authorHandle="nobody", likes=0, retweets=0,
                    tweet_text="Anthropic ships Claude Code update with new MCP support")
    check("lowreach:tracked-not-exempt", low_reach_cap(trk_zero, TL_H, TL_A)[0] == LOW_REACH_SCORE_CAP)
    # real engagement exempt (unknown handle but the crowd validated it)
    popular = dict(spam, authorHandle="nobody", likes=400, retweets=20)
    check("lowreach:engaged-exempt", low_reach_cap(popular, TL_H, TL_A)[0] is None)
    # public_metrics fallback (Required #1): nested metrics still count as reach
    nested = {"source": "x", "authorHandle": "nobody", "base_score": 80, "personal_fit_delta": 0,
              "tweet_text": "real post", "public_metrics": {"like_count": 300, "retweet_count": 10},
              "signals": {"topic_hits": [{"topic": "ai-ml"}]}}
    check("lowreach:public_metrics-counts", low_reach_cap(nested, TL_H, TL_A)[0] is None)
    # non-X (HN story) exempt — has its own points/comments meta
    story = {"source": "HN", "title": "Show HN: a thing", "base_score": 80, "personal_fit_delta": 0,
             "hn_points": 0, "hn_comments": 0, "signals": {"topic_hits": [{"topic": "ai-ml"}]}}
    check("lowreach:story-exempt", low_reach_cap(story, TL_H, TL_A)[0] is None)
    # a low-reach item with a genuinely HIGH model base still survives ABOVE the
    # other low-reach junk (cap, not discard): capped at 70 but kept, not zeroed.
    hi_base_lowreach = dict(spam, base_score=95, personal_fit_delta=0)
    check("lowreach:cap-not-discard", score_item(hi_base_lowreach, TL_H, TL_A, TRK)["_final"] == LOW_REACH_SCORE_CAP)

    # END-TO-END: reconstruct the 2026-06-10 incident pool and assert the digest
    # is NOT 7 Elon political tweets.
    incident = {
        "all_scored": [
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 8.3,
             "title": "@DrewPavlou The news orgs that say this instead of caring about beheadings are scum",
             "summary": "@DrewPavlou The news orgs that say this instead of caring about beheadings are scum",
             "tweet_id": "1", "url": "u1", "likes": 66249, "retweets": 7306,
             "signals": {"topic_hits": [{"topic": "news"}, {"topic": "news-and-politics"}]}},
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 7.2,
             "tweet_text": "Murderous migrants beheading innocent people is what's making people angry",
             "tweet_id": "2", "url": "u2", "likes": 163715, "retweets": 24576,
             "signals": {"topic_hits": []}},
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 7.2,
             "tweet_text": "Nothing else matters if civilization falls", "tweet_id": "3", "url": "u3",
             "likes": 130196, "retweets": 15829, "signals": {"topic_hits": []}},
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 7.2,
             "tweet_text": "💯 https://t.co/x", "tweet_id": "4", "url": "u4", "likes": 53519, "retweets": 7106,
             "signals": {"topic_hits": []}},
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 7.2,
             "tweet_text": "True https://t.co/x", "tweet_id": "5", "url": "u5", "likes": 42115, "retweets": 6089,
             "signals": {"topic_hits": []}},
            {"source": "x", "authorHandle": "elonmusk", "base_score": 61, "personal_fit_delta": 7.2,
             "tweet_text": "Yes https://t.co/x", "tweet_id": "6", "url": "u6", "likes": 37404, "retweets": 3355,
             "signals": {"topic_hits": []}},
            # genuinely good builder content that was buried under the Elon wall
            {"source": "x", "authorHandle": "michaelaiello", "base_score": 63, "personal_fit_delta": 8.0,
             "tweet_text": "Career update: I've joined @OpenAI to lead Cyber as Head of Product",
             "tweet_id": "7", "url": "u7", "likes": 900, "retweets": 30,
             "signals": {"topic_hits": [{"topic": "ai-ml"}, {"topic": "startups-business"}]}},
            {"source": "x", "authorHandle": "emollick", "base_score": 66, "personal_fit_delta": 8.0,
             "tweet_text": "Switch to a cheaper model to save money is a problem because routing matters more than price",
             "tweet_id": "8", "url": "u8", "likes": 400, "retweets": 20,
             "signals": {"topic_hits": [{"topic": "ai-ml"}, {"topic": "dev-tools"}]}},
        ]
    }
    sel, also, disc = select(incident["all_scored"], TL_H, TL_A, TRK)
    handles = [_handle(x) for x in sel]
    check("e2e:not-all-elon", not (sel and all(h == "elonmusk" for h in handles)))
    check("e2e:bare-frags-discarded",
          {"4", "5", "6"}.issubset({d.get("tweet_id") for d in disc if d.get("_drop") == "bare_fragment"}))
    check("e2e:elon-political-not-top",
          all(h != "elonmusk" or it["_final"] < TOP_GATE for it, h in zip(sel, handles)))
    check("e2e:good-content-surfaces",
          any(_handle(x) in {"michaelaiello", "emollick"} for x in (sel + also)))

    # EVENT-COLLAPSE: 4 accounts reporting ONE launch must not fill 4 Top slots.
    # (Mirrors the Fable-5 launch day that exposed the two-selectors-fighting bug.)
    launch = {"all_scored": [
        {"source": "x", "authorHandle": "acct1", "base_score": 82, "personal_fit_delta": 0,
         "tweet_text": "Anthropic released Claude Fable 5, the new Mythos-class tier above Opus",
         "event_key": "claude-fable-5-launch", "tweet_id": "L1", "url": "L1", "likes": 10,
         "signals": {"topic_hits": [{"topic": "ai-ml"}]}},
        {"source": "x", "authorHandle": "acct2", "base_score": 82, "personal_fit_delta": 0,
         "tweet_text": "Claude Fable 5 is impressive, the Mythos-class numbers on SWE-Bench are wild",
         "event_key": "claude-fable-5-launch", "tweet_id": "L2", "url": "L2", "likes": 8,
         "signals": {"topic_hits": [{"topic": "ai-ml"}]}},
        {"source": "x", "authorHandle": "acct3", "base_score": 82, "personal_fit_delta": 0,
         "tweet_text": "Claude Fable 5 已接入 API, the new Mythos-class coding model from Anthropic",
         "event_key": "claude-fable-5-launch", "tweet_id": "L3", "url": "L3", "likes": 5,
         "signals": {"topic_hits": [{"topic": "ai-ml"}]}},
        # a genuinely different event
        {"source": "hn", "title": "Gemma 4 released with open weights and a permissive license",
         "base_score": 84, "personal_fit_delta": 0, "event_key": "gemma-4-release",
         "tweet_id": "G1", "url": "G1", "signals": {"topic_hits": [{"topic": "ai-ml"}]}},
    ]}
    lsel, lalso, ldisc = select(launch["all_scored"], TL_H, TL_A, TRK)
    fable_in_top = [x for x in lsel if (x.get("event_key") == "claude-fable-5-launch")]
    check("e2e:event-collapse-one-fable", len(fable_in_top) <= 1)
    check("e2e:event-dup-dropped",
          any(d.get("_drop") == "event_dup" for d in ldisc))
    check("e2e:distinct-event-kept",
          any(x.get("event_key") == "gemma-4-release" for x in (lsel + lalso)))

    if fails:
        print("SELFTEST FAILED:", fails)
        return 1
    print("select_digest selftest OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
