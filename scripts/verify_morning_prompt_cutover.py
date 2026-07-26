#!/usr/bin/env python3
"""Structural lint for the morning-digest prompt after the x_search cutover.

Guards the Phase-2 edit against the two ways a prompt cutover silently breaks:
  1. The paid `api.twitter.com` path is still LIVE (comment never closed, or a
     stray call site left outside the block) -> the brief keeps paying.
  2. The new x_search path is accidentally INSIDE the comment -> the brief has no
     X gather at all and posts thin.

Run: python3 scripts/verify_morning_prompt_cutover.py [path/to/prompt.md]
Exit 0 = clean, 1 = problems (each printed).
"""
from __future__ import annotations

import os
import re
import sys

DEFAULT_PROMPT = os.path.expanduser("~/.hermes/state/cron/morning-digest/prompt.md")


def comment_spans(s):
    spans, i = [], 0
    while True:
        a = s.find("<!--", i)
        if a < 0:
            break
        b = s.find("-->", a)
        if b < 0:
            spans.append((a, len(s)))
            break
        spans.append((a, b + 3))
        i = b + 3
    return spans


def check(path=DEFAULT_PROMPT):
    s = open(path).read()
    spans = comment_spans(s)
    def inside(pos):
        return any(a <= pos < b for a, b in spans)
    def line(pos):
        return s[:pos].count("\n") + 1

    problems = []
    opens = len(re.findall(r"<!--", s))
    closes = len(re.findall(r"-->", s))
    print("HTML comments: %d open / %d close" % (opens, closes))
    if opens != closes:
        problems.append("unbalanced HTML comments (%d open vs %d close)" % (opens, closes))

    # 1. The paid ENDPOINT must never be reachable.
    #    Distinguish a real call site (a URL / curl target) from a prose mention.
    #    Note for §6a spend audits: the migration note itself mentions
    #    `api.twitter.com` in backticked prose, so the spec's suggested
    #    `grep -rn "api\.twitter\.com"` will still match this file. That grep is
    #    necessary but not sufficient — THIS lint is the precise check.
    for m in re.finditer(r"api\.twitter\.com", s):
        pos = m.start()
        ln = line(pos)
        text = s.splitlines()[ln - 1]
        is_url = ("https://api.twitter.com" in text) or ("http://api.twitter.com" in text)
        if inside(pos):
            print("  api.twitter.com  L%-4d commented-out %s" % (ln, "(URL)" if is_url else "(prose)"))
            continue
        if not is_url:
            print("  api.twitter.com  L%-4d live PROSE mention (documentation, not a call)" % ln)
            continue
        print("  api.twitter.com  L%-4d 🔴 LIVE URL" % ln)
        problems.append("LIVE paid api.twitter.com URL at line %d" % ln)

    # 2. x_api_search may only appear commented out, or in prose that explicitly
    #    frames it as the disabled/paid path.
    ALLOWED_PROSE = ("kept below", "the commented", "re-point", "PAID PATH ONLY")
    for m in re.finditer(r"x_api_search", s):
        if inside(m.start()):
            continue
        ln = line(m.start())
        text = s.splitlines()[ln - 1]
        if any(a in text for a in ALLOWED_PROSE):
            print("  x_api_search     L%-4d live-prose OK (documents the disabled path)" % ln)
            continue
        problems.append("LIVE x_api_search instruction at line %d: %s" % (ln, text.strip()[:90]))

    # 3. the new path must be present AND live (not swallowed by the comment)
    for needle in ("xsearch_gather.py", "--from-response", "empty_pool",
                   "min_faves:100", "allowed_x_handles", "credential_source"):
        pos = s.find(needle)
        if pos < 0:
            problems.append("new x_search path missing marker: %s" % needle)
            print("  %-20s MISSING" % needle)
            continue
        # find at least one LIVE occurrence
        live = any(not inside(m.start()) for m in re.finditer(re.escape(needle), s))
        print("  %-20s present live=%s" % (needle, live))
        if not live:
            problems.append("marker %r only appears inside the disabled comment block" % needle)

    # 4. the min_faves tier correction must be present (the spec's Phase-2 ask)
    if "does NOT apply to grok" not in s and "supports `min_faves:` fine" not in s:
        problems.append("missing the min_faves paid-vs-grok tier correction note")
    else:
        print("  min_faves tier note  present")

    # 5. the empty-pool / day-lock rule must be stated
    if "DO NOT create the PT-day post marker" not in s:
        problems.append("missing the empty-pool 'do not touch the day lock' rule")
    else:
        print("  day-lock rule        present")

    print()
    if problems:
        print("PROMPT CUTOVER LINT: %d PROBLEM(S)" % len(problems))
        for p in problems:
            print("  ! %s" % p)
        return 1
    print("PROMPT CUTOVER LINT: CLEAN")
    return 0


if __name__ == "__main__":
    sys.exit(check(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT))
