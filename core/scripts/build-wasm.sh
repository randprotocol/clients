#!/usr/bin/env bash
# Build the wasm core for the browser extensions into extension/shared/core/.
#
# Uses the `wasm` cargo profile (core/Cargo.toml) rather than wasm-pack's --release: LLVM's wasm
# backend never finishes shrugg-zkvm at opt-level 3, so that crate is built at a lower level.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../extension/shared/core}"
BINDGEN_VER=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/version = "\(.*\)"/\1/p')
if ! wasm-bindgen --version 2>/dev/null | grep -q "$BINDGEN_VER"; then
  cargo install wasm-bindgen-cli --version "$BINDGEN_VER" --locked
fi
rustup target add wasm32-unknown-unknown >/dev/null
cargo build --profile wasm --target wasm32-unknown-unknown -p wallet-wasm
mkdir -p "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" --out-name shrugg_wallet \
  target/wasm32-unknown-unknown/wasm/wallet_wasm.wasm
# wasm-opt shrinks the binary further when binaryen is installed; optional.
if command -v wasm-opt >/dev/null; then
  wasm-opt -O2 -o "$OUT/shrugg_wallet_bg.wasm" "$OUT/shrugg_wallet_bg.wasm"
fi
ls -la "$OUT"
