#!/usr/bin/env bash
# A TEST build of the Chrome extension for durian.market's devnet — never a release.
#
#   dist/chrome-devnet/     the extension, loaded unpacked at chrome://extensions
#
# It differs from `chrome/pack.sh`'s build in three things only:
#   * its wasm core is compiled with RAND_WALLET_CHAIN_ID / RAND_WALLET_RPC_URL (wallet-core's
#     DEFAULT_CHAIN_ID and DEFAULT_RPC_URL), so it is a wallet for chain 1919 and refuses every
#     other chain, the public one included;
#   * its name says so ("Rand Wallet (devnet 1919)"), so it is never mistaken for the real one
#     installed beside it — an unpacked build from another directory is another extension, with
#     its own id and its own storage;
#   * its manifest may reach the devnet's endpoint.
# Everything else — every file the user runs — is the release's.
#
#   scripts/devnet/pack-devnet.sh [chain_id] [rpc_url]
set -euo pipefail
cd "$(dirname "$0")/../.."
CHAIN="${1:-1919}"
RPC="${2:-https://durian.market/api/wallet-rpc}"
OUT=dist/chrome-devnet
CORE_OUT="$PWD/dist/devnet-core-$CHAIN"

RAND_WALLET_CHAIN_ID="$CHAIN" RAND_WALLET_RPC_URL="$RPC" core/scripts/build-wasm.sh "$CORE_OUT"

rm -rf "$OUT" && mkdir -p "$OUT/ui"
rsync -a --exclude '.DS_Store' --exclude core extension/shared/ "$OUT/"
rsync -a --exclude '.DS_Store' \
  --exclude test --exclude node_modules --exclude scripts \
  --exclude 'gallery.*' --exclude 'dev.*' --exclude 'package.json' --exclude 'package-lock.json' \
  ui/ "$OUT/ui/"
mkdir -p "$OUT/core"
cp "$CORE_OUT/rand_wallet.js" "$CORE_OUT/rand_wallet_bg.wasm" "$OUT/core/"

RPC="$RPC" CHAIN="$CHAIN" python3 - "$OUT/manifest.json" <<'PY'
import json, os, sys
from urllib.parse import urlsplit
m = json.load(open('chrome/manifest.json'))
chain, rpc = os.environ['CHAIN'], os.environ['RPC']
m['name'] = f"Rand Wallet (devnet {chain})"
m['short_name'] = f"Rand devnet {chain}"
m['description'] = f"TEST BUILD for devnet chain {chain} ({rpc}). Not for the public chain."
u = urlsplit(rpc)
host = f"{u.scheme}://{u.netloc}/*"
if host not in m['host_permissions']:
    m['host_permissions'].append(host)
json.dump(m, open(sys.argv[1], 'w'), indent=2)
PY
echo "$OUT — chain $CHAIN, $RPC"
