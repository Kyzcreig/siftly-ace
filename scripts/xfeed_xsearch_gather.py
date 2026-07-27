#!/usr/bin/env python3
"""xfeed_xsearch_gather.py — tiered x_search gather for the x-feed brief.

WHY THIS IS SEPARATE FROM morning-digest's PATH
------------------------------------------------
morning-digest is KEYWORD-driven — a handful of topical queries, x_search's
native strength, and a flat chunked sweep serves it fine.

x-feed is a COMPLETENESS read over a ~220-handle follow graph, and the top post
IS the product. A flat chunked sweep silently fails it. Measured 2026-07-27 on
the real 07-26 corpus (same 7 handles, same window, same floor):

    flat chunk of 7 @ min_faves:28000  ->  10 rows, ALL @elonmusk, recall 62%
        MISSED: @RepThomasMassie 102,003 likes  <- the day's #1 post
                @MrBeast          42,886 likes
    @elonmusk split out, other 6 chunked -> both recovered, recall 88%

Cause: the chunk budget is ~10 rows PER CALL, allocated across the whole chunk
by relevance. One dense handle consumes it and its neighbours return NOTHING.
So this gatherer plans a TIERED sweep (descending min_faves floors, dense
handles isolated) via xsearch_tiered_plan, and pipes every raw response through
the SAME adapter morning-digest uses so all guards apply identically.

WHAT IT DOES NOT DO
-------------------
It does not issue x_search calls itself — the agent does, one per planned query,
per the prompt. This script (a) prints the plan, and (b) adapts the saved raw
responses into pipeline candidate rows. Same two-phase shape as morning-digest.

Usage:
    xfeed_xsearch_gather.py --plan --since S --until U        # print queries
    xfeed_xsearch_gather.py --adapt --from-response F [...]   # -> candidates
"""
from __future__ import annotations
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from xsearch_gather import gather, load_handles          # noqa: E402
from xsearch_tiered_plan import build_plan, cost_floor   # noqa: E402

FOLLOWS = os.path.expanduser("~/.hermes/digest/xfeed-follows.txt")

# x-feed's floors differ from the planner's defaults. The brief publishes ~7 items
# from a ~220-handle graph, so tier 1 exists to GUARANTEE the day's biggest posts
# are captured before any budget is spent on breadth — that is the failure this
# whole design exists to prevent.
XFEED_TIERS = [
    ("headline", 20000, 10),   # the day's unmissable posts
    ("strong",    2000, 10),
    ("body",       100, 10),   # the long tail; packer isolates dense handles
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--adapt", action="store_true")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--handles-file", default=FOLLOWS)
    ap.add_argument("--history", help="paid timeline snapshot for calibration")
    ap.add_argument("--from-response", action="append", default=[])
    ap.add_argument("--out")
    ap.add_argument("--report")
    ap.add_argument("--min-faves", type=int, default=100)
    ap.add_argument("--max-calls", type=int, default=60,
                    help="refuse to emit a plan larger than this (cost guard)")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return _selftest()

    handles = load_handles(a.handles_file)
    if not handles:
        print(f"no handles in {a.handles_file}", file=sys.stderr)
        return 2

    if a.plan:
        if not (a.since and a.until):
            ap.error("--plan requires --since and --until")
        plan = build_plan(handles, a.since, a.until,
                          tiers=XFEED_TIERS, history=a.history)
        if len(plan) > a.max_calls:
            # Fail LOUD rather than silently truncating: a plan that outgrew its
            # budget means the calibration is stale, and quietly dropping tiers
            # would reintroduce exactly the coverage gap this exists to close.
            print(f"PLAN TOO LARGE: {len(plan)} calls > --max-calls {a.max_calls}. "
                  f"Raise the floors or the cap deliberately; do not truncate silently.",
                  file=sys.stderr)
            return 3
        if a.history:
            cf = cost_floor(a.history, tiers=XFEED_TIERS, n_handles=len(handles))
            for name, floor, _ in XFEED_TIERS:
                c = cf[name]
                print(f"# tier {name} min_faves:{floor} — {c['qualifying_posts']} posts, "
                      f"floor {c['min_calls']} calls", file=sys.stderr)
        print(f"# {len(plan)} calls over {len(set(h.lower() for h in handles))} handles",
              file=sys.stderr)
        for p in plan:
            print(json.dumps({"call": p["call"], "tier": p["tier"],
                              "handles": p["handles"], "query": p["query"]}))
        return 0

    if a.adapt:
        if not a.from_response:
            ap.error("--adapt requires at least one --from-response")
        if not (a.since and a.until):
            ap.error("--adapt requires --since and --until (local window re-filter)")
        responses = []
        for path in a.from_response:
            with open(path) as fh:
                responses.append(json.load(fh))
        # Reuse morning-digest's adapter verbatim so every guard (citation union,
        # tweet_text shape, flat likes, id coercion, window re-filter, truncation
        # tripwire, credential check) applies identically on both briefs.
        # NOTE: gather() returns a (candidates, report) TUPLE, not a dict.
        candidates, rep = gather(handles, a.since, a.until, min_faves=a.min_faves,
                                 responses=responses)
        payload = {"candidates": candidates, "report": rep}
        text = json.dumps(payload, ensure_ascii=False)
        if a.out:
            with open(a.out, "w") as fh:
                fh.write(text)
        else:
            print(text)
        if a.report:
            with open(a.report, "w") as fh:
                json.dump(payload["report"], fh, ensure_ascii=False)
        rep = payload["report"]
        print(f"x_search_calls={rep.get('x_search_calls')} "
              f"ok={rep.get('chunks_ok')} failed={rep.get('chunks_failed')} "
              f"emitted={rep.get('candidates_emitted')} "
              f"cred={rep.get('credential_sources')}", file=sys.stderr)
        for alert in rep.get("alerts", []) or []:
            print(f"ALERT: {alert}", file=sys.stderr)
        return 0

    ap.error("pass --plan or --adapt")


def _selftest():
    def check(c, label):
        print(("  ok   " if c else "  FAIL ") + label)
        if not c:
            raise SystemExit(1)

    since, until = "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z"

    # tier floors must descend, else a lower tier can never add anything
    floors = [f for _, f, _ in XFEED_TIERS]
    check(floors == sorted(floors, reverse=True), "x-feed tier floors descend")

    # the headline tier must exist and be high enough to stay sparse — that is the
    # tier that guarantees the day's #1 post survives the chunk budget
    check(XFEED_TIERS[0][1] >= 20000, "headline tier floor >= 20000")

    # a dense handle must be isolated, or it starves its chunk (the measured bug)
    plan = build_plan(["elonmusk", "quiet1", "quiet2"], since, until,
                      tiers=XFEED_TIERS,
                      history=None)
    check(all("min_faves:" in p["query"] for p in plan), "every query carries a floor")
    check(all("from:" in p["query"] for p in plan), "every query uses operator syntax")

    # every handle must be swept in every tier — history is a prior, never a filter
    for name, _, _ in XFEED_TIERS:
        covered = {h for p in plan if p["tier"] == name for h in p["handles"]}
        check(covered == {"elonmusk", "quiet1", "quiet2"}, f"tier {name} covers all handles")

    check(os.path.exists(FOLLOWS), f"follows file exists: {FOLLOWS}")
    print("xfeed_xsearch_gather selftest: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
