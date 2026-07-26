#!/usr/bin/env python3
"""Tiered x_search sweep planner — cover a large follow graph in ~15-30 calls.

WHY THIS EXISTS
---------------
`x_search` allocates a result budget of ~10 rows PER CALL across the WHOLE chunk,
by relevance/recency — it is NOT ~10 rows per handle. So whichever handle in a
chunk has the most qualifying posts consumes the budget and its neighbours return
NOTHING. Measured 2026-07-25, same tool, same day:

    8 handles @ min_faves:5000   -> 10 rows, ALL @elonmusk, other 7 got ZERO
    8 handles @ min_faves:20000  ->  8 rows across 4 handles, none starved
    5 handles @ min_faves:100    -> 10 rows (2 starved) vs 14 as 5 SOLO calls

The governing condition is therefore:

    chunk_is_safe  <=>  expected_qualifying_posts(whole_chunk, floor) < CAP

A flat `min_faves:100` sweep forces ~1 call per active handle (100+ calls for a
143-handle feed). Raising the floor makes a chunk sparse, so a TIERED sweep gets
the same top-of-feed coverage in a fraction of the calls:

    tier 1  high floor,   wide chunks  -> the day's genuine top posts
    tier 2  mid floor,    small chunks -> the strong middle
    tier 3  target floor, solo (heavy) -> the long tail

This module PLANS the calls. It does not issue them — the agent (or the caller)
issues each `x_search` and feeds the raw responses back to `xsearch_gather.py`,
which owns every guard (citation check, window re-filter, ID coercion, tripwire).

CALIBRATION
-----------
`--history` takes a paid-API timeline snapshot and measures, per handle, how many
posts actually clear each tier's floor. That turns "expected_qualifying_posts"
from a guess into a measurement, so a handle is only batched when the evidence
says the chunk stays under the cap. Without --history the planner falls back to a
conservative posture (heavy handles solo, small chunks) and says so.

WHAT THIS PLANNER CANNOT DO (measured, be honest about it)
----------------------------------------------------------
History is a PRIOR, not a forecast. Engagement only grows between the snapshot
and the run, and a quiet handle can have a loud day, so a chunk sized from
history can still overflow and starve its neighbours. Measured live 2026-07-25:

    4 handles packed to 9/10  -> 7 rows, ALL from one handle, 3 starved
    after the safety margin   -> 10 rows across 2 calls, but 2 handles STILL starved

So planning REDUCES how often starvation happens; it cannot eliminate it. The
truncation tripwire in xsearch_gather.py is the real backstop — it flags a call
that came back at the cap so the caller re-queries that handle with a narrower
window. Never treat a clean plan as proof of complete coverage; treat the
tripwire's silence as that proof.

Usage:
    xsearch_tiered_plan.py --handles-file H --since S --until U \\
        [--history timeline.json] [--tiers 20000,1000] [--json]
"""
from __future__ import annotations
import argparse, json, os, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from xsearch_gather import (            # noqa: E402
    build_query, chunk_handles, MAX_HANDLES_PER_CALL, DEFAULT_TRUNCATION_CAP,
    load_handles,
)

# (name, floor, max handles per chunk). Descending floors: each tier sweeps the
# whole handle set again at a lower bar, so a post missed by a full tier-1 chunk
# still has tier-2/3 to catch it.
#
# WIDTH IS A CEILING, NOT A TARGET. With --history the greedy packer isolates any
# handle dense enough to eat the budget and batches the sparse rest, so every tier
# can use the full width. An earlier version hardcoded width=1 for the tail tier
# "because loud accounts are dense at min_faves:100" — that produced 143 solo
# calls on a 143-handle feed (199 total), punishing the sparse majority for the
# density of a few. The packer already handles density; let it.
DEFAULT_TIERS = [
    ("top",    20000, MAX_HANDLES_PER_CALL),   # sparse everywhere
    ("strong",  1000, MAX_HANDLES_PER_CALL),
    ("tail",     100, MAX_HANDLES_PER_CALL),   # packer isolates the dense handles
]

# Fraction of the row cap a chunk may be packed to. Measured 2026-07-25: a chunk
# packed to 9/10 returned 7 rows, ALL from its densest handle, starving the other
# three and losing 5 of 9 known posts. History is a point estimate taken before
# the run, and engagement only grows, so "just fits" reliably overflows. 0.5
# leaves room for that drift; it costs more calls but the alternative is silent
# loss, which is the exact failure this whole design exists to prevent.
PACK_SAFETY = 0.5


def measure_history(path, tiers):
    """Per-handle counts of posts clearing each tier floor, from a paid snapshot.

    Retweet rows are excluded: they always carry like_count 0, so they can never
    clear a floor and counting them would understate a handle's density.
    """
    with open(path) as f:
        d = json.load(f)
    tweets = d.get("tweets") or d.get("data") or []
    users = {u.get("id"): (u.get("username") or "").lower()
             for u in (d.get("users") or []) if isinstance(u, dict)}
    counts = {name: Counter() for name, _, _ in tiers}
    for t in tweets:
        if (t.get("text") or "").startswith("RT @"):
            continue
        h = users.get(t.get("author_id"))
        if not h:
            continue
        likes = (t.get("public_metrics") or {}).get("like_count", 0) or 0
        for name, floor, _ in tiers:
            if likes >= floor:
                counts[name][h] += 1
    return counts


def plan_tier(handles, floor, max_chunk, since, until, hist=None,
              cap=DEFAULT_TRUNCATION_CAP):
    """Chunk one tier so each chunk's EXPECTED qualifying rows stay under `cap`.

    With history: greedily pack handles while the running sum of measured
    qualifying posts stays below the cap, and force a handle that alone meets or
    exceeds the cap into its own call (it would starve any neighbour).

    Without history: fall back to a fixed chunk size — correct but call-hungrier.
    """
    names = [str(h).strip().lstrip("@") for h in handles if str(h).strip()]
    width = max(1, min(int(max_chunk), MAX_HANDLES_PER_CALL))

    if hist is None:
        chunks = chunk_handles(names, chunk_size=width)
        return [{"handles": c, "expected": None, "solo_reason": None} for c in chunks]

    budget = max(1, int(cap * PACK_SAFETY))

    # A handle over the BUDGET (not merely over the cap) must also go solo — it
    # cannot share a call without pushing that call past the safety margin. The
    # real starvation case had a handle at 7 of a 10-cap: below the cap, so the
    # old rule batched it, but well over the 5-row budget, so it ate the chunk.
    dense = [h for h in names if hist.get(h.lower(), 0) > budget]
    rest = [h for h in names if hist.get(h.lower(), 0) <= budget]
    # Densest first: a greedy pack fills early chunks and leaves the sparse tail
    # to batch together, which minimises the number of calls.
    rest.sort(key=lambda h: -hist.get(h.lower(), 0))

    out = []
    for h in dense:
        n = hist.get(h.lower(), 0)
        why = (f"alone yields >= cap ({n} >= {cap})" if n >= cap
               else f"alone exceeds the pack budget ({n} > {budget})")
        out.append({"handles": [h], "expected": n, "solo_reason": why})

    cur, tot = [], 0
    for h in rest:
        n = hist.get(h.lower(), 0)
        if cur and (len(cur) >= width or tot + n > budget):
            out.append({"handles": cur, "expected": tot, "solo_reason": None})
            cur, tot = [], 0
        cur.append(h)
        tot += n
    if cur:
        out.append({"handles": cur, "expected": tot, "solo_reason": None})

    # A handle with zero measured qualifying posts still gets swept — history is a
    # prior, not a filter, and a quiet account can have a loud day.
    return out


def build_plan(handles, since, until, tiers=DEFAULT_TIERS, history=None,
               cap=DEFAULT_TRUNCATION_CAP):
    hist = measure_history(history, tiers) if history else None
    plan, call_no = [], 0
    for name, floor, width in tiers:
        h = hist[name] if hist else None
        for chunk in plan_tier(handles, floor, width, since, until, hist=h, cap=cap):
            call_no += 1
            plan.append({
                "call": call_no,
                "tier": name,
                "min_faves": floor,
                "handles": chunk["handles"],
                "history_rows": chunk["expected"],   # capacity from the HISTORY window, NOT a forecast
                "solo_reason": chunk["solo_reason"],
                "query": build_query(chunk["handles"], since, until, min_faves=floor),
            })
    return plan


def cost_floor(history, tiers=DEFAULT_TIERS, cap=DEFAULT_TRUNCATION_CAP,
               n_handles=None, max_width=MAX_HANDLES_PER_CALL):
    """Irreducible call count per tier. TWO independent lower bounds apply:

        rows term:    qualifying_posts / cap        (a call returns <= cap rows)
        handles term: n_handles / max_width         (a call names <= 10 handles)

    The true floor is max() of the two, and the handles term dominates at high
    floors: only 12 of 143 handles ever clear min_faves:20000, but every handle
    must still be NAMED once (history is a prior, not a filter — a quiet account
    can have a loud day), so ~15 calls are unavoidable no matter how few posts
    qualify. Reporting only the rows term under-states the cost and makes an
    essentially optimal plan look 5x wasteful.
    """
    counts = measure_history(history, tiers)
    out = {}
    for name, floor, _ in tiers:
        posts = sum(counts[name].values())
        rows_term = -(-posts // cap) if posts else 0
        handles_term = -(-int(n_handles) // max_width) if n_handles else 0
        out[name] = {
            "min_faves": floor,
            "qualifying_posts": posts,
            "rows_term": rows_term,
            "handles_term": handles_term,
            "min_calls": max(rows_term, handles_term),
            "handles_with_any": len(counts[name]),
        }
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--handles-file")
    ap.add_argument("--handle", action="append", default=[])
    ap.add_argument("--since", help="ISO8601 window start (required unless --selftest)")
    ap.add_argument("--until", help="ISO8601 window end (required unless --selftest)")
    ap.add_argument("--history", help="paid timeline snapshot for calibration")
    ap.add_argument("--cap", type=int, default=DEFAULT_TRUNCATION_CAP)
    ap.add_argument("--tiers", default=None,
                    help="comma-separated floors, e.g. '20000,1000' to skip the "
                         "expensive tail tier. Default: 20000,1000,100")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--queries-only", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)

    if a.selftest:
        return _selftest()

    if not a.since or not a.until:
        ap.error("--since and --until are required")

    if a.tiers:
        try:
            floors = sorted({int(x) for x in a.tiers.split(",") if x.strip()},
                            reverse=True)
        except ValueError:
            ap.error("--tiers must be comma-separated integers")
        if not floors:
            ap.error("--tiers produced no floors")
        # Names stay stable for the common floors so output is comparable across runs.
        known = {f: n for n, f, _ in DEFAULT_TIERS}
        tiers = [(known.get(f, f"f{f}"), f, MAX_HANDLES_PER_CALL) for f in floors]
    else:
        tiers = DEFAULT_TIERS

    handles = list(a.handle)
    if a.handles_file:
        handles += load_handles(a.handles_file)
    if not handles:
        print("no handles given", file=sys.stderr)
        return 2

    plan = build_plan(handles, a.since, a.until, tiers=tiers, history=a.history, cap=a.cap)

    if a.json:
        print(json.dumps({"calls": len(plan), "plan": plan}, indent=2))
        return 0
    if a.queries_only:
        for p in plan:
            print(p["query"])
            print("-" * 70)
        return 0

    by_tier = Counter(p["tier"] for p in plan)
    print("=" * 72)
    print(f"TIERED SWEEP PLAN — {len(set(h.lower() for h in handles))} handles "
          f"-> {len(plan)} calls")
    print("=" * 72)

    if a.history:
        nh = len(set(h.lower().lstrip("@") for h in handles))
        cf = cost_floor(a.history, tiers=tiers, cap=a.cap, n_handles=nh)
        print("\nCOST FLOOR (arithmetic — chunking cannot beat this):")
        print(f"  {'tier':<8} {'min_faves':>10} {'posts':>7} {'rows':>6} {'names':>6}"
              f" {'floor':>6} {'planned':>8}")
        for name, floor, _ in tiers:
            c = cf[name]
            print(f"  {name:<8} {c['min_faves']:>10} {c['qualifying_posts']:>7} "
                  f"{c['rows_term']:>6} {c['handles_term']:>6} "
                  f"{c['min_calls']:>6} {by_tier[name]:>8}")
        print(f"\n  Two independent bounds: a call returns <= {a.cap} ROWS and names <= "
              f"{MAX_HANDLES_PER_CALL} handles,")
        print(f"  so each tier costs >= max(posts/{a.cap}, handles/{MAX_HANDLES_PER_CALL}).")
        print("  At high floors the NAMES term dominates (few posts qualify, but every")
        print("  handle must still be swept). The lever on cost is the FLOOR — drop a")
        print("  tier with --tiers to trade tail coverage for calls.")

    if not a.history:
        print("\n⚠️  No --history given: falling back to fixed chunk widths. The plan is")
        print("    correct but call-hungrier, and expected-row counts are unknown.")
    else:
        print("\n📎 `hist:N` is CAPACITY measured on the --history snapshot's window —")
        print("   NOT a forecast for this window. A handle that cleared a floor on a")
        print("   busy day may clear nothing today; that is the prior working, not a")
        print("   failed sweep. Lower tiers exist to catch exactly that case.")
    for name, floor, _ in tiers:
        print(f"\n── tier {name}  (min_faves:{floor})  {by_tier[name]} calls")
        for p in [x for x in plan if x["tier"] == name][:6]:
            exp = "" if p["history_rows"] is None else f"  hist:{p['history_rows']}"
            solo = f"   [{p['solo_reason']}]" if p["solo_reason"] else ""
            print(f"   #{p['call']:>3}  {len(p['handles'])}h{exp}{solo}")
            print(f"        {', '.join('@'+h for h in p['handles'][:6])}"
                  f"{' …' if len(p['handles']) > 6 else ''}")
        if by_tier[name] > 6:
            print(f"   … {by_tier[name] - 6} more")
    print("\n" + "-" * 72)
    print("Issue ONE x_search call per entry (handles -> allowed_x_handles, query as-is),")
    print("save each raw response, then feed them ALL to xsearch_gather.py --from-response.")
    print("The gather step owns every guard; this planner only decides the call shape.")
    return 0


def _selftest():
    def check(c, label):
        print(("  ok   " if c else "  FAIL ") + label)
        if not c:
            raise SystemExit(1)

    since, until = "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z"

    # a handle that alone meets the cap must be isolated, or it starves neighbours
    hist = {"loud": 40, "quiet1": 1, "quiet2": 1}
    got = plan_tier(["loud", "quiet1", "quiet2"], 100, 5, since, until,
                    hist=hist, cap=10)
    solo = [c for c in got if c["handles"] == ["loud"]]
    check(len(solo) == 1 and solo[0]["solo_reason"], "dense handle forced solo")
    check(any(set(c["handles"]) == {"quiet1", "quiet2"} for c in got),
          "sparse handles batched together")

    # a chunk must never be planned to exceed the SAFETY BUDGET (not just the cap)
    hist2 = {f"h{i}": 4 for i in range(6)}
    got2 = plan_tier([f"h{i}" for i in range(6)], 100, 10, since, until,
                     hist=hist2, cap=10)
    budget = max(1, int(10 * PACK_SAFETY))
    check(all((c["expected"] or 0) <= budget for c in got2),
          f"no chunk exceeds the safety budget ({budget} of cap 10)")

    # REGRESSION (the real 2026-07-25 starvation): 4 handles summing to 9 must NOT
    # be packed into one chunk at cap 10 — that call returned 7 rows all from the
    # densest handle and lost 5 of 9 known posts.
    starve = {"endwokeness": 7, "spacex": 2, "wallstreetmav": 1, "nicksortor": 2}
    got_s = plan_tier(list(starve), 20000, 10, since, until, hist=starve, cap=10)
    check(len(got_s) > 1, "the 9-of-10 starvation chunk is split, not packed as one")
    check(any(c["handles"] == ["endwokeness"] for c in got_s),
          "the handle that ate the budget (7) is isolated")
    # Only MULTI-handle chunks can respect the budget: a solo handle over budget is
    # already the mitigation (it cannot starve anyone but itself), so exempt it.
    shared = [c for c in got_s if len(c["handles"]) > 1]
    check(shared and all((c["expected"] or 0) <= budget for c in shared),
          "every shared chunk respects the safety budget")

    # every handle is swept in every tier — history is a prior, never a filter
    plan = build_plan(["a", "b", "c"], since, until)
    for name, _, _ in DEFAULT_TIERS:
        covered = {h for p in plan if p["tier"] == name for h in p["handles"]}
        check(covered == {"a", "b", "c"}, f"tier {name} covers every handle")

    # zero-history handles are still swept
    got3 = plan_tier(["never_posted"], 100, 5, since, until, hist={}, cap=10)
    check(sum(len(c["handles"]) for c in got3) == 1, "unmeasured handle still swept")

    # queries must carry operator syntax + the floor
    check("min_faves:20000" in plan[0]["query"] and "from:a" in plan[0]["query"],
          "query uses operator syntax with the tier floor")

    # tiers must descend, else a lower tier could never add anything
    floors = [f for _, f, _ in DEFAULT_TIERS]
    check(floors == sorted(floors, reverse=True), "tier floors strictly descend")

    # cost floor must take the MAX of both bounds, not just the rows term
    import tempfile
    snap = {"tweets": [{"author_id": "1", "text": "hi",
                        "public_metrics": {"like_count": 50000}}],
            "users": [{"id": "1", "username": "loud"}]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(snap, fh)
        path = fh.name
    try:
        # 1 qualifying post -> rows term 1; 143 handles -> names term 15. Floor is 15.
        cf = cost_floor(path, cap=10, n_handles=143)["top"]
        check(cf["rows_term"] == 1, f"rows term ({cf['rows_term']}) counts posts/cap")
        check(cf["handles_term"] == 15,
              f"names term ({cf['handles_term']}) counts handles/width")
        check(cf["min_calls"] == 15, "floor takes the MAX of both bounds")
        # with no handle count the names term must not silently inflate the floor
        cf0 = cost_floor(path, cap=10)["top"]
        check(cf0["min_calls"] == 1, "floor falls back to rows term without n_handles")
    finally:
        os.unlink(path)

    print("xsearch_tiered_plan selftest: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
