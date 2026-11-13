#!/bin/sh
# End-to-end for the update path: install a healthy relay binary, update with a
# broken one, and assert what survives. Real Linux filesystem, real processes,
# container-local port 8899 — never 8788, so a relay on the host is untouched.
#
#   test/container/swap-e2e.sh [path-to-index.ts]
#
# Exit 0 only if after the failed update the directory holds the good binary and
# /health answers from it.
set -eu
entry="${1:-/src/index.ts}"
exec node -e '
const { spawnSync } = require("node:child_process");
process.env.PFB_ENTRY = process.argv[1];
process.argv.length = 2;
require("/e2e.mjs");
' "$entry"
