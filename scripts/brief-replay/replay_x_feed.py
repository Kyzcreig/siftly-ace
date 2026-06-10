#!/usr/bin/env python3
"""
replay_x_feed.py — Offline replay / funnel inspector for the x-feed-brief cron.

WHY THIS EXISTS
---------------
The x-feed brief is a prompt-driven cron (gpt-5.5 interprets prompt.md). When a
run looks wrong ("1,809 scanned but only 3 posted?", "why did a video idea repeat?",
"did anything good get cut?"), we need to reconstruct what happened WITHOUT
re-pulling from the X API (costs credits) or re-posting to Discord.

This script reads the artifacts the brief writes to disk each run and rebuilds
the full selection funnel + flags anomalies. Zero network. Zero cost. Zero posts.

ARTIFACTS IT READS (all under ~/.hermes/state/cron/x-feed-brief/)
-----------------------------------------------------------------
  _last_run_scored.json    (Step 6.7) every candidate + base/pf/final score +
                           signals + dropped_reason. THE gate instrument.
  _last_run_rendered.json  (Step 6.8, newer runs) what was actually rendered in
                           the posted message + a mismatch{} block. Optional —
                           older runs predate it.
  cache/timeline-YYYY-MM-DD.json   raw candidate pool (the X timeline read),
                           used only to corroborate scanned counts.

USAGE
-----
  python3 scripts/brief-replay/replay_x_feed.py                 # latest dump
  python3 scripts/brief-replay/replay_x_feed.py --file PATH     # a specific dump
  python3 scripts/brief-replay/replay_x_feed.py --top 40        # show N top rows
  python3 scripts/brief-replay/replay_x_feed.py --gate-top 60 --gate-quick 50
                                                  # what-if: re-bucket at custom gates
  python3 scripts/brief-replay/replay_x_feed.py --json          # machine-readable

EXIT CODE: 0 always (this is an inspector, not a test). The unit tests in
scripts/brief-replay/test_replay.py assert the funnel math against a fixture.
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

CRON_DIR = os.path.expanduser("~/.hermes/state/cron/x-feed-brief")
DEFAULT_SCORED = os.path.join(CRON_DIR, "_last_run_scored.json")
DEFAULT_RENDERED = os.path.join(CRON_DIR, "_last_run_rendered.json")

# Production gates (mirror prompt.md Step 6). Kept here so the replay can show
# both "as-run" buckets (from dropped_reason) and "what-if" re-bucketing.
PROD_GATE_TOP = 60     # top-tweets gate (lowered from 77 on 2026-06-10)
PROD_GATE_QUICK = 50   # quick-hits floor (lowered from 73 on 2026-06-10)


def load_json(path):
    with open(path, "r") as f:
        return json.load(f)


def build_funnel(scored: dict, gate_top: int, gate_quick: int) -> dict:
    """Reconstruct the selection funnel from a scored dump.

    Returns a dict of counts + the per-bucket topic spreads. Pure function of
    the dump + the two gate thresholds, so it's directly unit-testable.
    """
    items = scored.get("all_scored", [])
    total = len(items)

    # As-RUN buckets come straight from dropped_reason the LLM wrote.
    by_reason = Counter()
    for x in items:
        r = str(x.get("dropped_reason", "")) or "(none)"
        # collapse topic_dup:<id> into one bucket
        if r.startswith("topic_dup"):
            r = "topic_dup"
        by_reason[r] += 1

    # WHAT-IF buckets: re-bucket every item purely by final_score against the
    # supplied gates (ignores topic-dedup, which is an LLM step). This answers
    # "how many COULD qualify at gate X" and how many distinct topics that is.
    ge_top = [x for x in items if x.get("final_score", 0) >= gate_top]
    ge_quick = [x for x in items if gate_quick <= x.get("final_score", 0) < gate_top]
    topics_top = {x.get("topic", "?") for x in ge_top}
    topics_quick = {x.get("topic", "?") for x in ge_quick}

    return {
        "total": total,
        "by_reason": dict(by_reason),
        "gate_top": gate_top,
        "gate_quick": gate_quick,
        "ge_top_count": len(ge_top),
        "ge_top_distinct_topics": len(topics_top),
        "band_quick_count": len(ge_quick),
        "band_quick_distinct_topics": len(topics_quick),
    }


def _unbalanced_md_tokens(text: str) -> list[str]:
    """Return the Discord formatting tokens that appear an ODD (unbalanced)
    number of times outside code spans — these bleed formatting across a message
    (the 2026-06-10 '@alexalbert__' underline bug). Empty list = balanced.
    """
    if not text:
        return []
    # strip code spans first (their contents are literal)
    stripped = re.sub(r"```[\s\S]*?```", "", text)
    stripped = re.sub(r"`[^`]+`", "", stripped)
    bad = []
    for tok in ("__", "**", "~~", "||"):
        cnt = len([m for m in re.finditer(re.escape(tok), stripped)
                   if m.start() == 0 or stripped[m.start() - 1] != "\\"])
        if cnt % 2 == 1:
            bad.append(tok)
    return bad


def detect_anomalies(scored: dict, rendered: dict | None) -> list[str]:
    """Flag the known failure classes from the Jun-10 incident.

    Post-chunking (2026-06-10): the Discord post shows the FULL selected set
    (notify.py chunks to fit), so the render check is a true 1:1 — any selected
    tweet missing from the render is a REAL drop, not a char-cap artifact.
    """
    flags = []
    items = scored.get("all_scored", [])
    selected = list(scored.get("selected_top_ids", []))

    # 1. selection→render drop (the @mattpocockuk-class bug). Needs the render
    #    manifest; older runs can't be checked (flag that instead).
    if rendered is None:
        flags.append(
            "NO_RENDER_MANIFEST: _last_run_rendered.json absent — cannot verify "
            "selected==rendered for this run (run predates the render manifest, or it wasn't written)."
        )
    else:
        rendered_top = list(rendered.get("rendered_top_ids", []))
        # Chunking means Discord shows everything → rendered MUST equal selected (1:1).
        missing = [i for i in selected if i not in rendered_top]
        extra = [i for i in rendered_top if i not in selected]
        if missing:
            flags.append(
                f"RENDER_DROP: {len(missing)} selected tweet(s) NOT rendered: {missing} "
                "(real selection→render mismatch — chunking removed the char-cap excuse; auto-repair should re-add)."
            )
        if extra:
            flags.append(f"RENDER_EXTRA: {len(extra)} rendered tweet(s) not in selected_top_ids: {extra}.")

        # 2. duplicate video idea text (the 'Local AI agents…' bug)
        ideas = rendered.get("rendered_video_ideas", [])
        title_counts = Counter((i.get("title") or "").strip() for i in ideas if i.get("title"))
        dups = [t for t, c in title_counts.items() if c > 1]
        if dups:
            flags.append(f"DUP_VIDEO_IDEA: idea title(s) used for >1 tweet: {dups!r}.")
        angle_counts = Counter((i.get("angle") or "").strip() for i in ideas if i.get("angle"))
        dup_angles = [a for a, c in angle_counts.items() if c > 1]
        if dup_angles:
            flags.append(f"DUP_VIDEO_ANGLE: idea angle(s) used for >1 tweet: {dup_angles!r}.")

        # 2b. unbalanced markdown in the rendered message body (the underline bug)
        body = rendered.get("rendered_body") or rendered.get("body") or ""
        bad = _unbalanced_md_tokens(body)
        if bad:
            flags.append(
                f"UNBALANCED_MARKDOWN: rendered body has odd-count token(s) {bad!r} "
                "(user text opening formatting that never closes — notify.py linter should escape)."
            )

    # 3. topic starvation: a single topic eating a large share of the high scorers
    #    (the Claude-Fable-5 launch ate 8+ slots on Jun 10).
    hi = [x for x in items if x.get("final_score", 0) >= PROD_GATE_TOP]
    if hi:
        topic_counts = Counter(x.get("topic", "?") for x in hi)
        top_topic, top_n = topic_counts.most_common(1)[0]
        if top_n >= 5 and top_n / len(hi) >= 0.4:
            flags.append(
                f"TOPIC_STARVATION: topic {top_topic!r} holds {top_n}/{len(hi)} "
                f"({top_n/len(hi)*100:.0f}%) of >= {PROD_GATE_TOP} scorers — one news event "
                "is crowding the brief; consider allowing 2 distinct angles within a hot topic."
            )

    return flags


def render_report(scored: dict, rendered: dict | None, funnel: dict, top_n: int) -> str:
    items = sorted(scored.get("all_scored", []), key=lambda z: -z.get("final_score", 0))
    out = []
    out.append("=" * 72)
    out.append(f"X-FEED BRIEF REPLAY  ·  run_id={scored.get('run_id','?')}  ·  ts={scored.get('ts','?')}")
    out.append("=" * 72)
    out.append(f"scanned: {scored.get('timeline_count','?')} timeline + {scored.get('search_count','?')} search "
               f"= {scored.get('new_count','?')} new  ·  pf: {scored.get('pf_note','?')}")
    out.append("")
    out.append("FUNNEL (as run — from dropped_reason):")
    for reason, n in sorted(funnel["by_reason"].items(), key=lambda kv: -kv[1]):
        out.append(f"  {reason:<16} {n:>5}")
    out.append("")
    out.append(f"WHAT-IF at gates top>={funnel['gate_top']} / quick>={funnel['gate_quick']}:")
    out.append(f"  >= {funnel['gate_top']:>3} (top):    {funnel['ge_top_count']:>4} tweets · {funnel['ge_top_distinct_topics']:>3} distinct topics")
    out.append(f"  {funnel['gate_quick']}-{funnel['gate_top']-1} (quick): {funnel['band_quick_count']:>4} tweets · {funnel['band_quick_distinct_topics']:>3} distinct topics")
    out.append("")

    flags = detect_anomalies(scored, rendered)
    if flags:
        out.append("⚠️  ANOMALIES:")
        for f in flags:
            out.append(f"  - {f}")
    else:
        out.append("✅ No anomalies detected.")
    out.append("")

    out.append(f"TOP {top_n} BY final_score:")
    out.append(f"  {'fin':>3} {'base':>4} {'pfΔ':>5}  {'handle':<18} reason / topic")
    for x in items[:top_n]:
        out.append(
            f"  {x.get('final_score',0):>3} {x.get('base_score',0):>4} "
            f"{x.get('personal_fit_delta',0):>+5.1f}  @{(x.get('authorHandle') or '?'):<17} "
            f"{str(x.get('dropped_reason',''))[:14]:<14} [{(x.get('topic') or '')[:34]}]"
        )
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Offline replay/funnel inspector for x-feed-brief.")
    ap.add_argument("--file", default=DEFAULT_SCORED, help="path to a _last_run_scored.json")
    ap.add_argument("--rendered", default=None, help="path to a _last_run_rendered.json (default: sibling of --file)")
    ap.add_argument("--top", type=int, default=30, help="how many top rows to print")
    ap.add_argument("--gate-top", type=int, default=PROD_GATE_TOP, help="what-if top-tweets gate")
    ap.add_argument("--gate-quick", type=int, default=PROD_GATE_QUICK, help="what-if quick-hits floor")
    ap.add_argument("--json", action="store_true", help="emit machine-readable funnel JSON")
    args = ap.parse_args(argv)

    if not os.path.exists(args.file):
        print(f"ERROR: scored dump not found: {args.file}", file=sys.stderr)
        return 2
    scored = load_json(args.file)

    rendered = None
    rpath = args.rendered or os.path.join(os.path.dirname(os.path.abspath(args.file)), "_last_run_rendered.json")
    # only pair the rendered manifest if it's for the same run
    if os.path.exists(rpath):
        try:
            cand = load_json(rpath)
            if cand.get("run_id") == scored.get("run_id") or args.rendered:
                rendered = cand
        except Exception:
            rendered = None

    funnel = build_funnel(scored, args.gate_top, args.gate_quick)

    if args.json:
        print(json.dumps({"funnel": funnel, "anomalies": detect_anomalies(scored, rendered)}, indent=2))
    else:
        print(render_report(scored, rendered, funnel, args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
