#!/usr/bin/env python3
"""
gold_set_eval_test.py — regression net for the §6a gold-set certification harness
(PRD-gold-set-certification, v5 APPROVED).

The harness exists to PROVE the deterministic digest scorer holds 4 score-framed
bars on a ratified gold fixture. These tests prove the HARNESS itself has teeth —
the anti-rubber-stamp requirement (D-4): if a bar can't be made to red, it isn't
really being asserted.

Covers:
  - clean cert: the ratified gold set passes 4/4 bars (exit 0).
  - mutation matrix: each `--mutate barN` reds its target bar.
  - isolation: bar2/bar3/bar4 red ONLY their target; bar1 reds {bar1,bar4} by a
    documented structural entailment (a known_bad >= TOP_GATE is necessarily
    > min_good when min_good < TOP_GATE), which is asserted explicitly, not hidden.
  - no-leak: running a mutation then a clean cert in the SAME process leaves the
    clean cert green (the harness reloads score_digest; no global mutation persists).
  - validate-only: every gold item is fully labeled (no coercion).
  - gate-pin: the harness's expected gates match the live engine (49/45).
"""
import importlib
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _fresh_harness():
    """Import (or reimport) the harness fresh so no module state crosses tests."""
    if "gold_set_eval" in sys.modules:
        del sys.modules["gold_set_eval"]
    import gold_set_eval as G  # noqa: E402
    return G


class CleanCertTest(unittest.TestCase):
    def test_ratified_gold_set_passes_all_bars(self):
        G = _fresh_harness()
        data = G._load()
        result, code = G.evaluate(data)
        self.assertEqual(code, 0, f"clean cert must pass; violations={result.get('violations')}")
        self.assertTrue(all(result["bars"].values()), result["bars"])

    def test_validate_only_all_items_labeled(self):
        G = _fresh_harness()
        errs = G.validate(G._load())
        self.assertEqual(errs, [], f"every gold item must be fully labeled; errs={errs}")


class MutationMatrixTest(unittest.TestCase):
    """D-4: each bar must be make-able to red, else it isn't really asserted."""

    def _run(self, mutate):
        G = _fresh_harness()
        result, code = G.evaluate(G._load(), mutate=mutate)
        reds = {k for k, ok in result["bars"].items() if not ok}
        return result, code, reds

    def _min_good_vs_top(self):
        """The bar1<->bar4 entailment direction depends on whether the weakest real
        known_good sits above or below TOP_GATE — derive it from a clean run so these
        tests don't hardcode a direction that silently rots when corpus scores shift
        (e.g. the hn_points crowd-signal term lifted min_good above TOP_GATE)."""
        G = _fresh_harness()
        result, _ = G.evaluate(G._load())
        goods = [r["final"] for r in result["scored"] if r["label"] == "known_good"]
        return min(goods), G.TOP_GATE_EXPECTED

    def test_bar1_reds_known_bad_at_top(self):
        _, code, reds = self._run("bar1")
        self.assertEqual(code, 1)
        self.assertIn("bar1_no_known_bad_top", reds)
        # Entailment: bar1's probe scores TOP_GATE+1. It ALSO reds bar4 iff that score
        # exceeds the weakest known_good (min_good). So bar1 entails bar4 only when
        # min_good < TOP_GATE+1. Assert the live-derived expectation, not a fixed set.
        min_good, top = self._min_good_vs_top()
        expected = {"bar1_no_known_bad_top"}
        if (top + 1) > min_good:
            expected.add("bar4_no_inversion")  # known_bad at TOP+1 also out-scores min_good
        self.assertEqual(reds, expected,
                         f"bar1 reds must match entailment (min_good={min_good}, TOP={top})")

    def test_bar2_isolates(self):
        _, code, reds = self._run("bar2")
        self.assertEqual(code, 1)
        self.assertEqual(reds, {"bar2_known_good_clears_also"},
                         "bar2 probe must red ONLY bar2")

    def test_bar3_isolates(self):
        _, code, reds = self._run("bar3")
        self.assertEqual(code, 1)
        self.assertEqual(reds, {"bar3_no_neutral_top"},
                         "bar3 probe must red ONLY bar3")

    def test_bar4_reds_inversion(self):
        _, code, reds = self._run("bar4")
        self.assertEqual(code, 1)
        self.assertIn("bar4_no_inversion", reds)
        # bar4's probe scores min_good+1. It ALSO reds bar1 iff that score >= TOP_GATE,
        # i.e. when min_good+1 >= TOP_GATE (min_good is at/above the gate). Derive it.
        min_good, top = self._min_good_vs_top()
        expected = {"bar4_no_inversion"}
        if (min_good + 1) >= top:
            expected.add("bar1_no_known_bad_top")  # inversion probe also breaches TOP
        self.assertEqual(reds, expected,
                         f"bar4 reds must match entailment (min_good={min_good}, TOP={top})")


class NoLeakTest(unittest.TestCase):
    def test_mutation_does_not_leak_into_subsequent_clean_cert(self):
        # Run a mutation, then a clean cert, IN THE SAME PROCESS. The harness reloads
        # score_digest inside evaluate(), so no perturbation can persist. (Belt-and-
        # suspenders: the new probe design never mutates an engine global anyway.)
        G = _fresh_harness()
        _, mcode = G.evaluate(G._load(), mutate="bar1")
        self.assertEqual(mcode, 1)
        result, code = G.evaluate(G._load())  # clean run, same process
        self.assertEqual(code, 0, f"clean cert after a mutation must still pass; "
                                  f"violations={result.get('violations')}")


class CorpusFloorTest(unittest.TestCase):
    """Dogfood finding: an empty/hollow fixture would pass all 4 bars VACUOUSLY and
    green-light a cutover against nothing. The non-emptiness floor must hard-fail it."""

    def test_empty_gold_set_fails_loud(self):
        G = _fresh_harness()
        result, code = G.evaluate({"items": []})
        self.assertEqual(code, 1, "empty gold set must FAIL, not pass vacuously")
        self.assertFalse(result["corpus_floor_ok"])

    def test_single_class_only_fails(self):
        # all known_good, no known_bad / neutral → bars 1/3/4 are vacuous → must fail.
        G = _fresh_harness()
        data = G._load()
        goods = [it for it in data["items"] if it.get("label") == "known_good"]
        result, code = G.evaluate({"items": goods})
        self.assertEqual(code, 1, "single-class fixture must FAIL the corpus floor")
        self.assertFalse(result["corpus_floor_ok"])

    def test_ratified_set_clears_floor(self):
        G = _fresh_harness()
        result, _ = G.evaluate(G._load())
        self.assertTrue(result["corpus_floor_ok"])
        c = result["corpus_counts"]
        self.assertGreaterEqual(c["total"], 10)
        self.assertTrue(c["known_good"] and c["known_bad"] and c["neutral"])

    def test_min_corpus_below_gold_manifest(self):
        # Pass-2 RC-4: the floor must sit BELOW the curated gold-set size so a legitimately
        # pruned corpus isn't false-failed, while a truncated one still fails. Lock the
        # relationship so a future MIN_CORPUS bump above the manifest can't silently land.
        G = _fresh_harness()
        manifest = len(G._load()["items"])
        self.assertLess(G.MIN_CORPUS, manifest,
                        f"MIN_CORPUS={G.MIN_CORPUS} must be < gold manifest size {manifest}")


class GatePinTest(unittest.TestCase):
    def test_expected_gates_match_live_engine(self):
        G = _fresh_harness()
        os.environ["RECENCY_AS_TIEBREAK"] = "1"
        import score_digest as S
        importlib.reload(S)
        self.assertEqual((S.TOP_GATE, S.ALSO_GATE),
                         (G.TOP_GATE_EXPECTED, G.ALSO_GATE_EXPECTED),
                         "harness gate-pin must equal live engine gates")


if __name__ == "__main__":
    unittest.main()
