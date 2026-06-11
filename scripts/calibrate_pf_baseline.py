#!/usr/bin/env python3
"""
calibrate_pf_baseline.py — empirically derive the pf-score baseline.

The pf delta is `clamp(affinity - baseline) * weight`. The baseline should sit at
roughly the affinity of a NEUTRAL item, so genuinely on-taste content gets a
positive delta and off-taste content negative. The legacy 0.18 was a guess and
(calibration 2026-06-11) sits ABOVE the affinity of real actionable AI/dev
bookmarks, dragging every one of them to pf=-3.

This measures the affinity distribution (using the LIVE profile + pf-score's own
math) over:
  - the seed-44 miss-set (actionable bookmarks under TOP_GATE)
  - actionable bookmarks (positives)
  - hard-negative bookmarks (politics/memes/health)
and prints candidate baselines so we pick from data, not vibes.
"""
import importlib.util, json, os, random, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

# load the hyphenated pf-score module
_spec = importlib.util.spec_from_file_location(
    "pfscore", os.path.join(os.path.dirname(os.path.abspath(__file__)), "pf-score.py"))
P = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(P)

import calibrate_scoring as C
import inspect_missgate as M
from score_digest import score_item, TOP_GATE

PROFILE = json.load(open(P.DEFAULT_PROFILE))


def affinity(it):
    """Run pf-score's scorer with weight=1, baseline=0 -> raw == affinity."""
    cand = {"text": it.get("tweet_text") or "", "authorHandle": it.get("authorHandle") or "",
            "source": "x"}
    r = P.score_candidate(cand, 0, PROFILE, weight=1.0, baseline=0.0)
    return r["personal_fit_affinity"]


def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p / 100.0; f = int(k)
    return xs[f] if f + 1 >= len(xs) else xs[f] + (k - f) * (xs[f + 1] - xs[f])


def stats(name, xs):
    xs = sorted(xs)
    print(f"{name:28s} n={len(xs):3d}  min={xs[0]:.3f} p25={pct(xs,25):.3f} "
          f"median={pct(xs,50):.3f} p75={pct(xs,75):.3f} max={xs[-1]:.3f} "
          f"mean={sum(xs)/len(xs):.3f}")
    return pct(xs, 50)


def main():
    sample, tl, ta, trk = M.get_labeled_sample()
    clean = [it for it in sample
             if it.get("content_type") in M.ACTIONABLE and it.get("on_topic") != "off"]
    miss = [it for it in clean if score_item(it, tl, ta, trk)["_final"] < TOP_GATE]

    pos, hardneg = C.load_bookmarks(300)

    print("# Affinity distributions (LIVE brief-relevant-only profile)\n")
    stats("miss-set (actionable<gate)", [affinity(it) for it in miss])
    pos_med = stats("actionable positives", [affinity(it) for it in pos])
    neg_med = stats("hard-negatives", [affinity(it) for it in hardneg])

    print("\n# Candidate baselines")
    midpoint = round((pos_med + neg_med) / 2, 3)
    print(f"  legacy:              0.180")
    print(f"  pos/neg midpoint:    {midpoint}  (positives get +delta, negatives -delta)")
    # What baseline would make the median miss-set item land at delta>=0?
    miss_affs = sorted(affinity(it) for it in miss)
    print(f"  miss-set p75:        {round(pct(miss_affs,75),3)}  (clears 75% of misses)")
    print(f"  miss-set median:     {round(pct(miss_affs,50),3)}  (clears 50% of misses)")

    # Simulate: at a chosen baseline, how many misses flip to delta>=0?
    for b in (0.18, midpoint, round(pct(miss_affs,50),3), round(pct(miss_affs,75),3), 0.05, 0.0):
        flipped = sum(1 for a in miss_affs if (a - b) >= 0)
        # also: do hard-negs stay negative?
        neg_aff = [affinity(it) for it in hardneg]
        neg_pos = sum(1 for a in neg_aff if (a - b) > 0)
        print(f"  baseline={b:.3f} -> miss-set delta>=0: {flipped}/{len(miss_affs)} | "
              f"hard-negs going POSITIVE (bad): {neg_pos}/{len(neg_aff)}")


if __name__ == "__main__":
    main()
