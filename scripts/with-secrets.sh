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

# Default the real sqlite-vec extension so the live path is used, not the brute-force fallback.
if [[ -z "${SIFTLY_SQLITE_VEC_EXTENSION_PATH:-}" && -f "$REPO_ROOT/.local/vec0.dylib" ]]; then
  export SIFTLY_SQLITE_VEC_EXTENSION_PATH="$REPO_ROOT/.local/vec0.dylib"
fi

# Confirm presence by length only — never echo the secret.
echo "with-secrets.sh: OPENAI_API_KEY loaded (len=${#OPENAI_API_KEY}); vec0=${SIFTLY_SQLITE_VEC_EXTENSION_PATH:-<unset>}" >&2

exec "$@"
