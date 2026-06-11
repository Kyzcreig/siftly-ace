#!/usr/bin/env python3
"""
xfeed_shadow_test.py — #2 P2.2 regression net for the x-feed deterministic
shadow cutover.

Covers:
  - select_digest CLI gate/cap flags thread into the engine (P2.2 CLI surface).
  - morning-digest selection is BYTE-IDENTICAL when no overrides are passed
    (the load-bearing regression: shared engine must not regress morning-digest).
  - _item_text reads x-feed's text_snippet as a last-resort fallback (and ONLY
    last-resort: tweet_text still wins, so morning-digest is unaffected).
  - the shadow-diff harness's guard audit classifies an off-topic/political tweet
    as a GOOD drop and a real builder tweet (no guard) as an unexplained drop.
"""
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ItemTextFallbackTest(unittest.TestCase):
    def test_text_snippet_is_last_resort_only(self):
        import select_digest as SEL
        # tweet_text wins over snippet (morning-digest unaffected)
        self.assertEqual(
            SEL._item_text({"tweet_text": "real full text", "text_snippet": "snip"}),
            "real full text")
        # snippet used only when nothing else present (x-feed dump rows)
        self.assertEqual(SEL._item_text({"text_snippet": "snippet only"}), "snippet only")
        # title still beats snippet
        self.assertEqual(
            SEL._item_text({"title": "t", "text_snippet": "s"}), "t")


class CliGateFlagsTest(unittest.TestCase):
    """The P2.2 CLI flags must reach select_shadow's gates (proven by behavior:
    a tighter gate must drop an item a looser gate keeps)."""

    def _run(self, pool, extra):
        with tempfile.TemporaryDirectory() as d:
            inp = os.path.join(d, "in.json")
            out = os.path.join(d, "out.json")
            json.dump({"all_scored": pool}, open(inp, "w"))
            r = subprocess.run(
                [sys.executable, str(ROOT / "select_digest.py"),
                 "--engine", "deterministic", "--in", inp, "--out", out] + extra,
                capture_output=True, text=True, env={**os.environ, "RECENCY_AS_TIEBREAK": "1"})
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.load(open(out))

    def test_gate_flags_change_selection(self):
        # A solid on-topic builder tweet from a known-ish handle. With a low gate
        # it should be selectable; with a very high gate it should not clear Top.
        pool = [{
            "source": "x", "authorHandle": "steipete", "tweet_id": "1",
            "url": "https://x.com/steipete/status/1",
            "tweet_text": "I built a coding agent loop: codex maintains the repo, "
                          "wakes every 5 min, dispatches work to threads. Real numbers: "
                          "40% faster PR turnaround.",
            "likes": 850, "retweets": 30,
            "content_type": "field_report", "actionability": "actionable_now",
            "substance": "concrete", "on_topic": "core",
        }]
        loose = self._run(pool, ["--max-top", "5", "--max-also", "5",
                                 "--top-gate", "40", "--also-gate", "30"])
        tight = self._run(pool, ["--max-top", "5", "--max-also", "5",
                                 "--top-gate", "99", "--also-gate", "98"])
        loose_n = len(loose["selected"]) + len(loose["also"])
        tight_n = len(tight["selected"]) + len(tight["also"])
        self.assertGreater(loose_n, 0, "loose gate should select the builder tweet")
        self.assertEqual(tight_n, 0, "gate=99 should drop everything (flags reached engine)")


class MorningDigestRegressionTest(unittest.TestCase):
    """No overrides → byte-identical to the engine's own selftest defaults."""

    def test_selftests_still_pass(self):
        for script in ("score_digest.py", "select_digest.py"):
            r = subprocess.run([sys.executable, str(ROOT / script), "--selftest"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{script} selftest failed:\n{r.stdout}\n{r.stderr}")

    def test_default_kwargs_match_module_constants(self):
        import score_digest as S
        importlib.reload(S)
        # The override path must default to the module constants (no silent drift).
        pool = [{
            "source": "x", "authorHandle": "emollick", "tweet_id": "9",
            "tweet_text": "New benchmark: GPT-X scores 88 on the agentic eval, "
                          "a concrete result worth saving for routing decisions.",
            "likes": 5000, "retweets": 200,
            "content_type": "benchmark", "actionability": "reference",
            "substance": "concrete", "on_topic": "core",
        }]
        tl, ta = S._load_thought_leaders()
        trk = set(S._load_tracked_projects())
        a = S.select_shadow([dict(pool[0])], tl, ta, trk)
        b = S.select_shadow([dict(pool[0])], tl, ta, trk,
                            max_top=S.MAX_TOP, max_also=S.MAX_ALSO,
                            top_gate=S.TOP_GATE, also_gate=S.ALSO_GATE)
        # Same selection + same gates recorded in meta.
        self.assertEqual([i["_final"] for i in a[0]], [i["_final"] for i in b[0]])
        self.assertEqual(a[3]["gates"], b[3]["gates"])


class ShadowHarnessGuardAuditTest(unittest.TestCase):
    """The harness must call an off-topic/political legacy-posted tweet a GOOD
    (guard-explained) drop, and a real builder tweet an unexplained drop."""

    def _snapshot(self, rows):
        return {"all_scored": rows,
                "selected_top_ids": [r["tweet_id"] for r in rows],
                "quick_hits_ids": []}

    def test_guard_classifies_offtopic_vs_unexplained(self):
        import xfeed_shadow as H
        political = {
            "source": "x", "authorHandle": "VigilantFox", "tweet_id": "100",
            "url": "https://x.com/VigilantFox/status/100",
            "text_snippet": "Ivermectin is the wonder drug that keeps on giving for treating disease",
            "final_score": 61, "base_score": 61,
            "content_type": "news", "actionability": "none",
            "substance": "vague", "on_topic": "off",
        }
        builder = {
            "source": "x", "authorHandle": "steipete", "tweet_id": "101",
            "url": "https://x.com/steipete/status/101",
            "text_snippet": "Here's a simple loop: tell codex to maintain your repos and dispatch work to threads",
            "likes": 850, "retweets": 30,
            "final_score": 67, "base_score": 67,
            "content_type": "field_report", "actionability": "actionable_now",
            "substance": "concrete", "on_topic": "core",
        }
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "snap.json")
            json.dump(self._snapshot([political, builder]), open(p, "w"))
            # Force the deterministic engine to drop BOTH (gate above their scores)
            # so the guard audit runs on each: political => good drop, builder =>
            # unexplained (no guard — only the gate cut it).
            diff = H._diff_one(p, max_top=5, max_also=5, top_gate=95, also_gate=90)
        good_handles = {g["handle"] for g in diff["good_drops"]}
        bad_handles = {b["handle"] for b in diff["bad_drops"]}
        self.assertIn("VigilantFox", good_handles, "political/health tweet must be a guard-explained drop")
        self.assertIn("steipete", bad_handles, "real builder tweet has no guard → unexplained drop")


if __name__ == "__main__":
    unittest.main()
