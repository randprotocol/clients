#!/usr/bin/env bash
# EXPERIMENT: the wasm core with rayon on a pool of Web Workers (wallet-wasm's `threads` feature).
# Needs the pinned nightly with rust-src (std is rebuilt with atomics), and a page that is
# cross-origin isolated (COOP same-origin + COEP require-corp) so SharedArrayBuffer exists.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: build-wasm-threads.sh <out dir>}"
NIGHTLY="${NIGHTLY:-nightly-2026-08-28}"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"
CARGO_TARGET_DIR=target/threads cargo +"$NIGHTLY" build --profile wasm --target wasm32-unknown-unknown \
  -Z build-std=panic_abort,std -p wallet-wasm --features threads
BINDGEN_VER=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/version = "\(.*\)"/\1/p')
wasm-bindgen --version | grep -q "$BINDGEN_VER"
mkdir -p "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" --out-name rand_wallet \
  target/threads/wasm32-unknown-unknown/wasm/wallet_wasm.wasm
# wasm-bindgen-rayon's worker helper imports the package by its directory ('../../..'), which only a
# bundler resolves. The extensions and the web wallet ship plain files, so name the module itself.
for f in "$OUT"/snippets/wasm-bindgen-rayon-*/src/workerHelpers.js; do
  sed -i.bak "s#import('../../..')#import('../../../rand_wallet.js')#" "$f" && rm -f "$f.bak"
  grep -q "rand_wallet.js" "$f"
done
ls -la "$OUT"
