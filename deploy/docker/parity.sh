#!/usr/bin/env bash
# parity.sh — compare the live siftly web server against the container, page by page.
#
#   deploy/docker/parity.sh [OLD_BASE] [NEW_BASE]
#   defaults: OLD=http://127.0.0.1:3000 (launchd ai.siftly.web)  NEW=http://127.0.0.1:13000 (container)
#
# 15 GET probes: index, search (UI + API), 5 bookmarks (API, by id in the bookmark list),
# categories, a category, mindmap, stats, settings, and the brief-facing tweet route.
# Per path: compares HTTP status and sha256 of the NORMALIZED body. Normalization strips
# per-build/per-request values only:
#   - Next build id: the 21-char BUILD_ID string (read from each server's HTML), and its
#     '-'->'_' form in the <!--...--> head comment -> BUILDID
#   - hashed asset names under /_next/static/ (chunks/*.js|css, media/*) -> /_next/static/ASSET
#   - nonce="..." attributes -> nonce=""
# Everything else (data, markup, text) must be byte-identical. Exit 0 only if all 15 match.
#
# Data caveat: both servers must read the SAME dev.db contents. The side-by-side container
# reads a snapshot, so take the snapshot right before running this (see README) or a nightly
# ingest between snapshot and probe shows up as a body diff.
set -uo pipefail

OLD="${1:-http://127.0.0.1:3000}"
NEW="${2:-http://127.0.0.1:13000}"
DB="${SIFTLY_PARITY_DB:-$HOME/Projects/siftly-ace/prisma/dev.db}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ids=()
while IFS= read -r i; do [[ -n "$i" ]] && ids+=("$i"); done < <(
  sqlite3 -readonly "$DB" "select id from Bookmark order by id limit 5 offset 100;" 2>/dev/null)
tweet="$(sqlite3 -readonly "$DB" "select tweetId from Bookmark order by id limit 1 offset 100;" 2>/dev/null)"
cat="$(sqlite3 -readonly "$DB" "select slug from Category order by slug limit 1;" 2>/dev/null)"
if [[ ${#ids[@]} -ne 5 || -z "$tweet" || -z "$cat" ]]; then
  echo "parity: could not read 5 bookmark ids / a tweet id / a category from $DB" >&2; exit 2
fi

paths=(
  "/"
  "/bookmarks"
  "/ai-search"
  "/api/bookmarks?q=claude&limit=20"
  "/api/bookmarks?limit=5&sort=newest"
)
# 5 single bookmarks: pages 101..105 of the newest-first list (limit=1 -> one bookmark each).
for pg in 101 102 103 104 105; do paths+=("/api/bookmarks?limit=1&sort=newest&page=$pg"); done
paths+=(
  "/categories/$cat"
  "/api/categories"
  "/api/stats"
  "/mindmap"
  "/api/tweets/$tweet"
)

buildid() { curl -s --max-time 30 "$1/" | grep -oE '"buildId":"[^"]+"|\\"b\\":\\"[^\\]+' | head -1 | grep -oE '[A-Za-z0-9_-]{21}' | head -1; }
BO="$(buildid "$OLD")"; BN="$(buildid "$NEW")"

norm() { # $1 file, $2 build id
  local f="$1" b="$2"
  # the HTML head comment carries the build id with '-' rewritten to '_'
  if [[ -n "$b" ]]; then local b2="${b//-/_}"; perl -pi -e "s/\Q$b\E/BUILDID/g; s/\Q$b2\E/BUILDID/g" "$f"; fi
  perl -pi -e 's#/_next/static/(chunks|media|css)/[A-Za-z0-9._~-]+#/_next/static/ASSET#g; s/nonce="[^"]*"/nonce=""/g' "$f"
}

pass=0; fail=0; n=0
printf '%-48s %-5s %-5s %-8s %s\n' PATH OLD NEW BYTES RESULT
for p in "${paths[@]}"; do
  n=$((n+1))
  so=$(curl -s -o "$TMP/o" -w '%{http_code}' --max-time 60 "$OLD$p")
  sn=$(curl -s -o "$TMP/n" -w '%{http_code}' --max-time 60 "$NEW$p")
  norm "$TMP/o" "$BO"; norm "$TMP/n" "$BN"
  ho=$(shasum -a 256 "$TMP/o" | cut -c1-12); hn=$(shasum -a 256 "$TMP/n" | cut -c1-12)
  bytes=$(wc -c < "$TMP/o" | tr -d ' ')
  if [[ "$so" == "$sn" && "$ho" == "$hn" ]]; then r="MATCH $ho"; pass=$((pass+1))
  else r="DIFF old=$ho new=$hn"; fail=$((fail+1))
       diff <(fold -w 200 "$TMP/o") <(fold -w 200 "$TMP/n") | head -6 | sed 's/^/    /' >"$TMP/d"; fi
  printf '%-48s %-5s %-5s %-8s %s\n' "${p:0:48}" "$so" "$sn" "$bytes" "$r"
  [[ -s "$TMP/d" ]] && cat "$TMP/d" && : >"$TMP/d"
done
echo "build ids: old=${BO:-?} new=${BN:-?} (normalized)"
echo "parity: $pass/$n match, $fail diff"
[[ $fail -eq 0 && $n -eq 15 ]]
