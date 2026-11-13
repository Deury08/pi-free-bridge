#!/bin/sh
# End-to-end for the update path: install a healthy relay binary, then update with
# a broken one, and assert what survives. Real Linux filesystem, real processes,
# container-local port 8899 — never 8788, so a relay on the host is untouched.
#
#   test/container/swap-e2e.sh [path-to-index.ts]
#
# Exit 0 only if, after the failed update, the directory still holds the good
# binary and /health answers from it.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/swap-e2e.mjs" "$@"
