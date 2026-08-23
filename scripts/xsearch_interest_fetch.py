#!/usr/bin/env python3
"""xsearch_interest_fetch.py — interest searches via grok x_search ($0, subscription).

MIGRATION 2026-08-22: replaces `scripts/x-search-fetch.ts` (paid X API
`/2/tweets/search/recent` behind the RC2 cache, ~3-10 reads/day) with the SAME
xAI server-side `x_search` lane both briefs' timeline sweeps already use.
Rollback: the prompt swaps this line back to `npx tsx scripts/x-search-fetch.ts`
(the TS path + cache lib are preserved untouched).

Output (stdout) matches the shape the x-feed-brief prompt already parses:
  {status, queriesFetched, readsApprox, cacheFile, day,
   results: [{query, data: [tweet...], users: [user...]}]}
- `data[]` rows carry the raw-X-API-ish keys Step 3 matches on: id, text,
  author_id, created_at, public_metrics{like_count,retweet_count,reply_count}.
- `users[]` carries {id, username, name}; author_id == username surrogate
  (x_search returns handles, not numeric ids — matching still works because
  BOTH sides use the same surrogate).
- readsApprox is always 0 (subscription lane) — the migration watcher keys on
  x_search call counts, which we log to stderr.

No cache needed: the calls are $0, so same-day reruns just re-fetch.
Keyword queries need NO handle allow-list; window comes from --since/--until
(day-granular at the operator level; we filter rows locally to the true window).
"""
import argparse

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xsearch_gather import call_x_search, extract_rows, normalize_ts, _num, _parse_dt  # noqa: E402

DEFAULT_QUERIES = [
    "AI agents framework launch",
    "AI coding tool release",
    "open source model release",
]
MIN_FAVES = 50  # interest lane: keyword search floor (keeps meme-reply noise out)

JSON_SHAPE = (
    "Return ONLY a JSON array — no prose, no commentary, no code fences. One object "
    "per post. Keys exactly: handle, author_name, tweet_id, tweet_text, url, likes, "
    "retweets, replies, views, created_at.\n"
    "tweet_id MUST be a STRING (quoted), not a number. created_at MUST be exact "
    "ISO8601 UTC. Integers as integers; use null when a value is unknown. "
    "Return EVERY matching post, not a sample."
)


def build_interest_query(topic: str, since: str, until: str) -> str:
    # 🔴 MEASURED 2026-08-22: the operator form that is LOAD-BEARING for from:
    # handle sweeps returns EMPTY ([]) for pure-keyword topics
    # ("AI coding tool release min_faves:50 since:… until:…" -> 0 rows, success
    # true), while a natural-language phrasing of the SAME topic+floor+window
    # returned 13KB of rows. Keyword lane = NL phrasing; handle lane = operators.
    # Do not "unify" them without re-measuring both.
    since_d = since[:10]
    until_d = until[:10] if until else since_d
    return (
        f"Find popular posts on X between {since_d} and {until_d} (UTC) about: "
        f"{topic}. Only include posts with at least {MIN_FAVES} likes.\n\n{JSON_SHAPE}"
    )


def rows_to_api_shape(rows, since, until):
    """x_search rows -> raw-X-API-ish {data, users} the brief's Step 3 matches."""
    data, users, seen_users = [], [], set()
    # PARITY NOTE: the old paid path was /2/tweets/search/recent — a ~7-DAY window
    # with no 24h cut (the prompt's "24h window" rule applies to the TIMELINE lane
    # only). So filter day-granular: keep anything from the since-DAY onward.
    lo = _parse_dt(since[:10] + "T00:00:00Z")
    hi = _parse_dt(until)
    for r in rows:
        if not isinstance(r, dict):
            continue
        handle = str(r.get("handle") or "").lstrip("@").strip()
        tid = str(r.get("tweet_id") or "").strip()
        text = r.get("tweet_text") or ""
        if not (handle and tid and text):
            continue
        created = normalize_ts(r.get("created_at"))
        cdt = _parse_dt(created)
        if cdt and lo and hi and not (lo <= cdt <= hi):
            continue  # QUERY WIDE, FILTER NARROW
        data.append({
            "id": tid,
            "text": text,
            "author_id": handle,          # surrogate: both sides use handle
            "created_at": created,
            "public_metrics": {
                "like_count": _num(r.get("likes")),
                "retweet_count": _num(r.get("retweets")),
                "reply_count": _num(r.get("replies")),
                "impression_count": _num(r.get("views")),
            },
        })
        if handle not in seen_users:
            seen_users.add(handle)
            users.append({
                "id": handle,
                "username": handle,
                "name": r.get("author_name") or handle,
            })
    return data, users


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", default=[])
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    args = ap.parse_args(argv)
    queries = args.query or DEFAULT_QUERIES

    results, calls, failures = [], 0, []
    for topic in queries:
        q = build_interest_query(topic, args.since, args.until)
        resp = call_x_search(q, handles=[], since=args.since, until=args.until)
        calls += 1
        if not resp.get("success"):
            failures.append({"query": topic, "error": str(resp.get("error"))[:200]})
            print(f"[interest] FAIL {topic!r}: {resp.get('error')}", file=sys.stderr)
            results.append({"query": topic, "data": [], "users": []})
            continue
        rows = extract_rows(resp.get("answer") or "")
        data, users = rows_to_api_shape(rows, args.since, args.until)
        print(f"[interest] ok {topic!r}: {len(data)} posts", file=sys.stderr)
        results.append({"query": topic, "data": data, "users": users})

    status = "x_search" if not failures else ("partial" if len(failures) < len(queries) else "failed")
    out = {
        "status": status,
        "queriesFetched": len(queries) - len(failures),
        "readsApprox": 0,                       # $0 subscription lane
        "xSearchCalls": calls,
        "cacheFile": None,
        "day": args.since[:10],
        "failures": failures,
        "results": results,
    }
    json.dump(out, sys.stdout)
    # fail loudly if EVERYTHING failed (Step 1.5 treats it as a source failure)
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
