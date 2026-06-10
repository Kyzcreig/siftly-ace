#!/usr/bin/env python3
"""Unit tests for the brief-replay funnel reducers.

Run: python3 scripts/brief-replay/test_replay.py
(Pure stdlib unittest — no pytest dependency, matches the project's script style.)

The fixtures encode the Jun-10 2026 x-feed incident (1,809 scored, 1,796 below
gate, 8 topic_dup, 4 selected, 1 quick-hit; render manifest dropping a selected
tweet + a duplicated video idea) so the anomaly detectors are pinned to a real
regression.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import replay_x_feed as xf
import replay_morning_digest as md


def _scored_fixture():
    items = []
    # 4 selected (>=60), 1 quick (50-59), rest below 50, plus an 8-item topic_dup cluster
    items.append({"tweet_id": "A", "authorHandle": "AnthropicAI", "topic": "Fable5",
                  "base_score": 79, "personal_fit_delta": 5.7, "final_score": 85,
                  "signals": [], "dropped_reason": "selected"})
    items.append({"tweet_id": "B", "authorHandle": "PyTorch", "topic": "WinAI",
                  "base_score": 75, "personal_fit_delta": 5.7, "final_score": 81,
                  "signals": [], "dropped_reason": "selected"})
    items.append({"tweet_id": "C", "authorHandle": "hasantoxr", "topic": "AppleAI",
                  "base_score": 79, "personal_fit_delta": 1.3, "final_score": 80,
                  "signals": [], "dropped_reason": "selected"})
    items.append({"tweet_id": "D", "authorHandle": "mattpocockuk", "topic": "AgentSkills",
                  "base_score": 75, "personal_fit_delta": 3.4, "final_score": 78,
                  "signals": [], "dropped_reason": "selected"})
    items.append({"tweet_id": "E", "authorHandle": "NextFrontierX", "topic": "macOSAgentic",
                  "base_score": 70, "personal_fit_delta": 3.0, "final_score": 73,
                  "signals": [], "dropped_reason": "quick_hits"})
    # 8 topic_dup clones of Fable5 (all >=60 so topic-starvation can fire)
    for i in range(8):
        items.append({"tweet_id": f"dup{i}", "authorHandle": f"u{i}", "topic": "Fable5",
                      "base_score": 70, "personal_fit_delta": 6.0, "final_score": 74 - i,
                      "signals": [], "dropped_reason": "topic_dup:A"})
    # 1796 below gate
    for i in range(1796):
        items.append({"tweet_id": f"low{i}", "authorHandle": f"x{i}", "topic": f"t{i}",
                      "base_score": 20, "personal_fit_delta": 0.0, "final_score": 20,
                      "signals": [], "dropped_reason": "below_50"})
    return {
        "run_id": "fixture", "ts": "2026-06-10T14:34:48Z",
        "timeline_count": 1749, "search_count": 60, "new_count": 1809,
        "selected_top_ids": ["A", "B", "C", "D"], "quick_hits_ids": ["E"],
        "all_scored": items,
    }


class XFeedFunnel(unittest.TestCase):
    def setUp(self):
        self.scored = _scored_fixture()

    def test_funnel_counts(self):
        f = xf.build_funnel(self.scored, gate_top=60, gate_quick=50)
        self.assertEqual(f["total"], 1809)
        self.assertEqual(f["by_reason"]["below_50"], 1796)
        self.assertEqual(f["by_reason"]["topic_dup"], 8)
        self.assertEqual(f["by_reason"]["selected"], 4)
        self.assertEqual(f["by_reason"]["quick_hits"], 1)

    def test_render_drop_flag(self):
        # render manifest dropped selected "D" and duplicated a video idea title
        rendered = {
            "run_id": "fixture",
            "rendered_top_ids": ["A", "B", "C"],          # D missing
            "rendered_video_ideas": [
                {"tweet_id": "B", "title": "Local AI agents", "angle": "build small"},
                {"tweet_id": "C", "title": "Local AI agents", "angle": "build small"},  # dup
            ],
        }
        flags = xf.detect_anomalies(self.scored, rendered)
        joined = " ".join(flags)
        self.assertIn("RENDER_DROP", joined)
        self.assertIn("D", joined)
        self.assertIn("DUP_VIDEO_IDEA", joined)

    def test_no_manifest_flag(self):
        flags = xf.detect_anomalies(self.scored, None)
        self.assertTrue(any("NO_RENDER_MANIFEST" in f for f in flags))

    def test_topic_starvation_flag(self):
        # Fable5 cluster (1 selected + 8 dup = 9) dominates the >=60 scorers
        flags = xf.detect_anomalies(self.scored, None)
        self.assertTrue(any("TOPIC_STARVATION" in f for f in flags))

    def test_clean_run_no_flags(self):
        clean = _scored_fixture()
        # collapse the starvation cluster to distinct topics + give a valid manifest
        for it in clean["all_scored"]:
            if it["topic"] == "Fable5" and it["tweet_id"] != "A":
                it["topic"] = "uniq-" + it["tweet_id"]
        rendered = {"run_id": "fixture", "rendered_top_ids": ["A", "B", "C", "D"],
                    "rendered_video_ideas": [{"tweet_id": "A", "title": "t1", "angle": "a1"}]}
        flags = xf.detect_anomalies(clean, rendered)
        self.assertEqual(flags, [], f"expected no flags, got {flags}")

    def test_unbalanced_markdown_flag(self):
        # rendered body with an orphan '__' (the @alexalbert__ underline bug)
        clean = _scored_fixture()
        for it in clean["all_scored"]:
            if it["topic"] == "Fable5" and it["tweet_id"] != "A":
                it["topic"] = "uniq-" + it["tweet_id"]
        rendered = {
            "run_id": "fixture", "rendered_top_ids": ["A", "B", "C", "D"],
            "rendered_video_ideas": [{"tweet_id": "A", "title": "t1", "angle": "a1"}],
            "rendered_body": "**1.** @alexalbert__ posted something and it never closes",
        }
        flags = xf.detect_anomalies(clean, rendered)
        self.assertTrue(any("UNBALANCED_MARKDOWN" in f for f in flags), f"got {flags}")

    def test_balanced_markdown_no_flag(self):
        # balanced **bold** + code span with '__' inside must NOT flag
        clean = _scored_fixture()
        for it in clean["all_scored"]:
            if it["topic"] == "Fable5" and it["tweet_id"] != "A":
                it["topic"] = "uniq-" + it["tweet_id"]
        rendered = {
            "run_id": "fixture", "rendered_top_ids": ["A", "B", "C", "D"],
            "rendered_video_ideas": [{"tweet_id": "A", "title": "t1", "angle": "a1"}],
            "rendered_body": "**1.** clean **bold** and `a__b` literal code",
        }
        flags = xf.detect_anomalies(clean, rendered)
        self.assertEqual(flags, [], f"expected no flags, got {flags}")


class MorningDigestFunnel(unittest.TestCase):
    def test_funnel_and_dead_source(self):
        debug = {
            "run_id": "f", "ts": "t", "selected": [{"title": "x"}], "also": [],
            "all_scored": [
                {"source": "x", "final_score": 90, "base_score": 90, "title": "a", "dropped_reason": "selected_top"},
                {"source": "hn", "final_score": 0, "base_score": 0, "title": "b", "dropped_reason": "below_77"},
            ],
        }
        f = md.build_funnel(debug)
        self.assertEqual(f["total"], 2)
        self.assertEqual(f["by_source"]["x"], 1)
        flags = md.detect_anomalies(debug)
        self.assertTrue(any("DEAD_SOURCE" in fl for fl in flags))


if __name__ == "__main__":
    unittest.main(verbosity=2)
