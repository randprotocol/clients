#!/usr/bin/env bash
# Assemble web/wallet/dist/ — the whole wallet as a browser can load it. No bundler: the files
# are the files, and `serve.mjs` hands them over unchanged.
#
#   dist/index.html  main.js  idb.js  worker.js     this shell
#   dist/ui/                                        the shared UI and engine (ui/, minus its tooling)
#   dist/ui/fonts/                                  Inter, JetBrains Mono, Departure Mono, as tokens.css expects
#   dist/core/                                      rand_wallet.js + rand_wallet_bg.wasm
#
# dist/ is build output and is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=web/wallet/dist

# The wasm core is git-ignored build output too; building it takes a few minutes.
if [ ! -f extension/shared/core/rand_wallet_bg.wasm ] || [ ! -f extension/shared/core/rand_wallet.js ]; then
  echo "building the wasm core (this takes a few minutes)…"
  core/scripts/build-wasm.sh
fi

rm -rf "$OUT"
mkdir -p "$OUT/ui" "$OUT/core"

# ui/, without anything that is tooling rather than the app: the test suite, the token generator,
# the dev harness, the component gallery, and npm's own files.
rsync -a ui/ "$OUT/ui/" \
  --exclude test \
  --exclude node_modules \
  --exclude scripts \
  --exclude 'gallery.*' \
  --exclude 'dev.*' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude '.DS_Store'

cp web/wallet/index.html web/wallet/main.js web/wallet/idb.js web/wallet/worker.js "$OUT/"
cp extension/shared/core/rand_wallet.js extension/shared/core/rand_wallet_bg.wasm "$OUT/core/"

# A build with any of these in it is a build that would leak a test fixture or a 404 to the page.
for unwanted in ui/test ui/scripts ui/node_modules ui/gallery.html ui/dev.html ui/package.json; do
  if [ -e "$OUT/$unwanted" ]; then echo "build.sh: $unwanted should not be in dist/" >&2; exit 1; fi
done
for needed in index.html main.js idb.js worker.js ui/app.js ui/backend.js ui/tokens.css ui/base.css \
              ui/components.css ui/engine/backend-wasm.js ui/fonts/Inter-Variable.woff2 \
              ui/fonts/DepartureMono-Regular.woff2 ui/lib/entropy.js \
              core/rand_wallet.js core/rand_wallet_bg.wasm; do
  if [ ! -e "$OUT/$needed" ]; then echo "build.sh: $needed is missing from dist/" >&2; exit 1; fi
done

echo "built $OUT ($(du -sh "$OUT" | cut -f1))"
