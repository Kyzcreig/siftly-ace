#!/usr/bin/env bash
# Waits for the video transcription queue to fully drain, then re-embeds the
# whole corpus (sweeping in captions + OCR + video transcripts via the media
# join) and re-exports to Obsidian. One-shot finisher; safe to run in background.
set -uo pipefail

QUEUE="$HOME/.hermes/state/x-bookmarks/video-enrich-queue.jsonl"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE" || exit 1

pending_count() {
  python3 - "$QUEUE" <<'PY'
import json,sqlite3,sys
p=sys.argv[1]
db=p+'.sqlite'
try:
    con=sqlite3.connect(db)
    try:
        print(con.execute("SELECT COUNT(*) FROM queue WHERE status IN ('pending','leasing')").fetchone()[0])
        raise SystemExit
    finally:
        con.close()
except Exception:
    pass
n=0
try:
    for l in open(p):
        l=l.strip()
        if not l: continue
        try:
            if json.loads(l).get('status') in ('pending','leasing'): n+=1
        except Exception:
            pass
except FileNotFoundError:
    pass
print(n)
PY
}

# Wait (up to ~6h) for the queue to drain.
for _ in $(seq 1 720); do
  n="$(pending_count)"
  echo "[finalize] pending=$n $(date +%H:%M:%S)"
  [ "${n:-1}" -eq 0 ] && break
  sleep 30
done

echo "[finalize] queue drained — re-embedding full corpus"
scripts/with-secrets.sh tsx scripts/embed.ts --limit 100000 --force 2>&1 | grep -viE "loaded|vec0=" | tail -5

echo "[finalize] re-exporting to Obsidian"
npx tsx scripts/export-obsidian.ts 2>&1 | tail -5

echo "[finalize] DONE $(date +%H:%M:%S)"
