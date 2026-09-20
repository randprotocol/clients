#!/usr/bin/env bash
# Assemble desktop/dist-ui/ — everything the Tauri webview loads. No bundler: the files are the
# files, exactly as in web/wallet/build.sh, and Tauri serves them unchanged.
#
#   dist-ui/index.html  main.js  backend-tauri.js     this shell (desktop/ui-shell/)
#   dist-ui/ui/                                       the shared UI and engine (ui/, minus tooling)
#   dist-ui/ui/fonts/                                 Inter + JetBrains Mono, as tokens.css expects
#
# No core/ directory and no .wasm: this is the one shell whose chain crypto is native, reached
# through the `core_call` command rather than loaded into the page.
#
# Run by `cargo tauri dev` and `cargo tauri build` as their beforeDevCommand/beforeBuildCommand
# (src-tauri/tauri.conf.json), and runnable by hand. dist-ui/ is build output and is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=desktop/dist-ui

rm -rf "$OUT"
mkdir -p "$OUT/ui"

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

cp desktop/ui-shell/index.html desktop/ui-shell/main.js desktop/ui-shell/backend-tauri.js "$OUT/"

# A build with any of these in it is a build that would ship a test fixture or a 404 to the window.
for unwanted in ui/test ui/scripts ui/node_modules ui/gallery.html ui/dev.html ui/package.json; do
  if [ -e "$OUT/$unwanted" ]; then echo "stage-ui.sh: $unwanted should not be in dist-ui/" >&2; exit 1; fi
done
for needed in index.html main.js backend-tauri.js ui/app.js ui/backend.js ui/tokens.css ui/base.css \
              ui/components.css ui/engine/backend-native.js ui/engine/backend-shared.js \
              ui/lib/qr.js ui/fonts/Inter-Variable.woff2; do
  if [ ! -e "$OUT/$needed" ]; then echo "stage-ui.sh: $needed is missing from dist-ui/" >&2; exit 1; fi
done

echo "staged $OUT ($(du -sh "$OUT" | cut -f1))"
