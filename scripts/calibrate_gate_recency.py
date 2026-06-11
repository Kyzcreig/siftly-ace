#!/usr/bin/env python3
"""
calibrate_gate_recency.py — derive the recency-tiebreak gates AND prove the
cutover is selection-preserving on the live morning-digest debug pool.

Runs the full select_shadow pipeline on the last real debug pool under:
  - CURRENT live (additive recency +10, gates 58/50)
  - TIEBREAK    (recency=0 additive, gates 49/45)
and diffs the selected/also sets. The cutover is sound iff the posted items are
the same (selection-preserving) — recency stops inflating absolute scores but
must not change WHAT gets posted.
"""
import importlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

POOL_PATH = os.path.expanduser(
    "~/.hermes/state/cron/morning-digest/_last_run_debug.json")


def run(tiebreak):
    os.environ["RECENCY_AS_TIEBREAK"] = "1" if tiebreak else ""
    import score_digest as S
    importlib.reload(S)
    pool = json.load(open(POOL_PATH))["all_scored"]
    tl, ta = S._load_thought_leaders()
    trk = set(S._load_tracked_projects())
    sel, also, disc, meta = S.select_shadow([dict(it) for it in pool], tl, ta, trk)
    key = lambda it: it.get("tweet_id") or it.get("url") or S._item_text(it)[:60]
    return {
        "gates": (S.TOP_GATE, S.ALSO_GATE),
        "selected": [key(it) for it in sel],
        "also": [key(it) for it in also],
        "sel_titles": [(round(it["_final"]), (it.get("authorHandle") or it.get("source")), S._item_text(it)[:50]) for it in sel],
        "also_titles": [(round(it["_final"]), (it.get("authorHandle") or it.get("source")), S._item_text(it)[:50]) for it in also],
    }


def main():
    cur = run(False)
    tb = run(True)
    print(f"CURRENT live  gates={cur['gates']}  selected={len(cur['selected'])} also={len(cur['also'])}")
    print(f"TIEBREAK      gates={tb['gates']}  selected={len(tb['selected'])} also={len(tb['also'])}\n")

    sel_same = cur["selected"] == tb["selected"]
    also_same = cur["also"] == tb["also"]
    print(f"SELECTED identical (same items, same order): {sel_same}")
    print(f"ALSO     identical (same items, same order): {also_same}")

    sel_set_same = set(cur["selected"]) == set(tb["selected"])
    also_set_same = set(cur["also"]) == set(tb["also"])
    print(f"SELECTED set-equal (same items, any order):  {sel_set_same}")
    print(f"ALSO     set-equal (same items, any order):  {also_set_same}\n")

    print("CURRENT selected:")
    for t in cur["sel_titles"]:
        print(f"   {t[0]:>3}  @{t[1]:<16} {t[2]}")
    print("TIEBREAK selected:")
    for t in tb["sel_titles"]:
        print(f"   {t[0]:>3}  @{t[1]:<16} {t[2]}")

    if not (sel_set_same and also_set_same):
        print("\n[!] DIVERGENCE — items differ:")
        print("  only in CURRENT selected:", set(cur["selected"]) - set(tb["selected"]))
        print("  only in TIEBREAK selected:", set(tb["selected"]) - set(cur["selected"]))
        print("  only in CURRENT also:", set(cur["also"]) - set(tb["also"]))
        print("  only in TIEBREAK also:", set(tb["also"]) - set(cur["also"]))
        sys.exit(1)
    print("\nPARITY: posted items are identical between modes. Cutover is selection-preserving.")


if __name__ == "__main__":
    main()
