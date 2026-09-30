#!/usr/bin/env bash
# Build, on a Mac, every release package a Mac can build, into dist/release/v<version>/:
#
#   extensions   rand-wallet-chrome-<v>.zip, rand-wallet-firefox-<v>.zip      the store uploads
#   macos        rand-wallet-<v>-macos-arm64.dmg                              ad-hoc signed
#   android      rand-wallet-<v>-android.aab  (Google Play upload)
#                rand-wallet-<v>-android.apk  (the same build, to install by hand)
#   ios          rand-wallet-<v>-ios-unsigned.xcarchive.zip                   see ios/README.md
#   source       rand-wallet-<v>-source.tar.gz                                this commit + the submodule
#
#   scripts/release/build-local.sh                  everything
#   scripts/release/build-local.sh macos android    only those stages
#
# The Windows .msi and the Linux packages need their own OS: .github/workflows/release.yml builds
# them (and the macOS and extension packages again) on a tag; the Jenkinsfile is the same pipeline
# for a Jenkins with those agents. SHA256SUMS is written by scripts/release/checksums.sh.
#
# Android is signed when android/keystore.properties exists (android/README.md); without it the
# stage stops rather than produce a bundle Play would refuse. iOS is archived unsigned: uploading
# to TestFlight needs a paid team id, and is ios/scripts/archive.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
VER=$(node -p "require('./chrome/manifest.json').version")
OUT="$ROOT/dist/release/v$VER"
mkdir -p "$OUT"
STAGES=("$@")
[ ${#STAGES[@]} -gt 0 ] || STAGES=(extensions macos android ios source)

say() { printf '\n== %s ==\n' "$*"; }

stage_extensions() {
  say "extensions $VER"
  core/scripts/build-wasm.sh
  chrome/pack.sh
  firefox/pack.sh
  cp "dist/rand-wallet-chrome-$VER.zip" "dist/rand-wallet-firefox-$VER.zip" "$OUT/"
}

stage_macos() {
  say "macOS dmg $VER"
  scripts/release/build-desktop.sh
}

stage_android() {
  say "Android $VER"
  [ -f android/keystore.properties ] || { echo "android/keystore.properties is missing (android/README.md, Release for Google Play)"; exit 1; }
  if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  fi
  core/scripts/build-android.sh
  ( cd android && ./gradlew --no-daemon clean testDebugUnitTest bundleRelease assembleRelease )
  cp android/app/build/outputs/bundle/release/app-release.aab "$OUT/rand-wallet-$VER-android.aab"
  cp android/app/build/outputs/apk/release/app-release.apk "$OUT/rand-wallet-$VER-android.apk"
}

stage_ios() {
  say "iOS archive $VER (unsigned)"
  core/scripts/build-ios.sh
  local archive="$ROOT/ios/build/RandWallet-unsigned.xcarchive"
  rm -rf "$archive"
  ( cd ios && xcodebuild -project RandWallet.xcodeproj -scheme RandWallet -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$archive" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
      archive | tail -3 )
  rm -f "$OUT/rand-wallet-$VER-ios-unsigned.xcarchive.zip"
  ( cd ios/build && zip -qry -X "$OUT/rand-wallet-$VER-ios-unsigned.xcarchive.zip" RandWallet-unsigned.xcarchive )
}

stage_source() {
  say "source tarball $VER"
  scripts/release/source-tarball.sh "$OUT/rand-wallet-$VER-source.tar.gz"
}

for s in "${STAGES[@]}"; do
  case "$s" in
    extensions|macos|android|ios|source) "stage_$s" ;;
    *) echo "unknown stage: $s (extensions macos android ios source)"; exit 2 ;;
  esac
done

say "built"
ls -la "$OUT"
