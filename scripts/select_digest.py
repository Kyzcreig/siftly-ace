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


def score_item(item, tl_handles, tl_aliases, tracked):
    """final = base + pf_delta + GATED boost, clamped 0..100. Returns enriched dict."""
    base = _num(item.get("base_score"))
    pf = _num(item.get("personal_fit_delta"))
    boost, reasons = compute_boost(item, tl_handles, tl_aliases, tracked)
    final = max(0.0, min(100.0, base + pf + boost))
    out = dict(item)
    out["_boost"] = boost
    out["_boost_reasons"] = reasons
    out["_final"] = final
    return out


def _engagement(item):
    return _num(item.get("likes")) + _num(item.get("retweets"))


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


def select(pool, tl_handles, tl_aliases, tracked):
    """Returns (selected, also, discarded). Pure; no I/O."""
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
            d["_drop"] = "below_gate"
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


def build_render_input(data, tl_handles, tl_aliases, tracked, now=None):
    pool = data.get("all_scored") or []
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
            "discarded_below_gate": sum(1 for d in discarded if d.get("_drop") == "below_gate"),
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
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    with open(args.inp) as f:
        data = json.load(f)
    tl_handles, tl_aliases = _load_thought_leaders()
    tracked = _load_tracked_projects()
    render_input = build_render_input(data, tl_handles, tl_aliases, tracked)
    with open(args.out, "w") as f:
        json.dump(render_input, f, ensure_ascii=False, indent=2)
    aud = render_input["_select_audit"]
    print(f"select_digest: pool={aud['pool']} → top={aud['selected']} also={aud['also']} "
          f"| dropped bare={aud['discarded_bare']} below_gate={aud['discarded_below_gate']} "
          f"| boost-gated off-topic={len(aud['boost_gated_off_topic'])}")
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

    if fails:
        print("SELFTEST FAILED:", fails)
        return 1
    print("select_digest selftest OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
