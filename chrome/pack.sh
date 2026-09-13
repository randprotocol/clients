#!/usr/bin/env bash
# Assemble dist/chrome from extension/shared + this manifest, and zip it for the store.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f extension/shared/core/shrugg_wallet_bg.wasm ] || core/scripts/build-wasm.sh
VER=$(python3 -c "import json;print(json.load(open('chrome/manifest.json'))['version'])")
rm -rf dist/chrome && mkdir -p dist/chrome
rsync -a --exclude '.DS_Store' extension/shared/ dist/chrome/
cp chrome/manifest.json dist/chrome/manifest.json
rm -f dist/chrome/core/.gitignore dist/chrome/core/package.json dist/chrome/core/README.md
( cd dist/chrome && rm -f "../rand-wallet-chrome-$VER.zip" && zip -qr -X "../rand-wallet-chrome-$VER.zip" . -x '.DS_Store' )
echo "dist/rand-wallet-chrome-$VER.zip"; ls -la "dist/rand-wallet-chrome-$VER.zip"
