#!/usr/bin/env python3
"""Measure REAL concurrency limits for x_search before choosing a fan-out width.

Ace asked: "should we do 100 parallel calls? or as many calls as we have handles?"
That is an empirical question with three failure modes I must rule out, because
each one fails DIFFERENTLY and only one of them is loud:

  1. RATE LIMIT   -> loud (429 / error field). Recoverable with backoff.
  2. QUEUEING     -> silent. Calls succeed but wall-clock grows linearly, so
                     200-wide is no faster than 20-wide and we've gained nothing.
  3. DEGRADATION  -> SILENTLY WRONG. Under load the service returns fewer/emptier
                     results rather than erroring. This is the dangerous one: it
                     looks like "those handles didn't post" and would reintroduce
                     exactly the silent-loss class we just spent a night killing.

So: ramp the width, and at every width measure BOTH latency AND recall against a
fixed control handle whose true answer we already know. If recall drops as width
rises, the ceiling is real regardless of what the latency curve says.
"""
import concurrent.futures as cf
import json, os, sys, time

sys.path.insert(0, os.path.expanduser("~/Projects/siftly-ace/scripts"))
from xsearch_gather import call_x_search, build_query  # noqa: E402

SINCE = "2026-07-26T00:00:00Z"
UNTIL = "2026-07-28T00:00:00Z"

# Control: a handle we KNOW posted in-window, so a drop in its row count under
# load is degradation, not a quiet day. Padding handles just create load.
CONTROL = "levelsio"          # measured 10 rows @min_faves:100 at width 10
PAD = ["elonmusk", "RepThomasMassie", "EndWokeness", "sama", "VigilantFox",
       "RoyalSerf", "nicksortor", "mtgreenee", "DavidSacks", "AutismCapital",
       "emollick", "karpathy", "ollama", "simonw", "swyx", "teknium1",
       "AnthropicAI", "OpenAI", "GoogleDeepMind", "sciencegirl"]


def one(handle):
    q = build_query([handle], SINCE, UNTIL, 100)
    t0 = time.time()
    r = call_x_search(q, [handle], SINCE, UNTIL, timeout=300)
    dt = time.time() - t0
    ok = bool(r.get("success"))
    n = 0
    if ok:
        try:
            ans = r.get("answer") or "[]"
            rows = json.loads(ans[ans.find("["):ans.rfind("]") + 1] or "[]")
            n = len(rows)
        except Exception:
            n = -1        # unparseable != empty; keep them distinguishable
    return {"handle": handle, "ok": ok, "rows": n, "secs": round(dt, 1),
            "err": (r.get("error") or "")[:60]}


def wave(width):
    handles = [CONTROL] + [PAD[i % len(PAD)] for i in range(width - 1)]
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=width) as ex:
        res = list(ex.map(one, handles))
    wall = time.time() - t0
    ctrl = res[0]
    okc = sum(1 for r in res if r["ok"])
    lat = sorted(r["secs"] for r in res)
    return {"width": width, "wall": round(wall, 1), "ok": f"{okc}/{width}",
            "control_rows": ctrl["rows"],
            "p50": lat[len(lat) // 2], "max": lat[-1],
            "errs": [r["err"] for r in res if r["err"]][:2]}


if __name__ == "__main__":
    widths = [int(x) for x in (sys.argv[1:] or ["5", "20", "50"])]
    print(f"control=@{CONTROL}  window={SINCE[:10]}..{UNTIL[:10]}  floor=100\n")
    print(f"{'width':>5} {'wall':>7} {'ok':>8} {'ctrl':>5} {'p50':>6} {'max':>6}  errors")
    base = None
    for w in widths:
        r = wave(w)
        if base is None:
            base = r["control_rows"]
        flag = ""
        if r["control_rows"] < base:
            flag = f"  <-- CONTROL RECALL DROPPED ({base} -> {r['control_rows']})"
        print(f"{r['width']:>5} {r['wall']:>6.1f}s {r['ok']:>8} {r['control_rows']:>5} "
              f"{r['p50']:>5.1f}s {r['max']:>5.1f}s  {';'.join(r['errs'])}{flag}")
        time.sleep(3)
