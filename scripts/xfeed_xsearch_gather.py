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


def _split_window(since, until, parts):
    """Split [since, until) into `parts` contiguous sub-windows (ISO8601 Z)."""
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


def gather_parallel(handles, since, until, min_faves=DEFAULT_MIN_FAVES,
                    max_workers=DEFAULT_WORKERS, progress=None, retries=3,
                    split_truncated=True, max_splits=4):
    """One x_search call per handle, fanned out max_workers at a time.

    Returns (candidates, report). Never raises for a single handle's failure — a
    dead handle must not abort a 220-handle sweep — but every failure is COUNTED
    and named in the report so a partial sweep can never masquerade as a clean one.

    Rate-limited handles are retried with backoff (see _is_rate_limited); only a
    handle that exhausts its retries is recorded as failed.
    """
    handles = [str(h).strip().lstrip("@") for h in handles if str(h).strip()]
    lock = threading.Lock()
    state = {"done": 0}
    results = {}
    throttled_total = 0
    split_passes = 0

    def work(job):
        handle, w_since, w_until = job
        q = build_query([handle], w_since, w_until, min_faves)
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
    responses = run_wave([(h, since, until) for h in handles], max_workers)

    # TRUNCATION RECURSION — the piece that turns 60% head recall into full coverage.
    # A handle returning exactly the cap was almost certainly cut off, so re-query
    # it over narrower sub-windows until it stops hitting the cap. This is the ONLY
    # way to get a dense handle's full output: the cap is per call, so more calls
    # over smaller windows is the only lever (a lower floor makes it worse — the cap
    # then fills with recency and evicts the headliners).
    if split_truncated:
        for parts in (2, 4):
            if parts > max_splits:
                break
            # Only handles STILL hitting the cap at the current granularity.
            hot = sorted({job[0] for job, r in responses
                          if r.get("success") and len(_rows_from(r)) >= ROW_CAP})
            if not hot:
                break
            jobs = [(h, a, b) for h in hot for a, b in _split_window(since, until, parts)]
            print(f"  split pass: {len(hot)} capped handle(s) → "
                  f"{len(jobs)} calls over {parts} sub-windows", file=sys.stderr)
            extra = run_wave(jobs, max_workers)
            # UNION, never replace. Two measured reasons (2026-07-27):
            #  1. grok's date arithmetic is unreliable — a 12h sub-window call
            #     returns posts from outside that slice, so the sub-windows do NOT
            #     collectively cover what the whole-window call returned.
            #  2. Replacing therefore LOSES rows: measured 55 lost / 34 gained,
            #     a net -21 candidates and recall 50% -> 45%.
            # Keeping both and deduping by id is strictly additive: extra calls can
            # only ever add coverage, never subtract it.
            responses = responses + extra
            split_passes += 1
    wall = time.time() - t0

    results = responses

    candidates, per_handle, truncated, failed, degraded, creds = [], {}, [], [], [], set()
    all_stats, seen_ids = [], set()
    # `responses` is a LIST of (job, resp) — a handle can appear MORE THAN ONCE
    # after window-splitting, so accumulate per handle rather than assigning.
    for (handle, w_since, w_until), resp in responses:
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

    # Window splitting: contiguous, no gaps, endpoints preserved. A gap here would
    # silently drop every post inside it — invisible in any output.
    w = _split_window("2026-07-26T00:00:00Z", "2026-07-28T00:00:00Z", 4)
    check(len(w) == 4, "split into 4 sub-windows")
    check(w[0][0] == "2026-07-26T00:00:00Z", "split preserves start")
    check(w[-1][1] == "2026-07-28T00:00:00Z", "split preserves end")
    check(all(w[i][1] == w[i + 1][0] for i in range(3)), "sub-windows are contiguous (no gaps)")
    check(w[0][1] == "2026-07-26T12:00:00Z", "48h/4 = 12h slices")

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
