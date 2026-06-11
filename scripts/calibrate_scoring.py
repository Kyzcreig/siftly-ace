#!/usr/bin/env python3
"""
calibrate_scoring.py — fit the deterministic digest scorer to Ace's REAL bookmark
corpus (SPEC-bookmark-calibrated-scoring.md).

STEP 3 (this build, --measure): pull the calibration sets, heuristic-label them,
score with the CURRENT score_digest constants, and report separation (histograms,
quartiles, overlap, AUC, per-term variance) BEFORE any re-fit. Measurement first.

Sets (Ace's decisions 2026-06-11):
  POSITIVES   = bookmarks tagged productive (dev/ai/startups/...) and NOT excluded.
  N-HARD      = bookmarks tagged ONLY excluded (politics/meme/sports/crypto/...).
  N-SOFT      = non-selected items from morning-digest debug pool history.
Bookmarks-only (likes held out). crypto = excluded UNLESS a strong AI tag co-occurs.

USAGE
  calibrate_scoring.py --measure            # build sets, score, report (no changes)
  calibrate_scoring.py --measure --limit 400
"""
from __future__ import annotations
import argparse, json, os, sqlite3, statistics, sys, glob, random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score_digest as SD
from score_digest import score_item, _load_thought_leaders, _load_tracked_projects

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prisma", "dev.db")
DIGEST_DIR = os.path.expanduser("~/.hermes/state/cron/morning-digest")
EVAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "eval", "calibration")

PRODUCTIVE = {"developer-tools", "dev-tools", "ai-ml", "ai-resources", "tech-industry",
              "startups-business", "design-product", "design", "productivity",
              "security", "security-privacy", "finance-investing"}
EXCLUDED = {"politics", "news", "meme-humor", "funny-memes", "health-wellness", "health",
            "entertainment", "sports", "food-drink", "gaming", "crypto-web3", "finance-crypto"}
STRONG_AI = {"ai-ml", "ai-resources"}  # crypto conditional-include only with these


# ── heuristic labeler (free, for the Step-3 baseline) ───────────────────────
LAUNCH_KW = ("launch", "launching", "launched", "shipped", "shipping", "releasing",
             "released", "introducing", "announce", "announcing", "now available", "out now")
TUTORIAL_KW = ("how to", "guide", "tutorial", "step by step", "copy this", "here's how",
               "thread", "tips", "learn")
BENCHMARK_KW = ("benchmark", "leaderboard", "eval", "evals", "scores", "sota", "outperform")
ANALYSIS_KW = ("why", "because", "the reason", "turns out", "i think", "analysis", "deep dive")
PROMO_KW = ("discount", "sign up", "join the waitlist", "promo", "sponsored", "buy now")


def heuristic_labels(text, tags):
    t = (text or "").lower()
    tagset = set(tags)
    if any(k in t for k in LAUNCH_KW):
        ct = "launch"
    elif any(k in t for k in BENCHMARK_KW):
        ct = "benchmark"
    elif any(k in t for k in TUTORIAL_KW):
        ct = "tutorial"
    elif any(k in t for k in PROMO_KW):
        ct = "promo"
    elif any(k in t for k in ANALYSIS_KW):
        ct = "analysis"
    else:
        ct = "field_report" if len(t.split()) > 12 else "opinion"
    # actionability
    if ct in ("launch", "tutorial", "benchmark"):
        ac = "actionable_now"
    elif ct in ("analysis", "field_report"):
        ac = "reference"
    else:
        ac = "context_only"
    sub = "concrete" if len(t.split()) > 14 else ("mixed" if len(t.split()) > 6 else "vague")
    # on_topic from tags (productive tags = core; excluded-only = off)
    if tagset & PRODUCTIVE:
        ot = "core"
    elif tagset & EXCLUDED:
        ot = "off"
    else:
        ot = "adjacent"
    return {"content_type": ct, "actionability": ac, "substance": sub, "on_topic": ot}


def _metrics(raw):
    try:
        pm = (raw.get("tweet") or {}).get("public_metrics") or {}
        return pm.get("like_count", 0) or 0, pm.get("retweet_count", 0) or 0
    except Exception:
        return 0, 0


def _created(raw):
    try:
        return (raw.get("tweet") or {}).get("created_at")
    except Exception:
        return None


def classify(tags):
    """positive | hard_neg | mixed | neither, per Ace's rules (crypto conditional)."""
    ts = set(tags)
    has_prod = bool(ts & PRODUCTIVE)
    has_excl = bool(ts & EXCLUDED)
    # crypto-with-strong-AI is a conditional positive
    crypto = bool(ts & {"crypto-web3", "finance-crypto"})
    if crypto and (ts & STRONG_AI):
        return "positive"
    if has_prod and not has_excl:
        return "positive"
    if has_excl and not has_prod:
        return "hard_neg"
    if has_prod and has_excl:
        return "mixed"
    return "neither"


def load_bookmarks(limit=None):
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT text, authorHandle, rawJson, semanticTags FROM Bookmark WHERE source='bookmark'"
    ).fetchall()
    con.close()
    pos, hardneg = [], []
    for text, handle, rawjson, tagjson in rows:
        try:
            tags = json.loads(tagjson) if tagjson else []
        except Exception:
            tags = []
        try:
            raw = json.loads(rawjson) if rawjson else {}
        except Exception:
            raw = {}
        likes, rts = _metrics(raw)
        item = {"source": "x", "authorHandle": handle, "tweet_text": text,
                "likes": likes, "retweets": rts, "published_at": _created(raw),
                "signals": {}, **heuristic_labels(text, tags)}
        cls = classify(tags)
        if cls == "positive":
            pos.append(item)
        elif cls == "hard_neg":
            hardneg.append(item)
    if limit:
        random.seed(42)
        pos = random.sample(pos, min(limit, len(pos)))
        hardneg = random.sample(hardneg, min(limit, len(hardneg)))
    return pos, hardneg


def load_soft_negatives(limit=None):
    """Non-selected items from morning-digest debug pool history. These already
    carry production labels (content_type etc.), so use them as-is."""
    soft = []
    seen = set()
    for path in sorted(glob.glob(os.path.join(DIGEST_DIR, "_*debug*.json"))) + [
            os.path.join(DIGEST_DIR, "_last_run_debug.json")]:
        try:
            data = json.load(open(path))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        for it in data.get("all_scored", []):
            tid = it.get("tweet_id") or it.get("id")
            if tid in seen:
                continue
            seen.add(tid)
            # a "soft negative" = an item that did NOT get selected (below gate)
            dr = str(it.get("dropped_reason") or "")
            if dr.startswith("below") or dr in ("topic_dup", "seen_dedupe"):
                soft.append(it)
    if limit:
        random.seed(43)
        soft = random.sample(soft, min(limit, len(soft)))
    return soft


def score_all(items, tl, ta, trk):
    out = []
    for it in items:
        try:
            s = score_item(it, tl, ta, trk)
            out.append(s["_final"])
        except Exception:
            continue
    return out


def auc(pos, neg):
    """Probability a random positive outranks a random negative (Mann-Whitney)."""
    if not pos or not neg:
        return float("nan")
    wins = ties = 0
    # O(n*m) is fine at these sizes
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1
            elif p == n:
                ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def quart(xs):
    if not xs:
        return {}
    xs = sorted(xs)
    return {"n": len(xs), "min": min(xs), "p25": _pct(xs, 25), "median": statistics.median(xs),
            "p75": _pct(xs, 75), "max": max(xs), "mean": round(statistics.mean(xs), 1)}


def _pct(sorted_xs, p):
    k = (len(sorted_xs) - 1) * p / 100.0
    f = int(k)
    return sorted_xs[f] if f + 1 >= len(sorted_xs) else round(sorted_xs[f] + (k - f) * (sorted_xs[f + 1] - sorted_xs[f]), 1)


def histogram(xs, width=40, buckets=10):
    if not xs:
        return ""
    lines = []
    for b in range(buckets):
        lo, hi = b * 100 / buckets, (b + 1) * 100 / buckets
        c = sum(1 for x in xs if lo <= x < hi or (b == buckets - 1 and x == 100))
        bar = "█" * int(round(width * c / max(1, len(xs))))
        lines.append(f"  {lo:3.0f}-{hi:3.0f}: {bar} {c}")
    return "\n".join(lines)


def measure(limit=None):
    tl, ta = _load_thought_leaders()
    trk = set(_load_tracked_projects())
    pos_items, hardneg_items = load_bookmarks(limit)
    soft_items = load_soft_negatives(limit)

    pos = score_all(pos_items, tl, ta, trk)
    hardneg = score_all(hardneg_items, tl, ta, trk)
    soft = score_all(soft_items, tl, ta, trk)

    report = []
    report.append("=" * 64)
    report.append("STEP 3 — bookmark-calibration MEASUREMENT (current constants)")
    report.append(f"gates: TOP={SD.TOP_GATE} ALSO={SD.ALSO_GATE} cap={SD.LOW_REACH_SCORE_CAP}")
    report.append("=" * 64)
    for name, xs in (("POSITIVES (productive bookmarks)", pos),
                     ("HARD NEG (politics/meme/sports/crypto bookmarks)", hardneg),
                     ("SOFT NEG (below-gate digest-pool noise)", soft)):
        report.append(f"\n## {name}")
        report.append(f"  {quart(xs)}")
        report.append(histogram(xs))
    report.append("\n## SEPARATION (AUC = P(random positive outranks random negative))")
    report.append(f"  AUC(positives vs hard-neg) : {auc(pos, hardneg):.3f}")
    report.append(f"  AUC(positives vs soft-neg) : {auc(pos, soft):.3f}")
    if pos and hardneg:
        below = sum(1 for p in pos if p < SD.TOP_GATE)
        cleared = sum(1 for n in hardneg if n >= SD.TOP_GATE)
        report.append(f"\n## OVERLAP @ TOP_GATE={SD.TOP_GATE}")
        report.append(f"  positives BELOW gate: {below}/{len(pos)} ({100*below/len(pos):.0f}%) — these are good posts the scorer would drop")
        report.append(f"  hard-negs CLEARING gate: {cleared}/{len(hardneg)} ({100*cleared/len(hardneg):.0f}%) — noise the scorer would surface")
    # per-term variance on positives — proves base/recency are near-constant
    report.append("\n## PER-TERM VARIANCE on positives (low variance = term does no work)")
    terms = {"base": [], "engagement": [], "author": [], "pf": [], "recency": [], "media": []}
    for it in pos_items:
        try:
            b = score_item(it, tl, ta, trk)["_breakdown"]
            for k in terms:
                terms[k].append(b[k])
        except Exception:
            pass
    for k, xs in terms.items():
        if xs:
            report.append(f"  {k:11}: mean={statistics.mean(xs):5.1f} stdev={statistics.pstdev(xs):4.1f} range=[{min(xs)},{max(xs)}]")
    text = "\n".join(report)
    print(text)

    os.makedirs(EVAL_DIR, exist_ok=True)
    json.dump({"positives": pos, "hard_neg": hardneg, "soft_neg": soft,
               "auc_pos_vs_hardneg": auc(pos, hardneg), "auc_pos_vs_softneg": auc(pos, soft),
               "gates": {"top": SD.TOP_GATE, "also": SD.ALSO_GATE},
               "counts": {"pos": len(pos), "hardneg": len(hardneg), "soft": len(soft)}},
              open(os.path.join(EVAL_DIR, "step3-measurement.json"), "w"), indent=2)
    open(os.path.join(EVAL_DIR, "step3-report.txt"), "w").write(text)
    print(f"\n-> {EVAL_DIR}/step3-report.txt + step3-measurement.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    if args.measure:
        measure(args.limit)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
