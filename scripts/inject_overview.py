#!/usr/bin/env python3
"""inject_overview.py — atomically attach the Overview synthesis to a brief's
render input, so the LLM never hand-edits the render JSON (the selection guard
owns its structure; this only adds an additive `overview` string field).

Reads the overview prose from a file (written by the brief's Overview step),
sets `data["overview"]`, writes back via temp+rename. Fail-safe: if the overview
file is missing/empty or anything errors, the render input is left UNCHANGED and
exit is 0 — the brief simply posts without an overview. Never blocks the digest.

Usage:
  python3 scripts/inject_overview.py --render-input <_render_input.json> --overview-file <prose.txt>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

MAX_CHARS = 7200  # ~two pages; the overview is a real briefing, not a teaser (Ace 2026-06-24, 4x the old half-page)


def _truncate(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in ("\n\n", ". ", "\n", " "):
        i = cut.rfind(sep)
        if i > limit * 0.6:
            return cut[:i + (len(sep) if sep == ". " else 0)].rstrip() + " …"
    return cut.rstrip() + " …"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-input", required=True)
    ap.add_argument("--overview-file", required=True)
    ap.add_argument("--max-chars", type=int, default=MAX_CHARS)
    args = ap.parse_args(argv)
    try:
        if not os.path.exists(args.overview_file):
            return 0  # no overview produced → leave render input untouched
        with open(args.overview_file, encoding="utf-8") as f:
            prose = f.read().strip()
        if not prose:
            return 0
        with open(args.render_input, encoding="utf-8") as f:
            data = json.load(f)
        data["overview"] = _truncate(prose, args.max_chars)
        d = os.path.dirname(os.path.abspath(args.render_input))
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, args.render_input)
        sys.stderr.write(f"overview injected ({len(data['overview'])} chars)\n")
        return 0
    except Exception as e:
        # fail-safe: never block the brief on an overview hiccup
        sys.stderr.write(f"inject_overview skipped (non-fatal): {str(e)[:200]}\n")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
