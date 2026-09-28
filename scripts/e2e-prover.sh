#!/usr/bin/env bash
# The delegated-proving end-to-end test: a wasm wallet (the real core and engine under Node, real
# `fetch`) pairs a real `rand-prover`, sends through it to a real one-validator `rand-node` on a
# Test-profile chain, and the note lands in a second wallet. One real bundle proof, made by the
# prover — ~2.5 min on a laptop. Do not run it beside another proving job.
#
#   scripts/e2e-prover.sh
#   RAND_NODE_BIN=… RAND_PROVER_BIN=… scripts/e2e-prover.sh   # use these binaries, build nothing
#
# Without the two overrides it builds `rand-node` and `rand-prover` (release) from the fullnode
# this repo vendors, `core/vendor/fullnode` (the submodule: `git submodule update --init`). That
# build needs the `circuits` checkout BESIDE the fullnode: `randprotocol-zkvm` reaches
# `../../../circuits/guests-compiled/{evm-core,sbpf-core}` (and the optional CUDA crate) by path,
# which from the submodule is `core/vendor/circuits` — the vendored copies this repo carries (see
# its README). A fullnode checkout of your own needs a real `circuits` checkout beside it instead.
#
# Cargo rewrites the submodule's Cargo.lock against the vendored CUDA stub, so it is put back after
# the build: nothing under core/vendor/ is left changed. The target directory is core/target/e2e.
#
# The wasm core must be built too (extension/shared/core/rand_wallet_bg.wasm); it is built here
# when missing, as chrome/pack.sh does.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh

if [ -z "${RAND_NODE_BIN:-}" ] || [ -z "${RAND_PROVER_BIN:-}" ]; then
  FULLNODE="$ROOT/core/vendor/fullnode"
  [ -f "$FULLNODE/Cargo.toml" ] || { echo "core/vendor/fullnode is empty: git submodule update --init" >&2; exit 1; }
  [ -d "$ROOT/core/vendor/circuits/guests-compiled" ] || { echo "core/vendor/circuits is missing: the fullnode build needs it beside the fullnode" >&2; exit 1; }
  LOCK_BACKUP=$(mktemp)
  cp "$FULLNODE/Cargo.lock" "$LOCK_BACKUP"
  trap 'cp "$LOCK_BACKUP" "$FULLNODE/Cargo.lock"; rm -f "$LOCK_BACKUP"' EXIT
  TARGET="$ROOT/core/target/e2e"
  ( cd "$FULLNODE" && CARGO_TARGET_DIR="$TARGET" cargo build --release -p randprotocol-node -p randprotocol-prover )
  # Put the lockfile back now: the `exec` below replaces this shell, so the EXIT trap never runs.
  cp "$LOCK_BACKUP" "$FULLNODE/Cargo.lock"; rm -f "$LOCK_BACKUP"; trap - EXIT
  export RAND_NODE_BIN="${RAND_NODE_BIN:-$TARGET/release/rand-node}"
  export RAND_PROVER_BIN="${RAND_PROVER_BIN:-$TARGET/release/rand-prover}"
fi

for bin in "$RAND_NODE_BIN" "$RAND_PROVER_BIN"; do
  [ -x "$bin" ] || { echo "not an executable: $bin" >&2; exit 1; }
done
echo "rand-node:   $RAND_NODE_BIN"
echo "rand-prover: $RAND_PROVER_BIN"
exec node --test web/wallet/test/prover.e2e.test.mjs
