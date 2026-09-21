#!/usr/bin/env node
// Assemble desktop/dist-ui/ — everything the Tauri webview loads. No bundler: the files are the
// files, exactly as in web/wallet/build.sh, and Tauri serves them unchanged.
//
//   dist-ui/index.html  main.js  backend-tauri.js     this shell (desktop/ui-shell/)
//   dist-ui/ui/                                       the shared UI and engine (ui/, minus tooling)
//   dist-ui/ui/fonts/                                 Inter + JetBrains Mono, as tokens.css expects
//
// No core/ directory and no .wasm: this is the one shell whose chain crypto is native, reached
// through the `core_call` command rather than loaded into the page.
//
// Run by `cargo tauri dev` and `cargo tauri build` as their beforeDevCommand/beforeBuildCommand
// (src-tauri/tauri.conf.json), and runnable by hand (`node desktop/scripts/stage-ui.mjs`).
// dist-ui/ is build output and is git-ignored.
//
// This is stage-ui.sh's job in plain Node: bash + rsync do not exist on a stock Windows machine
// (and `msi` is a bundle target), while Node is already a prerequisite of this repo's own tests.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'desktop', 'dist-ui');

// ui/, without anything that is tooling rather than the app: the test suite, the token generator,
// the dev harness, the component gallery, and npm's own files. Matched by basename at any depth,
// exactly as the old rsync excludes did.
const EXCLUDE_NAMES = new Set(['test', 'node_modules', 'scripts', 'package.json', 'package-lock.json', '.DS_Store']);
function keep(src) {
  const base = src.split(/[\\/]/).pop();
  if (EXCLUDE_NAMES.has(base)) return false;
  if (base.startsWith('gallery.') || base.startsWith('dev.')) return false;
  return true;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'ui'), { recursive: true });

cpSync(join(root, 'ui'), join(OUT, 'ui'), { recursive: true, filter: (src) => keep(src) });
for (const f of ['index.html', 'main.js', 'backend-tauri.js']) {
  cpSync(join(root, 'desktop', 'ui-shell', f), join(OUT, f));
}

// A build with any of these in it is a build that would ship a test fixture or a 404 to the window.
for (const unwanted of ['ui/test', 'ui/scripts', 'ui/node_modules', 'ui/gallery.html', 'ui/dev.html', 'ui/package.json']) {
  if (existsSync(join(OUT, unwanted))) {
    console.error(`stage-ui.mjs: ${unwanted} should not be in dist-ui/`);
    process.exit(1);
  }
}
for (const needed of ['index.html', 'main.js', 'backend-tauri.js', 'ui/app.js', 'ui/backend.js', 'ui/tokens.css', 'ui/base.css',
                      'ui/components.css', 'ui/engine/backend-native.js', 'ui/engine/backend-shared.js',
                      'ui/lib/qr.js', 'ui/fonts/Inter-Variable.woff2']) {
  if (!existsSync(join(OUT, needed))) {
    console.error(`stage-ui.mjs: ${needed} is missing from dist-ui/`);
    process.exit(1);
  }
}

console.log('staged desktop/dist-ui');
