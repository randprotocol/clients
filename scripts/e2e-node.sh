#!/usr/bin/env bash
# The wallet-against-a-real-node end-to-end suite: the wallet's real transport, reply validators
# and flows (the wasm core and engine under Node, real `fetch`) against one real one-validator
# `rand-node` on a Test-profile chain. It covers chain identity, the whole client-side RPC contract
# (every method in ui/lib/rpc-methods.js, empty and populated), the faucet → scan → balance →
# activity → rescan flow, failover and submit rules, and a node restart; with a `rand-prover` it
# also sends from one wallet to another through one real bundle proof (a couple of minutes on a
# laptop — do not run it beside another proving job). Everything else takes about a minute.
#
#   RAND_NODE_BIN=… scripts/e2e-node.sh                       # all but the spend round trip
#   RAND_NODE_BIN=… RAND_PROVER_BIN=… scripts/e2e-node.sh     # and the spend round trip
#
#   RAND_NODE_BIN    a `rand-node`: a fullnode release asset (CI downloads v0.7.1) or a build.
#                    Required — without it the suite would only report itself skipped.
#   RAND_PROVER_BIN  a `rand-prover` from the same release; without it the spend case is skipped.
#
# Nothing is built here except the wasm core (extension/shared/core/rand_wallet_bg.wasm), when
# missing — as chrome/pack.sh does. The node binaries are never built by this script: take a
# release (`gh release download v0.7.1 -R randprotocol/fullnode`) or see scripts/e2e-prover.sh for
# building them from the vendored fullnode. The suite must hold on v0.7.1, so it uses no node
# feature newer than that.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh

[ -n "${RAND_NODE_BIN:-}" ] || { echo "RAND_NODE_BIN is not set: point it at a rand-node binary (see the header)" >&2; exit 1; }
for var in RAND_NODE_BIN RAND_PROVER_BIN; do
  bin="${!var:-}"
  [ -z "$bin" ] || [ -x "$bin" ] || { echo "$var is not an executable: $bin" >&2; exit 1; }
done
echo "rand-node:   $RAND_NODE_BIN"
echo "rand-prover: ${RAND_PROVER_BIN:-(not set: the spend round trip is skipped)}"
exec node --test web/wallet/test/node.e2e.test.mjs
