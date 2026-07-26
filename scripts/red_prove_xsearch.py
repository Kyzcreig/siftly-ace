#!/usr/bin/env python3
"""
red_prove_xsearch.py — MUTATION PROOF for the xsearch_gather.py blocker guards.

WHY
---
A green test suite proves nothing on its own: a test that passes against BOTH the
fixed and the broken code is vacuous. This harness surgically reverts each guard in
`xsearch_gather.py` to its documented naive/pre-fix behavior, re-runs the targeted
tests, and asserts they go RED. If a mutation leaves the suite green, that test is
NOT actually guarding the blocker and the run fails.

Every mutation is applied to a COPY in a temp dir — the real source is never touched,
so this is safe to run against a dirty tree and cannot leave the repo mutated.

Usage:
    python3 scripts/red_prove_xsearch.py           # run all mutations
    python3 scripts/red_prove_xsearch.py -v        # show full pytest output
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "scripts" / "xsearch_gather.py"
TEST = REPO / "scripts" / "__tests__" / "xsearch_gather_test.py"


# Each mutation: (blocker, label, pytest -k selector, old_snippet, new_snippet)
# `old_snippet` MUST exist verbatim in the source — a miss is a hard failure
# (anchor drift means the proof silently stopped proving anything).
MUTATIONS = [
    (
        "B1", "emit `text` instead of `tweet_text` (the spec-v3 shape)",
        "Blocker1",
        '"tweet_text": text,              # B1: the ONLY key _item_text will read',
        '"text": text,',
    ),
    (
        "B1", "drop the FLAT likes/retweets, keep only public_metrics",
        "Blocker1",
        '        "likes": likes,                  # B1: flat — overview/render read only these\n'
        '        "retweets": rts,\n',
        "",
    ),
    (
        "B2", "return the raw id (no string coercion)",
        "Blocker2",
        "    if isinstance(value, int):\n        return str(value)",
        "    if isinstance(value, int):\n        return value",
    ),
    (
        "B3", "ISO-only parser (drop the RFC-1123 fallback)",
        "Blocker3",
        "        try:\n"
        "            dt = email.utils.parsedate_to_datetime(s)\n"
        "        except (TypeError, ValueError, IndexError):\n"
        "            return None",
        "        return None",
    ),
    (
        "B4", "never flag an empty pool",
        "Blocker4",
        'report["empty_pool"] = (report["rows_after_window_filter"] == 0)',
        'report["empty_pool"] = False',
    ),
    (
        "B4", "exit 0 even on an empty pool / credential fallback",
        "cli_exits_nonzero",
        '    if report["empty_pool"] or not report["credential_ok"]:\n        return 3',
        "    if False:\n        return 3",
    ),
    (
        "B5", "accept uncited tweet_ids (no hallucination guard)",
        "uncited_row_is_dropped",
        "        if cited is not None and tid not in cited:",
        "        if False:",
    ),
    (
        "B5", "read only the top-level `citations` array (the spec's literal wording)",
        "Blocker5",
        'for key in ("citations", "inline_citations"):',
        'for key in ("citations",):',
    ),
    (
        "B5", "ignore the `degraded` flag",
        "degraded_chunk_yields_no_candidates",
        '    if stats["degraded"]:',
        "    if False:",
    ),
    (
        "B6", "always report credentials as OK (hide metered fallback)",
        "Blocker6",
        'stats["credential_ok"] = stats["credential_source"] == REQUIRED_CREDENTIAL_SOURCE',
        'stats["credential_ok"] = True',
    ),
    (
        "CONTRACT", "build a PROSE query instead of operator syntax",
        "operator_syntax_not_prose or G1_handles or since_until_always",
        '    clauses = [f"from:{h}{faves} since:{since_d} until:{until_d}{rts}" for h in hs]',
        '    clauses = ["the 30 most recent posts" for h in hs]',
    ),
    (
        "CONTRACT", "drop the local window re-filter (trust grok's date math)",
        "local_window_filter_overrides",
        "        if not in_window(cand, since, until):\n            continue",
        "        if False:\n            continue",
    ),
]


def run(argv=None):
    ap = argparse.ArgumentParser(description="mutation-prove the xsearch_gather guards")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    original = SRC.read_text()
    proven, problems = 0, []

    print("=" * 78)
    print("RED-PROOF — reverting each guard to its naive behavior, expecting RED")
    print("=" * 78)

    # Sanity: the suite must be GREEN before we start, or 'RED' means nothing.
    base = subprocess.run([sys.executable, "-m", "pytest", str(TEST), "-q"],
                          cwd=REPO, capture_output=True, text=True)
    base_line = (base.stdout.strip().splitlines() or ["<no output>"])[-1]
    if base.returncode != 0:
        print(f"ABORT: baseline suite is not green -> {base_line}")
        return 1
    print(f"baseline: {base_line}\n")

    for blocker, label, selector, old, new in MUTATIONS:
        if old not in original:
            problems.append(f"[{blocker}] ANCHOR DRIFT — snippet not found: {label}")
            print(f"  ⚠️  [{blocker}] ANCHOR DRIFT (proof is not running): {label}")
            continue

        with tempfile.TemporaryDirectory() as td:
            work = Path(td) / "repo"
            # Copy only what the tests import (scripts/ incl. __tests__), keeping the
            # mutation run fast. NOTE: no `dirs_exist_ok` — the repo's `python3` is
            # anaconda 3.7 (AGENTS.md's documented PATH hazard), so this harness must
            # stay 3.7-compatible or it silently stops running.
            shutil.copytree(REPO / "scripts", work / "scripts",
                            ignore=shutil.ignore_patterns("__pycache__", "node_modules",
                                                          "brief-replay", "eval", "lib",
                                                          "gather", "*.ts", "*.sh"))
            (work / "scripts" / "xsearch_gather.py").write_text(original.replace(old, new, 1))

            proc = subprocess.run(
                [sys.executable, "-m", "pytest",
                 str(work / "scripts" / "__tests__" / "xsearch_gather_test.py"),
                 "-q", "-k", selector, "-p", "no:cacheprovider"],
                cwd=work, capture_output=True, text=True)

        last = (proc.stdout.strip().splitlines() or ["<no output>"])[-1]
        if proc.returncode != 0 and ("failed" in last or "error" in last):
            print(f"  ✅ [{blocker}] RED as expected — {label}")
            print(f"        {last}")
            proven += 1
        else:
            print(f"  ❌ [{blocker}] STILL GREEN — test is VACUOUS — {label}")
            print(f"        {last}")
            problems.append(f"[{blocker}] vacuous guard: {label}")
        if args.verbose:
            print(proc.stdout)

    print("=" * 78)
    print(f"RED-PROOF: {proven}/{len(MUTATIONS)} guards proven non-vacuous")
    for p in problems:
        print(f"  ! {p}")
    # The real source is never modified by this harness — assert that.
    assert SRC.read_text() == original, "harness mutated the real source (bug)"
    print("source unchanged (mutations ran against temp copies)")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(run())
