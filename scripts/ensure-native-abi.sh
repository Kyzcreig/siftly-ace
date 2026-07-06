#!/usr/bin/env bash
# ensure-native-abi.sh — self-heal native-module ABI drift.
#
# WHY: native node modules (better-sqlite3) are compiled against a specific node
# ABI (NODE_MODULE_VERSION). When node is upgraded on the box, the prebuilt .node
# is compiled for the OLD ABI and every `require('better-sqlite3')` throws
# ("was compiled against a different Node.js version"). In siftly-ace that broke
# ALL TS Prisma/better-sqlite3 DB paths — most visibly translation, which lives
# on the nightly brief post-path and fail-safe-swallowed the throw so it went
# unnoticed for days (2026-07-06).
#
# WHAT: probe better-sqlite3's native load. If it fails, `npm rebuild` it ONCE so
# the .node is recompiled for the running node. Idempotent + cheap on the happy
# path (a require that succeeds is milliseconds; the rebuild only runs when the
# ABI is actually broken). Fail-safe: a rebuild that itself fails is logged and
# NON-fatal — the caller still proceeds (translation degrades to original text,
# it never blocks the brief).
#
# This replaces the manual "remember to run npm rebuild after every node upgrade"
# toil with automatic self-healing on the path that needs it.
set -uo pipefail
REPO="${SIFTLY_REPO:-$HOME/Projects/siftly-ace}"
NODE_BIN="$(command -v node || echo node)"
err(){ echo "[ensure-native-abi] $*" >&2; }

cd "$REPO" 2>/dev/null || { err "repo not found: $REPO"; exit 0; }  # exit 0 = non-fatal

# Probe: does the native module load under the CURRENT node ABI?
if "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1; then
  exit 0   # healthy — nothing to do (the common case, fast)
fi

# Broken. Confirm it's the ABI-mismatch signature before rebuilding (don't mask a
# genuinely-missing module or a different failure with a pointless rebuild loop).
PROBE_ERR="$("$NODE_BIN" -e "try{require('better-sqlite3')}catch(e){process.stderr.write(String(e.message||e))}" 2>&1 || true)"
case "$PROBE_ERR" in
  *NODE_MODULE_VERSION*|*"different Node.js version"*|*"was compiled against"*)
    err "better-sqlite3 ABI mismatch detected (node $($NODE_BIN -v)); rebuilding once…"
    if npm rebuild better-sqlite3 >/dev/null 2>&1 && "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1; then
      err "better-sqlite3 rebuilt OK — native DB paths healthy again"
      exit 0
    else
      err "npm rebuild better-sqlite3 FAILED — DB-backed TS paths (incl. translation) will degrade; continuing non-fatally"
      exit 0   # non-fatal: caller proceeds, translation fail-safes to original text
    fi
    ;;
  *)
    err "better-sqlite3 load failed but not an ABI mismatch (\"${PROBE_ERR:0:120}\") — not rebuilding; continuing"
    exit 0
    ;;
esac
