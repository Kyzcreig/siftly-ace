#!/usr/bin/env bash
# Daily incremental Siftly ingest wrapper for launchd.
# Secrets stay in scripts/with-secrets.sh; this file only wires the no-agent cron path.
set -euo pipefail

REPO_ROOT="/Users/alexgierczyk/Projects/siftly-ace"
cd "$REPO_ROOT"

# launchd starts with a sparse PATH; include Homebrew + system paths for op, node/npx, and python3.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

exec "$REPO_ROOT/scripts/with-secrets.sh" npx tsx scripts/daily-ingest.ts "$@"
