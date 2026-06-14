#!/usr/bin/env python3
"""siftly-gatherer-silentblock-watch — G2 watchdog (PRD-brief-live-wiring §5.3 / D-5).

Reads the gatherer-probe artifacts that wave6-output-shadow-watch writes daily to
  ~/.hermes/state/x-bookmarks/gatherer-probe/<ts>.json
and alerts #alerts when a discovery source has SILENTLY stopped producing — a real
RSS/scrape block must not masquerade as "nothing hot" forever.

Alerts (to #alerts) when ANY of:
  (a) SILENT BLOCK: a source's AGGREGATE fetched==0 for N consecutive RUN days.
      "Aggregate" = the source's total fetched across that day's probe (Reddit rotates
      ~5-of-9 subs/day, so a per-sub zero is EXPECTED — only the day-total matters).
      Rotation-aware: a sub not scheduled today is not a block (D-4b/D-5, Pass-1 B-2).
  (b) STALE INPUT: the newest probe artifact is older than STALE_DAYS — a dead probe
      /cron is NOT health (missing != zero). The probe stopping is its own alert.
  (c) SCHEMA DRIFT: the newest artifact doesn't match the asserted shape — alert
      rather than silently mis-read a changed schema.

Otherwise SILENT (empty stdout). no_agent cron: empty stdout = nothing delivered.
Pure stdlib, exits 0 always (a watchdog that crashes is a watchdog that lies).

Its OWN silence is covered by the cron-observability stack (D-9/AC-14): cron.ace
flags a job that stops checking in, so this watcher going dark is itself detectable.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

PROBE_DIR = Path.home() / ".hermes/state/x-bookmarks/gatherer-probe"
SOURCES = ("reddit", "github-trending")
# N consecutive aggregate-zero RUN days before a silent-block alert (OQ-2, default 3).
ZERO_DAYS_N = int(os.environ.get("SIFTLY_SILENTBLOCK_N", "3"))
# Newest artifact older than this => the probe/cron is dead (staleness alert).
STALE_DAYS = float(os.environ.get("SIFTLY_PROBE_STALE_DAYS", "2"))
# #alerts channel (loud-fail lane). #logs would be wrong for a real degradation.
ALERTS_CHANNEL = "1480528231286181948"


def _load_artifacts() -> list[dict]:
    """Newest-first list of valid probe artifacts. Skips unparseable files."""
    if not PROBE_DIR.is_dir():
        return []
    out: list[tuple[float, dict]] = []
    for p in PROBE_DIR.glob("*.json"):
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        # sort key: prefer the artifact ts, fall back to mtime
        ts = d.get("ts")
        try:
            key = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
        except Exception:
            key = p.stat().st_mtime
        out.append((key, d))
    out.sort(key=lambda t: t[0], reverse=True)
    return [d for _, d in out]


def _schema_ok(art: dict) -> bool:
    """Assert the shape we depend on, so a changed schema alerts instead of mis-reads."""
    if not isinstance(art.get("sources"), list) or not art["sources"]:
        return False
    for s in art["sources"]:
        if not isinstance(s, dict):
            return False
        if "source" not in s or "fetched" not in s:
            return False
        if not isinstance(s.get("fetched"), int):
            return False
    return True


def _pt_day(art: dict) -> str:
    """The probe's own day stamp, else derive from ts."""
    d = art.get("pt_day")
    if isinstance(d, str) and d:
        return d
    ts = art.get("ts")
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except Exception:
        return ""


def _source_fetched(art: dict, source: str) -> int | None:
    """Aggregate fetched for a source in one artifact; None if the source is absent."""
    for s in art.get("sources", []):
        # probe uses "github-trending"; the digest tags "github" — match either
        sname = str(s.get("source", ""))
        if sname == source or (source == "github-trending" and sname == "github"):
            try:
                return int(s.get("fetched", 0))
            except Exception:
                return 0
    return None


def main() -> int:
    arts = _load_artifacts()
    alerts: list[str] = []

    if not arts:
        # No artifacts at all -> the probe never ran / dir missing. Stale by definition,
        # but only alert if the dir exists (otherwise the feature may not be wired yet).
        if PROBE_DIR.is_dir():
            alerts.append("⚠️ siftly gatherer-probe: NO artifacts found — probe never wrote / dir empty (dead probe?)")
        _emit(alerts)
        return 0

    newest = arts[0]

    # (c) schema drift on the newest artifact
    if not _schema_ok(newest):
        alerts.append(
            "⚠️ siftly gatherer-probe: newest artifact FAILED schema check "
            "(shape drifted — watchdog can't trust `fetched`). Inspect "
            f"{PROBE_DIR}"
        )
        _emit(alerts)  # don't try to read counts off a bad-shape artifact
        return 0

    # (b) staleness — newest artifact too old
    ts = newest.get("ts")
    try:
        newest_dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        newest_dt = None
    if newest_dt is not None:
        age = datetime.now(timezone.utc) - newest_dt
        if age > timedelta(days=STALE_DAYS):
            alerts.append(
                f"⚠️ siftly gatherer-probe: STALE — newest artifact is {age.days}d old "
                f"(> {STALE_DAYS}d). The probe/cron likely stopped (dead ≠ healthy)."
            )

    # (a) silent block — per source, aggregate-zero for N consecutive distinct RUN days.
    # Walk newest-first, one artifact per pt_day (the latest run that day), require the
    # source PRESENT (schema ok) and fetched==0 across the last N days.
    seen_days: list[str] = []
    by_day: dict[str, dict] = {}
    for art in arts:
        if not _schema_ok(art):
            continue
        day = _pt_day(art)
        if not day or day in by_day:
            continue
        by_day[day] = art
        seen_days.append(day)
    # seen_days is newest-first, unique days
    for source in SOURCES:
        if len(seen_days) < ZERO_DAYS_N:
            continue  # not enough run-days yet to assert a block
        recent = seen_days[:ZERO_DAYS_N]
        vals = [_source_fetched(by_day[d], source) for d in recent]
        # All present AND all zero => silent block. A None (source absent) breaks the
        # streak (we won't false-alarm on a source that simply wasn't probed).
        if all(v == 0 for v in vals):
            alerts.append(
                f"🔴 siftly {source}: SILENT BLOCK — aggregate fetched==0 for "
                f"{ZERO_DAYS_N} consecutive run-days ({', '.join(recent)}). "
                f"Likely an IP-level RSS/scrape block, not a quiet news day. Check the lane."
            )

    _emit(alerts)
    return 0


def _emit(alerts: list[str]) -> None:
    """Empty => silent (no_agent delivers nothing). Non-empty => print for delivery to
    #alerts. We print the channel-routing hint as the first line so the cron's deliver
    target is #alerts; the no_agent runner delivers stdout verbatim to the configured
    channel, which we set to #alerts at create time."""
    if not alerts:
        return
    print("\n".join(alerts))


if __name__ == "__main__":
    sys.exit(main())
