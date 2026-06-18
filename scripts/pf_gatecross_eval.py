#!/usr/bin/env python3
"""pf-gatecross-eval — rigorous PF embed-promotion gate evaluator.

For each brief, re-runs the LIVE deterministic selection twice over the brief's
real scored pool — once with the live keyword PF delta, once with the would-be
embed PF delta (both pulled from the latest pf-audit artifact) — and reports the
true posted<->not-posted GATE-CROSS %, plus the embed-baseline calibration health
(why items move). Read-only; never posts a brief, never mutates state.

Used by the weekly eval cron (siftly-pf-gate-eval) and runnable by hand:
    python3 scripts/pf_gatecross_eval.py            # human table
    python3 scripts/pf_gatecross_eval.py --json     # machine summary
"""
import sys, os, json, glob, copy, argparse, statistics as st

sys.path.insert(0, os.path.expanduser("~/Projects/siftly-ace/scripts"))
import score_digest as sd  # noqa: E402

PFA = os.path.expanduser("~/.hermes/state/x-bookmarks/pf-audit")
POOLS = {
    "morning-digest": os.path.expanduser("~/.hermes/state/cron/morning-digest/_last_run_debug.json"),
    "x-feed-brief":   os.path.expanduser("~/.hermes/state/cron/x-feed-brief/_last_run_scored.json"),
}
GATES = {
    "morning-digest": {},
    "x-feed-brief": dict(max_top=5, max_also=5, top_gate=60, also_gate=50),
}
GATE_THRESHOLD_PCT = 10.0  # AC#9: ≤10% gate-cross to promote


def _id(x):
    return x.get("id") or x.get("url") or x.get("tweet_id")


def _deltas(brief):
    files = sorted(glob.glob(f"{PFA}/{brief}-*.json"))
    if not files:
        return None, None
    j = json.load(open(files[-1]))
    out = {it["id"]: (it.get("keyword_personal_fit_delta"),
                      it.get("shadow_personal_fit_delta")) for it in j.get("items", [])}
    return out, os.path.basename(files[-1])


def _posted_set(pool, mode, dmap, gates):
    p = copy.deepcopy(pool)
    for it in p:
        d = dmap.get(_id(it))
        if d is not None and d[0 if mode == "kw" else 1] is not None:
            it["personal_fit_delta"] = d[0] if mode == "kw" else d[1]
    sel, also, _d, _m = sd.select_shadow(p, **gates)
    return {_id(x) for x in sel} | {_id(x) for x in also}


def eval_brief(brief):
    poolpath = POOLS[brief]
    if not os.path.exists(poolpath):
        return {"brief": brief, "error": f"no scored pool at {poolpath}"}
    data = json.load(open(poolpath))
    pool = data.get("all_scored") or data.get("pool") or []
    dmap, src = _deltas(brief)
    if not dmap or not pool:
        return {"brief": brief, "error": "no pf-audit deltas or empty pool"}
    matched = sum(1 for it in pool if _id(it) in dmap)
    kw = _posted_set(pool, "kw", dmap, GATES[brief])
    em = _posted_set(pool, "embed", dmap, GATES[brief])
    union = kw | em
    crossed = len(kw - em) + len(em - kw)
    pct = round(100 * crossed / max(1, len(union)), 1)
    kd = [dmap[_id(it)][0] for it in pool if _id(it) in dmap and dmap[_id(it)][0] is not None]
    ed = [dmap[_id(it)][1] for it in pool if _id(it) in dmap and dmap[_id(it)][1] is not None]
    return {
        "brief": brief, "source": src, "pool": len(pool),
        "matched_pct": round(100 * matched / len(pool)),
        "live_posted": len(kw), "embed_posted": len(em),
        "gate_cross": crossed, "gate_cross_pct": pct,
        "would_drop": len(kw - em), "would_enter": len(em - kw),
        "kw_delta_mean": round(st.mean(kd), 2) if kd else None,
        "kw_delta_range": [round(min(kd), 2), round(max(kd), 2)] if kd else None,
        "embed_delta_mean": round(st.mean(ed), 2) if ed else None,
        "embed_delta_range": [round(min(ed), 2), round(max(ed), 2)] if ed else None,
        "pass": pct <= GATE_THRESHOLD_PCT,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    results = [eval_brief(b) for b in POOLS]
    if args.json:
        print(json.dumps(results, indent=2))
        return
    for r in results:
        if r.get("error"):
            print(f"=== {r['brief']} === ERROR: {r['error']}")
            continue
        verdict = "PASS ✅" if r["pass"] else f"FAIL ❌ (>{GATE_THRESHOLD_PCT}%)"
        print(f"=== {r['brief']} ({r['source']}) ===")
        print(f"  pool={r['pool']} matched={r['matched_pct']}% | live-posted={r['live_posted']} embed-posted={r['embed_posted']}")
        print(f"  GATE-CROSS {r['gate_cross_pct']}% — {verdict}  (drop {r['would_drop']} / enter {r['would_enter']})")
        print(f"  kw Δ mean={r['kw_delta_mean']} {r['kw_delta_range']} | embed Δ mean={r['embed_delta_mean']} {r['embed_delta_range']}")
        if r["embed_delta_mean"] and r["kw_delta_mean"] is not None and r["embed_delta_mean"] - r["kw_delta_mean"] > 5:
            print("  ⚠ embed Δ is a large near-uniform positive offset → baseline (PF_BASELINE) likely miscalibrated for the embed affinity distribution; recalibrate before promoting.")


if __name__ == "__main__":
    main()
