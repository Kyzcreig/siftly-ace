#!/usr/bin/env python3
"""
xfeed_backfill_labels.py — one-shot: join full tweet text from the warm x-feed
caches onto the scored dump, so we can label the contention-zone pool NOW
(instead of waiting days for live runs to emit labels). Read-only on caches;
writes a labeled pool to the path given by --out.

It does NOT call a model. It emits the joined pool (full text + legacy score) for
a separate labeling pass (xfeed_label.py), and restricts to the contention zone
(score >= --min-score) since anything below the also-gate can never be selected.
"""
import argparse, glob, json, os

BASE = os.path.expanduser("~/.hermes/state/cron/x-feed-brief")


def build_id_text(cache_dir):
    idtext = {}
    for p in glob.glob(os.path.join(cache_dir, "timeline-*.json")):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        for t in d.get("tweets", []):
            tid = str(t.get("id"))
            if tid and t.get("text"):
                idtext.setdefault(tid, t["text"])
    for p in glob.glob(os.path.join(cache_dir, "interest-*.json")):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        for res in d.get("results", []):
            data = res.get("data")
            rows = data if isinstance(data, list) else (data or {}).get("data", [])
            for t in (rows or []):
                tid = str(t.get("id"))
                if tid and t.get("text"):
                    idtext.setdefault(tid, t["text"])
    return idtext


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=os.path.join(BASE, "_last_run_scored.json"))
    ap.add_argument("--cache-dir", default=os.path.join(BASE, "cache"))
    ap.add_argument("--out", default="/tmp/xfeed-labeled-pool.json")
    ap.add_argument("--min-score", type=int, default=40,
                    help="only carry rows with legacy final_score >= this (contention zone)")
    args = ap.parse_args()

    idtext = build_id_text(args.cache_dir)
    dump = json.load(open(args.dump))
    pool = dump.get("all_scored", [])

    out_rows, joined, missing = [], 0, 0
    for r in pool:
        if r.get("final_score", r.get("base_score", 0)) < args.min_score:
            continue
        tid = str(r.get("tweet_id"))
        full = idtext.get(tid)
        if full:
            joined += 1
        else:
            missing += 1
            full = r.get("text_snippet", "")
        out_rows.append({
            "tweet_id": tid,
            "authorHandle": r.get("authorHandle"),
            "url": r.get("url"),
            "likes": r.get("likes", 0),
            "replies": r.get("replies", 0),
            "retweets": r.get("retweets", 0),
            "source": "x",
            "tweet_text": full,
            "topic": r.get("topic"),
            "legacy_final_score": r.get("final_score", r.get("base_score", 0)),
            "legacy_base_score": r.get("base_score"),
        })
    json.dump({"all_scored": out_rows}, open(args.out, "w"), ensure_ascii=False, indent=2)
    print(f"contention pool (score>={args.min_score}): {len(out_rows)} rows "
          f"| full-text joined={joined} snippet-fallback={missing} → {args.out}")


if __name__ == "__main__":
    main()
