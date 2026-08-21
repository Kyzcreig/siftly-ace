#!/usr/bin/env python3
"""Deterministic presentation delta for consecutive morning-digest briefs.

The selector still owns `selected` and `also`. This script only annotates those
items with `_delta`, adds resolved tombstones under `delta.resolved`, and keeps a
small dated history so tomorrow can compare against the brief actually posted
today. Renderers decide how to collapse `_delta.status == "unchanged"`.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from select_digest import _guard_event_groups

DIGEST_DIR = Path(os.path.expanduser("~/.hermes/state/cron/morning-digest"))
DEFAULT_CURRENT = DIGEST_DIR / "_render_input.json"
DEFAULT_STATE = DIGEST_DIR / "brief-delta-history.json"
_HISTORY_DAYS = 8
_VOLATILE_FIELDS = {
    "_delta",
    "date",
    "fetched_at",
    "likes",
    "retweets",
    "public_metrics",
    "published_at",
    "ts",
}


def _validate_brief(data: Any, label: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be a JSON object")
    for bucket in ("selected", "also"):
        value = data.get(bucket, [])
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError(f"{label}.{bucket} must be a list of objects")
    return data


def _parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid ISO date: {value!r}") from exc


def brief_date(data: dict[str, Any], override: str | None = None) -> str:
    if override:
        return _parse_date(override).isoformat()
    raw = str(data.get("ts") or "")
    if len(raw) >= 10:
        try:
            return _parse_date(raw[:10]).isoformat()
        except ValueError:
            pass
    raise ValueError("brief date missing: provide --date or an ISO timestamp in .ts")


def _clean_item(item: dict[str, Any]) -> dict[str, Any]:
    clean = copy.deepcopy(item)
    clean.pop("_delta", None)
    return clean


def _snapshot(data: dict[str, Any], date: str) -> dict[str, Any]:
    return {
        "date": date,
        "selected": [_clean_item(item) for item in data.get("selected", [])],
        "also": [_clean_item(item) for item in data.get("also", [])],
    }


def _atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _load_history(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {"schema_version": 1, "briefs": []}
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("briefs"), list):
        raise ValueError(f"invalid delta history: {path}")
    return data


def save_snapshot(path: str | Path, data: dict[str, Any], date: str) -> None:
    path = Path(path)
    _validate_brief(data, "current")
    date = _parse_date(date).isoformat()
    history = _load_history(path)
    by_date: dict[str, dict[str, Any]] = {}
    for entry in history["briefs"]:
        if isinstance(entry, dict) and isinstance(entry.get("date"), str):
            by_date[entry["date"]] = entry
    by_date[date] = _snapshot(data, date)
    briefs = [by_date[key] for key in sorted(by_date)[-_HISTORY_DAYS:]]
    _atomic_json(path, {"schema_version": 1, "briefs": briefs})


def _entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for section, bucket in (("Top", "selected"), ("Also", "also")):
        for rank, item in enumerate(data.get(bucket, []), 1):
            entries.append({"section": section, "rank": rank, "order": len(entries), "item": item})
    return entries


def _location(entry: dict[str, Any]) -> str:
    return f"{entry['section']} #{entry['rank']}"


def _fingerprint(item: dict[str, Any]) -> str:
    payload = {key: value for key, value in item.items() if key not in _VOLATILE_FIELDS and key != "event_key"}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _annotate_moved(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    old_location = _location(previous)
    new_location = _location(current)
    delta: dict[str, Any] = {"status": "moved", "from": old_location}
    if old_location != new_location:
        delta["to"] = new_location
    else:
        delta["detail"] = "updated since yesterday"
    return delta


def _pair_group(
    current: list[dict[str, Any]], previous: list[dict[str, Any]]
) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Pair same-event entries deterministically, exact URL first then by rank."""
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    remaining_current = list(current)
    remaining_previous = list(previous)

    for cur in list(remaining_current):
        cur_url = str(cur["item"].get("url") or "")
        if not cur_url:
            continue
        match = next((old for old in remaining_previous if str(old["item"].get("url") or "") == cur_url), None)
        if match is None:
            continue
        pairs.append((cur, match))
        remaining_current.remove(cur)
        remaining_previous.remove(match)

    while remaining_current and remaining_previous:
        pairs.append((remaining_current.pop(0), remaining_previous.pop(0)))
    return pairs, remaining_current, remaining_previous


def _item_identity(item: dict[str, Any]) -> str:
    url = str(item.get("url") or "")
    if url:
        return f"url:{url}"
    source = str(item.get("source") or "").lower()
    for key in ("tweet_id", "id"):
        value = str(item.get(key) or "")
        if value:
            return f"{source}:{key}:{value}"
    return ""


def _merge_exact_identity_groups(group_ids: list[int], entries: list[dict[str, Any]]) -> list[int]:
    """Preserve exact URL/tweet identity alongside the selector's event groups."""
    parents = {group_id: group_id for group_id in group_ids}

    def find(group_id: int) -> int:
        while parents[group_id] != group_id:
            parents[group_id] = parents[parents[group_id]]
            group_id = parents[group_id]
        return group_id

    first_group_by_identity: dict[str, int] = {}
    for group_id, entry in zip(group_ids, entries):
        identity = _item_identity(entry["item"])
        if not identity:
            continue
        previous_group = first_group_by_identity.get(identity)
        if previous_group is None:
            first_group_by_identity[identity] = group_id
            continue
        left = find(group_id)
        right = find(previous_group)
        if left != right:
            parents[left] = right
    return [find(group_id) for group_id in group_ids]


def apply_delta(
    current: dict[str, Any],
    previous: dict[str, Any] | None,
    current_date: str,
    previous_date: str | None = None,
) -> dict[str, Any]:
    """Return an annotated copy; selected/also membership, order, and values stay intact."""
    _validate_brief(current, "current")
    current_date_obj = _parse_date(current_date)
    gap = False
    if previous is not None:
        _validate_brief(previous, "previous")
        if previous_date is None or _parse_date(previous_date) != current_date_obj - dt.timedelta(days=1):
            previous = None
            previous_date = None
            gap = True

    out = copy.deepcopy(current)
    out.pop("delta", None)
    current_entries = _entries(out)
    previous_copy = copy.deepcopy(previous) if previous is not None else {"selected": [], "also": []}
    previous_entries = _entries(previous_copy)
    pool = [entry["item"] for entry in current_entries + previous_entries]
    group_ids = _guard_event_groups(pool) if pool else []
    group_ids = _merge_exact_identity_groups(group_ids, current_entries + previous_entries)

    groups: dict[int, dict[str, list[dict[str, Any]]]] = {}
    current_count = len(current_entries)
    for index, (group_id, entry) in enumerate(zip(group_ids, current_entries + previous_entries)):
        side = "current" if index < current_count else "previous"
        groups.setdefault(group_id, {"current": [], "previous": []})[side].append(entry)

    resolved_entries: list[tuple[int, dict[str, Any]]] = []
    counts = {"new": 0, "moved": 0, "resolved": 0, "unchanged": 0}
    for grouped in groups.values():
        pairs, current_only, previous_only = _pair_group(grouped["current"], grouped["previous"])
        for cur, old in pairs:
            same_location = _location(cur) == _location(old)
            same_payload = _fingerprint(cur["item"]) == _fingerprint(old["item"])
            if same_location and same_payload:
                cur["item"]["_delta"] = {"status": "unchanged"}
                counts["unchanged"] += 1
            else:
                cur["item"]["_delta"] = _annotate_moved(cur, old)
                counts["moved"] += 1
        for cur in current_only:
            cur["item"]["_delta"] = {"status": "new"}
            counts["new"] += 1
        for old in previous_only:
            item = _clean_item(old["item"])
            item["_delta"] = {"status": "resolved", "from": _location(old)}
            resolved_entries.append((old["order"], item))
            counts["resolved"] += 1

    # Same-event unioning can place a previous-only item in a current event's
    # group. Keep resolved tombstones in yesterday's original presentation order.
    resolved = [item for _, item in sorted(resolved_entries, key=lambda entry: entry[0])]

    out["delta"] = {
        "schema_version": 1,
        "date": current_date_obj.isoformat(),
        "previous_date": previous_date,
        "gap": gap,
        "counts": counts,
        "resolved": resolved,
    }
    return out


def apply_with_history(
    current: dict[str, Any],
    state_path: str | Path,
    date: str | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    state_path = Path(state_path)
    current_date = brief_date(current, date)
    previous_date = (_parse_date(current_date) - dt.timedelta(days=1)).isoformat()
    history = _load_history(state_path)
    previous = next(
        (entry for entry in history["briefs"] if isinstance(entry, dict) and entry.get("date") == previous_date),
        None,
    )
    out = apply_delta(current, previous, current_date, previous_date if previous else None)
    if persist:
        save_snapshot(state_path, current, current_date)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Annotate a selected morning brief with yesterday's delta")
    parser.add_argument("--current", default=str(DEFAULT_CURRENT))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--out", default=str(DEFAULT_CURRENT))
    parser.add_argument("--date", help="ISO date override (acceptance/replay only)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--defer-snapshot",
        action="store_true",
        help="annotate now, but persist today's baseline only after the post succeeds",
    )
    mode.add_argument(
        "--snapshot-only",
        action="store_true",
        help="persist --current as today's successfully posted baseline without annotating",
    )
    args = parser.parse_args(argv)

    current_path = Path(args.current)
    with current_path.open(encoding="utf-8") as handle:
        current = json.load(handle)
    current_date = brief_date(current, args.date)
    if args.snapshot_only:
        save_snapshot(args.state, current, current_date)
        print(f"brief_delta: snapshot committed date={current_date}")
        return 0

    out = apply_with_history(current, args.state, current_date, persist=not args.defer_snapshot)
    _atomic_json(Path(args.out), out)
    counts = out["delta"]["counts"]
    print(
        "brief_delta: "
        + " ".join(f"{key}={counts[key]}" for key in ("new", "moved", "resolved", "unchanged"))
        + f" previous={out['delta']['previous_date'] or 'none'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
