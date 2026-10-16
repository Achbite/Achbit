#!/usr/bin/env bash
# One-time local development identity. Builds never create or replace this key.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { printf 'Run this setup on the Mac development host.\n' >&2; exit 1; }
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
IDENTITY='DeepCode Local Development'
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
[ -f "$KEYCHAIN" ] || { printf 'The login keychain is missing: %s\n' "$KEYCHAIN" >&2; exit 1; }
umask 077
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-signing.XXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

if security find-certificate -c "$IDENTITY" -p "$KEYCHAIN" > "$SCRATCH/certificate.pem" 2> "$SCRATCH/lookup-error"; then
  # An interrupted trust prompt can be resumed without replacing the identity.
  security find-identity -p codesigning "$KEYCHAIN" | grep -F "\"$IDENTITY\"" >/dev/null || {
    printf 'The certificate exists without its private key. Restore that identity; setup will not replace it.\n' >&2
    exit 1
  }
else
  lookup_status=$?
  # security reports errSecItemNotFound as shell exit status 44.
  if [ "$lookup_status" -ne 44 ]; then
    cat "$SCRATCH/lookup-error" >&2
    exit "$lookup_status"
  fi
  cat > "$SCRATCH/certificate.cnf" <<'CERTIFICATE'
[req]
prompt = no
distinguished_name = subject
x509_extensions = signing
[subject]
CN = DeepCode Local Development
[signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CERTIFICATE
  /usr/bin/openssl req -new -x509 -newkey rsa:2048 -nodes -days 3650 \
    -config "$SCRATCH/certificate.cnf" -keyout "$SCRATCH/private-key.pem" -out "$SCRATCH/certificate.pem"
  # macOS can reject an empty PKCS#12 password. This temporary password is
  # unrelated to the user's login password and is removed with the export.
  /usr/bin/openssl rand -hex 32 > "$SCRATCH/passphrase"
  /usr/bin/openssl pkcs12 -export -inkey "$SCRATCH/private-key.pem" -in "$SCRATCH/certificate.pem" \
    -name "$IDENTITY" -out "$SCRATCH/identity.p12" -passout "file:$SCRATCH/passphrase"
  security import "$SCRATCH/identity.p12" -k "$KEYCHAIN" -f pkcs12 \
    -P "$(cat "$SCRATCH/passphrase")" -T /usr/bin/codesign
fi

# Trust only code signing in this user's domain, not SSL or the system trust store.
if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -F "\"$IDENTITY\"" >/dev/null; then
  printf 'macOS may ask you to confirm this one-time local code-signing identity.\n'
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$SCRATCH/certificate.pem"
fi
signer="$(DEEPCODE_MACOS_SIGN_IDENTITY="$IDENTITY" python3 "$ROOT_DIR/scripts/macos_signing.py")"
# Exercise private-key access during setup, so the first build does not discover
# a pending keychain authorization after compilation has already completed.
cp /usr/bin/true "$SCRATCH/signing-probe"
printf 'If codesign requests this key, confirm it and choose Always Allow for subsequent builds.\n'
codesign --force --sign "$signer" "$SCRATCH/signing-probe"
codesign --verify --strict "$SCRATCH/signing-probe"
printf 'Local signing identity is ready. Reuse it for subsequent builds; keep its private key in the login keychain.\n'
