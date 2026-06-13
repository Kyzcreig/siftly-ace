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

# Minimum real (non-synthetic) corpus size for a non-vacuous certification. Set below the
# curated 15-item gold set so legitimate pruning is allowed, while a truncated/empty fixture
# fails loud instead of passing the bars vacuously (Review Blocker 5).
MIN_CORPUS = 10

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


# Mutation matrix (D-4 anti-rubber-stamp): each `--mutate barN` must make EXACTLY
# barN red and leave the other three green, proving that bar has teeth. The earlier
# design mutated engine globals (S.BASE / S.OFF_TOPIC_PEN), which could NOT isolate a
# bar — e.g. zeroing OFF_TOPIC_PEN["off"] lifted an unrelated *neutral* over TOP_GATE
# and red bar3 while targeting bar1/bar4. Cross-bar leakage = the bar's teeth are
# unproven, the exact failure the matrix exists to catch.
#
# Isolation-correct design: score every REAL gold item through the UNPERTURBED engine,
# then inject ONE synthetic probe of the target label whose post-score `final` is forced
# to violate only that bar. No engine global is touched, so no other item can move and
# no other bar can flip. The probe carries `_forced_final` consumed in evaluate().
def _mutation_probe(kind, min_good):
    """Return (probe_item, note). probe_item is scored as itself but its `final` is
    overridden to `_forced_final`, violating exactly `kind`'s bar. `min_good` is the
    weakest real known_good score, used so bar4's inversion probe stays below TOP_GATE
    (and therefore reds bar4 in isolation, without also tripping bar1)."""
    base = {"id": f"MUT-{kind}", "source": "x", "handle": "mutation_probe",
            "likes": 0, "retweets": 0, "text": "mutation probe",
            "content_type": "news", "actionability": "none",
            "substance": "vague", "on_topic": "off"}
    if kind == "bar1":   # no known_bad >= TOP_GATE
        base.update(label="known_bad", _forced_final=float(TOP_GATE_EXPECTED + 1))
        return base, f"synthetic known_bad forced to {TOP_GATE_EXPECTED + 1} (>= TOP_GATE) -> bar1 reds"
    if kind == "bar2":   # every known_good >= ALSO_GATE
        base.update(label="known_good", _forced_final=float(ALSO_GATE_EXPECTED - 1))
        return base, f"synthetic known_good forced to {ALSO_GATE_EXPECTED - 1} (< ALSO_GATE) -> bar2 reds"
    if kind == "bar3":   # no neutral >= TOP_GATE
        base.update(label="neutral", _forced_final=float(TOP_GATE_EXPECTED + 1))
        return base, f"synthetic neutral forced to {TOP_GATE_EXPECTED + 1} (>= TOP_GATE) -> bar3 reds"
    if kind == "bar4":   # no known_bad final > the WEAKEST known_good (min_good)
        base.update(label="known_bad", _forced_final=float(min_good + 1))
        return base, (f"synthetic known_bad forced to min_good+1 ({min_good + 1}) -> bar4 reds "
                      f"(inversion vs weakest known_good); stays < TOP_GATE so bar1 unaffected")
    raise SystemExit(f"unknown mutation {kind!r}")


def evaluate(data, mutate=None):
    """Score the gold set through the real pipeline; return (result dict, exit_code)."""
    os.environ["RECENCY_AS_TIEBREAK"] = "1"
    import importlib
    import score_digest as S
    importlib.reload(S)

    mutation_note = None

    # D-10 gate-pin: the engine's resolved tiebreak gates must equal the single literal.
    if S.TOP_GATE != TOP_GATE_EXPECTED or S.ALSO_GATE != ALSO_GATE_EXPECTED:
        print(f"GATE-PIN FAIL: engine gates TOP={S.TOP_GATE}/ALSO={S.ALSO_GATE} "
              f"!= expected {TOP_GATE_EXPECTED}/{ALSO_GATE_EXPECTED}", file=sys.stderr)
        return {"error": "gate-pin"}, 1

    pool = [_to_engine(it) for it in data["items"]]

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

    # Mutation matrix (D-4): inject ONE forced-score synthetic probe of the target
    # label AFTER all real items are scored through the unperturbed engine. The probe's
    # `final` is set directly (no engine global touched), so EXACTLY the target bar can
    # red and no real item's score moves. bar4's probe needs the real min_good first.
    if mutate:
        real_min_good = min((r["final"] for r in scored if r["label"] == "known_good"),
                            default=0.0)
        probe, mutation_note = _mutation_probe(mutate, real_min_good)
        scored.append({
            "id": probe["id"], "label": probe["label"], "handle": probe["handle"],
            "final": probe["_forced_final"], "low_reach_capped": False,
            "coerced": False, "source": probe["source"], "synthetic": True,
        })

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
    # bar4 (anti-inversion): no known_bad may outscore the WEAKEST known_good. Using
    # min_good (not max_good) is the strict reading of "no known_bad > any known_good"
    # and is the stronger guard — a known_bad beating even your weakest real builder is
    # an inversion. (Pass-3 RC-4: this is a score-level check, independent of placement.)
    min_good = min((r["final"] for r in goods), default=0.0)
    bar4 = [r["id"] for r in bads if r["final"] > min_good]

    bars = {
        "bar1_no_known_bad_top": not bar1,
        "bar2_known_good_clears_also": not bar2,
        "bar3_no_neutral_top": not bar3,
        "bar4_no_inversion": not bar4,
    }
    # Non-emptiness floor (dogfood finding): an empty/hollow fixture would satisfy all 4
    # bars VACUOUSLY (no item to violate them) and green-light a cutover against nothing.
    # Silent-pass is unacceptable — require a real corpus with all three label classes.
    # MUT-* synthetic probes don't count toward the real-corpus floor. The MIN_CORPUS
    # threshold (named, not a bare literal — Review Blocker 5) is set below the curated
    # gold-set size (15) so legitimate pruning to ~10 is allowed, while a truncated/empty
    # fixture fails. Per-class ≥1 also guarantees bar4's min_good comes from a REAL
    # known_good (an all-synthetic-good set can't satisfy the inversion bar).
    real = [r for r in scored if not r.get("synthetic")]
    n_good = sum(1 for r in real if r["label"] == "known_good")
    n_bad = sum(1 for r in real if r["label"] == "known_bad")
    n_neutral = sum(1 for r in real if r["label"] == "neutral")
    corpus_floor_ok = (len(real) >= MIN_CORPUS
                       and n_good >= 1 and n_bad >= 1 and n_neutral >= 1)
    # synthetic probe is exempt from the coercion check (it carries a forced score, not
    # a real engine path); only real gold items must be fully labeled / non-coerced.
    coerced = [r["id"] for r in scored if r["coerced"] and not r.get("synthetic")]
    passed = (all(bars.values()) and not coerced and not hn_cap_errs
              and corpus_floor_ok)

    result = {
        "gates": {"top": S.TOP_GATE, "also": S.ALSO_GATE},
        "scored": scored, "bars": bars,
        "corpus_floor_ok": corpus_floor_ok,
        "corpus_counts": {"total": len(real), "known_good": n_good,
                          "known_bad": n_bad, "neutral": n_neutral},
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
    if not result.get("corpus_floor_ok", True):
        c = result.get("corpus_counts", {})
        print(f"    FAIL  corpus floor (hollow/empty fixture): total={c.get('total')} "
              f"known_good={c.get('known_good')} known_bad={c.get('known_bad')} neutral={c.get('neutral')} "
              f"— need ≥10 items with ≥1 of each class (bars pass vacuously otherwise)")
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
