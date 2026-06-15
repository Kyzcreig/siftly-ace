#!/usr/bin/env python3
"""
author_cap_test.py — Wave 6 G3 author-diversity cap regression net.

Ace, 2026-06-15: "2 per author cap" generally, but "I don't want more than ONE
of his posts specifically" (emollick). These tests prove the live deterministic
selection engine (score_digest.select_shadow) honors:

  • the per-handle override (emollick=0 from author-caps.txt) — at most 1 emollick
    in the COMBINED Top+Also, with the next-best DISTINCT author filling the slot;
  • the general default cap (2) for non-overridden authors;
  • non-authored items (stories/HN, no handle) are NEVER capped;
  • the kill-switch (SIFTLY_AUTHOR_CAP=0 restores pre-cap behavior (no-op);
  • a capped drop is recorded as _drop=='author_cap' and counted in meta.
"""
import importlib
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _x(handle, tid, text, likes=400, rts=20, ct="field_report",
       act="actionable_now", sub="concrete", on="core"):
    """A strong, gate-clearing on-topic X item from `handle`."""
    return {
        "source": "x", "authorHandle": handle, "tweet_id": str(tid),
        "url": f"https://x.com/{handle}/status/{tid}",
        "tweet_text": text,
        "likes": likes, "retweets": rts,
        "content_type": ct, "actionability": act, "substance": sub, "on_topic": on,
    }


class AuthorCapTest(unittest.TestCase):
    def setUp(self):
        # Reload fresh so module-level env reads (RECENCY etc.) are clean, and
        # ensure the cap is ENABLED (clear any inherited kill-switch).
        os.environ.pop("SIFTLY_AUTHOR_CAP", None)
        import score_digest
        importlib.reload(score_digest)
        self.S = score_digest
        self.tl, self.ta = self.S._load_thought_leaders()
        self.trk = set(self.S._load_tracked_projects())

    def _run(self, pool):
        return self.S.select_shadow([dict(p) for p in pool], self.tl, self.ta, self.trk)

    def _handles(self, selected, also):
        out = []
        for it in selected + also:
            out.append(str(it.get("authorHandle") or "").lstrip("@").lower())
        return out

    def test_emollick_override_caps_at_one(self):
        """Three strong emollick items + distinct others → at most ONE emollick
        appears; a different author fills the freed slot."""
        pool = [
            _x("emollick", 1, "Field report: I wired Opus into my repo loop, "
                              "concrete 40% PR-turnaround win, here are the numbers."),
            _x("emollick", 2, "Second emollick: a benchmark result GPT-X 88 on the "
                              "agentic eval, worth saving for routing decisions.", ct="benchmark"),
            _x("emollick", 3, "Third emollick: a hands-on tutorial recipe for "
                              "context engineering with concrete code snippets.", ct="tutorial"),
            _x("simonw", 10, "Simon: shipped a new datasette plugin, concrete "
                            "install + usage, you can run it today."),
            _x("karpathy", 11, "Karpathy: a concrete writeup on tokenizer internals "
                              "with runnable code and clear builder takeaways."),
        ]
        selected, also, discarded, meta = self._run(pool)
        handles = self._handles(selected, also)
        self.assertEqual(handles.count("emollick"), 1,
                         f"emollick override=0 violated; got {handles}")
        # The two surplus emollick items are author-cap drops.
        capped = [d for d in discarded if d.get("_drop") == "author_cap"]
        self.assertEqual(len(capped), 2, f"expected 2 emollick cap drops, got {capped}")
        self.assertTrue(all(d.get("_author_cap_handle") == "emollick" for d in capped))
        # A distinct author filled the freed slots.
        self.assertIn("simonw", handles)
        self.assertIn("karpathy", handles)
        self.assertEqual(meta["author_cap"]["dropped"], 2)
        self.assertEqual(meta["author_cap"]["overrides"].get("emollick"), 1)

    def test_default_cap_two_for_non_overridden(self):
        """A non-overridden prolific author is capped at the default (2), not 1."""
        pool = [
            _x("simonw", 20, "Simon one: concrete datasette release with runnable steps."),
            _x("simonw", 21, "Simon two: a second concrete tool ship, usable today, real numbers."),
            _x("simonw", 22, "Simon three: a third concrete builder post with code."),
            _x("karpathy", 23, "Karpathy: concrete tokenizer writeup with runnable code."),
        ]
        selected, also, discarded, meta = self._run(pool)
        handles = self._handles(selected, also)
        self.assertEqual(handles.count("simonw"), 2,
                         f"default cap=0 violated; got {handles}")
        capped = [d for d in discarded if d.get("_drop") == "author_cap"]
        self.assertEqual(len(capped), 1)

    def test_non_authored_items_never_capped(self):
        """Stories/HN rows (no authorHandle) are never subject to the cap, even
        many of them."""
        pool = [
            {"source": "hn", "title": "HN story one about a concrete AI tool launch",
             "url": "https://news.ycombinator.com/item?id=1", "hn_points": 200,
             "content_type": "launch", "actionability": "actionable_now",
             "substance": "concrete", "on_topic": "core"},
            {"source": "hn", "title": "HN story two about another concrete model release",
             "url": "https://news.ycombinator.com/item?id=2", "hn_points": 180,
             "content_type": "launch", "actionability": "actionable_now",
             "substance": "concrete", "on_topic": "core"},
            {"source": "smol", "title": "smol.ai recap three of a concrete tooling change",
             "url": "https://news.smol.ai/issues/x", "hn_points": None,
             "content_type": "analysis", "actionability": "reference",
             "substance": "concrete", "on_topic": "core"},
        ]
        selected, also, discarded, meta = self._run(pool)
        capped = [d for d in discarded if d.get("_drop") == "author_cap"]
        self.assertEqual(capped, [], "non-authored items must never be author-capped")

    def test_kill_switch_disables_cap(self):
        """SIFTLY_AUTHOR_CAP=0 → no-op: surplus emollick items are NOT cap-dropped."""
        os.environ["SIFTLY_AUTHOR_CAP"] = "0"
        try:
            import score_digest
            importlib.reload(score_digest)
            S = score_digest
            tl, ta = S._load_thought_leaders()
            trk = set(S._load_tracked_projects())
            pool = [
                _x("emollick", 1, "Strong emollick field report with concrete numbers and a 40% win."),
                _x("emollick", 2, "Second strong emollick benchmark result GPT-X 88 agentic eval.", ct="benchmark"),
            ]
            selected, also, discarded, meta = S.select_shadow(
                [dict(p) for p in pool], tl, ta, trk)
            capped = [d for d in discarded if d.get("_drop") == "author_cap"]
            self.assertEqual(capped, [], "kill-switch must disable the author cap")
            self.assertFalse(meta["author_cap"]["enabled"])
        finally:
            os.environ.pop("SIFTLY_AUTHOR_CAP", None)


class CapHelperTest(unittest.TestCase):
    def setUp(self):
        import score_digest
        importlib.reload(score_digest)
        self.S = score_digest

    def test_cap_for_override_beats_default(self):
        ov = {"emollick": 1}
        self.assertEqual(self.S._cap_for("emollick", ov, 2), 1)
        self.assertEqual(self.S._cap_for("simonw", ov, 2), 2)
        # non-authored → None (never capped)
        self.assertIsNone(self.S._cap_for("", ov, 2))

    def test_loader_parses_handle_and_skips_garbage(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("# comment\n@emollick 1\nsimonw 2\nmalformed_line\nbad N\n")
            path = f.name
        try:
            ov = self.S._load_author_cap_overrides(path)
            self.assertEqual(ov, {"emollick": 1, "simonw": 2})
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
