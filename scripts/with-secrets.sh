#!/usr/bin/env bash
# with-secrets.sh — inject siftly-ace runtime secrets from 1Password, then exec the given command.
#
# WHY: no secret literals live in the repo or in a committed .env. The embedding key
# (and any future runtime secret) is pulled from 1Password at call time via the fleet
# service-account token, so cron/tests/CLI all get a valid key without a manual export.
#
# Usage:
#   scripts/with-secrets.sh npm run embed -- --limit 50
#   scripts/with-secrets.sh npx tsx scripts/embed.ts --limit 5 --force
#   scripts/with-secrets.sh npm run test:e2e
#
# Requires either:
#   - OP_SERVICE_ACCOUNT_TOKEN in env (fleet service account; non-interactive — for cron), or
#   - an interactive `op signin` session (for a human shell).
#
# Secrets injected (1Password Engineering vault, referenced by stable item id):
#   OPENAI_API_KEY  <- item 77x7lxny2xabgkuupkhkthttsy field `credential`
#
# vec0 extension path: defaults to ./.local/vec0.dylib if present and not already set,
# so the real sqlite-vec path is exercised rather than silently demoting to brute-force.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -eq 0 ]]; then
  echo "with-secrets.sh: no command given" >&2
  echo "usage: scripts/with-secrets.sh <command> [args...]" >&2
  exit 64
fi

# Under launchd the environment is sparse: OP_SERVICE_ACCOUNT_TOKEN may be unset even though
# it lives in ~/.hermes/.env. Source ONLY that one var (no secret echoed) so op can auth
# non-interactively. Interactive shells already have it exported and skip this.
if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" && -r "$HOME/.hermes/.env" ]]; then
  _optok_line="$(grep -E "^OP_SERVICE_ACCOUNT_TOKEN=" "$HOME/.hermes/.env" | head -n1)"
  if [[ -n "$_optok_line" ]]; then
    export OP_SERVICE_ACCOUNT_TOKEN="${_optok_line#OP_SERVICE_ACCOUNT_TOKEN=}"
  fi
  unset _optok_line
fi

if ! command -v op >/dev/null 2>&1; then
  echo "with-secrets.sh: 1Password CLI 'op' not found on PATH" >&2
  exit 69
fi

# Stable 1Password item reference. op resolves this whether driven by a service-account
# token (cron) or an interactive session (human shell). No secret value is ever printed.
OPENAI_ITEM_REF="op://Engineering/77x7lxny2xabgkuupkhkthttsy/credential"

if ! OPENAI_API_KEY="$(op read "$OPENAI_ITEM_REF" 2>/dev/null)"; then
  echo "with-secrets.sh: failed to read OPENAI_API_KEY from 1Password ($OPENAI_ITEM_REF)" >&2
  echo "  - cron: ensure OP_SERVICE_ACCOUNT_TOKEN is set for this process" >&2
  echo "  - shell: run 'op signin' first" >&2
  exit 1
fi
export OPENAI_API_KEY

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "with-secrets.sh: resolved OPENAI_API_KEY is empty" >&2
  exit 1
fi

# X OAuth2 client credentials for the webapp's interactive "Connect X" import flow.
# Canonical copy lives in 1Password (Engineering item n32tdp5kpvb7i4pga2thzatqwy,
# fields oauth2_client_id / oauth2_client_secret). The DB Setting rows were scrubbed
# (2026-06-09) so no OAuth client secret is stored in plaintext sqlite; the routes now
# prefer these env vars and fall back to DB only if unset.
X_OAUTH_ID_REF="op://Engineering/n32tdp5kpvb7i4pga2thzatqwy/oauth2_client_id"
X_OAUTH_SECRET_REF="op://Engineering/n32tdp5kpvb7i4pga2thzatqwy/oauth2_client_secret"
if X_OAUTH_CLIENT_ID="$(op read "$X_OAUTH_ID_REF" 2>/dev/null)" \
   && X_OAUTH_CLIENT_SECRET="$(op read "$X_OAUTH_SECRET_REF" 2>/dev/null)" \
   && [[ -n "$X_OAUTH_CLIENT_ID" && -n "$X_OAUTH_CLIENT_SECRET" ]]; then
  export X_OAUTH_CLIENT_ID X_OAUTH_CLIENT_SECRET
  echo "with-secrets.sh: X_OAUTH_CLIENT_ID loaded (len=${#X_OAUTH_CLIENT_ID}); X_OAUTH_CLIENT_SECRET loaded (len=${#X_OAUTH_CLIENT_SECRET})" >&2
else
  echo "with-secrets.sh: X OAuth2 client creds not loaded from 1Password (webapp Connect-X flow will fall back to DB if present)" >&2
fi

# Default the real sqlite-vec extension so the live path is used, not the brute-force fallback.
if [[ -z "${SIFTLY_SQLITE_VEC_EXTENSION_PATH:-}" && -f "$REPO_ROOT/.local/vec0.dylib" ]]; then
  export SIFTLY_SQLITE_VEC_EXTENSION_PATH="$REPO_ROOT/.local/vec0.dylib"
fi

# Confirm presence by length only — never echo the secret.
echo "with-secrets.sh: OPENAI_API_KEY loaded (len=${#OPENAI_API_KEY}); vec0=${SIFTLY_SQLITE_VEC_EXTENSION_PATH:-<unset>}" >&2

exec "$@"
