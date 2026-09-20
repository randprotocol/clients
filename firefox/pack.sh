#!/usr/bin/env bash
# Assemble dist/firefox — the extension exactly as Firefox loads it — and zip it for AMO.
#
#   dist/firefox/          popup/app/background/worker, backend-extension.js, lib/, icons/
#   dist/firefox/ui/       the shared UI and engine (ui/, minus its tooling)
#   dist/firefox/core/     rand_wallet.js + rand_wallet_bg.wasm
#   dist/firefox/manifest.json
#
# `dist/firefox` is the extension's ROOT: every import in it has to resolve inside this directory.
# Copying only extension/shared/ used to leave four re-export shims importing `../../../ui/…`,
# which resolves in the repo layout and 404s here — the packed extension was broken from task 1.2
# until 2.1. `extension/test/smoke.mjs` now packs and checks this tree, so it cannot happen quietly
# again. There is no bundler and no minifier on purpose: an AMO reviewer reads the files that run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh
VER=$(python3 -c "import json;print(json.load(open('firefox/manifest.json'))['version'])")
rm -rf dist/firefox && mkdir -p dist/firefox/ui
rsync -a --exclude '.DS_Store' extension/shared/ dist/firefox/
# ui/, without anything that is tooling rather than the app: the test suite, the token generator,
# the dev harness, the component gallery, and npm's own files.
rsync -a --exclude '.DS_Store' \
  --exclude test --exclude node_modules --exclude scripts \
  --exclude 'gallery.*' --exclude 'dev.*' --exclude 'package.json' --exclude 'package-lock.json' \
  ui/ dist/firefox/ui/
cp firefox/manifest.json dist/firefox/manifest.json
rm -f dist/firefox/core/.gitignore dist/firefox/core/package.json dist/firefox/core/README.md
( cd dist/firefox && rm -f "../rand-wallet-firefox-$VER.zip" && zip -qr -X "../rand-wallet-firefox-$VER.zip" . -x '.DS_Store' )
echo "dist/rand-wallet-firefox-$VER.zip"; ls -la "dist/rand-wallet-firefox-$VER.zip"
