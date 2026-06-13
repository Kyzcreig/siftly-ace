#!/usr/bin/env python3
"""
gold_set_eval.py — §6a gold-set certification harness for the deterministic digest
scorer (PRD-gold-set-certification, v5 APPROVED).

Scores the frozen gold set (docs/eval/digest-gold-set.json) through the REAL
production pipeline (score_digest.select_shadow under RECENCY_AS_TIEBREAK=1) and
asserts the 4 score-framed bars (D-4/D-11):

  Bar1: no known_bad has final >= TOP_GATE        (no spam/junk is TOP-worthy)
  Bar2: every known_good has final >= ALSO_GATE   (real builders clear the bar)
  Bar3: no neutral has final >= TOP_GATE          (low-value isn't TOP-worthy)
  Bar4: no known_bad's final exceeds any known_good's final  (anti-inversion)

Gate-pin (D-10): the engine's resolved tiebreak gates MUST equal 49/45 (one literal,
fed to both the pipeline and the assertion). HN items (D-9) are source="hackernews"
and the harness asserts they are NOT low-reach-capped (the cap is X-only).

Exit 0 = PASS (all 4 bars), 1 = FAIL or a structural error. The full per-item table
+ margins are printed so any result is auditable.

Usage:
  gold_set_eval.py                     # certify the (ratified) gold set
  gold_set_eval.py --validate-only     # only check all items are fully labeled
  gold_set_eval.py --mutate bar1|bar2|bar3|bar4   # test-only: perturb so that bar reds
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

GOLD = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "docs", "eval", "digest-gold-set.json")

# D-10: the expected tiebreak gates as a SINGLE literal, fed to both the pipeline
# and the gate-pin assertion. No re-typed 49/45 anywhere else.
TOP_GATE_EXPECTED = 49
ALSO_GATE_EXPECTED = 45

ENUM = {
    "content_type": {"launch", "benchmark", "tutorial", "field_report", "analysis",
                     "news", "opinion", "promo", "reply_fragment"},
    "actionability": {"actionable_now", "reference", "context_only", "none"},
    "substance": {"concrete", "mixed", "vague"},
    "on_topic": {"core", "adjacent", "off"},
}


def _load():
    with open(os.path.abspath(GOLD)) as f:
        return json.load(f)


def _to_engine(item):
    """Map a gold item to the engine schema (D-9: HN items source='hackernews',
    which the low-reach cap treats as not-X → exempt)."""
    e = dict(item)
    e["authorHandle"] = item.get("handle")
    e["tweet_text"] = item.get("text")
    src = (item.get("source") or "").lower()
    if src in ("hackernews", "hn"):
        e["source"] = "hackernews"
    else:
        e["source"] = "x"
    return e


def validate(data):
    """Assert every item carries all 4 valid enum labels (no coerce path). Returns
    list of errors (empty = ok)."""
    errs = []
    for it in data["items"]:
        for field, allowed in ENUM.items():
            v = it.get(field)
            if v is None:
                errs.append(f"{it['id']}: missing {field}")
            elif v not in allowed:
                errs.append(f"{it['id']}: {field}={v!r} not in {sorted(allowed)}")
    return errs


def _apply_mutation(S, kind):
    """Test-only: perturb the engine in-memory so EXACTLY `kind`'s bar reds.
    Runs in its own subprocess (the pytest harness isolates each), so module-level
    mutation here can never leak into another case."""
    if kind == "bar1":
        # lift a known_bad's promo BASE so its final clears TOP_GATE
        for ac in S.BASE["promo"]:
            S.BASE["promo"][ac] = 95
        S.OFF_TOPIC_PEN["off"] = 0          # let the spam's off-topic not sink it
        return "known_bad promo BASE->95, off_pen->0 (known_bad reaches TOP)"
    if kind == "bar2":
        # crush every BASE so a known_good can't clear ALSO_GATE
        for ct in S.BASE:
            for ac in S.BASE[ct]:
                S.BASE[ct][ac] = 0
        return "all BASE->0 (known_good drops below ALSO_GATE)"
    if kind == "bar3":
        # the synthetic neutral injected below scores high; here lift news BASE so
        # a neutral (news/context_only) clears TOP_GATE
        for ac in S.BASE["news"]:
            S.BASE["news"][ac] = 95
        return "news BASE->95 (synthetic neutral clears TOP_GATE)"
    if kind == "bar4":
        # zero the off-topic penalty so a high-engagement known_bad outscores a known_good
        S.OFF_TOPIC_PEN["off"] = 0
        S.BASE["promo"]["none"] = 90
        return "off_pen->0, promo BASE->90 (known_bad outscores known_good)"
    raise SystemExit(f"unknown mutation {kind!r}")


def evaluate(data, mutate=None):
    """Score the gold set through the real pipeline; return (result dict, exit_code)."""
    os.environ["RECENCY_AS_TIEBREAK"] = "1"
    import importlib
    import score_digest as S
    importlib.reload(S)

    mutation_note = None
    if mutate:
        # bar3 needs a synthetic neutral injected (production neutrals are floor-pinned, D-12)
        mutation_note = _apply_mutation(S, mutate)

    # D-10 gate-pin: the engine's resolved tiebreak gates must equal the single literal.
    if S.TOP_GATE != TOP_GATE_EXPECTED or S.ALSO_GATE != ALSO_GATE_EXPECTED:
        print(f"GATE-PIN FAIL: engine gates TOP={S.TOP_GATE}/ALSO={S.ALSO_GATE} "
              f"!= expected {TOP_GATE_EXPECTED}/{ALSO_GATE_EXPECTED}", file=sys.stderr)
        return {"error": "gate-pin"}, 1

    pool = [_to_engine(it) for it in data["items"]]
    # bar3 mutation: inject a synthetic neutral so the bar has something to red
    if mutate == "bar3":
        pool.append(_to_engine({
            "id": "synthetic-neutral", "source": "x", "handle": "synth_neutral",
            "likes": 5000, "retweets": 500, "text": "a synthetic on-topic AI model agent benchmark note",
            "label": "neutral", "content_type": "news", "actionability": "context_only",
            "substance": "mixed", "on_topic": "core",
        }))

    tl, ta = S._load_thought_leaders()
    trk = set(S._load_tracked_projects())

    # score each item; keep label + breakdown
    scored = []
    by_id = {}
    for raw in pool:
        gid = raw.get("id")
        label = raw.get("label")
        out = S.score_item(raw, tl, ta, trk,
                           low_reach_cap_val=ALSO_GATE_EXPECTED - 5)
        rec = {
            "id": gid, "label": label, "handle": raw.get("authorHandle"),
            "final": out["_final"], "low_reach_capped": out["_breakdown"]["low_reach_capped"],
            "coerced": out["_breakdown"]["label_coerced"],
            "source": raw.get("source"),
        }
        scored.append(rec)
        by_id[gid] = rec

    goods = [r for r in scored if r["label"] == "known_good"]
    bads = [r for r in scored if r["label"] == "known_bad"]
    neutrals = [r for r in scored if r["label"] == "neutral"]

    # D-9: HN known_goods must NOT be low-reach-capped (cap is X-only) — schema check
    hn_cap_errs = [r["id"] for r in goods
                   if r["source"] == "hackernews" and r["low_reach_capped"]]

    # the 4 score-framed bars (D-11)
    bar1 = [r["id"] for r in bads if r["final"] >= TOP_GATE_EXPECTED]
    bar2 = [r["id"] for r in goods if r["final"] < ALSO_GATE_EXPECTED]
    bar3 = [r["id"] for r in neutrals if r["final"] >= TOP_GATE_EXPECTED]
    max_good = max((r["final"] for r in goods), default=0.0)
    bar4 = [r["id"] for r in bads if r["final"] > max_good]

    bars = {
        "bar1_no_known_bad_top": not bar1,
        "bar2_known_good_clears_also": not bar2,
        "bar3_no_neutral_top": not bar3,
        "bar4_no_inversion": not bar4,
    }
    coerced = [r["id"] for r in scored if r["coerced"]]
    passed = all(bars.values()) and not coerced and not hn_cap_errs

    result = {
        "gates": {"top": S.TOP_GATE, "also": S.ALSO_GATE},
        "scored": scored, "bars": bars,
        "violations": {"bar1": bar1, "bar2": bar2, "bar3": bar3, "bar4": bar4,
                       "coerced": coerced, "hn_low_reach_capped": hn_cap_errs},
        "mutation": mutation_note,
        "passed": passed,
    }
    return result, (0 if passed else 1)


def _print_report(result):
    g = result["gates"]
    print(f"=== GOLD-SET CERTIFICATION (gates TOP={g['top']} ALSO={g['also']}, RECENCY_AS_TIEBREAK=1) ===")
    if result.get("mutation"):
        print(f"  [MUTATION ACTIVE: {result['mutation']}]")
    # per-item table with margins (D-7)
    print(f"  {'id':35} {'label':11} {'final':>6}  margin   notes")
    for r in sorted(result["scored"], key=lambda x: -x["final"]):
        if r["label"] == "known_good":
            margin = f"{r['final'] - ALSO_GATE_EXPECTED:+.0f} vs ALSO"
            warn = "  ⚠ THIN" if (r["final"] - ALSO_GATE_EXPECTED) < 5 else ""
        else:
            margin = f"{TOP_GATE_EXPECTED - r['final']:+.0f} vs TOP"
            warn = ""
        cap = " [low-reach-capped]" if r["low_reach_capped"] else ""
        print(f"  {r['id']:35} {r['label']:11} {r['final']:>6.1f}  {margin:12}{warn}{cap}")
    print("  ── bars ──")
    for k, v in result["bars"].items():
        print(f"    {'PASS' if v else 'FAIL'}  {k}")
    v = result["violations"]
    if v["coerced"]:
        print(f"    FAIL  label_coerced (unlabeled items): {v['coerced']}")
    if v["hn_low_reach_capped"]:
        print(f"    FAIL  HN known_good low-reach-capped (D-9 schema): {v['hn_low_reach_capped']}")
    n = sum(1 for x in result["bars"].values() if x)
    print(f"\nGOLD SET: {'PASS' if result['passed'] else 'FAIL'} ({n}/4 bars)")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate-only", action="store_true")
    ap.add_argument("--mutate", choices=["bar1", "bar2", "bar3", "bar4"], default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    data = _load()

    errs = validate(data)
    if args.validate_only:
        if errs:
            for e in errs:
                print(f"  {e}", file=sys.stderr)
            print(f"VALIDATE: FAIL ({len(errs)} issues)")
            return 1
        print(f"VALIDATE: 15/15 items fully labeled" if len(data["items"]) == 15
              else f"VALIDATE: {len(data['items'])}/{len(data['items'])} items fully labeled")
        return 0
    if errs:
        for e in errs:
            print(f"  {e}", file=sys.stderr)
        print("GOLD SET: FAIL — items not fully labeled (hard error, no coerce)", file=sys.stderr)
        return 1

    result, code = evaluate(data, mutate=args.mutate)
    if "error" in result:
        return code
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_report(result)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
