#!/usr/bin/env bash
# Build Rand Wallet.app (universal: Apple silicon + Intel) and a .dmg into dist/.
#   desktop/scripts/build-macos.sh            # unsigned, for local use
#   CODESIGN_ID="Developer ID Application: …" NOTARIZE_PROFILE=… desktop/scripts/build-macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin
mkdir -p dist
APP="dist/Rand Wallet.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create -output "$APP/Contents/MacOS/rand-wallet" \
  target/aarch64-apple-darwin/release/rand-wallet target/x86_64-apple-darwin/release/rand-wallet
# Icon: .icns from the 1024 PNG.
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z $s $s assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d assets/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Rand Wallet</string>
  <key>CFBundleDisplayName</key><string>Rand Wallet</string>
  <key>CFBundleIdentifier</key><string>org.randprotocol.wallet.desktop</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>rand-wallet</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
</dict></plist>
PLIST
if [ -n "${CODESIGN_ID:-}" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$CODESIGN_ID" "$APP"
fi
DMG="dist/RandWallet-$VERSION-macos.dmg"
rm -f "$DMG"
hdiutil create -volname "Rand Wallet" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
if [ -n "${CODESIGN_ID:-}" ] && [ -n "${NOTARIZE_PROFILE:-}" ]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi
echo "wrote $APP and $DMG"
