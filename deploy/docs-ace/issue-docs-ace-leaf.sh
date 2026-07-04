#!/usr/bin/env bash
# issue-docs-ace-leaf.sh — issue the *.docs.ace WILDCARD leaf from the Ace Local Root CA,
# mirroring issue-index-leaf.sh discipline: CA key only in a mode-600 temp file (never
# argv/stdout/log), pubkey-match guard before signing, openssl-verify the issued leaf.
# Idempotent: skips if the existing leaf has >RENEW_THRESHOLD_DAYS remaining.
# SAN covers the wildcard (per-doc <slug>.docs.ace) AND the apex docs.ace (portal).
set -euo pipefail
umask 077

CERTS_DIR="$HOME/.hermes/var/docs-portal/certs"
LEAF_DAYS=397
RENEW_THRESHOLD_DAYS=30
CA_KEY_ITEM='Ace Local Root CA — Private Key'
CA_KEY_FIELD='private_key'
CA_ROOT_ITEM='DNS Portal Local PKI (root+int)'
CA_ROOT_FIELD='root_crt'

mkdir -p "$CERTS_DIR"

leaf_needs_reissue() {
  [[ -f "$CERTS_DIR/docs.crt" && -f "$CERTS_DIR/docs.key" ]] || return 0
  local enddate exp now
  enddate="$(openssl x509 -enddate -noout -in "$CERTS_DIR/docs.crt" | cut -d= -f2)"
  exp="$(date -j -f '%b %e %T %Y %Z' "$enddate" +%s 2>/dev/null)" || return 0
  now="$(date +%s)"
  (( (exp - now) < RENEW_THRESHOLD_DAYS * 86400 ))
}

if [[ "${1:-}" != "--force" ]] && ! leaf_needs_reissue; then
  echo "*.docs.ace leaf already valid >=${RENEW_THRESHOLD_DAYS}d — skip"
  exit 0
fi

tmpd="$(mktemp -d -t docs-leaf.XXXXXX)"
cleanup() { shred -u "$tmpd/ca.key" 2>/dev/null || rm -f "$tmpd/ca.key"; rm -rf "$tmpd"; }
trap cleanup EXIT

cakey="$tmpd/ca.key"; cacrt="$tmpd/ca.crt"; ext="$tmpd/ext.cnf"; csr="$tmpd/leaf.csr"

# Ensure op is authenticated even under launchd's sparse env (read the service-account token file).
if ! op whoami >/dev/null 2>&1; then
  TF="$HOME/.hermes/.op-service-token"
  [[ -f "$TF" ]] || TF="/Users/alexgierczyk/.hermes/.op-service-token"
  if [[ -f "$TF" ]]; then
    IFS= read -r _OPTOK < "$TF"
    VN="OP_SERVICE_ACCOUNT"; VN="${VN}_TOKEN"
    export "$VN"="$_OPTOK"
  fi
fi

set +x
op item get "$CA_KEY_ITEM"  --vault Engineering --fields "label=$CA_KEY_FIELD"  --reveal > "$cakey"
op item get "$CA_ROOT_ITEM" --vault Engineering --fields "label=$CA_ROOT_FIELD" --reveal > "$cacrt"
chmod 600 "$cakey" "$cacrt"

if head -1 "$cakey" | grep -q '^"'; then sed -i '' -e 's/^"//' -e 's/"$//' "$cakey"; fi
if head -1 "$cacrt" | grep -q '^"'; then sed -i '' -e 's/^"//' -e 's/"$//' "$cacrt"; fi

kp="$(openssl pkey -in "$cakey" -pubout 2>/dev/null)"
cp="$(openssl x509 -in "$cacrt" -pubkey -noout 2>/dev/null)"
[[ -n "$kp" && "$kp" == "$cp" ]] || { echo "FATAL: CA key does not match recovered root cert — refusing to sign" >&2; exit 1; }

# SAN: wildcard for per-doc subdomains + the apex portal name.
printf 'subjectAltName=DNS:*.docs.ace,DNS:docs.ace\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$ext"
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$CERTS_DIR/docs.key.new" -subj "/CN=*.docs.ace" -out "$csr" 2>/dev/null
openssl x509 -req -in "$csr" -CA "$cacrt" -CAkey "$cakey" -CAcreateserial \
  -days "$LEAF_DAYS" -extfile "$ext" -out "$CERTS_DIR/docs.crt.new" 2>/dev/null
openssl verify -CAfile "$cacrt" "$CERTS_DIR/docs.crt.new" >/dev/null 2>&1 \
  || { echo "FATAL: issued leaf failed openssl verify against the CA" >&2; rm -f "$CERTS_DIR/docs.crt.new" "$CERTS_DIR/docs.key.new"; exit 1; }
chmod 600 "$CERTS_DIR/docs.key.new" "$CERTS_DIR/docs.crt.new"
mv "$CERTS_DIR/docs.key.new" "$CERTS_DIR/docs.key"
mv "$CERTS_DIR/docs.crt.new" "$CERTS_DIR/docs.crt"
echo "*.docs.ace + docs.ace wildcard leaf issued + verified ($LEAF_DAYS d)"
