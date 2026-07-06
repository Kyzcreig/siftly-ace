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

# Native-ABI self-heal (fail-CLOSED): daily-ingest CANNOT run if the DB is broken,
# so a failed rebuild aborts the run (exit 1). Delegates to the shared authority
# scripts/ensure-native-abi.sh (the ONE place this logic lives — build-report.sh
# uses the same script fail-OPEN). A Homebrew node upgrade silently invalidates
# better-sqlite3's compiled .node; the guard rebuilds it once before the run.
"$REPO_ROOT/scripts/ensure-native-abi.sh" --strict || exit 1

exec "$REPO_ROOT/scripts/with-secrets.sh" npx tsx scripts/daily-ingest.ts "$@"
