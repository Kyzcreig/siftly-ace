#!/usr/bin/env bash
# ensure-native-abi.sh — the ONE authority that self-heals native-module ABI drift.
#
# WHY: native node modules (better-sqlite3) are compiled against a specific node
# ABI (NODE_MODULE_VERSION). When node is upgraded on the box (Homebrew auto-bump),
# the prebuilt .node is compiled for the OLD ABI and every `require('better-sqlite3')`
# throws ("was compiled against a different Node.js version"). In siftly-ace this
# broke ALL TS Prisma/better-sqlite3 DB paths — the nightly daily-ingest (fail-closed,
# 2026-07-04) AND translation on the brief post-path, which fail-safe-swallowed the
# throw so it went unnoticed for days (2026-07-06).
#
# WHAT: probe better-sqlite3's native load. If it fails with the ABI-mismatch
# signature, `npm rebuild` it ONCE and re-verify. Idempotent + cheap on the happy
# path (a require that succeeds is milliseconds; the rebuild only runs when the ABI
# is actually broken). Narrow: a non-ABI load failure (missing bindings, etc.) does
# NOT trigger a pointless rebuild.
#
# TWO fail-modes, per caller:
#   default   fail-OPEN  — a failed/skipped rebuild exits 0 (non-fatal). For callers
#                          where the DB is OPTIONAL (translation on the brief path
#                          degrades to original text; must never block the brief).
#   --strict  fail-CLOSED — a failed rebuild / still-broken module exits 1. For
#                          callers that CANNOT run without the DB (daily-ingest).
#
# This replaces the per-script inline copies + the manual "remember to npm rebuild
# after every node upgrade" toil with one self-healing authority.
set -uo pipefail
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1
REPO="${SIFTLY_REPO:-$HOME/Projects/siftly-ace}"
NODE_BIN="$(command -v node || echo node)"
err(){ echo "[ensure-native-abi] $*" >&2; }
# fail(): honor the caller's fail-mode. strict → exit 1 (abort the run); else exit 0.
fail(){ err "$1"; [ "$STRICT" = "1" ] && exit 1 || exit 0; }

cd "$REPO" 2>/dev/null || fail "repo not found: $REPO"

# Probe: does the native module load under the CURRENT node ABI?
if "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1; then
  exit 0   # healthy — the common case, fast
fi

# Broken. Confirm the ABI-mismatch signature before rebuilding (don't mask a
# genuinely-missing module or a different failure with a pointless rebuild).
PROBE_ERR="$("$NODE_BIN" -e "try{require('better-sqlite3')}catch(e){process.stderr.write(String(e.message||e))}" 2>&1 || true)"
case "$PROBE_ERR" in
  *NODE_MODULE_VERSION*|*"different Node.js version"*|*"was compiled against"*)
    err "better-sqlite3 ABI mismatch detected (node $($NODE_BIN -v), ABI $($NODE_BIN -p 'process.versions.modules')); rebuilding once…"
    if npm rebuild better-sqlite3 >&2 && "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1; then
      err "better-sqlite3 rebuilt OK — native DB paths healthy again"
      exit 0
    else
      fail "npm rebuild better-sqlite3 FAILED / still unloadable — DB-backed TS paths will not work"
    fi
    ;;
  *)
    fail "better-sqlite3 load failed but not an ABI mismatch (\"${PROBE_ERR:0:120}\") — not rebuilding"
    ;;
esac
