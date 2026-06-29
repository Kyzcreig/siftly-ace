#!/usr/bin/env python3
"""overview_digest.py — deterministic aggregator for the brief "Overview" synthesis.

Reads a brief's FULL scored candidate pool (`all_scored[]` from the Step-6.5 debug
dump) and emits a compact, factual aggregate that the brief's Overview prompt step
turns into a half-page "what's going on" synthesis (big themes + big stories).

This NEVER writes prose and NEVER posts — it only crunches numbers the briefs
already produce. Pure stdlib, fast, no network. Fail-safe: on any error it prints
a minimal valid JSON so the brief can skip the overview cleanly.

Usage:
  python3 scripts/overview_digest.py --in <pool.json> [--brief morning-digest|x-feed-brief]
  # → JSON aggregate on stdout
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict

# topics we never surface as a "theme" headline (noise / not a story).
# `x.com`/`twitter`/`tracked-project`-style tags match nearly every tweet (the URL
# host or a watch-list marker), so they pollute the theme histogram with a
# meaningless catch-all bucket — never headline them. Same for over-broad source
# tags. Keep this list tight: only genuinely contentless labels.
SKIP_TOPICS = {
    "", "other", "misc", "uncategorized",
    "x.com", "x", "twitter", "twitter.com", "tweet", "status",
    "tracked-project", "general", "ai", "news",
}


def _pool(data: dict) -> list:
    return data.get("all_scored") or data.get("pool") or []


# Re-score the pool through the SAME deterministic authority that gates the brief
# (score_digest.score_item — incl. Backstop 4 junk demotion + the off-topic guard),
# so the overview can NEVER surface what the brief itself wouldn't. Stamps each item:
#   _ov_final     : the real deterministic final score (ranking/salience authority)
#   _ov_excluded  : True if junk-flagged OR effective-off-topic (drop from headlines)
# Fail-safe: if score_digest can't be imported/run, fall back to the dump's
# `final_score` / raw `on_topic` label so the overview still renders (degraded).
def _rescore_pool(pool: list) -> bool:
    """Mutate pool items in place with `_ov_final` + `_ov_excluded`. Returns True if
    the real deterministic re-score ran, False if it fell back to dump values."""
    try:
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from score_digest import (  # noqa: E402
            score_item, _load_thought_leaders, _load_tracked_projects,
        )
        tl_h, tl_a = _load_thought_leaders()
        trk = _load_tracked_projects()
        for it in pool:
            try:
                out = score_item(it, tl_h, tl_a, trk)
                bd = out.get("_breakdown", {})
                it["_ov_final"] = float(out.get("_final", 0.0))
                it["_ov_excluded"] = bool(bd.get("junk_backstop")) or bd.get("effective_on_topic") == "off"
            except Exception:
                # per-item fallback: trust the dump's values for this one item
                it["_ov_final"] = _num(it.get("final_score"))
                it["_ov_excluded"] = (it.get("on_topic") or "core") == "off"
        return True
    except Exception:
        # whole-module fallback: the overview still works off the dump's fields
        for it in pool:
            it["_ov_final"] = _num(it.get("final_score"))
            it["_ov_excluded"] = (it.get("on_topic") or "core") == "off"
        return False


def _id(it: dict) -> str:
    return it.get("id") or it.get("url") or it.get("tweet_id") or ""


def _text(it: dict) -> str:
    return (it.get("title") or it.get("tweet_text") or it.get("summary")
            or it.get("text") or "").strip()


# Leading @mentions on a reply tweet ("@a @b actual point") carry no story signal —
# strip them so the label reads as the actual point, not the reply targets.
_LEADING_MENTIONS = re.compile(r"^(?:\s*@\w{1,15}\b[,:]?\s*)+")
# A tweet that opens with a bare/t.co URL ("https://t.co/x has officially entered…")
# would otherwise make the label LEAD with an opaque link. Strip leading URL(s) so the
# gist is the actual sentence. Also strips a trailing-only url-fragment lead-in.
_LEADING_URL = re.compile(r"^(?:\s*https?://\S+\s*)+", re.IGNORECASE)
# Newsy lead-ins that carry zero content if taken alone ("BREAKING:", "JUST IN:",
# "NEW:", "🚨") — strip a leading one so the label is the actual headline, not the
# klaxon. Only stripped when it's a short prefix followed by real text.
_LEAD_NOISE = re.compile(r"^(?:🚨|⚡️?|breaking|just in|new|update|exclusive|alert|news)\s*[:\-—]?\s*", re.IGNORECASE)
_WS = re.compile(r"\s+")
_SENT_SPLIT = re.compile(r"(?<=[.!?。！？])\s|\n")


def _gist(txt: str, limit: int) -> str:
    """First meaningful clause of a tweet for a label. Takes the first sentence,
    but if it's tiny (a 'BREAKING:'-style klaxon or a 1-2 word fragment), absorbs
    the next sentence too so the label carries real content, not just the lead-in."""
    txt = _LEAD_NOISE.sub("", txt).strip()
    parts = [p.strip() for p in _SENT_SPLIT.split(txt) if p.strip()]
    if not parts:
        return ""
    gist = parts[0]
    # absorb the next clause when the first is too short to mean anything.
    i = 1
    while len(gist) < 40 and i < len(parts):
        gist = f"{gist} {parts[i]}"
        i += 1
    return gist.strip().rstrip(":-—, ")


def _is_tweet(it: dict) -> bool:
    src = str(it.get("source") or "").lower()
    return src in ("x", "twitter") or bool(it.get("tweet_id")) or "/status/" in (it.get("url") or "")


def _clip(s: str, limit: int) -> str:
    """Clip to <=limit chars at a WORD boundary (never mid-word), '…' if trimmed."""
    s = s.strip()
    if len(s) <= limit:
        return s
    cut = s[:limit].rstrip()
    sp = cut.rfind(" ")
    if sp > limit * 0.5:  # only back off to a space if it isn't pathologically early
        cut = cut[:sp].rstrip()
    return cut.rstrip(":-—,;") + "…"


def _label(it: dict, limit: int = 90) -> str:
    """A clean, human-readable label for an item — used for theme examples AND
    top-story names so the Overview prose/chips never read as raw tweet fragments.

    - Non-tweets (github/reddit/HN/Perplexity): the title IS a clean headline/slug.
    - Tweets: '@handle: <first clause>' with leading @mentions stripped (a reply's
      target handles aren't the story). Falls back to '@handle' or the raw text.

    Clipping is WORD-boundary (never "which model is t") with a trailing '…'.
    """
    if not _is_tweet(it):
        base = (it.get("title") or it.get("summary") or it.get("text") or "").strip()
        return _clip(_WS.sub(" ", base), limit)
    txt = (it.get("tweet_text") or it.get("title") or it.get("text") or "").strip()
    txt = _WS.sub(" ", _LEADING_MENTIONS.sub("", txt)).strip()
    txt = _LEADING_URL.sub("", txt).strip()  # don't let a label lead with an opaque t.co link
    gist = _gist(txt, limit)
    handle = str(it.get("authorHandle") or "").strip().lstrip("@")
    if not gist:
        return f"@{handle}" if handle else ""
    body = f"@{handle}: {gist}" if handle else gist
    return _clip(body, limit)


def _topics(it: dict) -> list:
    """topic labels for an item, robust to BOTH brief shapes:
      - morning-digest: signals is a DICT with topic_hits=[{topic, why}, ...]
      - x-feed-brief:    signals is a LIST of {name, ...}; the topic_hits entry
                         carries hits=[raw keyword, ...]
    Returns lowercased topic/keyword strings (skipping noise labels)."""
    sig = it.get("signals")
    out = []
    if isinstance(sig, dict):
        for h in (sig.get("topic_hits") or []):
            t = (h.get("topic") if isinstance(h, dict) else str(h)) or ""
            t = t.strip().lower()
            if t and t not in SKIP_TOPICS:
                out.append(t)
    elif isinstance(sig, list):
        for entry in sig:
            if isinstance(entry, dict) and entry.get("name") == "topic_hits":
                for kw in (entry.get("hits") or []):
                    t = str(kw).strip().lower()
                    if t and t not in SKIP_TOPICS:
                        out.append(t)
    # fallback: a top-level topic_hits list (defensive)
    if not out:
        for h in (it.get("topic_hits") or []):
            t = (h.get("topic") if isinstance(h, dict) else str(h)) or ""
            t = t.strip().lower()
            if t and t not in SKIP_TOPICS:
                out.append(t)
    return out


def _num(v, d=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _engagement(it: dict) -> float:
    return _num(it.get("likes")) + _num(it.get("retweets")) + _num(it.get("hn_points"))


def aggregate(data: dict, brief: str, top_n_themes: int = 8, top_n_stories: int = 12) -> dict:
    pool = _pool(data)
    n = len(pool)
    # Re-score through the SAME deterministic authority that gates the brief (incl.
    # Backstop-4 junk demotion + off-topic guard), so the overview can't surface
    # crypto/scam/fragment junk the model mislabeled `core`. Stamps _ov_final/_ov_excluded.
    rescored = _rescore_pool(pool)
    # Headlines/themes consider only items the deterministic engine would NOT exclude
    # (junk-flagged or effective-off-topic). We still report how much noise the pool
    # carried (Ace asked to know the mood).
    on = [it for it in pool if not it.get("_ov_excluded", (it.get("on_topic") or "core") == "off")]
    off_count = n - len(on)

    def _score(it):  # ranking/salience authority = the real deterministic final
        return _num(it.get("_ov_final", it.get("final_score")))

    # --- theme histogram (topic -> count + summed deterministic score as salience) ---
    # Examples must be the STRONGEST items per topic, not the first-seen ones, or a
    # single over-tagged junk tweet (one crypto post tagged models+coding+security)
    # becomes the face of every theme. Iterate high-score → low so examples[:3] are
    # the best, and dedupe an item across themes so the same tweet doesn't headline
    # three different lanes.
    theme_count: Counter = Counter()
    theme_salience: dict = defaultdict(float)
    theme_examples: dict = defaultdict(list)
    theme_example_ids: dict = defaultdict(set)
    on_by_score = sorted(on, key=_score, reverse=True)
    used_example_ids: set = set()
    for it in on_by_score:
        sal = _score(it)
        label = _label(it)
        iid = _id(it)
        for t in set(_topics(it)):
            theme_count[t] += 1
            theme_salience[t] += sal
            # one example per item globally (don't repeat the same tweet across themes),
            # and skip empty/degenerate labels.
            if (len(theme_examples[t]) < 3 and label and iid not in used_example_ids
                    and iid not in theme_example_ids[t]):
                theme_examples[t].append(label)
                theme_example_ids[t].add(iid)
                used_example_ids.add(iid)
    # rank themes by salience (sum of scores), tie-break count
    themes = sorted(theme_count.keys(),
                    key=lambda t: (theme_salience[t], theme_count[t]), reverse=True)[:top_n_themes]
    # A theme with no usable example is just a bare tag — drop it (it'd only invite
    # the LLM to pad). Keep themes that have at least one concrete example.
    theme_rows = [{
        "topic": t, "count": theme_count[t],
        "salience": round(theme_salience[t], 1),
        "examples": theme_examples[t],
    } for t in themes if theme_examples[t]]

    # --- top stories (highest deterministic score, deduped by event_key/text) ---
    # Each gets a stable 1-based `ref` number so the Overview prose can cite [N]
    # and inject_overview resolves [N] → the real URL (links never come from the LLM).
    seen_keys = set()
    stories = []
    for it in sorted(on, key=_score, reverse=True):
        key = it.get("event_key") or _text(it)[:80].lower()
        if key in seen_keys:
            continue
        seen_keys.add(key)
        url = it.get("url") or ""
        if not url:
            continue  # a story with no URL can't be a citable reference
        stories.append({
            "ref": len(stories) + 1,
            "label": _label(it),
            "title": _text(it)[:200],
            "handle": it.get("authorHandle"),
            "source": it.get("source"),
            "content_type": it.get("content_type"),
            "final_score": round(_score(it), 1),
            "engagement": int(_engagement(it)),
            "url": url,
        })
        if len(stories) >= top_n_stories:
            break

    # --- loud authors (frequency + engagement) — most relevant for x-feed ---
    author_count: Counter = Counter()
    author_eng: dict = defaultdict(float)
    for it in on:
        h = it.get("authorHandle")
        if h:
            author_count[h] += 1
            author_eng[h] += _engagement(it)
    loud = sorted(author_count.keys(),
                  key=lambda h: (author_count[h], author_eng[h]), reverse=True)
    loud_rows = [{"handle": h, "count": author_count[h], "engagement": int(author_eng[h])}
                 for h in loud[:8] if author_count[h] >= 2]

    # --- content-type mix ---
    ctype = Counter((it.get("content_type") or "?") for it in on)

    return {
        "brief": brief,
        "pool_size": n,
        "on_topic_size": len(on),
        "off_topic_count": off_count,
        "rescored": rescored,
        "themes": theme_rows,
        "top_stories": stories,
        "loud_authors": loud_rows,
        "content_mix": dict(ctype.most_common()),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--brief", default="")
    ap.add_argument("--top-themes", type=int, default=8)
    ap.add_argument("--top-stories", type=int, default=12)
    args = ap.parse_args(argv)
    try:
        with open(args.inp) as f:
            data = json.load(f)
        out = aggregate(data, args.brief, args.top_themes, args.top_stories)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        # fail-safe: emit minimal valid JSON so the brief skips the overview cleanly
        print(json.dumps({"brief": args.brief, "error": str(e)[:200],
                          "pool_size": 0, "themes": [], "top_stories": []}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
