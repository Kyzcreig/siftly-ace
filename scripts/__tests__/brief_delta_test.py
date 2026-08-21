#!/usr/bin/env python3
import copy
import json
import os
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import brief_delta as bd  # noqa: E402
import render_digest as rd  # noqa: E402


def _load(name):
    return json.loads((FIXTURES / name).read_text())


def _without_delta(items):
    return [{k: v for k, v in item.items() if k != "_delta"} for item in items]


def test_actual_consecutive_briefs_have_new_moved_and_resolved_without_selection_changes():
    previous = _load("brief_delta_actual_2026-08-18.json")
    current = _load("brief_delta_actual_2026-08-19.json")
    selected_before = copy.deepcopy(current["selected"])
    also_before = copy.deepcopy(current["also"])

    out = bd.apply_delta(current, previous, "2026-08-19", "2026-08-18")

    assert out["delta"]["counts"] == {
        "new": 6,
        "moved": 1,
        "resolved": 6,
        "unchanged": 0,
    }
    assert out["selected"][0]["_delta"]["status"] == "moved"
    assert all(i["_delta"]["status"] == "new" for i in out["selected"][1:] + out["also"])
    assert len(out["delta"]["resolved"]) == 6
    assert all(i["_delta"]["status"] == "resolved" for i in out["delta"]["resolved"])
    assert [i["url"] for i in out["delta"]["resolved"]] == [
        i["url"] for i in previous["selected"][1:] + previous["also"]
    ]
    assert _without_delta(out["selected"]) == selected_before
    assert _without_delta(out["also"]) == also_before


def test_unchanged_items_stay_selected_but_are_marked_for_presentation_collapse():
    item = {
        "source": "HN",
        "title": "Stable story",
        "url": "https://example.com/stable",
        "score": 88,
    }
    previous = {"selected": [copy.deepcopy(item)], "also": []}
    current = {"selected": [copy.deepcopy(item)], "also": []}

    out = bd.apply_delta(current, previous, "2026-08-19", "2026-08-18")

    assert out["delta"]["counts"]["unchanged"] == 1
    assert out["selected"][0]["_delta"]["status"] == "unchanged"
    assert _without_delta(out["selected"]) == [item]


def test_tweet_id_is_the_exact_identity_fallback_when_url_is_missing():
    item = {"source": "X", "tweet_id": "123", "tweet_text": "Stable post", "score": 88}

    out = bd.apply_delta(
        {"selected": [copy.deepcopy(item)], "also": []},
        {"selected": [copy.deepcopy(item)], "also": []},
        "2026-08-19",
        "2026-08-18",
    )

    assert out["delta"]["counts"]["unchanged"] == 1


def test_nonconsecutive_previous_brief_is_not_reported_as_yesterday():
    current = {"selected": [{"url": "https://example.com/new"}], "also": []}
    stale = {"selected": [{"url": "https://example.com/old"}], "also": []}

    out = bd.apply_delta(current, stale, "2026-08-19", "2026-08-17")

    assert out["delta"]["previous_date"] is None
    assert out["delta"]["counts"] == {
        "new": 1,
        "moved": 0,
        "resolved": 0,
        "unchanged": 0,
    }
    assert out["delta"]["gap"] is True


def test_state_history_makes_same_day_reruns_idempotent(tmp_path):
    state_path = tmp_path / "brief-delta-history.json"
    previous = _load("brief_delta_actual_2026-08-18.json")
    current = _load("brief_delta_actual_2026-08-19.json")

    bd.save_snapshot(state_path, previous, "2026-08-18")
    first = bd.apply_with_history(current, state_path, "2026-08-19")
    second = bd.apply_with_history(current, state_path, "2026-08-19")

    assert first["delta"] == second["delta"]
    assert [i["_delta"] for i in first["selected"]] == [i["_delta"] for i in second["selected"]]
    history = json.loads(state_path.read_text())
    assert [entry["date"] for entry in history["briefs"]] == ["2026-08-18", "2026-08-19"]


def test_deferred_snapshot_does_not_advance_history_until_post_succeeds(tmp_path):
    state_path = tmp_path / "brief-delta-history.json"
    previous = _load("brief_delta_actual_2026-08-18.json")
    current = _load("brief_delta_actual_2026-08-19.json")
    bd.save_snapshot(state_path, previous, "2026-08-18")

    out = bd.apply_with_history(current, state_path, "2026-08-19", persist=False)

    assert out["delta"]["counts"]["moved"] == 1
    assert [entry["date"] for entry in json.loads(state_path.read_text())["briefs"]] == ["2026-08-18"]
    bd.save_snapshot(state_path, out, "2026-08-19")
    assert [entry["date"] for entry in json.loads(state_path.read_text())["briefs"]] == [
        "2026-08-18",
        "2026-08-19",
    ]


def test_discord_renderer_leads_changed_items_and_collapses_unchanged():
    previous = _load("brief_delta_actual_2026-08-18.json")
    current = _load("brief_delta_actual_2026-08-19.json")
    out = bd.apply_delta(current, previous, "2026-08-19", "2026-08-18")

    body, _, _ = rd.render_full(out, apply_dedup=False)

    assert "**moved**" in body
    assert "**new**" in body
    assert "**resolved**" in body
    assert body.index("**moved**") < body.index("GBrain actually works")
    assert body.index("**resolved**") < body.index("Less than two years later")

    stable = {
        "source": "HN",
        "title": "This unchanged card must not render",
        "url": "https://example.com/stable",
        "score": 88,
    }
    unchanged = bd.apply_delta(
        {"ts": "2026-08-19T04:00:00-07:00", "selected": [stable], "also": []},
        {"selected": [stable], "also": []},
        "2026-08-19",
        "2026-08-18",
    )
    collapsed_body, _, _ = rd.render_full(unchanged, apply_dedup=False)
    assert "This unchanged card must not render" not in collapsed_body
    assert "1 unchanged item collapsed" in collapsed_body


def test_discord_collapse_preserves_original_top_rank_numbers():
    stable = {"source": "HN", "title": "Stable", "url": "https://example.com/stable", "score": 90}
    new = {"source": "HN", "title": "New story", "url": "https://example.com/new", "score": 80}
    out = bd.apply_delta(
        {"selected": [stable, new], "also": []},
        {"selected": [stable], "also": []},
        "2026-08-19",
        "2026-08-18",
    )

    body, _, _ = rd.render_full(out, apply_dedup=False)

    assert "Stable" not in body
    assert "**new** · **2.**" in body


def test_empty_today_still_renders_resolved_tombstones():
    old = {"source": "HN", "title": "Yesterday only", "url": "https://example.com/old", "score": 80}
    out = bd.apply_delta(
        {"selected": [], "also": [], "empty_note": "Nothing cleared the bar today"},
        {"selected": [old], "also": []},
        "2026-08-19",
        "2026-08-18",
    )

    body, _, _ = rd.render_full(out, apply_dedup=False)

    assert "**resolved**" in body
    assert "Yesterday only" in body
