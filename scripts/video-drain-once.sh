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
# Launchd can inherit HERMES_PROFILE=daedalus from prior worker sessions. The
# Daedalus profile copy of parakeet-transcribe.sh is stale and ignores
# PARAKEET_URL, which collapses the fleet pool back to ACE-AI. Pin the current
# default-profile skill script explicitly so per-worker PARAKEET_URL fan-out is
# honored without mutating another Hermes profile.
export PARAKEET_TRANSCRIBE_SCRIPT="${PARAKEET_TRANSCRIBE_SCRIPT:-/Users/alexgierczyk/.hermes/skills/media/parakeet-transcribe/scripts/parakeet-transcribe.sh}"

mkdir -p "$(dirname "$LOG_PATH")"
exec >>"$LOG_PATH" 2>&1

cd "$REPO_ROOT"

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

active_queue_count() {
  local q="${SIFTLY_VIDEO_QUEUE_PATH:-$HOME/.hermes/state/x-bookmarks/video-enrich-queue.jsonl}"
  local db="$q.sqlite"
  if [[ -f "$db" ]]; then
    sqlite3 "$db" "SELECT COUNT(*) FROM queue WHERE status IN ('pending','leasing');" 2>/dev/null || echo 1
  elif [[ -f "$q" ]]; then
    python3 - "$q" <<'PY'
import json,sys
n=0
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    try:
        if json.loads(l).get('status') in ('pending','leasing'): n+=1
    except Exception:
        pass
print(n)
PY
  else
    echo 0
  fi
}

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
  active="$(active_queue_count)"
  echo "[$(timestamp)] batch complete processed=$processed active=$active"
  if [[ "$active" -eq 0 ]]; then
    break
  fi
  if [[ "$processed" -eq 0 ]]; then
    echo "[$(timestamp)] no claimable records but active=$active; waiting for stale leases/other worker completion"
    sleep 60
  fi
done

echo "[$(timestamp)] queue drained; running finalize-after-drain.sh"
./scripts/finalize-after-drain.sh

echo "[$(timestamp)] $LABEL complete; unloading self"
