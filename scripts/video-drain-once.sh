#!/usr/bin/env bash
# One-shot launchd/manual wrapper for the Siftly video transcription drain.
# Runs batches until the queue has no pending work, finalizes search/export, then
# unloads its own LaunchAgent so this backfill helper does NOT become a daemon.
set -euo pipefail

REPO_ROOT="/Users/alexgierczyk/Projects/siftly-ace"
LOG_PATH="${SIFTLY_VIDEO_DRAIN_LOG:-/Users/alexgierczyk/Library/Logs/siftly-video-drain-once.log}"
LABEL="ai.siftly.video-drain-once"
LIMIT="${SIFTLY_VIDEO_DRAIN_LIMIT:-50}"
TIMEOUT_MS="${SIFTLY_VIDEO_DRAIN_TIMEOUT_MS:-1800000}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/alexgierczyk/.local/bin:/usr/bin:/bin:${PATH:-}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
# Default to the full Parakeet fleet. scripts/video-enrich.ts health-filters and
# pins each worker to a backend via PARAKEET_URL because parakeet-transcribe.sh
# itself only accepts one URL per call.
export SIFTLY_PARAKEET_BACKENDS="${SIFTLY_PARAKEET_BACKENDS:-http://192.168.1.216:8923,http://192.168.1.78:8923,http://127.0.0.1:8924}"

mkdir -p "$(dirname "$LOG_PATH")"
exec >>"$LOG_PATH" 2>&1

cd "$REPO_ROOT"

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

self_unload() {
  # Best effort. If run manually or already unloaded, do nothing. The work is
  # done before this point; failure to unload only means launchctl still lists a
  # one-shot disabled/completed job.
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
}
trap self_unload EXIT

echo "[$(timestamp)] $LABEL starting (pid=$$ limit=$LIMIT backends=$SIFTLY_PARAKEET_BACKENDS)"

while true; do
  set +e
  out="$(npx tsx scripts/video-enrich.ts --limit "$LIMIT" --timeout-ms "$TIMEOUT_MS" 2>&1)"
  code=$?
  set -e
  echo "$out"
  if [[ "$code" -ne 0 ]]; then
    echo "[$(timestamp)] video drain batch failed exit=$code; leaving LaunchAgent loaded for inspection"
    trap - EXIT
    exit "$code"
  fi

  processed="$(printf '%s\n' "$out" | grep -oE 'processed=[0-9]+' | tail -1 | cut -d= -f2 || true)"
  processed="${processed:-0}"
  echo "[$(timestamp)] batch complete processed=$processed"
  if [[ "$processed" -eq 0 ]]; then
    break
  fi
done

echo "[$(timestamp)] queue drained; running finalize-after-drain.sh"
./scripts/finalize-after-drain.sh

echo "[$(timestamp)] $LABEL complete; unloading self"
