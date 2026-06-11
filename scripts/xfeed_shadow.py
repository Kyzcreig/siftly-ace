#!/usr/bin/env python3
"""
xfeed_shadow.py — #2 P2.2/P2.3 shadow-diff harness for the x-feed-brief
deterministic cutover.

Runs the SHARED deterministic engine (score_digest.select_shadow, the same code
morning-digest posts from) over real x-feed `_last_run_scored.json` snapshots and
diffs its selection against the legacy prose-scored selection x-feed posts TODAY.
It is OFFLINE and read-only: it never posts, never touches the live brief, never
mutates the engine's module globals (caps/gates thread as explicit kwargs).

WHY (PRD §2.2 / §B4): the cutover's acceptance is **membership quality**, not
cardinality parity. This harness produces the evidence:

  1. Membership diff — for each snapshot, which tweets the deterministic engine
     ADDS vs REMOVES vs KEEPS relative to the legacy post, each with a reason.
  2. Guard audit — every tweet legacy posted that the deterministic engine drops
     is checked against the known guards (engagement-gamed unknown-author,
     off-topic/political, bare fragment). A drop that fires a guard is a WIN
     (the cutover exists to remove these); a drop with no guard reason is flagged
     for human review.
  3. Volume floor — reports |det_volume - legacy_volume|; per Ace's call
     (2026-06: "same volume, better membership") a delta > ±1 is a SANITY flag,
     not a hard target.
  4. Gate sweep (--sweep) — runs the engine across candidate (top_gate, also_gate)
     pairs and reports, per pair, det volume + guard-clean drops + bad drops, so
     P2.3 can pick x-feed-specific gates from x-feed's OWN score distribution
     (NOT inherited from morning-digest's 49/45 — different pool).

Usage:
  # diff the latest live snapshot against the legacy post, default x-feed gates
  python3 scripts/xfeed_shadow.py

  # diff a specific snapshot / dir of snapshots
  python3 scripts/xfeed_shadow.py --in ~/.hermes/state/cron/x-feed-brief/_last_run_scored.json
  python3 scripts/xfeed_shadow.py --glob '~/.hermes/state/cron/x-feed-brief/snapshots/*.json'

  # P2.3 gate derivation: sweep gate pairs across all snapshots
  python3 scripts/xfeed_shadow.py --glob '.../snapshots/*.json' --sweep

  # x-feed product shape (Top up to 5 @≥60, Quick Hits up to 5 @≥50)
  python3 scripts/xfeed_shadow.py --max-top 5 --max-also 5 --top-gate 60 --also-gate 50

Notes on the input snapshot (`_last_run_scored.json`, x-feed Step 6.7 schema):
  - Pre-P2.2 snapshots carry ONLY legacy fields (text_snippet, base_score,
    final_score, dropped_reason ...) and NO enum labels. The harness still runs:
    score_digest.normalize_labels() applies SAFE_DEFAULT labels for missing ones,
    so a pre-label snapshot scores deterministically (conservatively) and the diff
    is still meaningful as a floor. Once P2.2's additive prompt lands, snapshots
    carry real labels and the diff sharpens. The harness prints which mode it ran
    in (`labels: real` vs `labels: defaulted`).
  - x-feed dumps a ≤120-char `text_snippet`, NOT full text. The engine's text
    helpers read `tweet_text|title|summary`; we alias snippet→tweet_text so the
    on-topic / bare-fragment guards have text to work on. This is a FLOOR (a
    snippet can clip a tech token); flagged in the report.
"""
import argparse
import glob as _glob
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

# x-feed product shape (Step 6: Top up to 5 @≥60, Quick Hits up to 5 @≥50).
XFEED_MAX_TOP = 5
XFEED_MAX_ALSO = 5
XFEED_TOP_GATE = 60
XFEED_ALSO_GATE = 50


def _key(it):
    return it.get("tweet_id") or it.get("url") or (it.get("text_snippet") or "")[:60]


def _prep_pool(raw_pool):
    """Map x-feed Step-6.7 dump rows into the shape the shared engine reads.

    The engine reads tweet_text|title|summary for text, source=='x' for the X
    low-reach guard, likes/retweets for engagement, and the 4 enum labels. x-feed
    rows carry text_snippet (not tweet_text), likes/replies (not retweets), no
    explicit source. We alias WITHOUT discarding the originals so the report can
    still show the legacy fields. retweets is unknown in the dump → 0 (engagement
    floor uses likes+retweets; replies are not part of the engine's _engagement,
    matching morning-digest)."""
    pool = []
    for r in raw_pool:
        it = dict(r)
        it.setdefault("source", "x")  # x-feed pool is all tweets
        if "tweet_text" not in it and it.get("text_snippet"):
            it["tweet_text"] = it["text_snippet"]
        if "retweets" not in it:
            it["retweets"] = 0  # not recorded in the x-feed dump; engagement = likes only
        pool.append(it)
    return pool


def _has_real_labels(raw_pool):
    return any(r.get("content_type") or r.get("on_topic") for r in raw_pool)


def _legacy_selection(raw_pool, max_top, max_also, top_gate, also_gate):
    """Reconstruct what the LEGACY prose path posts from a snapshot.

    Prefer the recorded selection (selected_top_ids / quick_hits_ids) when present
    — that is the ground truth of what actually posted. Fall back to re-deriving
    from final_score + the product gates when a snapshot predates id recording."""
    selected_ids = set(_top_ids or [])
    qh_ids = set(_qh_ids or [])
    if selected_ids or qh_ids:
        top = [r for r in raw_pool if str(r.get("tweet_id")) in selected_ids]
        also = [r for r in raw_pool if str(r.get("tweet_id")) in qh_ids]
        return top, also, "recorded"
    # Fallback: rank by legacy score, apply the product gates.
    ranked = sorted(raw_pool, key=_legacy_score, reverse=True)
    top, also = [], []
    for r in ranked:
        f = _legacy_score(r)
        if f >= top_gate and len(top) < max_top:
            top.append(r)
        elif f >= also_gate and len(also) < max_also:
            also.append(r)
    return top, also, "rederived"


def _deterministic_selection(raw_pool, max_top, max_also, top_gate, also_gate):
    import score_digest as S
    pool = _prep_pool(raw_pool)
    tl, ta = S._load_thought_leaders()
    trk = set(S._load_tracked_projects())
    sel, also, disc, meta = S.select_shadow(
        pool, tl, ta, trk,
        max_top=max_top, max_also=max_also, top_gate=top_gate, also_gate=also_gate)
    return sel, also, disc, meta


def _guard_reason(item):
    """Why would the deterministic engine drop a tweet the legacy path posted?
    Returns a short reason string if a KNOWN guard fires (a 'good' drop), else
    None (a drop with no guard explanation → human review).

    Guards considered (all are reasons the cutover EXISTS to drop a tweet):
      - bare fragment (no standalone substance)
      - python on-topic override (zero tech tokens) — the hard backstop
      - MODEL on_topic=off — politics/health/insult the model itself flagged; the
        deterministic engine applies OFF_TOPIC_PEN so it scores below gate. This
        is a legitimate, explained drop even when python_on_topic leaves the label
        alone (e.g. an "AI super-vaccine" health tweet carries the token "AI").
      - MODEL content_type promo/reply_fragment — ad/shill or bare reply.
      - engagement-gamed unknown author (not a thought-leader, below low-reach floor)
    """
    import score_digest as S
    import select_digest as SEL
    reasons = []
    text = SEL._item_text(item)
    if SEL.is_bare_fragment(text):
        reasons.append("bare_fragment")
    py_ot, py_reason = S.python_on_topic(item)
    if py_ot == "off":
        reasons.append(f"off_topic({py_reason})")
    elif str(item.get("on_topic")).lower() == "off":
        reasons.append("off_topic(model_label)")
    ct = str(item.get("content_type")).lower()
    if ct in ("promo", "reply_fragment"):
        reasons.append(f"low_value({ct})")
    # engagement-gamed unknown author: not a thought-leader + below low-reach floor
    tl, ta = S._load_thought_leaders()
    if not S._is_thought_leader(item, tl, ta):
        cap, cap_reason = SEL.low_reach_cap(item, tl, ta)
        if cap is not None:
            reasons.append(f"low_reach_unknown_author(eng={SEL._engagement(item)})")
    return ", ".join(reasons) if reasons else None


def _legacy_score(r):
    """Legacy posted score, tolerant of both the live dump (final_score) and the
    backfilled labeled pool (legacy_final_score)."""
    v = r.get("final_score")
    if v is None:
        v = r.get("legacy_final_score")
    if v is None:
        v = r.get("base_score", r.get("legacy_base_score", 0))
    return v


def _diff_one(path, max_top, max_also, top_gate, also_gate):
    with open(os.path.expanduser(path)) as f:
        data = json.load(f)
    raw_pool = data.get("all_scored") or []
    global _top_ids, _qh_ids
    _top_ids = data.get("selected_top_ids")
    _qh_ids = data.get("quick_hits_ids")

    leg_top, leg_also, leg_mode = _legacy_selection(
        raw_pool, max_top, max_also, top_gate, also_gate)
    det_top, det_also, det_disc, det_meta = _deterministic_selection(
        raw_pool, max_top, max_also, top_gate, also_gate)

    leg_posted = {_key(r): r for r in (leg_top + leg_also)}
    det_posted = {_key(r): r for r in (det_top + det_also)}

    # Map every deterministically-discarded item to the engine's own drop reason
    # (event_dup = same-event/same-author collapse, below_gate_or_cap, bare_fragment).
    # A legacy-posted tweet the engine collapsed as a dup is a GOOD drop (the brief
    # would otherwise carry 2-3 near-duplicate tweets from one author/event).
    det_drop_reason = {}
    for d in det_disc:
        det_drop_reason[_key(d)] = d.get("_drop")

    added = [k for k in det_posted if k not in leg_posted]
    removed = [k for k in leg_posted if k not in det_posted]
    kept = [k for k in det_posted if k in leg_posted]

    # Guard-audit every legacy-posted tweet the deterministic engine drops.
    good_drops, bad_drops = [], []
    for k in removed:
        item = _prep_pool([leg_posted[k]])[0]
        gr = _guard_reason(item)
        # Fold in the engine's structural drop reason (event/author collapse is a win).
        edrop = det_drop_reason.get(k)
        if edrop == "event_dup":
            gr = (gr + ", " if gr else "") + "event/author_collapse(dedupe win)"
        elif edrop == "bare_fragment" and not gr:
            gr = "bare_fragment"
        rec = {"key": k, "handle": leg_posted[k].get("authorHandle"),
               "snippet": (leg_posted[k].get("text_snippet") or leg_posted[k].get("tweet_text") or "")[:80],
               "legacy_score": _legacy_score(leg_posted[k]),
               "guard": gr}
        (good_drops if gr else bad_drops).append(rec)

    return {
        "path": path,
        "pool": len(raw_pool),
        "labels": "real" if _has_real_labels(raw_pool) else "defaulted",
        "legacy_mode": leg_mode,
        "legacy_volume": len(leg_posted),
        "det_volume": len(det_posted),
        "volume_delta": len(det_posted) - len(leg_posted),
        "kept": len(kept),
        "added": [{"key": k, "handle": det_posted[k].get("authorHandle"),
                   "snippet": (det_posted[k].get("text_snippet") or det_posted[k].get("tweet_text") or "")[:80],
                   "det_score": round(det_posted[k].get("_final", 0), 1)} for k in added],
        "good_drops": good_drops,
        "bad_drops": bad_drops,
        "det_meta": det_meta,
    }


def _print_diff(d):
    flag = "⚠️ " if (d["bad_drops"] or abs(d["volume_delta"]) > 1) else "✅ "
    print(f"\n{flag}{os.path.basename(d['path'])}  "
          f"pool={d['pool']} labels={d['labels']} legacy={d['legacy_mode']}")
    print(f"   volume: legacy={d['legacy_volume']} det={d['det_volume']} "
          f"(delta {d['volume_delta']:+d}; ±1 is sanity floor, not target) "
          f"| kept={d['kept']} added={len(d['added'])} dropped={len(d['good_drops']) + len(d['bad_drops'])}")
    if d["added"]:
        print("   + ADDED by deterministic (better-membership candidates):")
        for a in d["added"]:
            print(f"       @{a['handle']} [{a['det_score']}] {a['snippet']}")
    if d["good_drops"]:
        print("   - DROPPED (guard fired — the cutover's job; GOOD):")
        for g in d["good_drops"]:
            print(f"       @{g['handle']} (legacy {g['legacy_score']}) → {g['guard']} | {g['snippet']}")
    if d["bad_drops"]:
        print("   ⚠️ DROPPED with NO guard reason (HUMAN REVIEW — may be over-tight gate):")
        for b in d["bad_drops"]:
            print(f"       @{b['handle']} (legacy {b['legacy_score']}) | {b['snippet']}")


def _sweep(paths, max_top, max_also):
    """P2.3 gate derivation: run the engine across candidate gate pairs over all
    snapshots, report det volume + clean/bad drops per pair so x-feed gates are
    chosen from x-feed's OWN distribution."""
    top_candidates = [50, 52, 55, 58, 60, 62, 65]
    also_candidates = [40, 42, 45, 48, 50]
    print("\n=== GATE SWEEP (P2.3 derivation — pick from x-feed's own pool) ===")
    print(f"snapshots={len(paths)}  max_top={max_top} max_also={max_also}")
    print(f"{'top':>4} {'also':>5} | {'avg_vol':>8} {'good_drop':>10} {'bad_drop':>9} {'added':>6}")
    for tg in top_candidates:
        for ag in also_candidates:
            if ag > tg:
                continue
            vols, good, bad, added = 0, 0, 0, 0
            for p in paths:
                d = _diff_one(p, max_top, max_also, tg, ag)
                vols += d["det_volume"]
                good += len(d["good_drops"])
                bad += len(d["bad_drops"])
                added += len(d["added"])
            n = max(1, len(paths))
            print(f"{tg:>4} {ag:>5} | {vols / n:>8.1f} {good:>10} {bad:>9} {added:>6}")
    print("\nPick the pair with target volume (Ace: same as legacy ≈ today's count),\n"
          "maximal good_drops, and ZERO bad_drops. Feed it to select_digest.py\n"
          "--top-gate/--also-gate at P2.4.")


def main(argv=None):
    ap = argparse.ArgumentParser(description="x-feed deterministic-cutover shadow-diff harness (#2 P2.2/P2.3).")
    default_in = "~/.hermes/state/cron/x-feed-brief/_last_run_scored.json"
    ap.add_argument("--in", dest="inp", default=default_in, help="single snapshot path")
    ap.add_argument("--glob", dest="glob", default=None, help="glob of snapshots (overrides --in)")
    ap.add_argument("--max-top", type=int, default=XFEED_MAX_TOP)
    ap.add_argument("--max-also", type=int, default=XFEED_MAX_ALSO)
    ap.add_argument("--top-gate", type=int, default=XFEED_TOP_GATE)
    ap.add_argument("--also-gate", type=int, default=XFEED_ALSO_GATE)
    ap.add_argument("--sweep", action="store_true", help="P2.3 gate sweep across snapshots")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args(argv)

    if args.glob:
        paths = sorted(_glob.glob(os.path.expanduser(args.glob)))
        if not paths:
            print(f"no snapshots matched {args.glob}", file=sys.stderr)
            return 2
    else:
        paths = [args.inp]

    if args.sweep:
        _sweep(paths, args.max_top, args.max_also)
        return 0

    diffs = [_diff_one(p, args.max_top, args.max_also, args.top_gate, args.also_gate)
             for p in paths]

    if args.json:
        print(json.dumps(diffs, ensure_ascii=False, indent=2))
        return 0

    total_bad = 0
    for d in diffs:
        _print_diff(d)
        total_bad += len(d["bad_drops"])

    print(f"\n=== SUMMARY: {len(diffs)} snapshot(s) | "
          f"gates top={args.top_gate} also={args.also_gate} | "
          f"{total_bad} unexplained drop(s) across all ===")
    if total_bad:
        print("⚠️ Unexplained drops present — gates may be too tight, or a real "
              "item is being cut. Review before P2.4 flip.")
    else:
        print("✅ Every legacy→deterministic drop has a guard reason. "
              "Membership-quality acceptance (B4) holds for this window.")
    return 0


# Module-level globals set per-snapshot by _diff_one (legacy id recovery).
_top_ids = None
_qh_ids = None

if __name__ == "__main__":
    raise SystemExit(main())
