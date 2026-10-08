#!/usr/bin/env bash
# Build the wasm core into extension/shared/core/ unless the copy there is newer than every core
# source (core-stale.sh says why it is not).
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -f extension/shared/core/rand_wallet.js ] && ! why=$(core/scripts/core-stale.sh extension/shared/core/rand_wallet_bg.wasm); then
  exit 0
fi
echo "building the wasm core: ${why:-rand_wallet.js is missing}" >&2
exec core/scripts/build-wasm.sh
