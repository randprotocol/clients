#!/usr/bin/env bash
# The withdraw end-to-end test: a wasm wallet (the real core and engine under Node, real `fetch`)
# is minted a bridged token on a local one-validator chain with a bridged genesis, pairs a real
# `rand-prover`, and burns the token back to Ethereum through it, against a real `rand-node`.
# Two real bundle proofs (the mint's, made by the fullnode's `rand` CLI; the burn's, made by the
# prover) — ~5 min on a laptop. Do not run it beside another proving job.
#
#   scripts/e2e-withdraw.sh
#   RAND_NODE_BIN=… RAND_PROVER_BIN=… RAND_CLI_BIN=… scripts/e2e-withdraw.sh   # use these, build only the fixtures
#
# Without the three overrides it builds `rand-node`, `rand` and `rand-prover` (release) from the
# fullnode this repo vendors, exactly as scripts/e2e-prover.sh does (read its header for the
# `circuits` layout the build needs and why the submodule's Cargo.lock is put back afterwards).
# `e2e-fixtures` — the bridged genesis and the test-guardian attestations — is this repo's own
# crate (core/crates/e2e-fixtures) and is always built here.
#
# To try a LATER node than the vendored one (a v0.6.4 gas build, say) against this wallet, pass
# RAND_NODE_BIN and RAND_CLI_BIN from that build and RAND_PROVER_BIN from the vendored one: the
# test then shows whether that node still admits what this wallet proves.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh

if [ -z "${RAND_NODE_BIN:-}" ] || [ -z "${RAND_PROVER_BIN:-}" ] || [ -z "${RAND_CLI_BIN:-}" ]; then
  FULLNODE="$ROOT/core/vendor/fullnode"
  [ -f "$FULLNODE/Cargo.toml" ] || { echo "core/vendor/fullnode is empty: git submodule update --init" >&2; exit 1; }
  [ -d "$ROOT/core/vendor/circuits/guests-compiled" ] || { echo "core/vendor/circuits is missing: the fullnode build needs it beside the fullnode" >&2; exit 1; }
  LOCK_BACKUP=$(mktemp)
  cp "$FULLNODE/Cargo.lock" "$LOCK_BACKUP"
  trap 'cp "$LOCK_BACKUP" "$FULLNODE/Cargo.lock"; rm -f "$LOCK_BACKUP"' EXIT
  TARGET="$ROOT/core/target/e2e"
  ( cd "$FULLNODE" && CARGO_TARGET_DIR="$TARGET" cargo build --release -p randprotocol-node -p randprotocol-client -p randprotocol-prover )
  cp "$LOCK_BACKUP" "$FULLNODE/Cargo.lock"; rm -f "$LOCK_BACKUP"; trap - EXIT
  export RAND_NODE_BIN="${RAND_NODE_BIN:-$TARGET/release/rand-node}"
  export RAND_PROVER_BIN="${RAND_PROVER_BIN:-$TARGET/release/rand-prover}"
  export RAND_CLI_BIN="${RAND_CLI_BIN:-$TARGET/release/rand}"
fi

( cd core && cargo build --release -p e2e-fixtures )
export RAND_FIXTURES_BIN="$ROOT/core/target/release/e2e-fixtures"

exec node --test web/wallet/test/withdraw.e2e.test.mjs
