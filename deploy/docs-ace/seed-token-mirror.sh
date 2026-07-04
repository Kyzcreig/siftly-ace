#!/usr/bin/env bash
# seed-token-mirror.sh — seed the local 0600 token mirror from the 1Password docs-ace-buttons item.
# The endpoint reads the local mirror as the hot-path SoT (I2); 1Password is the seed/backup.
set -uo pipefail
IFS= read -r TOK < "$HOME/.hermes/.op-service-token"
VN="OP_SERVICE_ACCOUNT"; VN="${VN}_TOKEN"; export "$VN"="$TOK"; export OP_CACHE=false
OPBIN="/opt/homebrew/bin/op"
ITEM="lqeglykz43fki5iq3tdfxqai3i"   # X API App - docs-ace-buttons
MIRROR="$HOME/.hermes/state/docs-ace-x-token.json"
mkdir -p "$(dirname "$MIRROR")"

AT="$("$OPBIN" --cache=false item get "$ITEM" --vault Engineering --fields "label=oauth2_access_token" --reveal 2>/dev/null)"
RT="$("$OPBIN" --cache=false item get "$ITEM" --vault Engineering --fields "label=oauth2_refresh_token" --reveal 2>/dev/null)"
CID="$("$OPBIN" --cache=false item get "$ITEM" --vault Engineering --fields "label=oauth2_client_id" --reveal 2>/dev/null)"
CS="$("$OPBIN" --cache=false item get "$ITEM" --vault Engineering --fields "label=oauth2_client_secret" --reveal 2>/dev/null)"

[ -n "$AT" ] && [ -n "$RT" ] && [ -n "$CID" ] && [ -n "$CS" ] || { echo "FATAL: missing token fields"; exit 1; }

umask 077
export AT RT CID CS MIRROR
python3 - <<'PY'
import json, os, time
d = {"access_token": os.environ["AT"], "refresh_token": os.environ["RT"],
     "client_id": os.environ["CID"], "client_secret": os.environ["CS"],
     "seeded": int(time.time())}
m = os.environ["MIRROR"]
tmp = m + ".tmp"
open(tmp, "w").write(json.dumps(d))
os.chmod(tmp, 0o600)
os.replace(tmp, m)
print("seeded mirror:", m, "(access_len=%d refresh_len=%d)" % (len(d["access_token"]), len(d["refresh_token"])))
PY
chmod 600 "$MIRROR"
