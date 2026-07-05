#!/usr/bin/env bash
# Daily incremental Siftly ingest wrapper for launchd.
# Secrets stay in scripts/with-secrets.sh; this file only wires the no-agent cron path.
set -euo pipefail

REPO_ROOT="/Users/alexgierczyk/Projects/siftly-ace"
cd "$REPO_ROOT"

# launchd starts with a sparse PATH; include Homebrew + system paths for op, node/npx, and python3.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# Route cron notifications to dedicated ops channels unless the launch environment overrides them.
export SIFTLY_DAILY_CRON="${SIFTLY_DAILY_CRON:-1}"
export SIFTLY_ALERT_CHANNEL="${SIFTLY_ALERT_CHANNEL:-1480528231286181948}"
export SIFTLY_LOG_CHANNEL="${SIFTLY_LOG_CHANNEL:-1480525090331561984}"

# Native-ABI self-heal: better-sqlite3 is a compiled native module pinned to the Node
# ABI it was built against. A Homebrew `node` upgrade (e.g. 24→26, ABI 127→147) silently
# invalidates it, and EVERY DB write then throws NODE_MODULE_VERSION mismatch → ingest
# fails until someone runs `npm rebuild`. This bit us 2026-07-04 (node auto-bumped 5/14).
# Cheap preflight: try to load the module; if it throws, rebuild it in place before the run.
if ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  echo "daily-ingest: better-sqlite3 native ABI mismatch detected — rebuilding for $(node --version) (ABI $(node -p 'process.versions.modules'))" >&2
  npm rebuild better-sqlite3 >&2 || { echo "daily-ingest: npm rebuild better-sqlite3 FAILED" >&2; exit 1; }
  node -e 'require("better-sqlite3")' >/dev/null 2>&1 || { echo "daily-ingest: better-sqlite3 still unloadable after rebuild" >&2; exit 1; }
  echo "daily-ingest: better-sqlite3 rebuilt OK" >&2
fi

exec "$REPO_ROOT/scripts/with-secrets.sh" npx tsx scripts/daily-ingest.ts "$@"
