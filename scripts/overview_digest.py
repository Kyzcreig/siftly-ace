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

# topics we never surface as a "theme" headline (noise / not a story)
SKIP_TOPICS = {"", "other", "misc", "uncategorized"}


def _pool(data: dict) -> list:
    return data.get("all_scored") or data.get("pool") or []


def _id(it: dict) -> str:
    return it.get("id") or it.get("url") or it.get("tweet_id") or ""


def _text(it: dict) -> str:
    return (it.get("title") or it.get("tweet_text") or it.get("summary")
            or it.get("text") or "").strip()


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
    # only consider on-topic (core/adjacent) items for theme/story headlines; an
    # 'off' political/unrelated item shouldn't define the AI landscape — but we DO
    # report how much off-topic noise the pool carried (Ace asked to know the mood).
    on = [it for it in pool if (it.get("on_topic") or "core") != "off"]
    off_count = n - len(on)

    # --- theme histogram (topic -> count + summed final_score as salience) ---
    theme_count: Counter = Counter()
    theme_salience: dict = defaultdict(float)
    theme_examples: dict = defaultdict(list)
    for it in on:
        sal = _num(it.get("final_score"))
        for t in set(_topics(it)):
            theme_count[t] += 1
            theme_salience[t] += sal
            if len(theme_examples[t]) < 3 and _text(it):
                theme_examples[t].append(_text(it)[:120])
    # rank themes by salience (sum of scores), tie-break count
    themes = sorted(theme_count.keys(),
                    key=lambda t: (theme_salience[t], theme_count[t]), reverse=True)[:top_n_themes]
    theme_rows = [{
        "topic": t, "count": theme_count[t],
        "salience": round(theme_salience[t], 1),
        "examples": theme_examples[t],
    } for t in themes]

    # --- top stories (highest final_score, deduped by event_key/text) ---
    seen_keys = set()
    stories = []
    for it in sorted(on, key=lambda x: _num(x.get("final_score")), reverse=True):
        key = it.get("event_key") or _text(it)[:80].lower()
        if key in seen_keys:
            continue
        seen_keys.add(key)
        stories.append({
            "title": _text(it)[:200],
            "handle": it.get("authorHandle"),
            "source": it.get("source"),
            "content_type": it.get("content_type"),
            "final_score": round(_num(it.get("final_score")), 1),
            "engagement": int(_engagement(it)),
            "url": it.get("url"),
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
