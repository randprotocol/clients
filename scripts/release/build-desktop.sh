#!/usr/bin/env bash
# Build the desktop app's packages for the OS this runs on, under release names, into
# dist/release/v<version>/:
#
#   macOS     rand-wallet-<v>-macos-<arm64|x64>.dmg                    ad-hoc signed
#   Windows   rand-wallet-<v>-windows-x64.msi                          the installer
#             rand-wallet-<v>-windows-x64-setup.exe                    the same app, NSIS installer
#   Linux     rand-wallet-<v>-linux-<x86_64|arm64>.AppImage  .deb  .rpm
#             rand-wallet-<v>-linux-<x86_64|arm64>.tar.gz              the bare binary, icon, .desktop
#
#   scripts/release/build-desktop.sh                              for this machine
#   scripts/release/build-desktop.sh --target x86_64-apple-darwin an Intel dmg from an Apple-silicon Mac
#
# A platform builds only its own packages: there is no .msi from a Mac and no .dmg from Linux.
# Prerequisites are desktop/README.md's: Rust (rustup installs the pinned toolchain), Node 20+,
# tauri-cli 2, and on Linux the webkit2gtk / appindicator / rsvg dev packages plus rpm. On Windows
# run it from Git Bash.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=${2:?--target needs a triple}; shift 2 ;;
    *) echo "usage: build-desktop.sh [--target <triple>]"; exit 2 ;;
  esac
done

VER=$(node -p "require('./chrome/manifest.json').version")
OUT="$ROOT/dist/release/v$VER"
mkdir -p "$OUT"

MACHINE=${TARGET%%-*}
[ -n "$MACHINE" ] || MACHINE=$(uname -m)
case "$(uname -s)" in
  Darwin) OS=macos; BUNDLES=dmg ;;
  Linux) OS=linux; BUNDLES=appimage,deb,rpm ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows; BUNDLES=msi,nsis ;;
  *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac
case "$OS-$MACHINE" in
  macos-arm64|macos-aarch64) ARCH=arm64 ;;
  linux-aarch64|linux-arm64) ARCH=arm64 ;;
  linux-x86_64) ARCH=x86_64 ;;
  *-x86_64|*-amd64|*-AMD64) ARCH=x64 ;;
  *) echo "unsupported machine: $MACHINE"; exit 1 ;;
esac
NAME="rand-wallet-$VER-$OS-$ARCH"

ARGS=(--bundles "$BUNDLES")
REL=desktop/src-tauri/target/release
if [ -n "$TARGET" ]; then
  rustup target add "$TARGET" >/dev/null
  ARGS+=(--target "$TARGET")
  REL=desktop/src-tauri/target/$TARGET/release
fi

# CI=true: on macOS bundle_dmg.sh otherwise scripts Finder to lay the window out, which no
# non-interactive shell can do. APPIMAGE_EXTRACT_AND_RUN: linuxdeploy is itself an AppImage, and a
# container or CI runner has no FUSE to mount it with.
( cd desktop/src-tauri && CI=true APPIMAGE_EXTRACT_AND_RUN=1 cargo tauri build "${ARGS[@]}" )

# One file per pattern, or the build did not make what this script says it makes.
take() {
  local dest=$1; shift
  local found=()
  for f in "$@"; do [ -e "$f" ] && found+=("$f"); done
  [ ${#found[@]} -eq 1 ] || { echo "expected one file for $dest, found ${#found[@]}: ${found[*]:-none}"; exit 1; }
  cp "${found[0]}" "$OUT/$dest"
}

B="$REL/bundle"
case "$OS" in
  macos)
    take "$NAME.dmg" "$B"/dmg/*_"$VER"_*.dmg
    ;;
  windows)
    take "$NAME.msi" "$B"/msi/*_"$VER"_*.msi
    take "$NAME-setup.exe" "$B"/nsis/*_"$VER"_*-setup.exe
    ;;
  linux)
    take "$NAME.AppImage" "$B"/appimage/*_"$VER"_*.AppImage
    take "$NAME.deb" "$B"/deb/*_"$VER"_*.deb
    take "$NAME.rpm" "$B"/rpm/*-"$VER"-*.rpm
    # The bare binary for a distribution none of the three packages fit. It still needs
    # webkit2gtk 4.1 from the distribution at run time; INSTALL says where the files go.
    STAGE=$(mktemp -d)
    trap 'rm -rf "$STAGE"' EXIT
    mkdir -p "$STAGE/$NAME"
    cp "$REL/rand-wallet" "$STAGE/$NAME/rand-wallet"
    cp desktop/assets/rand-wallet.desktop "$STAGE/$NAME/rand-wallet.desktop"
    cp desktop/assets/icons/128x128@2x.png "$STAGE/$NAME/rand-wallet.png"
    cp LICENSE "$STAGE/$NAME/LICENSE"
    cp linux/INSTALL "$STAGE/$NAME/INSTALL"
    tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
    ;;
esac

ls -la "$OUT"
