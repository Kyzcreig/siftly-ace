#!/usr/bin/env bash
# build-report.sh — render a brief's _render_input.json as a Refined-Cards HTML
# report and publish it to a fresh doc-share link. Prints ONLY the URL on stdout
# (so the caller can grab it); all diagnostics go to stderr.
#
# Exit non-zero on ANY failure so the brief's Step 7 can fall back to the inline
# post and never be left with nothing.
#
# Usage: build-report.sh <render_input.json> <title> <out_html_path>
#   stdout: the published URL (one line) on success
set -uo pipefail

REPO="$HOME/Projects/siftly-ace"
IN="${1:-}"; TITLE="${2:-Brief}"; OUT="${3:-/tmp/siftly-report.html}"
DOC_SHARE="$HOME/.hermes/skills-shared/general/doc-share/scripts/doc-share.sh"

err(){ echo "[build-report] $*" >&2; }

[ -n "$IN" ] && [ -f "$IN" ] || { err "render input missing: $IN"; exit 1; }
TSX="$REPO/node_modules/.bin/tsx"
[ -x "$TSX" ] || { err "tsx not found"; exit 1; }

# 0a) SELF-HEAL native-module ABI drift (2026-07-06). If node was upgraded on the
#     box, better-sqlite3's prebuilt .node is compiled for the old ABI and every
#     DB lookup throws — which silently disabled translation for days. This probes
#     + auto-rebuilds ONCE if broken. Cheap on the happy path, fail-safe (never
#     blocks the brief). Replaces the old "remember to npm rebuild" manual step.
bash "$REPO/scripts/ensure-native-abi.sh" || true

# 0) OVERVIEW SAFETY-NET (2026-06-29): the overview is injected into _render_input.json
#    by Step 6.9, but if the LLM ran Step 6.7 (select_digest, which REWRITES
#    _render_input.json) AFTER 6.9, the injected overview is clobbered and the
#    Landscape section silently vanishes (the symptom Ace caught). Make the report
#    build the LAST writer: if the render-input has no overview but the brief's
#    linked-overview file exists, re-inject it here so ordering can't lose it.
#    Fully fail-safe + idempotent: if already present or the file is missing, no-op.
OV_FILE="${4:-}"
if [ -z "$OV_FILE" ]; then
  # derive the brief's linked-overview tmp file from the render-input dir name
  case "$IN" in
    *morning-digest*) OV_FILE="/tmp/morning-digest-overview-linked.txt" ;;
    *x-feed*)         OV_FILE="/tmp/x-feed-overview-linked.txt" ;;
  esac
fi
if [ -n "$OV_FILE" ] && [ -s "$OV_FILE" ]; then
  if ! python3 -c "import json,sys; sys.exit(0 if json.load(open('$IN')).get('overview') else 1)" 2>/dev/null; then
    err "overview missing from render-input; re-injecting from $OV_FILE (Step-6.9/6.7 ordering safety-net)"
    python3 "$REPO/scripts/inject_overview.py" --render-input "$IN" --overview-file "$OV_FILE" 2>&1 >&2 || err "overview re-inject non-fatal failure"
  fi
fi

# 1) render HTML (getTweet hydrates tweet cards; secrets not required for public tweets).
#    Route through with-secrets.sh so OPENAI_API_KEY is present for foreign-text
#    translation (lib/translate.ts). Translation is fail-safe: if secrets can't load,
#    it silently no-ops and the report still builds with original-language text.
WITH_SECRETS="$REPO/scripts/with-secrets.sh"
cd "$REPO" || { err "cd repo failed"; exit 1; }
if [ -x "$WITH_SECRETS" ]; then
  RENDER_CMD=(bash "$WITH_SECRETS" "$TSX" scripts/html_report.ts --in "$IN" --out "$OUT" --title "$TITLE")
else
  RENDER_CMD=("$TSX" scripts/html_report.ts --in "$IN" --out "$OUT" --title "$TITLE")
fi
if ! timeout 180 "${RENDER_CMD[@]}" >&2; then
  err "html_report.ts failed"; exit 1
fi
[ -s "$OUT" ] || { err "empty html output"; exit 1; }

# 2) publish. Publisher is selectable (I7): DOCS_PUBLISHER=ace (DEFAULT, docs.ace) | herenow.
#    `ace`  → ace_publisher.py writes into the docs.ace webroot, mints <slug>.docs.ace, self-verifies (I3).
#    herenow→ today's doc-share→here.now path (retained opt-in + the share-copy engine).
#    Each driver prints ONLY the URL on stdout; non-zero/empty ⇒ caller's inline fallback (I3).
unset HERMES_HOME
PUBLISHER="${DOCS_PUBLISHER:-ace}"
ACE_PUB="$HOME/.hermes/var/docs-portal/ace_publisher.py"

# derive the doc_identity_key (D-11): briefs = (brief_name, PT_date). Stable across a same-day re-run
# so a retry REUSES the slug (keeps the posted #daily link alive).
PT_DATE="$(TZ=America/Los_Angeles date +%F)"
case "$IN" in
  *morning-digest*) DOC_ID="morning-digest|$PT_DATE"; DOC_TYPE="briefs" ;;
  *x-feed*)         DOC_ID="x-feed-brief|$PT_DATE";   DOC_TYPE="briefs" ;;
  *)                DOC_ID="doc|$(basename "$IN")|$PT_DATE"; DOC_TYPE="docs" ;;
esac

if [ "$PUBLISHER" = "ace" ] && [ -f "$ACE_PUB" ]; then
  URL="$(DOCS_HOST_IP=192.168.1.18 /opt/homebrew/bin/python3 "$ACE_PUB" \
          --in "$OUT" --type "$DOC_TYPE" --doc-id "$DOC_ID" --title "$TITLE" 2>>/tmp/ace-publish.err)"
  case "$URL" in
    https://*) echo "$URL"; err "published (ace): $URL"; exit 0 ;;
    *) err "ace publisher returned no URL (see /tmp/ace-publish.err) — falling back to here.now" ;;
  esac
fi

# herenow driver (explicit opt-in OR ace-fallback): publish to a fresh doc-share link.
URL="$(bash "$DOC_SHARE" "$OUT" --no-render --title "$TITLE" 2>/dev/null | tail -1)"
case "$URL" in
  https://*) echo "$URL"; err "published (herenow): $URL"; exit 0 ;;
  *) err "doc-share returned no URL"; exit 1 ;;
esac
