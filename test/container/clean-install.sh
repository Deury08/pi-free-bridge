#!/usr/bin/env bash
# Downloads the published relay exactly as a new user would, proves the checksum,
# and checks that it serves /health with no Bun, no Node and no OpenCode present.
#
# This asserts the product claim, not the implementation: after this passes, the
# release really is installable on an empty machine.
set -euo pipefail

VERSION="${RELAY_VERSION:-v0.4.0}"
ASSET="${RELAY_ASSET:-relay-linux-x64}"
BASE="https://github.com/Deury08/pi-free-bridge/releases/download/${VERSION}"

echo "==> environment (all of these must be absent)"
for tool in bun node opencode; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool is present, this is not a clean machine"; exit 1
  fi
  echo "    absent: $tool"
done

echo "==> downloading ${ASSET} ${VERSION}"
curl -fsSL -o "$ASSET" "${BASE}/${ASSET}"
curl -fsSL -o SHA256SUMS "${BASE}/SHA256SUMS"

echo "==> verifying the published checksum"
grep -E "[[:space:]]${ASSET}$" SHA256SUMS > expected.sha256 || {
  echo "FAIL: no checksum line for ${ASSET}"; exit 1; }
sha256sum -c expected.sha256
chmod +x "$ASSET"

echo "==> starting the relay with no configuration at all"
PORT=8899 RELAY_STDIN_LIFETIME=off "./$ASSET" > relay.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -sf --max-time 2 http://127.0.0.1:8899/health -o health.json; then break; fi
  sleep 1
done

test -s health.json || { echo "FAIL: /health never answered"; tail -20 relay.log; exit 1; }
echo "==> /health"
cat health.json; echo

python3_absent=1
grep -q '"service":"pi-free-bridge-relay"' health.json || { echo "FAIL: wrong service"; exit 1; }
grep -q '"sessionSource":"generated"' health.json || {
  echo "FAIL: the relay did not generate its own session id"; exit 1; }

echo "==> PASS: an empty machine installed and ran the relay"
