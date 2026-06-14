#!/usr/bin/env python3
"""Tests for siftly-gatherer-silentblock-watch (G2 watchdog, PRD §5.3 / D-5 / AC-5/AC-11).

Run: python3 docs/gates/test_silentblock_watch.py
Exercises the watchdog against synthetic probe-artifact dirs. Pure stdlib; no network.
Mirrors the live script at ~/.hermes/scripts/siftly-gatherer-silentblock-watch.py (kept
in the repo for review/CI; the live copy is what the cron runs).
"""
import io
import json
import pathlib
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timezone, timedelta

WATCH = pathlib.Path.home() / ".hermes/scripts/siftly-gatherer-silentblock-watch.py"


def _exec(probe_dir, stale_days=99, n=3):
    src = WATCH.read_text()
    g = {"__name__": "x"}
    exec(src, g)
    g["PROBE_DIR"] = pathlib.Path(probe_dir)
    g["STALE_DAYS"] = stale_days
    g["ZERO_DAYS_N"] = n
    buf = io.StringIO()
    with redirect_stdout(buf):
        g["main"]()
    return buf.getvalue().strip()


def _write(d, days_ago, reddit, github, schema_ok=True):
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    day = (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d")
    if schema_ok:
        art = {"ts": ts, "pt_day": day, "sources": [
            {"source": "reddit", "fetched": reddit},
            {"source": "github-trending", "fetched": github}]}
    else:
        art = {"ts": ts, "pt_day": day, "sources": "WRONG"}
    pathlib.Path(d, f"{ts.replace(':','-')}.json").write_text(json.dumps(art))


def run():
    fails = 0

    def check(name, cond):
        nonlocal fails
        print(f"  {'✓' if cond else '✗ FAIL'} {name}")
        if not cond:
            fails += 1

    # 1. healthy (github>0, reddit zero only 1 day) -> SILENT
    with tempfile.TemporaryDirectory() as d:
        _write(d, 0, 0, 14)
        check("healthy day -> silent", _exec(d) == "")

    # 2. reddit aggregate-zero 3 consecutive days -> SILENT BLOCK
    with tempfile.TemporaryDirectory() as d:
        for i in (0, 1, 2):
            _write(d, i, 0, 14)
        out = _exec(d)
        check("3-day reddit zero -> silent-block alert", "SILENT BLOCK" in out and "reddit" in out)

    # 3. reddit zero only 2 of 3 days (rotation/quiet) -> SILENT (streak broken)
    with tempfile.TemporaryDirectory() as d:
        _write(d, 0, 0, 14); _write(d, 1, 37, 14); _write(d, 2, 0, 14)
        check("non-zero day breaks streak -> silent", _exec(d) == "")

    # 4. stale newest artifact -> STALE alert
    with tempfile.TemporaryDirectory() as d:
        _write(d, 5, 5, 14)
        check("5d-old artifact -> stale alert", "STALE" in _exec(d, stale_days=2))

    # 5. schema drift -> schema alert
    with tempfile.TemporaryDirectory() as d:
        _write(d, 0, 5, 14, schema_ok=False)
        check("bad shape -> schema alert", "schema check" in _exec(d))

    # 6. github silent-block (the HTML-scrape source, D-5b) -> alert
    with tempfile.TemporaryDirectory() as d:
        for i in (0, 1, 2):
            _write(d, i, 25, 0)
        out = _exec(d)
        check("3-day github zero -> silent-block alert", "SILENT BLOCK" in out and "github" in out)

    # 7. fewer than N run-days -> no silent-block alert (not enough evidence)
    with tempfile.TemporaryDirectory() as d:
        _write(d, 0, 0, 0)
        check("<N days -> no silent-block alert", "SILENT BLOCK" not in _exec(d))

    print(f"\n{'ALL PASS' if fails == 0 else f'{fails} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(run())
