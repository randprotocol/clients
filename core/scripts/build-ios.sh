#!/usr/bin/env bash
# Build the static core for device and simulator and assemble an XCFramework the Xcode project
# links: ios/Frameworks/RandWalletCore.xcframework.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../ios/Frameworks}"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim >/dev/null
export IPHONEOS_DEPLOYMENT_TARGET=16.0
cargo build -p wallet-ffi --release --target aarch64-apple-ios
cargo build -p wallet-ffi --release --target aarch64-apple-ios-sim
mkdir -p "$OUT"
rm -rf "$OUT/RandWalletCore.xcframework"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/librand_wallet.a -headers crates/wallet-ffi/include \
  -library target/aarch64-apple-ios-sim/release/librand_wallet.a -headers crates/wallet-ffi/include \
  -output "$OUT/RandWalletCore.xcframework"
echo "wrote $OUT/RandWalletCore.xcframework"
