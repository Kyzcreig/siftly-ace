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
import re
import sys
import tempfile

MAX_CHARS = 1900  # ~300-word ceiling (Ace 2026-06-25 — the overview is a tight read, not a wall). A theme with nothing real to say is dropped, never padded to length.

# A trailing "…"/"..." at the very END of the overview is never wanted: it's either
# model junk or truncation crud, and it renders as a stray dangling ellipsis on the page.
_TRAILING_ELLIPSIS = re.compile(r"\s*(?:…|\.\.\.)\.?\s*$")


def _visible_len(text: str) -> int:
    """Length of the overview as it actually RENDERS, ignoring the invisible URLs that
    resolve_overview_refs.py injects. That step expands every bare `[N]` citation into a
    masked link `[[N]](https://x.com/.../status/<id>)` and every `@handle` into
    `[@handle](https://x.com/handle)` — hundreds of chars of URL that DON'T display. The
    budget must be measured on the visible text, otherwise a perfectly-short overview trips
    the cap purely because of link URLs and gets chopped mid-content (the dangling-"…" bug)."""
    v = re.sub(r"\[\[(\d{1,3})\]\]\([^)]+\)", r"[\1]", text)  # masked cite → bare [N]
    v = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", v)            # any [label](url) → label
    return len(v)


def _truncate(text: str, limit: int) -> str:
    text = text.strip()
    # Budget on VISIBLE length, not raw — see _visible_len. When the overview fits, return
    # it untouched EXCEPT for a stray trailing ellipsis (model junk we didn't create).
    if _visible_len(text) <= limit:
        return _TRAILING_ELLIPSIS.sub("", text).rstrip()
    cut = text[:limit]
    for sep in ("\n\n", ". ", "\n", " "):
        i = cut.rfind(sep)
        if i > limit * 0.6:
            return cut[:i + (len(sep) if sep == ". " else 0)].rstrip() + " …"
    return cut.rstrip() + " …"


def _selftest() -> int:
    fails = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    ell = re.compile(r"(?:…|\.\.\.)\.?\s*$")

    # 1. A short overview whose RAW length only exceeds the cap because of injected link
    #    URLs must NOT be truncated (visible text is well under budget) and must NOT gain a
    #    trailing ellipsis. This is the live double-budget bug (2026-07-10).
    url = "https://x.com/pmarca/status/2075515835410706796"
    linked = ("📡 **Your Timeline**\nThe day skewed toward shipping over think-pieces, with "
              "builders wiring agents into real tools rather than arguing benchmarks "
              + "".join(f"[[{n}]]({url})" for n in range(1, 40)) + ".")
    out = _truncate(linked, MAX_CHARS)
    check(_visible_len(linked) <= MAX_CHARS, "test fixture should be visibly short")
    check(len(linked) > MAX_CHARS, "test fixture raw length should exceed cap (URLs)")
    check(not ell.search(out), f"short-but-URL-inflated overview gained a dangling ellipsis: {out[-40:]!r}")
    check(out.rstrip().endswith(")."), f"content chopped when it shouldn't be: {out[-40:]!r}")

    # 2. A dangling model ellipsis on an otherwise-short overview is stripped.
    junk = "🗞️ **The Landscape**\nA clean short read about the day's momentum. …"
    check(not ell.search(_truncate(junk, MAX_CHARS)), "trailing model ellipsis not stripped")

    # 3. A genuinely-too-long overview (by VISIBLE length) still truncates with ' …'.
    long = "🗞️ **The Landscape**\n" + ("word " * 500)
    lt = _truncate(long, 200)
    check(lt.endswith("…"), "genuinely-long overview should still truncate with an ellipsis")
    check(_visible_len(lt) <= 200 + 5, f"truncated overview over budget: {_visible_len(lt)}")

    if fails:
        print("inject_overview SELFTEST FAILED:")
        for f in fails:
            print("  -", f)
        return 1
    print("inject_overview selftest OK (4 checks)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-input")
    ap.add_argument("--overview-file")
    ap.add_argument("--max-chars", type=int, default=MAX_CHARS)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    if not args.render_input or not args.overview_file:
        ap.error("--render-input and --overview-file are required (or use --selftest)")
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
