#!/usr/bin/env python3
"""Budget + timing tests for xfeed_xsearch_gather.gather_parallel (t_0c429a9d).

x_search is replaced by an in-process fake with a fixed per-call latency, so the
10-27 overrun (378 handles at ~100 s/call ran 2730 s past the 1800 s cron cap) is
replayed at millisecond scale. No network.

Run: python3 -m pytest scripts/__tests__/xfeed_gather_budget_test.py -q
"""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import xfeed_xsearch_gather as xg  # noqa: E402

SINCE, UNTIL = "2026-10-26T11:00:00Z", "2026-10-27T11:00:00Z"


def _fake(latency, capped=(), calls=None, timeouts=None):
    def call(q, handles, since, until, timeout=300):
        if timeouts is not None:
            timeouts.append(timeout)
        if calls is not None:
            calls.append(handles[0])
        time.sleep(latency)
        n = xg.ROW_CAP if handles[0] in capped else 1
        rows = [{"handle": handles[0], "tweet_id": str(10 ** 18 + i), "tweet_text": "x",
                 "created_at": "2026-10-26T20:00:00Z", "likes": 500} for i in range(n)]
        return {"success": True, "credential_source": "xai-oauth", "answer": json.dumps(rows)}
    return call


def test_no_budget_runs_full_sweep_and_prints_timing(monkeypatch, capsys):
    monkeypatch.setattr(xg, "call_x_search", _fake(0.01))
    handles = [f"h{i}" for i in range(50)]
    _c, rep = xg.gather_parallel(handles, SINCE, UNTIL, min_faves=150, max_workers=8,
                                 progress=25)
    err = capsys.readouterr().err
    assert rep["partial"] is False
    assert rep["handles_complete"] == 50
    assert rep["x_search_calls"] == 50
    assert rep["mean_call_s"] is not None and rep["max_call_s"] >= 0
    lines = [ln for ln in err.splitlines() if "… 25 calls" in ln or "… 50 calls" in ln]
    assert len(lines) == 2, err
    assert "elapsed" in lines[0] and "s/call" in lines[0] and "last 25:" in lines[0]


def test_budget_stops_sweep_and_reports_partial(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(xg, "call_x_search", _fake(0.05, capped={"h0"}, calls=calls))
    handles = [f"h{i}" for i in range(200)]
    t0 = time.time()
    _c, rep = xg.gather_parallel(handles, SINCE, UNTIL, min_faves=150, max_workers=4,
                                 progress=25, budget_s=0.5)
    wall = time.time() - t0
    err = capsys.readouterr().err
    # 200 calls x 0.05 s / 4 wide = 2.5 s unbudgeted; the budget holds it near 0.5 s.
    assert wall < 1.5, wall
    assert rep["partial"] is True
    assert 0 < rep["handles_complete"] < 200
    assert rep["budget_skipped_calls"] == 200 - rep["handles_complete"]
    assert rep["chunks_failed"] == 0, "a budget skip must not count as a failed call"
    assert rep["x_search_calls"] == len(calls)
    assert not any("FAILED" in a for a in rep["alerts"])
    # The capped handle would escalate; past the budget the pass is skipped and logged.
    assert "budget: 0.5s spent" in err and "skipping" in err
    assert "escalate:" not in err


def test_budget_not_hit_is_not_partial(monkeypatch):
    monkeypatch.setattr(xg, "call_x_search", _fake(0.0, capped={"h1"}))
    _c, rep = xg.gather_parallel([f"h{i}" for i in range(10)], SINCE, UNTIL,
                                 min_faves=150, max_workers=4, budget_s=60)
    assert rep["partial"] is False and rep["handles_complete"] == 10
    assert rep["split_passes"] > 0, "recovery passes still run inside the budget"


def test_tail_call_gets_shortened_timeout_and_its_expiry_is_a_skip(monkeypatch):
    timeouts = []

    def call(q, handles, since, until, timeout=300):
        timeouts.append(timeout)
        return {"success": False, "error": f"x_search timed out after {timeout}s"}

    monkeypatch.setattr(xg, "call_x_search", call)
    _c, rep = xg.gather_parallel(["a", "b"], SINCE, UNTIL, min_faves=150, max_workers=2,
                                 budget_s=10)
    assert timeouts and all(t <= 10 + xg.BUDGET_TAIL_S for t in timeouts)
    assert rep["chunks_failed"] == 0 and rep["partial"] is True


def test_real_timeout_without_budget_is_still_a_failure(monkeypatch):
    monkeypatch.setattr(xg, "call_x_search",
                        lambda q, h, s, u, timeout=300: {"success": False,
                                                         "error": "x_search timed out after 300s"})
    _c, rep = xg.gather_parallel(["a"], SINCE, UNTIL, min_faves=150, max_workers=1)
    assert rep["chunks_failed"] == 1 and rep["partial"] is False


def test_backoff_sleep_is_logged(monkeypatch, capsys):
    state = {"n": 0}

    def call(q, handles, since, until, timeout=300):
        state["n"] += 1
        if state["n"] == 1:
            return {"success": False, "error": "resource-exhausted: Too many requests"}
        return {"success": True, "credential_source": "xai-oauth", "answer": "[]"}

    monkeypatch.setattr(xg, "call_x_search", call)
    monkeypatch.setattr(xg.time, "sleep", lambda s: None)
    xg.gather_parallel(["a"], SINCE, UNTIL, min_faves=150, max_workers=1)
    assert "backoff sleep" in capsys.readouterr().err
