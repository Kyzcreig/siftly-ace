#!/usr/bin/env bash
# Launchd/manual wrapper for the Siftly web UI production server.
# Builds when the checked-in app has changed since .next/BUILD_ID, then starts Next on *:3000.
set -euo pipefail

REPO_ROOT="/Users/alexgierczyk/Projects/siftly-ace"
LOG_PATH="${SIFTLY_WEB_LOG:-/Users/alexgierczyk/Library/Logs/siftly-web.log}"

# launchd starts with a sparse PATH; include Homebrew + system paths for node/npm/op/python.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"

mkdir -p "$(dirname "$LOG_PATH")"
exec >>"$LOG_PATH" 2>&1

cd "$REPO_ROOT"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

BUILD_ID="$REPO_ROOT/.next/BUILD_ID"
needs_build=0
build_reason=""

if [[ ! -f "$BUILD_ID" ]]; then
  needs_build=1
  build_reason="missing .next/BUILD_ID"
else
  while IFS= read -r newer_path; do
    if [[ -n "$newer_path" ]]; then
      needs_build=1
      build_reason="$newer_path newer than .next/BUILD_ID"
      break
    fi
  done < <(
    /usr/bin/find app components lib prisma public \
      \( -path '*/__tests__/*' -o -name '*.test.*' -o -name '*.spec.*' \) -prune -o \
      -type f \
      \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.css' -o -name '*.json' -o -name '*.prisma' \) \
      -newer "$BUILD_ID" -print 2>/dev/null
    for file in package.json package-lock.json next.config.ts tsconfig.json postcss.config.mjs middleware.ts middleware.js proxy.ts proxy.js instrumentation.ts instrumentation.js; do
      if [[ -f "$file" && "$file" -nt "$BUILD_ID" ]]; then
        printf '%s\n' "$file"
      fi
    done
  )
fi

echo "[$(timestamp)] siftly web-server.sh starting (pid=$$)"

if [[ "$needs_build" -eq 1 ]]; then
  echo "[$(timestamp)] production build stale: $build_reason"
  npm run build
else
  echo "[$(timestamp)] production build current: $BUILD_ID"
fi

echo "[$(timestamp)] starting Next production server on 0.0.0.0:3000"
exec "$REPO_ROOT/scripts/with-secrets.sh" npm run start -- -p 3000 -H 0.0.0.0
