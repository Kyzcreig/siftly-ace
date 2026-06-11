#!/usr/bin/env python3
"""
inspect_missgate.py — pull the actionable bookmarks that fall UNDER TOP_GATE and
show the term-by-term decomposition (base / engagement / author / pf / recency /
media / off_topic_pen / low_reach_cap), so we can see WHY each is missed before
touching any constant.

Reproduces the exact seed-44, n=150 pipeline from /tmp/calib-clean.txt, but
CACHES the model labels to disk (calib-label-cache.json) so we never re-pay Opus
just to re-inspect. Pass --refresh to force a fresh model-label pass.
"""
import json, os, random, sys, argparse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import calibrate_scoring as C
from score_digest import (
    score_item, _load_thought_leaders, _load_tracked_projects, TOP_GATE, ALSO_GATE,
    LOW_REACH_SCORE_CAP, LOW_REACH_ENGAGEMENT_FLOOR,
)
from select_digest import _engagement, _handle

CACHE = "/tmp/calib-label-cache.json"
ACTIONABLE = {"launch", "benchmark", "tutorial", "field_report", "analysis"}


def get_labeled_sample(refresh=False):
    tl, ta = _load_thought_leaders()
    trk = set(_load_tracked_projects())
    pos, hardneg = C.load_bookmarks(150)
    random.seed(44)
    sample = random.sample(pos, 150)
    keyf = lambda it: (it.get("tweet_text") or "")[:200]
    if (not refresh) and os.path.exists(CACHE):
        cached = {o["k"]: o for o in json.load(open(CACHE))}
        miss = [it for it in sample if keyf(it) not in cached]
        if not miss:
            for it in sample:
                c = cached[keyf(it)]
                for k in ("content_type", "actionability", "substance", "on_topic", "_model_labeled"):
                    if k in c:
                        it[k] = c[k]
            C.inject_pf(sample)
            return sample, tl, ta, trk
        print(f"[cache stale: {len(miss)} uncached -> refreshing]", file=sys.stderr)
    sample = C.model_label_sample(sample, 150)
    json.dump([
        {"k": keyf(it), "content_type": it.get("content_type"),
         "actionability": it.get("actionability"), "substance": it.get("substance"),
         "on_topic": it.get("on_topic"), "_model_labeled": it.get("_model_labeled")}
        for it in sample], open(CACHE, "w"))
    C.inject_pf(sample)
    return sample, tl, ta, trk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    sample, tl, ta, trk = get_labeled_sample(refresh=args.refresh)

    clean = [it for it in sample
             if it.get("content_type") in ACTIONABLE and it.get("on_topic") != "off"]
    scored = [(score_item(it, tl, ta, trk), it) for it in clean]
    miss = [(s, it) for (s, it) in scored if s["_final"] < TOP_GATE]
    miss.sort(key=lambda x: x[0]["_final"])

    print(f"# Actionable bookmarks UNDER TOP_GATE({TOP_GATE})")
    print(f"# clean actionable n={len(clean)} | missed n={len(miss)} "
          f"({100*len(miss)/max(1,len(clean)):.0f}%)")
    print(f"# LOW_REACH: unknown handle + engagement < {LOW_REACH_ENGAGEMENT_FLOOR} "
          f"-> hard-cap at {LOW_REACH_SCORE_CAP}\n")

    # Cause tally
    causes = {"low_reach_capped": 0, "pf_negative": 0, "low_base": 0, "off_pen": 0}
    for s, it in miss:
        b = s["_breakdown"]
        if b["low_reach_capped"]:
            causes["low_reach_capped"] += 1
        if b["pf"] < 0:
            causes["pf_negative"] += 1
        if b["base"] < TOP_GATE - 6:
            causes["low_base"] += 1
        if b["off_topic_pen"] < 0:
            causes["off_pen"] += 1

    for i, (s, it) in enumerate(miss, 1):
        b = s["_breakdown"]
        lab = b["labels"]
        txt = (it.get("tweet_text") or "").replace("\n", " ")[:140]
        eng = _engagement(it)
        print(f"[{i}] final={s['_final']:.0f}  @{_handle(it) or '?'}  eng={eng}")
        print(f"    {lab['content_type']}/{lab['actionability']}/{lab['substance']}/{lab['on_topic']}"
              f"  pre_cap={b['pre_cap']}  low_reach_capped={b['low_reach_capped']}")
        print(f"    base={b['base']} sub={b['substance_adj']} eng={b['engagement']} "
              f"auth={b['author']} pf={b['pf']} rec={b['recency']} med={b['media']} "
              f"off={b['off_topic_pen']}")
        print(f"    \"{txt}\"\n")

    print("## Cause tally (an item can have >1 cause)")
    for k, v in causes.items():
        print(f"  {k}: {v}/{len(miss)}")


if __name__ == "__main__":
    main()
