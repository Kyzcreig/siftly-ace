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

    def test_bar1_reds_known_bad_at_top(self):
        _, code, reds = self._run("bar1")
        self.assertEqual(code, 1)
        self.assertIn("bar1_no_known_bad_top", reds)
        # documented entailment: a known_bad >= TOP_GATE(49) is also > min_good(<49),
        # so bar1 STRICTLY IMPLIES bar4 at this corpus. Assert exactly {bar1,bar4}.
        self.assertEqual(reds, {"bar1_no_known_bad_top", "bar4_no_inversion"},
                         "bar1 probe must red exactly bar1 + its entailed bar4")

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

    def test_bar4_isolates_below_top_gate(self):
        _, code, reds = self._run("bar4")
        self.assertEqual(code, 1)
        # bar4's probe scores min_good+1, which is < TOP_GATE, so bar1 stays green —
        # proving bar4 has independent teeth (inversion without breaching TOP).
        self.assertEqual(reds, {"bar4_no_inversion"},
                         "bar4 probe must red ONLY bar4 (stays below TOP_GATE)")


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
