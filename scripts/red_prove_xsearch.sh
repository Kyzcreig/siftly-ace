#!/usr/bin/env bash
# red_prove_xsearch.sh — MUTATION PROOF for the xsearch_gather blocker guards.
#
# A green test suite proves nothing on its own: a test that passes against BOTH the
# fixed and the broken code is vacuous. This script surgically reverts each guard to
# its naive/pre-fix behavior, re-runs the suite, and asserts the corresponding test
# goes RED. Every mutation is reverted afterwards (git checkout).
#
# Usage: bash scripts/red_prove_xsearch.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=scripts/xsearch_gather.py
TEST=scripts/__tests__/xsearch_gather_test.py
PASS=0; FAIL=0

restore() { git checkout -- "$SRC" 2>/dev/null || true; }
trap restore EXIT

mutate_and_expect_red() {
  local label="$1" test_selector="$2" python_mutation="$3"
  restore
  python3 - "$SRC" <<PY
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
${python_mutation}
p.write_text(s)
PY
  if [ $? -ne 0 ]; then
    echo "  ⚠️  ${label}: mutation could not be applied (anchor drift)"; FAIL=$((FAIL+1)); restore; return
  fi
  out=$(python3 -m pytest "$TEST" -q -k "$test_selector" 2>&1 | tail -1)
  if echo "$out" | grep -qE "failed|error"; then
    echo "  ✅ RED as expected — ${label}"
    echo "       └─ $out"
    PASS=$((PASS+1))
  else
    echo "  ❌ STILL GREEN (test is vacuous!) — ${label}"
    echo "       └─ $out"
    FAIL=$((FAIL+1))
  fi
  restore
}

echo "════════ RED-PROOF: mutating each guard, expecting the test to fail ════════"

echo
echo "BLOCKER 1 — candidate shape (tweet_text + flat metrics)"
mutate_and_expect_red "emit \`text\` instead of \`tweet_text\` (spec-v3 shape)" \
  "Blocker1" \
  's = s.replace(\x27"tweet_text": text,              # B1: the ONLY key _item_text will read\x27, \x27"text": text,\x27)
assert \x27"text": text,\x27 in s'

mutate_and_expect_red "drop the FLAT likes/retweets, keep only public_metrics" \
  "flat_AND_nested or SURVIVAL_row_renders" \
  's = s.replace(\x27"likes": likes,                  # B1: flat — overview/render read only these\n        "retweets": rts,\x27, \x27\x27)
assert \x27"likes": likes,                  # B1\x27 not in s'

echo
echo "BLOCKER 2 — snowflake id coercion"
mutate_and_expect_red "return the raw id (no string coercion)" \
  "Blocker2" \
  's = s.replace("    if isinstance(value, int):\n        return str(value)", "    if isinstance(value, int):\n        return value")
assert "        return value\n" in s'

echo
echo "BLOCKER 3 — timestamp normalization"
mutate_and_expect_red "ISO-only parser (drop the RFC-1123 fallback)" \
  "Blocker3" \
  'old = """        try:
            dt = email.utils.parsedate_to_datetime(s)
        except (TypeError, ValueError, IndexError):
            return None"""
assert old in s
s = s.replace(old, "        return None")'

echo
echo "BLOCKER 4 — empty pool loud failure"
mutate_and_expect_red "never flag an empty pool" \
  "Blocker4" \
  's = s.replace(\x27report["empty_pool"] = (report["rows_after_window_filter"] == 0)\x27, \x27report["empty_pool"] = False\x27)
assert \x27report["empty_pool"] = False\x27 in s'

mutate_and_expect_red "exit 0 even on an empty pool" \
  "cli_exits_nonzero_on_empty_pool" \
  'old = """    if report["empty_pool"] or not report["credential_ok"]:
        return 3"""
assert old in s
s = s.replace(old, "    if False:\n        return 3")'

echo
echo "BLOCKER 5 — citation hallucination guard"
mutate_and_expect_red "accept uncited tweet_ids" \
  "uncited_row_is_dropped" \
  'old = """        if cited is not None and tid not in cited:"""
assert old in s
s = s.replace(old, "        if False:")'

mutate_and_expect_red "read only the top-level \`citations\` array (spec wording)" \
  "Blocker5" \
  's = s.replace(\x27for key in ("citations", "inline_citations"):\x27, \x27for key in ("citations",):\x27)
assert \x27for key in ("citations",):\x27 in s'

mutate_and_expect_red "ignore the degraded flag" \
  "degraded_chunk_yields_no_candidates" \
  'old = """    if stats["degraded"]:"""
assert old in s
s = s.replace(old, "    if False:", 1)'

echo
echo "BLOCKER 6 — credential fallback visibility"
mutate_and_expect_red "always report credentials as OK" \
  "Blocker6" \
  's = s.replace(\x27stats["credential_ok"] = stats["credential_source"] == REQUIRED_CREDENTIAL_SOURCE\x27, \x27stats["credential_ok"] = True\x27)
assert \x27stats["credential_ok"] = True\x27 in s'

echo
echo "SOURCING CONTRACT — operator syntax"
mutate_and_expect_red "build a PROSE query instead of operator syntax" \
  "operator_syntax_not_prose or G1_handles or since_until" \
  'old = """    clauses = [f"from:{h}{faves} since:{since_d} until:{until_d}{rts}" for h in hs]"""
assert old in s
s = s.replace(old, "    clauses = [f\x27the 30 most recent posts\x27 for h in hs]")'

mutate_and_expect_red "drop the local window re-filter (trust grok\x27s date math)" \
  "local_window_filter_overrides" \
  'old = """        if not in_window(cand, since, until):
            continue"""
assert old in s
s = s.replace(old, "        if False:\n            continue")'

echo
echo "════════════════════════════════════════════════════════════════════════════"
echo "RED-PROOF: ${PASS} guards proven non-vacuous, ${FAIL} problems"
restore
[ "$FAIL" -eq 0 ] || exit 1
echo "Restored clean: $(git status --porcelain "$SRC" | wc -l | tr -d ' ') modified files"
