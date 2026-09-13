#!/usr/bin/env bash
# Build the Linux binary and a tarball with a .desktop entry and icon into dist/.
# Needs the usual GUI build deps (Debian/Ubuntu): build-essential pkg-config libgl1-mesa-dev
# libxkbcommon-dev libwayland-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
ARCH=$(uname -m)
cargo build --release
STAGE="dist/rand-wallet-$VERSION-linux-$ARCH"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp target/release/rand-wallet "$STAGE/"
cp assets/icon.png "$STAGE/rand-wallet.png"
cp assets/rand-wallet.desktop "$STAGE/"
cat > "$STAGE/install.sh" <<'INSTALL'
#!/usr/bin/env bash
# Install for the current user: ~/.local/bin, ~/.local/share/applications, ~/.local/share/icons.
set -e
cd "$(dirname "$0")"
install -Dm755 rand-wallet "$HOME/.local/bin/rand-wallet"
install -Dm644 rand-wallet.png "$HOME/.local/share/icons/hicolor/256x256/apps/rand-wallet.png"
install -Dm644 rand-wallet.desktop "$HOME/.local/share/applications/rand-wallet.desktop"
echo "installed; run rand-wallet or find Rand Wallet in your launcher"
INSTALL
chmod +x "$STAGE/install.sh"
tar -C dist -czf "$STAGE.tar.gz" "$(basename "$STAGE")"
echo "wrote $STAGE.tar.gz"
# An AppImage can be produced from the same stage directory with linuxdeploy:
#   linuxdeploy --appdir AppDir -e target/release/rand-wallet -d assets/rand-wallet.desktop -i assets/icon.png --output appimage
