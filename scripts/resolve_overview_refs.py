#!/usr/bin/env python3
"""resolve_overview_refs.py — turn [N] citations in an Overview into linked refs.

The Overview prose (written by the brief's LLM step) cites stories as [1], [2], …
matching the `ref` numbers in overview_digest.py's `top_stories`. This script:
  1. reads the prose + the overview aggregate JSON,
  2. finds which [N] markers the prose actually used,
  3. appends a Wikipedia-style reference list mapping each used [N] → its real URL
     (URLs come from the deterministic aggregate, NEVER from the model — so a
     citation can't point at a hallucinated link).

Discord renders the inline [N] as plain text and the reference list as tappable
links. Fail-safe: bad/empty input → prose passed through unchanged, exit 0.

Usage:
  python3 scripts/resolve_overview_refs.py --prose <overview.txt> --agg <overview-input.json> [--out <file>]
  # prints (or writes) prose + "🔗 **Refs** [1] <url> …"
"""
from __future__ import annotations

import argparse
import json
import re
import sys

REF_RE = re.compile(r"\[(\d{1,3})\]")


def resolve(prose: str, agg: dict) -> str:
    prose = prose.rstrip()
    stories = (agg or {}).get("top_stories") or []
    url_by_ref = {}
    for s in stories:
        r = s.get("ref")
        u = s.get("url")
        if isinstance(r, int) and u:
            url_by_ref[r] = u
    used = []
    for m in REF_RE.finditer(prose):
        n = int(m.group(1))
        if n in url_by_ref and n not in used:
            used.append(n)
    if not used:
        return prose  # no resolvable citations → leave prose as-is
    used.sort()
    lines = [prose, "", "🔗 " + "  ·  ".join(f"[{n}] <{url_by_ref[n]}>" for n in used)]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prose", required=True)
    ap.add_argument("--agg", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    try:
        with open(args.prose, encoding="utf-8") as f:
            prose = f.read()
        with open(args.agg, encoding="utf-8") as f:
            agg = json.load(f)
        out = resolve(prose, agg)
    except Exception as e:
        sys.stderr.write(f"resolve_overview_refs passthrough (non-fatal): {str(e)[:200]}\n")
        try:
            out = open(args.prose, encoding="utf-8").read().rstrip()
        except Exception:
            return 0
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
