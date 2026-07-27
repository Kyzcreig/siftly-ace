#!/usr/bin/env python3
"""xfeed_xsearch_gather.py — ONE-CALL-PER-HANDLE parallel x_search gather for x-feed.

WHY ONE CALL PER HANDLE (measured 2026-07-27, do not "optimize" this back)
--------------------------------------------------------------------------
x-feed is a COMPLETENESS read over a ~220-handle follow graph and the top post IS
the product. Every batched shape was measured against the paid corpus on the same
day/window, and batching fails in BOTH directions:

    10 handles, one call @min_faves:15000  ->  56% recall
    10 handles, one call @min_faves:5000   ->  22% recall  (WORSE)
     narrow chunks, run in parallel        -> 100% recall  (12/12, zero misses)

The cap is ~10 rows PER CALL and it is NOT "the top 10 matching posts" — it is a
relevance/recency mix. So:
  * floor too HIGH -> posts near the floor drop unpredictably (a 15,341-like post
    vanished at a 15,000 floor in two separate calls, but returned solo)
  * floor too LOW  -> the cap fills with recent low-engagement posts and EVICTS
    the headliners (the day's #1 at 67k likes was dropped this way)

One call per handle gives each handle its OWN 10-row budget. There is no chunk to
dilute, no eviction, no floor tuning, and no solo-list to maintain. It is the only
shape with no failure mode — which also means no ongoing calibration work.

WHY THAT IS AFFORDABLE
----------------------
Concurrency is nearly free: 5 parallel calls took 82s wall-clock, 10 took 77s.
The cost of narrow chunks is calls, and calls parallelize; the cost of wide chunks
is silent data loss, which does not. Fan-out width is measured, not guessed — see
scripts/measure_xsearch_concurrency.py and --max-workers below.

SAFETY
------
Guards are NOT reimplemented here. Raw responses are piped through the same
xsearch_gather adapter morning-digest uses, so citation-union, tweet_text shape,
flat likes/retweets, id coercion, window re-filter, truncation tripwire and the
credential check all apply identically to both briefs.

Usage:
    xfeed_xsearch_gather.py --since S --until U [--max-workers N] --out FILE
    xfeed_xsearch_gather.py --selftest
"""
from __future__ import annotations
import argparse, concurrent.futures as cf, json, os, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from xsearch_gather import (  # noqa: E402
    build_query, call_x_search, load_handles, adapt_chunk, merge_stats,
    REQUIRED_CREDENTIAL_SOURCE,
)

FOLLOWS = os.path.expanduser("~/.hermes/digest/xfeed-follows.txt")
DEFAULT_WORKERS = 20
DEFAULT_MIN_FAVES = 100
ROW_CAP = 10          # the per-call budget; hitting it exactly means truncation


def _rows_from(resp):
    """Extract the model's JSON array, tolerating prose/fences around it."""
    ans = resp.get("answer") or ""
    i, j = ans.find("["), ans.rfind("]")
    if i < 0 or j <= i:
        return []
    try:
        rows = json.loads(ans[i:j + 1])
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _is_rate_limited(resp) -> bool:
    """True when the failure is xAI's concurrency throttle rather than a real error.

    MEASURED 2026-07-27: at 50 concurrent calls xAI returns
    `resource-exhausted: Too many requests for team <id>` for the overflow. This
    matters because it is the GOOD failure mode — it is loud, and the calls that
    DID land kept full recall (the control handle returned its full 10 rows at
    every width tested). So a throttled call is retryable, not lost data; what we
    must never do is let it fall through as "this handle had no posts", which is
    indistinguishable from a quiet day and would silently shrink the brief.
    """
    blob = f"{resp.get('error') or ''} {resp.get('degraded_reason') or ''}".lower()
    return ("resource-exhausted" in blob or "too many requests" in blob
            or "rate limit" in blob or "429" in blob)


def widen_to_day_bounds(since, until):
    """Widen a precise window to the CALENDAR-DAY span that actually covers it.

    ⚠️ NON-OBVIOUS AND LOAD-BEARING (measured 2026-07-27). grok's since:/until:
    operators are DAY-GRANULAR and the upper bound behaves EXCLUSIVELY, so you
    cannot express a rolling 24h window directly:

        want 2026-07-26T11:00Z .. 2026-07-27T11:00Z
        query until:2026-07-27  -> silently returns NOTHING from 07-27
                                   (measured: lost @elonmusk 17,099 + 10,335,
                                    @TRHLofficial 8,562 — head recall 15/15 -> 11/15)
        query until:2026-07-28  -> covers both days, correct

    So the ONLY correct way to get a 24h window out of this API is: query the
    widened calendar-day span, then let the adapter's local timestamp filter trim
    to the true window. Querying "48h" is therefore not sloppiness — it is what a
    24h brief actually requires. The extra rows cost nothing; they are filtered
    locally (report.adapter_stats.rows_after_window_filter shows the trim).
    """
    import datetime as dt
    s = dt.datetime.fromisoformat(since.replace("Z", "+00:00"))
    u = dt.datetime.fromisoformat(until.replace("Z", "+00:00"))
    s_day = s.replace(hour=0, minute=0, second=0, microsecond=0)
    # +1 day because the upper bound excludes its own date.
    u_day = u.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)
    return s_day.strftime("%Y-%m-%dT%H:%M:%SZ"), u_day.strftime("%Y-%m-%dT%H:%M:%SZ")


def _split_window(since, until, parts):
    """Split [since, until) into `parts` contiguous sub-windows (ISO8601 Z).

    ⚠️ ONLY USEFUL AT DAY GRANULARITY. Measured 2026-07-27: grok IGNORES
    intra-day since:/until: times — a `since:2026-07-26T12:00:00Z
    until:2026-07-26T18:00:00Z` query for @RoyalSerf returned [] + degraded,
    while the paid corpus proves he posted at 16:07 and 17:05 inside it. So
    splitting a 48h window into 4x12h slices produces empty calls, not finer
    coverage. Splitting into whole DAYS works because the date operators are
    honoured. The escalation ladder below is the real lever for dense handles.
    """
    import datetime as dt
    s = dt.datetime.fromisoformat(since.replace("Z", "+00:00"))
    u = dt.datetime.fromisoformat(until.replace("Z", "+00:00"))
    step = (u - s) / parts
    out = []
    for i in range(parts):
        a = s + step * i
        b = s + step * (i + 1) if i < parts - 1 else u
        out.append((a.strftime("%Y-%m-%dT%H:%M:%SZ"), b.strftime("%Y-%m-%dT%H:%M:%SZ")))
    return out


# Escalation ladder for handles that come back capped. MEASURED on @RoyalSerf
# (29 real posts >=100 likes, pinned at exactly 10 through two window-split
# passes):
#     min_faves:100  -> 10 rows, MISSED his #1 (12,838 likes) and #2 (9,355)
#     min_faves:1000 -> 10 rows, BOTH recovered
#     min_faves:5000 ->  3 rows, both present
# Each floor surfaces a DIFFERENT slice of the same handle: a low floor buys
# breadth (recent, smaller posts) while a high floor guarantees the headliners
# cannot be evicted by the recency-weighted cap. Union is strictly additive, so
# escalating can only add coverage.
FLOOR_LADDER = (1000, 5000, 20000)


def gather_parallel(handles, since, until, min_faves=DEFAULT_MIN_FAVES,
                    max_workers=DEFAULT_WORKERS, progress=None, retries=3,
                    split_truncated=True, split_days=True, max_splits=4):
    """One x_search call per handle, fanned out max_workers at a time.

    Returns (candidates, report). Never raises for a single handle's failure — a
    dead handle must not abort a 220-handle sweep — but every failure is COUNTED
    and named in the report so a partial sweep can never masquerade as a clean one.

    Rate-limited handles are retried with backoff (see _is_rate_limited); only a
    handle that exhausts its retries is recorded as failed.
    """
    handles = [str(h).strip().lstrip("@") for h in handles if str(h).strip()]
    # QUERY wide (calendar-day bounds — the API is day-granular), FILTER narrow
    # (the adapter trims to the caller's true window). Doing this here means a
    # caller can always pass the precise window it actually wants.
    q_since, q_until = widen_to_day_bounds(since, until)
    lock = threading.Lock()
    state = {"done": 0}
    results = {}
    throttled_total = 0
    split_passes = 0

    def work(job):
        handle, w_since, w_until, floor = job
        q = build_query([handle], w_since, w_until, floor)
        resp = call_x_search(q, [handle], w_since, w_until, timeout=300)
        with lock:
            state["done"] += 1
            if progress and state["done"] % progress == 0:
                print(f"  … {state['done']} calls", file=sys.stderr)
        return job, resp

    def run_wave(jobs, width):
        """Issue `jobs` at `width` concurrency, retrying throttled ones narrower."""
        nonlocal throttled_total
        out, pending = [], list(jobs)
        for attempt in range(retries + 1):
            if not pending:
                break
            if attempt:
                # Back off AND narrow the fan-out: retrying a throttle at the same
                # width just reproduces it. Halve workers each round, floor of 4.
                wait = 5 * attempt
                w = max(4, width // (2 ** attempt))
                print(f"  retry {attempt}: {len(pending)} throttled, "
                      f"waiting {wait}s then {w} at a time", file=sys.stderr)
                time.sleep(wait)
            else:
                w = width
            with cf.ThreadPoolExecutor(max_workers=w) as ex:
                batch = list(ex.map(work, pending))
            nxt = []
            for job, resp in batch:
                if not resp.get("success") and _is_rate_limited(resp) and attempt < retries:
                    nxt.append(job)
                    continue
                out.append((job, resp))
            throttled_total += len(nxt)
            pending = nxt
        for job in pending:   # exhausted retries — record as a real failure
            out.append((job, {"success": False, "error": "rate-limited after retries"}))
        return out

    t0 = time.time()
    responses = run_wave([(h, q_since, q_until, min_faves) for h in handles], max_workers)

    # ESCALATION LADDER — the fix for dense handles, replacing time-slicing.
    # A handle returning exactly the cap was truncated. Re-query it at a HIGHER
    # floor: that surfaces a different slice (the headliners the recency-weighted
    # cap evicted at the low floor) instead of the same top-10 over and over.
    # Measured on @RoyalSerf: floor 100 -> 10 rows missing his #1 (12,838 likes)
    # and #2 (9,355); floor 1000 -> both recovered. Window-splitting could NOT fix
    # him because grok ignores intra-day times (see _split_window).
    # Union + id-dedupe keeps every pass strictly additive.
    if split_truncated:
        for floor in FLOOR_LADDER:
            if floor <= min_faves:
                continue
            hot = sorted({job[0] for job, r in responses
                          if r.get("success") and len(_rows_from(r)) >= ROW_CAP})
            if not hot:
                break
            jobs = [(h, q_since, q_until, floor) for h in hot]
            print(f"  escalate: {len(hot)} capped handle(s) → re-query at "
                  f"min_faves:{floor}", file=sys.stderr)
            responses = responses + run_wave(jobs, max_workers)
            split_passes += 1

        # DAY-SPLIT PASS — complements the ladder rather than replacing it.
        # The two levers recover DIFFERENT posts and neither alone is enough
        # (measured on 30 handles vs the paid corpus, paid top-30):
        #     day-split only  -> 24/30      ladder only -> 29/30
        #     BOTH (union)    -> 30/30, and head-15 goes 14/15 -> 15/15
        # The last ladder-only miss was an @elonmusk post that only a per-day
        # query surfaces. Day granularity ONLY — grok ignores intra-day times.
        if split_days:
            import datetime as _dt
            s = _dt.datetime.fromisoformat(q_since.replace("Z", "+00:00"))
            u = _dt.datetime.fromisoformat(q_until.replace("Z", "+00:00"))
            n_days = max(1, round((u - s).total_seconds() / 86400))
            hot = sorted({job[0] for job, r in responses
                          if r.get("success") and len(_rows_from(r)) >= ROW_CAP})
            if hot and n_days > 1:
                jobs = [(h, a, b, min_faves) for h in hot
                        for a, b in _split_window(q_since, q_until, n_days)]
                print(f"  day-split: {len(hot)} capped handle(s) → {len(jobs)} calls "
                      f"over {n_days} day(s)", file=sys.stderr)
                responses = responses + run_wave(jobs, max_workers)
                split_passes += 1
    wall = time.time() - t0

    results = responses

    candidates, per_handle, truncated, failed, degraded, creds = [], {}, [], [], [], set()
    all_stats, seen_ids = [], set()
    # `responses` is a LIST of (job, resp) — a handle can appear MORE THAN ONCE
    # after window-splitting, so accumulate per handle rather than assigning.
    for (handle, w_since, w_until, _floor), resp in responses:
        per_handle.setdefault(handle, 0)
        if not resp.get("success"):
            failed.append(f"{handle}[{w_since[:13]}]: {(resp.get('error') or 'unknown')[:70]}")
            continue
        src = resp.get("credential_source")
        if src:
            creds.add(src)
        if resp.get("degraded"):
            degraded.append(handle)
        # adapt_chunk owns EVERY guard (citation union, tweet_text shape, flat
        # likes/retweets, id coercion, window re-filter, likes floor, tripwire).
        # Do not reshape rows here — reimplementing any of it is how the silent
        # failure classes come back.
        # NOTE: filter against the ORIGINAL OUTER window, not the sub-window that
        # was queried. grok returns posts outside a narrow slice, and those rows are
        # legitimate data for the sweep — discarding them because they fell outside
        # a slice WE invented dropped 50 of 207 rows in the measured replace-variant.
        cands, stats = adapt_chunk(resp, [handle], since, until, min_faves=min_faves)
        all_stats.append(stats)
        # Still capped after the final split pass = genuinely more data than we can
        # reach; report it rather than pretend the sweep was complete.
        if len(_rows_from(resp)) >= ROW_CAP:
            truncated.append(handle)
        for cand in cands:
            cid = cand.get("id") or cand.get("tweet_id")
            if cid and cid in seen_ids:
                continue      # sub-windows can overlap at the boundary
            if cid:
                seen_ids.add(cid)
            candidates.append(cand)
            per_handle[handle] += 1

    alerts = []
    if not candidates:
        alerts.append("EMPTY POOL: every handle returned zero rows in-window. "
                      "Do NOT touch the PT-day lock — retry must stay possible.")
    if creds and creds != {REQUIRED_CREDENTIAL_SOURCE}:
        alerts.append(f"CREDENTIAL FALLBACK: {sorted(creds)} (expected "
                      f"{REQUIRED_CREDENTIAL_SOURCE}) — possible SILENT METERED BILLING.")
    # A handful of failures is survivable; a large fraction means the sweep is not
    # a completeness read any more and the brief must not pretend otherwise.
    if failed and len(failed) > max(3, len(handles) // 10):
        alerts.append(f"{len(failed)}/{len(handles)} handle calls FAILED — "
                      f"coverage is NOT complete this run.")
    # A degraded chunk normally just means "this handle had no in-window posts above
    # the floor" (benign, and expected on a 220-handle sweep). Only flag it when it
    # is universal. Count DISTINCT handles, not responses: after window-splitting one
    # handle contributes many responses, so a response-level count trivially exceeds
    # the handle count and fired this alert on a healthy sweep (measured 2026-07-27).
    if degraded and len({h for h in degraded}) >= len(per_handle) and per_handle:
        alerts.append("EVERY handle reported degraded — treat the sweep as suspect.")

    report = {
        "x_search_calls": len(responses),
        "handles_swept": len(handles),
        "split_passes": split_passes,
        "handles_ok": len([h for h,n in per_handle.items() if n>=0]) - 0,
        "chunks_failed": len(failed),
        "candidates_emitted": len(candidates),
        "wall_seconds": round(wall, 1),
        "max_workers": max_workers,
        "throttled_retries": throttled_total,
        "min_faves": min_faves,
        "credential_sources": sorted(creds),
        "truncated_handles": sorted(set(truncated)),
        "degraded_handles_n": len(degraded),
        "failures": failed[:10],
        "alerts": alerts,
        "per_handle": per_handle,
        # The adapter's own per-stage drop counts, merged across all handles.
        # These are what prove a collapse happened at a SPECIFIC guard (e.g.
        # rows_uncited, dropped_out_of_window) rather than "the day was quiet".
        "adapter_stats": merge_stats(all_stats) if all_stats else {},
    }
    return candidates, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--handles-file", default=FOLLOWS)
    ap.add_argument("--min-faves", type=int, default=DEFAULT_MIN_FAVES)
    ap.add_argument("--max-workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--limit", type=int, help="only the first N handles (smoke tests)")
    ap.add_argument("--out")
    ap.add_argument("--report")
    ap.add_argument("--progress", type=int, default=25)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return _selftest()
    if not (a.since and a.until):
        ap.error("--since and --until are required")

    handles = load_handles(a.handles_file)
    if a.limit:
        handles = handles[:a.limit]
    if not handles:
        print(f"no handles in {a.handles_file}", file=sys.stderr)
        return 2

    print(f"sweeping {len(handles)} handles, {a.max_workers} at a time, "
          f"min_faves:{a.min_faves}", file=sys.stderr)
    cands, rep = gather_parallel(handles, a.since, a.until,
                                 min_faves=a.min_faves, max_workers=a.max_workers,
                                 progress=a.progress)

    payload = {"candidates": cands, "report": rep}
    text = json.dumps(payload, ensure_ascii=False)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text)
    else:
        print(text)
    if a.report:
        with open(a.report, "w") as fh:
            json.dump(rep, fh, ensure_ascii=False, indent=2)

    print(f"calls={rep['x_search_calls']} ok={rep['handles_ok']} "
          f"failed={rep['chunks_failed']} emitted={rep['candidates_emitted']} "
          f"wall={rep['wall_seconds']}s cred={rep['credential_sources']}", file=sys.stderr)
    if rep["truncated_handles"]:
        print(f"TRUNCATED (hit the {ROW_CAP}-row cap, may have more): "
              f"{rep['truncated_handles']}", file=sys.stderr)
    for al in rep["alerts"]:
        print(f"ALERT: {al}", file=sys.stderr)
    return 1 if rep["alerts"] else 0


def _selftest():
    fails = []

    def check(c, label):
        print(("  ok   " if c else "  FAIL ") + label)
        if not c:
            fails.append(label)

    # One handle per call => no parenthesised group, filters stated once.
    q = build_query(["levelsio"], "2026-07-26T00:00:00Z", "2026-07-28T00:00:00Z", 100)
    first = q.split("\n")[0]
    check(first.startswith("from:levelsio"), "single-handle query, no group")
    check("(" not in first, "no parens for a solo handle")
    check(first.count("min_faves:") == 1, "floor stated once")

    check(_rows_from({"answer": '[{"a":1},{"a":2}]'}) == [{"a": 1}, {"a": 2}], "row parse")
    check(_rows_from({"answer": 'here you go:\n```json\n[{"a":1}]\n```'}) == [{"a": 1}],
          "row parse through prose/fences")
    check(_rows_from({"answer": "[]"}) == [], "empty array")
    check(_rows_from({"answer": "not json"}) == [], "garbage -> empty, no raise")

    check(ROW_CAP == 10, "row cap matches the measured per-call budget")

    # The escalation ladder must ASCEND — each rung has to surface a slice the
    # previous one couldn't, and a descending/flat rung would just re-fetch the
    # same evicted top-10 (the exact failure that pinned @RoyalSerf at 10 rows).
    check(list(FLOOR_LADDER) == sorted(FLOOR_LADDER), "floor ladder ascends")
    check(FLOOR_LADDER[0] > DEFAULT_MIN_FAVES, "ladder starts above the base floor")
    check(len(FLOOR_LADDER) >= 3, "ladder has enough rungs for a very dense handle")

    # Window splitting is retained but must NOT be used intra-day (grok ignores
    # times); this asserts the helper is still correct where it IS valid.
    w = _split_window("2026-07-26T00:00:00Z", "2026-07-28T00:00:00Z", 2)
    check(len(w) == 2 and w[0][1] == "2026-07-27T00:00:00Z", "day-granular split is clean")
    check(all(w[i][1] == w[i + 1][0] for i in range(len(w) - 1)), "no gaps between days")

    # DAY-GRANULAR BOUNDS — the trap that cost head recall 15/15 -> 11/15.
    # A rolling 24h window MUST be widened to calendar days before querying, or
    # the exclusive day-granular upper bound silently drops the newest day.
    qs, qu = widen_to_day_bounds("2026-07-26T11:00:00Z", "2026-07-27T11:00:00Z")
    check(qs == "2026-07-26T00:00:00Z", "widen: start floors to its day")
    check(qu == "2026-07-28T00:00:00Z", "widen: end goes to day AFTER (exclusive bound)")
    check(qu > "2026-07-27T00:00:00Z", "widen: the newest day is INSIDE the query span")
    qs2, qu2 = widen_to_day_bounds("2026-07-26T00:00:00Z", "2026-07-28T00:00:00Z")
    check((qs2, qu2) == ("2026-07-26T00:00:00Z", "2026-07-29T00:00:00Z"),
          "widen is safe (never narrows) on an already-day-aligned window")

    check(_is_rate_limited({"error": "resource-exhausted: Too many requests for team x"}),
          "detects the measured xAI throttle string")
    check(_is_rate_limited({"error": "HTTP 429"}), "detects 429")
    check(not _is_rate_limited({"error": "handle not found"}),
          "a real error is NOT treated as retryable throttle")

    check(os.path.exists(FOLLOWS), f"follows file exists: {FOLLOWS}")
    n = len(load_handles(FOLLOWS))
    check(n > 50, f"follows file has a real graph ({n} handles)")

    print("xfeed_xsearch_gather selftest: " + ("PASS" if not fails else f"FAIL {fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
