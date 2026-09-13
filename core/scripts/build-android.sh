#!/usr/bin/env bash
# Build the shared core for arm64 and x86_64 Android into the app's jniLibs.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../android/app/src/main/jniLibs}"
: "${ANDROID_NDK_HOME:=${ANDROID_NDK_ROOT:-}}"
if [ -z "$ANDROID_NDK_HOME" ]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  ANDROID_NDK_HOME="$(ls -d "$SDK"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -d "$ANDROID_NDK_HOME" ] || { echo "set ANDROID_NDK_HOME (install an NDK with sdkmanager 'ndk;27.2.12479018')"; exit 1; }
export ANDROID_NDK_HOME
command -v cargo-ndk >/dev/null || cargo install cargo-ndk
rustup target add aarch64-linux-android x86_64-linux-android >/dev/null
cargo ndk -t arm64-v8a -t x86_64 -P 24 -o "$OUT" build -p wallet-ffi --release
ls -la "$OUT"/*
