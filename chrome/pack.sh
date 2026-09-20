#!/usr/bin/env bash
# Assemble dist/chrome — the extension exactly as Chrome loads it — and zip it for the store.
#
#   dist/chrome/          popup/app/background/worker, backend-extension.js, lib/, icons/
#   dist/chrome/ui/       the shared UI and engine (ui/, minus its tooling)
#   dist/chrome/core/     rand_wallet.js + rand_wallet_bg.wasm
#   dist/chrome/manifest.json
#
# `dist/chrome` is the extension's ROOT: every import in it has to resolve inside this directory.
# Copying only extension/shared/ used to leave four re-export shims importing `../../../ui/…`,
# which resolves in the repo layout and 404s here — the packed extension was broken from task 1.2
# until 2.1. `extension/test/smoke.mjs` now packs and checks this tree, so it cannot happen quietly
# again. There is no bundler and no minifier on purpose: a store reviewer reads the files that run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f extension/shared/core/rand_wallet_bg.wasm ] || core/scripts/build-wasm.sh
VER=$(python3 -c "import json;print(json.load(open('chrome/manifest.json'))['version'])")
rm -rf dist/chrome && mkdir -p dist/chrome/ui
rsync -a --exclude '.DS_Store' extension/shared/ dist/chrome/
# ui/, without anything that is tooling rather than the app: the test suite, the token generator,
# the dev harness, the component gallery, and npm's own files.
rsync -a --exclude '.DS_Store' \
  --exclude test --exclude node_modules --exclude scripts \
  --exclude 'gallery.*' --exclude 'dev.*' --exclude 'package.json' --exclude 'package-lock.json' \
  ui/ dist/chrome/ui/
cp chrome/manifest.json dist/chrome/manifest.json
rm -f dist/chrome/core/.gitignore dist/chrome/core/package.json dist/chrome/core/README.md
( cd dist/chrome && rm -f "../rand-wallet-chrome-$VER.zip" && zip -qr -X "../rand-wallet-chrome-$VER.zip" . -x '.DS_Store' )
echo "dist/rand-wallet-chrome-$VER.zip"; ls -la "dist/rand-wallet-chrome-$VER.zip"
