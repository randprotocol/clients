#!/usr/bin/env bash
# Assemble dist/firefox from extension/shared + this manifest, and zip it for the store.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh
VER=$(python3 -c "import json;print(json.load(open('firefox/manifest.json'))['version'])")
rm -rf dist/firefox && mkdir -p dist/firefox
rsync -a --exclude '.DS_Store' extension/shared/ dist/firefox/
cp firefox/manifest.json dist/firefox/manifest.json
rm -f dist/firefox/core/.gitignore dist/firefox/core/package.json dist/firefox/core/README.md
( cd dist/firefox && rm -f "../rand-wallet-firefox-$VER.zip" && zip -qr -X "../rand-wallet-firefox-$VER.zip" . -x '.DS_Store' )
echo "dist/rand-wallet-firefox-$VER.zip"; ls -la "dist/rand-wallet-firefox-$VER.zip"
