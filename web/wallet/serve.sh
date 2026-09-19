#!/usr/bin/env bash
# Build the wallet and serve it to this machine only, at http://127.0.0.1:8787/.
#
# `RAND_WALLET_PORT` picks another port. Ctrl-C stops it. Nothing is uploaded, nothing is
# downloaded except from the Rand node you point the wallet at in Settings.
set -euo pipefail
cd "$(dirname "$0")/../.."
web/wallet/build.sh
exec node web/wallet/serve.mjs
