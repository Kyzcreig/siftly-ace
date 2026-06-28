#!/usr/bin/env python3
"""Tests for overview_digest.py — the deterministic brief-overview aggregator.

Guards the 2026-06-28 fixes for the garbled "The Landscape" overview:
- junk topics ('x.com', 'tracked-project', ...) never become themes
- labels never truncate mid-word (word-boundary + ellipsis)
- a 'BREAKING:'-klaxon label absorbs real content, not just the lead-in
- theme examples are the highest-scored items, deduped across themes
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import overview_digest as od  # noqa: E402


def tweet(handle, text, score, topics, on_topic="core", **extra):
    return {
        "authorHandle": handle,
        "tweet_text": text,
        "source": "x",
        "url": f"https://x.com/{handle}/status/{abs(hash(handle+text)) % 10**18}",
        "final_score": score,
        "on_topic": on_topic,
        "signals": {"topic_hits": [{"topic": t} for t in topics]},
        **extra,
    }


def test_skips_junk_topics():
    pool = {"all_scored": [
        tweet("a", "Anthropic shipped Claude Tag, an always-on Slack agent.", 90, ["models", "x.com", "tracked-project"]),
        tweet("b", "OpenAI released a new structured-outputs API for agents.", 88, ["models", "x.com", "agents"]),
    ]}
    agg = od.aggregate(pool, "morning-digest")
    topics = {t["topic"] for t in agg["themes"]}
    assert "x.com" not in topics, "x.com must be filtered as junk"
    assert "tracked-project" not in topics
    assert "models" in topics


def test_label_no_midword_truncation():
    it = tweet("DanieljrBlack",
               "for years, the AI conversation has been about one thing : which model is the smartest of them all and why it matters",
               89, ["models"])
    lbl = od._label(it)
    assert "which model is t" not in lbl, "must not cut mid-word"
    assert lbl.endswith("…"), "a trimmed label ends with an ellipsis"
    # the last visible token before the ellipsis is a whole word
    assert not lbl[:-1].rstrip().endswith(" t")


def test_breaking_klaxon_absorbs_real_content():
    it = tweet("CryptoTice_",
               "BREAKING:\n\nThe U.S. government just cleared Claude Mythos 5 for limited release.\n\nAfter a two-week blackout.",
               89, ["models"])
    lbl = od._label(it)
    assert "U.S. government" in lbl, f"klaxon should yield the real headline, got: {lbl!r}"
    assert lbl.strip() not in ("@CryptoTice_: BREAKING: The U.S.", "@CryptoTice_:")


def test_theme_examples_are_top_scored_and_deduped_across_themes():
    # one over-tagged junk tweet (high score, tagged into 3 lanes) must NOT headline
    # all three themes; a real per-lane item should surface instead.
    pool = {"all_scored": [
        tweet("junk", "Mecha Comet crypto gadget on Kickstarter.", 91, ["models", "coding", "security"]),
        tweet("real1", "DeepSeek-V3 weights dropped, 100GB, MIT license.", 80, ["models"]),
        tweet("real2", "New agent eval harness with golden datasets and regression tests.", 79, ["coding"]),
        tweet("real3", "Prompt-injection defense layer for tool-calling agents.", 78, ["security"]),
    ]}
    agg = od.aggregate(pool, "morning-digest")
    by_topic = {t["topic"]: t["examples"] for t in agg["themes"]}
    # the junk tweet appears as an example for AT MOST one theme (global dedup)
    junk_appearances = sum(
        1 for exs in by_topic.values() for e in exs if "Mecha Comet" in e
    )
    assert junk_appearances <= 1, f"over-tagged item headlined {junk_appearances} themes"
    # and the real per-lane items surface
    assert any("DeepSeek" in e for e in by_topic.get("models", []))


def test_empty_theme_dropped():
    # a topic whose only items have empty labels should not appear
    pool = {"all_scored": [
        tweet("x", "Real models news: Llama 3.3 70B benchmarks posted.", 85, ["models"]),
        {"authorHandle": "", "tweet_text": "", "source": "x", "url": "https://x.com/_/status/1",
         "final_score": 50, "on_topic": "core", "signals": {"topic_hits": [{"topic": "ghosttopic"}]}},
    ]}
    agg = od.aggregate(pool, "morning-digest")
    topics = {t["topic"] for t in agg["themes"]}
    assert "ghosttopic" not in topics


def test_top_stories_have_clean_labels_and_urls():
    pool = {"all_scored": [
        tweet("starmexxx", "Built a 24-bay home server to mirror every open LLM, 384TB for $3K.", 87, ["models"]),
    ]}
    agg = od.aggregate(pool, "morning-digest")
    assert agg["top_stories"], "should have a story"
    s = agg["top_stories"][0]
    assert s["ref"] == 1
    assert s["url"].startswith("https://")
    assert "24-bay" in s["label"]


def test_failsafe_on_empty_pool():
    agg = od.aggregate({"all_scored": []}, "morning-digest")
    assert agg["themes"] == []
    assert agg["top_stories"] == []
    assert agg["pool_size"] == 0


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
