#!/usr/bin/env python3
"""Phase 4 — x-feed SOURCING shadow: paid timeline sweep vs x_search gather.

The question this answers is NOT "how many raw posts does each source return?"
(coverage %), but the only one that matters for a cutover:

    Does the brief PUBLISH a different set of ~7 posts?

A source that returns half the raw rows but the same published Top/Also set is a
free win. A source that returns 95% of rows but drops one Top story is a
regression. Raw-coverage percentages are a proxy; the published set is the product.

Usage:
    xfeed_sourcing_shadow.py --paid <timeline.json> --xsearch <candidates.json> [--json]
"""
from __future__ import annotations
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load_paid(path):
    """Paid X API sweep -> pipeline candidate rows (same shape the adapter emits)."""
    with open(path) as f:
        d = json.load(f)
    tweets = d.get("tweets") or d.get("data") or []
    users = {u.get("id"): u.get("username")
             for u in (d.get("users") or []) if isinstance(u, dict)}
    out = []
    for t in tweets:
        txt = t.get("text") or ""
        if txt.startswith("RT @"):
            continue                      # retweet rows always carry 0 engagement
        pm = t.get("public_metrics") or {}
        handle = users.get(t.get("author_id"), "")
        tid = str(t.get("id"))
        out.append({
            "source": "x",
            "authorHandle": handle,
            "tweet_id": tid,
            "tweet_text": txt,
            "url": f"https://x.com/{handle}/status/{tid}",
            "likes": pm.get("like_count", 0),
            "retweets": pm.get("retweet_count", 0),
            "public_metrics": pm,
            "created_at": t.get("created_at"),
        })
    return out


def _load_xsearch(path):
    with open(path) as f:
        d = json.load(f)
    rows = d.get("candidates", d if isinstance(d, list) else [])
    for r in rows:
        r.setdefault("source", "x")
        r.setdefault("authorHandle", r.get("handle", ""))
    return rows


def _label(rows):
    """Apply the deterministic labels the LLM would emit.

    The shadow cannot invoke the model, so both arms get IDENTICAL neutral labels.
    That is the point: holding labeling constant isolates the SOURCING difference,
    which is the only variable under test. Absolute scores are therefore not
    meaningful here — only the paid-vs-xsearch DELTA is.
    """
    for r in rows:
        r.setdefault("content_type", "opinion")
        r.setdefault("actionability", "context_only")
        r.setdefault("substance", "specific")
        r.setdefault("on_topic", "core")
    return rows


def _select(rows):
    import score_digest as S
    import select_digest as SD
    tl, ta = S._load_thought_leaders()
    trk = set(S._load_tracked_projects())
    scored = []
    for r in _label([dict(x) for x in rows]):
        out = S.score_item(r, tl, ta, trk)
        r["_final"] = out["_final"]
        r["_breakdown"] = out["_breakdown"]
        scored.append(r)
    scored.sort(key=lambda x: -x["_final"])

    # GATE NOTE (measured 2026-07-25): with neutral labels the score ceiling is ~61,
    # below ALSO_GATE(77) — so gate-based selection publishes NOTHING on either arm
    # and the comparison is vacuous. The LLM's labels, not the source, are what lift
    # a post over the gate, and the shadow deliberately holds labels constant.
    #
    # So compare the RANK-ORDERED HEAD instead: the top (MAX_TOP + MAX_ALSO) items by
    # deterministic score. That is what the gates would select from, and it isolates
    # the sourcing difference without needing the model in the loop.
    head_n = SD.MAX_TOP + SD.MAX_ALSO
    head = scored[:head_n]
    return scored, head[:SD.MAX_TOP], head[SD.MAX_TOP:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paid", required=True)
    ap.add_argument("--xsearch", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    paid = _load_paid(a.paid)
    xs = _load_xsearch(a.xsearch)

    p_scored, p_top, p_also = _select(paid)
    x_scored, x_top, x_also = _select(xs)

    p_pub = [r["tweet_id"] for r in p_top + p_also]
    x_pub = [r["tweet_id"] for r in x_top + x_also]
    p_set, x_set = set(p_pub), set(x_pub)

    overlap = p_set & x_set
    only_paid = p_set - x_set
    only_xs = x_set - p_set

    by_id = {r["tweet_id"]: r for r in p_scored + x_scored}

    res = {
        "pool": {"paid": len(paid), "xsearch": len(xs)},
        "published": {"paid": len(p_pub), "xsearch": len(x_pub)},
        "overlap": len(overlap),
        "only_paid": sorted(only_paid),
        "only_xsearch": sorted(only_xs),
        "jaccard": round(len(overlap) / max(1, len(p_set | x_set)), 3),
    }

    if a.json:
        print(json.dumps(res, indent=2))
        return 0

    print("=" * 74)
    print("PHASE 4 — x-feed SOURCING shadow: paid sweep vs x_search gather")
    print("=" * 74)
    print(f"\nraw pool      paid={len(paid):5}   xsearch={len(xs):5}")
    print(f"published     paid={len(p_pub):5}   xsearch={len(x_pub):5}")
    print(f"overlap       {len(overlap)}   jaccard={res['jaccard']}")

    if only_paid:
        print(f"\n🔴 PUBLISHED BY PAID ONLY ({len(only_paid)}) — what a cutover would LOSE:")
        for i in sorted(only_paid):
            r = by_id.get(i, {})
            print(f"   {r.get('_final','?'):>6}  @{r.get('authorHandle','?'):<18} "
                  f"{(r.get('tweet_text') or '')[:52]!r}")
    else:
        print("\n✅ nothing published by paid-only — a cutover loses no published post")

    if only_xs:
        print(f"\n🟢 PUBLISHED BY XSEARCH ONLY ({len(only_xs)}) — what a cutover would GAIN:")
        for i in sorted(only_xs):
            r = by_id.get(i, {})
            print(f"   {r.get('_final','?'):>6}  @{r.get('authorHandle','?'):<18} "
                  f"{(r.get('tweet_text') or '')[:52]!r}")

    print("\n" + "-" * 74)
    print("VERDICT: a cutover is safe when only_paid is EMPTY — i.e. the rank-ordered")
    print("head loses nothing. Raw-pool size is NOT the acceptance criterion.")
    print("NOTE: both arms use identical neutral labels (no LLM in the shadow), so")
    print("absolute scores are not meaningful — only the paid-vs-xsearch delta is.")
    print("")
    print("⚠️  FAIRNESS GATE — read before trusting a verdict:")
    print("    This is only a valid comparison when the x_search arm gathered the SAME")
    print("    handle set as the paid sweep. If the x_search pool is much smaller than")
    print("    the paid pool, the diff measures INCOMPLETE GATHERING, not the source's")
    print("    quality. Check the pool line above: a paid pool in the thousands against")
    print("    a two-digit x_search pool means run a full gather first.")
    if len(xs) * 4 < len(paid):
        print("")
        print(f"    🔴 UNFAIR AS RUN: xsearch pool ({len(xs)}) is far smaller than paid "
              f"({len(paid)}).")
        print("       Treat the diff above as a HARNESS SMOKE TEST, not a cutover verdict.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
