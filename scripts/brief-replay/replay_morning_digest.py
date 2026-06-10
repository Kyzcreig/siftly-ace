#!/usr/bin/env python3
"""
replay_morning_digest.py — Offline replay / funnel inspector for morning-digest cron.

WHY: same rationale as replay_x_feed.py — reconstruct what a run did from disk
artifacts, no network, no re-post. Answers "why only N items?", "what got cut?",
"which source dominated?", "did personal-fit fire?".

ARTIFACTS (under ~/.hermes/state/cron/morning-digest/)
  _last_run_debug.json   every scored candidate + base/pf/final + source +
                         dropped_reason; plus `selected` and `also` lists and
                         an `x_failure_note`. THE gate instrument.
  _last_run_summary.json small posted-summary (top/also counts, per-source tallies).

NOTE: morning-digest's debug dump is written near the END of a run, so a run
that died early (e.g. the Jun-10 codex broken-pipe) leaves a STALE dump from the
previous successful run. Always cross-check `ts` against the run you're chasing —
a stale ts means that run produced no fresh dump (itself a signal the run failed
before scoring/dumping).

USAGE
  python3 scripts/brief-replay/replay_morning_digest.py
  python3 scripts/brief-replay/replay_morning_digest.py --file PATH --top 40
  python3 scripts/brief-replay/replay_morning_digest.py --json
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from collections import Counter

CRON_DIR = os.path.expanduser("~/.hermes/state/cron/morning-digest")
DEFAULT_DEBUG = os.path.join(CRON_DIR, "_last_run_debug.json")


def load_json(path):
    with open(path) as f:
        return json.load(f)


def build_funnel(debug: dict) -> dict:
    items = debug.get("all_scored", [])
    by_reason = Counter()
    by_source = Counter()
    for x in items:
        r = str(x.get("dropped_reason", "")) or "(none)"
        if r.startswith("topic_dup"):
            r = "topic_dup"
        by_reason[r] += 1
        by_source[x.get("source", "?")] += 1
    return {
        "total": len(items),
        "selected": len(debug.get("selected", [])),
        "also": len(debug.get("also", [])),
        "by_reason": dict(by_reason),
        "by_source": dict(by_source),
    }


def detect_anomalies(debug: dict) -> list[str]:
    flags = []
    items = debug.get("all_scored", [])
    selected = debug.get("selected", [])
    also = debug.get("also", [])

    # duplicate titles across selected+also (the x-feed dup-idea analogue)
    titles = [(i.get("title") or "").strip()[:80] for i in (selected + also) if i.get("title")]
    dups = [t for t, c in Counter(titles).items() if c > 1]
    if dups:
        flags.append(f"DUP_ITEM_TITLE: title(s) rendered >1x: {dups!r}")

    # x_failure_note set means the X source partially failed this run
    note = (debug.get("x_failure_note") or "").strip()
    if note:
        flags.append(f"X_SOURCE_NOTE: {note}")

    # everything scored 0 from a source => that source likely failed silently
    by_source_max = {}
    for x in items:
        s = x.get("source", "?")
        by_source_max[s] = max(by_source_max.get(s, 0), x.get("final_score", 0))
    dead = [s for s, m in by_source_max.items() if m == 0]
    if dead:
        flags.append(f"DEAD_SOURCE: source(s) with all-zero scores (possible silent fetch failure): {dead}")

    return flags


def render_report(debug: dict, funnel: dict, top_n: int) -> str:
    items = sorted(debug.get("all_scored", []), key=lambda z: -z.get("final_score", 0))
    out = []
    out.append("=" * 72)
    out.append(f"MORNING-DIGEST REPLAY  ·  run_id={debug.get('run_id','?')}  ·  ts={debug.get('ts','?')}")
    out.append("=" * 72)
    out.append(f"pf: {debug.get('pf_note','') or '(none)'}")
    out.append(f"selected={funnel['selected']}  also={funnel['also']}  scored={funnel['total']}")
    out.append("")
    out.append("BY SOURCE:")
    for s, n in sorted(funnel["by_source"].items(), key=lambda kv: -kv[1]):
        out.append(f"  {s:<14} {n:>4}")
    out.append("")
    out.append("BY dropped_reason:")
    for r, n in sorted(funnel["by_reason"].items(), key=lambda kv: -kv[1]):
        out.append(f"  {r:<16} {n:>4}")
    out.append("")
    flags = detect_anomalies(debug)
    if flags:
        out.append("⚠️  ANOMALIES:")
        for f in flags:
            out.append(f"  - {f}")
    else:
        out.append("✅ No anomalies detected.")
    out.append("")
    out.append(f"TOP {top_n} BY final_score:")
    out.append(f"  {'fin':>3} {'base':>4} {'pfΔ':>5}  {'src':<6} {'handle':<16} title")
    for x in items[:top_n]:
        out.append(
            f"  {x.get('final_score',0):>3} {x.get('base_score',0):>4} "
            f"{x.get('personal_fit_delta',0):>+5.1f}  {str(x.get('source','?')):<6} "
            f"@{(x.get('authorHandle') or '?'):<15} {(x.get('title') or '')[:42]}"
        )
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Offline replay/funnel inspector for morning-digest.")
    ap.add_argument("--file", default=DEFAULT_DEBUG)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.file):
        print(f"ERROR: debug dump not found: {args.file}", file=sys.stderr)
        return 2
    debug = load_json(args.file)
    funnel = build_funnel(debug)
    if args.json:
        print(json.dumps({"funnel": funnel, "anomalies": detect_anomalies(debug)}, indent=2))
    else:
        print(render_report(debug, funnel, args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
