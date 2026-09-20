# Wallet UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Phantom-grade interface shared by the Tauri desktop app, the Chrome/Firefox extension and a new local wasm web wallet, with the repository renamed shrugg → rand, multi-asset (RAND + RPL) balances and transfers, and an RPC client covering every node method.

**Architecture:** `ui/` holds vanilla-ES-module screens that talk only to a `Backend` object. Three shells implement `Backend`: Tauri commands over the existing Rust engine (native proving), and two wasm-worker backends (extension `storage.local`, web IndexedDB) that cannot prove. Chain crypto stays in `core/crates/wallet-core`.

**Tech Stack:** Rust (wallet-core, Tauri 2), vanilla JS ES modules + CSS (no bundler, no framework), wasm-bindgen, `node --test`, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-19-wallet-ui-redesign-design.md`

## Global Constraints

- No chain crypto outside `wallet-core`; new behaviour is a new `dispatch` method.
- `ui/` and the extension: vanilla ES modules, no bundler, no framework, no network fonts, no `eval`; CSP `script-src 'self' 'wasm-unsafe-eval'`.
- **Amended (spec §11):** the node is already renamed. Wire names are `rand_<method>` and `rand1…`, crates are `randprotocol-*`, the submodule tracks fullnode `main` (chain 13 at 142e1f7) and is never edited. No "shrugg" anywhere in any case; `core/scripts/check-rename.sh` allows nothing. The namespace and prefix still appear once per language as `RPC_NAMESPACE = "rand"` / `ADDRESS_HRP = "rand1"`. **Wherever a task below writes `shrugg_…`, `shrugg1…` or a `shrugg-*` crate, read `rand_…`, `rand1…`, `randprotocol-*`.**
- Display symbol is `RAND`; RPL = registry assets with index ≥ 1. No balance RPC exists; balances come from the local scan.
- A shell whose `send.canProve().ok` is false never shows a Prove button and never simulates a send.
- Colours, radius, spacing only from `design/tokens.json`. Aurora gradient only on the balance hero and primary action. Motion 150–250 ms, off under `prefers-reduced-motion`. Targets ≥ 44 px, visible focus, WCAG AA in both themes. Breakpoint: 900 px.
- wasm builds use `--profile wasm` (zkvm at opt-level 1). Never `wasm-pack --release`.
- Commit after every task; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

```
ui/                          shared interface (new)
  tokens.css base.css components.css
  app.js                     mount(container, backend, {mode}); router; theme; lock gate
  backend.js                 BACKEND_SHAPE, assertBackend(b)
  screens/{onboarding,lock,home,asset,activity,detail,receive,send,faucet,explore,settings}.js
  lib/{format,qr,icons,assets,dom,rpc-methods}.js
  engine/{wallet,crypto,rpc,backend-wasm}.js   scan/send orchestration and the Backend shared by both wasm shells
  fonts/*.woff2
  test/*.test.mjs  test/fake-backend.mjs
  scripts/build-tokens.mjs
extension/shared/
  backend-extension.js       Backend over lib/{wallet,store,crypto,core,rpc}.js   (new)
  popup.js app.js            mount ui/app.js                                      (rewritten)
  lib/views.js styles.css lib/format.js lib/qr.js                                 (deleted; moved to ui/)
web/wallet/
  index.html main.js backend-web.js idb.js worker.js build.sh serve.sh serve.mjs  (new)
desktop/
  src-tauri/{Cargo.toml,tauri.conf.json,build.rs,capabilities/default.json}
  src-tauri/src/{main.rs,commands.rs,state.rs}  + moved engine.rs store.rs rpc.rs secrets.rs
  ui-shell/{index.html,main.js,backend-tauri.js}
  src/ui.rs src/theme.rs                                                          (deleted)
core/crates/wallet-core/src/lib.rs   RAND names, RPC_NAMESPACE/ADDRESS_HRP, asset transfer
```

---

## Phase 0 — Rename shrugg → rand

### Task 0.1: Rename the core library and its artefact names

**Files:**
- Modify: `core/crates/wallet-core/src/lib.rs`, `core/crates/wallet-ffi/**`, `core/crates/wallet-wasm/**`, `core/crates/*/Cargo.toml`, `core/scripts/build-{wasm,ios,android}.sh`
- Rename: `core/crates/wallet-ffi/include/shrugg_wallet.h` → `rand_wallet.h`
- Test: `core/crates/wallet-core/src/lib.rs` (tests module)

**Interfaces:**
- Produces: `version` reply gains `"rpc_namespace": "shrugg"`, `"address_hrp": "shrugg1"`, and `"token_symbol": "RAND"`. Library/artefact names: `rand_wallet` (`librand_wallet.{a,so}`, `rand_wallet.h`, `rand_wallet.js`, `rand_wallet_bg.wasm`), C symbols `rand_wallet_*`, header guard `RAND_WALLET_H`. Rust consts `pub const RPC_NAMESPACE: &str = "shrugg"; pub const ADDRESS_HRP: &str = "shrugg1"; pub use shrugg_core::UNITS_PER_SHRUGG as UNITS_PER_RAND;`

- [ ] **Step 1: Write the failing test** (append to the `tests` module of `wallet-core/src/lib.rs`)

```rust
#[test]
fn version_reports_rand_and_wire_names() {
    let v = constants();
    assert_eq!(v["token_symbol"], "RAND");
    assert_eq!(v["rpc_namespace"], RPC_NAMESPACE);
    assert_eq!(v["address_hrp"], ADDRESS_HRP);
    assert_eq!(RPC_NAMESPACE, "shrugg");
    assert_eq!(ADDRESS_HRP, "shrugg1");
}

#[test]
fn user_facing_errors_say_rand() {
    let err = select_inputs(&[], 0, 1).unwrap_err().to_string();
    assert!(err.contains("RAND") && !err.contains("SHRUGG"), "{err}");
}
```

- [ ] **Step 2:** Run `cd core && cargo test -p wallet-core version_reports user_facing` — expected: compile error, `RPC_NAMESPACE` not found.
- [ ] **Step 3: Implement.** In `lib.rs`: add the three consts/re-export above beside the existing `use shrugg_core::…` line and replace every use of `UNITS_PER_SHRUGG` in our code with `UNITS_PER_RAND`; add the two keys to `constants()` and set `"token_symbol": "RAND"`; replace `SHRUGG` with `RAND` in every string literal and doc comment (lines ~17, 354, 370, 488, 500, 577). In `wallet-ffi` and `wallet-wasm`: `[lib] name = "rand_wallet"` (ffi), exported C functions `shrugg_wallet_*` → `rand_wallet_*`, header renamed with `git mv` and its guard/prototypes updated. In the three build scripts replace `shrugg_wallet` → `rand_wallet` and `ShruggWalletCore` → `RandWalletCore`; keep the comment's `shrugg-zkvm` (crate name).
- [ ] **Step 4:** Run `cd core && cargo test -p wallet-core && cargo build -p wallet-ffi` — expected: all pass.
- [ ] **Step 5:** `git add -A core && git commit -m "core: rename the wallet library to rand_wallet; RAND symbol; wire names as constants"`

### Task 0.2: Rename in the extension, rebuild wasm

**Files:** Modify `extension/shared/worker.js`, `extension/test/smoke.mjs`, `extension/shared/lib/*.js`, `extension/README.md`, `chrome/{pack.sh,manifest.json,STORE.md,README.md}`, `firefox/{…same…}`; regenerate `extension/shared/core/`.

**Interfaces:** Consumes Task 0.1 artefact names. Produces `extension/shared/core/rand_wallet.js` + `rand_wallet_bg.wasm`.

- [ ] **Step 1: Make the smoke test demand the new names.** In `smoke.mjs` change both import paths to `rand_wallet.js` / `rand_wallet_bg.wasm` and add after the `keys ok` checks:

```js
const ver = c('version');
if (ver.token_symbol !== 'RAND') throw new Error('token_symbol ' + ver.token_symbol);
if (!w.address.startsWith(ver.address_hrp)) throw new Error('address_hrp mismatch');
```

  and replace the literal `'shrugg1'` check with `ver.address_hrp` (move the `ver` line above it).
- [ ] **Step 2:** `node extension/test/smoke.mjs` — expected: FAIL, cannot find `rand_wallet.js`.
- [ ] **Step 3:** `rm -rf extension/shared/core/shrugg_wallet* && core/scripts/build-wasm.sh`; update `worker.js` imports and both `pack.sh` guards to `rand_wallet_bg.wasm`; in JS comments/strings/READMEs/STORE notes replace `SHRUGG`→`RAND`, `shrugg-node` prose stays where it names the binary. Leave `'shrugg_…'` RPC strings for Task 5.1.
- [ ] **Step 4:** `node extension/test/smoke.mjs && chrome/pack.sh && firefox/pack.sh` — expected: `keys-only smoke test passed`, two zips.
- [ ] **Step 5:** Commit `extension: rand_wallet core, RAND symbol`.

### Task 0.3: Rename in desktop, iOS, Android, web, docs; rebuild natives

**Files:** `desktop/src/*.rs`, `desktop/README.md`, `ios/**` (`git mv ios/RandWallet/Core/ShruggCore.swift ios/RandWallet/Core/RandCore.swift`, `project.yml`, all Swift references `ShruggCore`→`RandCore`, `ShruggWalletCore`→`RandWalletCore`), `android/**` (`System.loadLibrary("rand_wallet")`, JNI names follow the Java class which does not change), `web/clients.astro`, `design/tokens.json` (`"symbol": "RAND"`), `README.md`, `macosx|linux|windows/README.md`, `docs/superpowers/specs/2026-09-13-*.md` (add a one-line note at the top: "Renamed shrugg → rand on 2026-09-19; see the 2026-09-19 spec §10", leave the body).

- [ ] **Step 1: Write the guard script** `core/scripts/check-rename.sh`:

```bash
#!/usr/bin/env bash
# Fails if our tree still says shrugg anywhere except the wire names the node owns.
set -euo pipefail
cd "$(dirname "$0")/../.."
ALLOW='shrugg_[a-zA-Z]+|shrugg1|shrugg-(core|zkvm|client|node)|shrugg_(core|zkvm|client)|UNITS_PER_SHRUGG|"shrugg"'
HITS=$(grep -rIniE 'shrugg' . \
  --exclude-dir={.git,vendor,target,dist,build,.gradle,node_modules,DerivedData,Frameworks,jniLibs} \
  --exclude=check-rename.sh --exclude=Cargo.lock --exclude='2026-09-1[39]-*.md' \
  | grep -viE "^[^:]+:[0-9]+:.*($ALLOW)" || true)
# lines that contain an allowed token may still contain a forbidden one: strip allowed, re-test
LEFT=$(grep -rIniE 'shrugg' . \
  --exclude-dir={.git,vendor,target,dist,build,.gradle,node_modules,DerivedData,Frameworks,jniLibs} \
  --exclude=check-rename.sh --exclude=Cargo.lock --exclude='2026-09-1[39]-*.md' \
  | sed -E "s/($ALLOW)//g" | grep -iE 'shrugg' || true)
if [ -n "$HITS$LEFT" ]; then echo "$HITS"; echo "$LEFT"; echo "rename incomplete"; exit 1; fi
echo "rename clean"
```

- [ ] **Step 2:** `chmod +x core/scripts/check-rename.sh && core/scripts/check-rename.sh` — expected: FAIL listing desktop/ios/android/web/docs lines.
- [ ] **Step 3:** Apply the renames listed under **Files**. Then `rm -rf ios/Frameworks/ShruggWalletCore.xcframework android/app/src/main/jniLibs/*/libshrugg_wallet.so && core/scripts/build-ios.sh && core/scripts/build-android.sh`.
- [ ] **Step 4:** Run, all expected to pass: `core/scripts/check-rename.sh` → `rename clean`; `cd desktop && cargo build`; `cd ios && xcodegen && xcodebuild -scheme RandWallet -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO | tail -3` → `BUILD SUCCEEDED`; `cd android && JAVA_HOME=/opt/homebrew/opt/openjdk ./gradlew assembleDebug -q`.
- [ ] **Step 5:** Commit `rename shrugg to rand across desktop, iOS, Android, web and docs`.

---

### Task 0.4: Move the vendored fullnode to `main` and remove every remaining "shrugg"

Added mid-run on the owner's instruction; full brief in the SDD workspace (`task-0.4-brief.md`): bump `core/vendor/fullnode` 03c9fb9 → 142e1f7, port `wallet-core` to `randprotocol-*`, `rand_` RPC strings and `rand1` addresses in every client, rebuild and re-verify wasm / desktop / iOS / Android, empty the guard's allow list.

### Task 0.5: Licence — GPL-3.0-only (owner's decision, 2026-09-19)

Upstream's crates are `GPL-3.0-only` and every binary here links them. Add the verbatim GPL-3.0 text as `LICENSE` at the repo root (from https://www.gnu.org/licenses/gpl-3.0.txt; do not retype it); set `license = "GPL-3.0-only"` in `core/Cargo.toml` (workspace) and every crate that declares its own, `desktop/Cargo.toml` (and later `desktop/src-tauri/Cargo.toml`), `ui/package.json` (`"license": "GPL-3.0-only"`); fix `firefox/STORE.md`, `chrome/STORE.md`, the READMEs, `web/clients.astro`, the Android/iOS metadata and any source-file header that says Apache-2.0. Third-party licences stay as they are (`ui/fonts/*` OFL, `core/vendor/*`). Verify: `grep -rniE 'apache' . --exclude-dir={.git,vendor,target,node_modules,build,dist}` returns only third-party notices; `cargo metadata` parses; commit `licence: GPL-3.0-only, matching the node's crates this links`.

### Task 0.6: `text_mute` reaches AA in every client (owner's decision, 2026-09-19)

`design/tokens.json` `dark.text_mute` and `light.text_mute` measure 3.5–4.4:1 on `bg`/`surface`. Pick the closest values in the same hue that reach ≥ 4.5:1 on both `bg` and `surface` in each theme (the Task 1.1 report proposes values); extend `ui/test/tokens.test.mjs`'s contrast test to cover `text_mute`; regenerate `ui/tokens.css`; mirror the two values in the hand-copied palettes — iOS (`ios/RandWallet/**` colour definitions / asset catalog), Android (`android/app/src/main/res/values*/colors.xml`), desktop (`desktop/src/theme.rs` until Task 3.2 deletes it). Rebuild desktop, iOS and Android to prove nothing broke. Commit `design: text_mute meets AA; palettes in sync`.

---

## Phase 1 — `ui/` and the web wallet

### Task 1.1: Tokens, base and component CSS, fonts

**Files:** Create `ui/scripts/build-tokens.mjs`, `ui/tokens.css` (generated, committed), `ui/base.css`, `ui/components.css`, `ui/fonts/{Inter-Variable.woff2,JetBrainsMono-Variable.woff2}` (download from the projects' GitHub releases; OFL licence files alongside), `ui/test/tokens.test.mjs`, `ui/gallery.html` (static page showing every component in both themes, for the visual pass).

**Interfaces:** Produces CSS custom properties `--bg --bg-soft --surface --surface-2 --border --border-soft --text --text-soft --text-mute --text-strong --accent --accent-2 --on-accent --positive --negative --warning --gradient --r-sm --r-md --r-lg --r-xl --r-pill --s-1…--s-8 --font --mono`; themes via `:root` (dark), `:root[data-theme="light"]`, and `@media (prefers-color-scheme: light) { :root[data-theme="system"] {…} }`. Component classes: `.btn .btn-primary .btn-ghost .btn-round .hero .card .row .avatar .tabbar .sidebar .sheet .modal .field .chip .skeleton .toast .banner .ring .mono .amount`. Layout classes on `<body>`: `.compact` (< 900 px) / `.wide`.

- [ ] **Step 1: Failing test** `ui/test/tokens.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from '../scripts/build-tokens.mjs';

const tokens = JSON.parse(readFileSync(new URL('../../design/tokens.json', import.meta.url)));

test('tokens.css is up to date with design/tokens.json', () => {
  const onDisk = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
  assert.equal(onDisk, render(tokens));
});
test('both themes define every colour', () => {
  const css = render(tokens);
  for (const k of Object.keys(tokens.dark)) {
    const v = '--' + k.replaceAll('_', '-') + ':';
    assert.equal(css.split(v).length - 1, 3, v); // dark, light, system-light
  }
});
function lum(hex) { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); }
test('text on bg and surface meets AA in both themes', () => {
  for (const t of ['dark', 'light']) for (const fg of ['text', 'text_soft']) for (const bg of ['bg', 'surface'])
    assert.ok(contrast(tokens[t][fg], tokens[t][bg]) >= 4.5, `${t} ${fg} on ${bg}`);
});
```

- [ ] **Step 2:** `node --test ui/test/` — FAIL: cannot find `build-tokens.mjs`.
- [ ] **Step 3: Implement** `build-tokens.mjs` exporting `render(tokens)` (emits the three theme blocks, gradient as `linear-gradient(135deg, from, to)`, radius, spacing, the two font stacks with `@font-face` for the woff2 files) and, when run as a script, writing `ui/tokens.css`. Run it. Write `base.css` (reset; `font-variant-numeric: tabular-nums` on `.amount`; `:focus-visible` 2 px `--accent` ring offset 2 px; `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation: none !important; transition: none !important } }`; `body.compact` single column max-width 420 px centred, `body.wide` grid `240px minmax(0,1fr) minmax(0,420px)`), and `components.css` per the class list: `.hero` uses `--gradient` with a soft radial highlight and 24 px radius; `.btn-round` 56 px circle with caption beneath; `.row` 64 px list row with `.avatar` 40 px; `.tabbar` fixed bottom, 4 items, active item accent + 3 px pill indicator; `.sheet` slides up 220 ms with a scrim, becomes `.modal` centred 440 px under `body.wide`; `.skeleton` shimmer; `.ring` SVG progress ring for proving. If a contrast assertion fails, fix the value in `design/tokens.json` (smallest change that reaches 4.5) and regenerate.
- [ ] **Step 4:** `node --test ui/test/` — PASS. Open `ui/gallery.html` in the browser in both themes at 360 px and 1200 px; fix anything misaligned or clipped.
- [ ] **Step 5:** Commit `ui: tokens, base and component styles`.

### Task 1.2: Backend contract, fake backend, DOM helpers

**Files:** Create `ui/backend.js`, `ui/test/fake-backend.mjs`, `ui/lib/dom.js`, move `extension/shared/lib/format.js`→`ui/lib/format.js` and `qr.js`→`ui/lib/qr.js` with `git mv` (extension imports updated in Task 2.1; until then leave one-line re-export shims at the old paths), `ui/test/backend.test.mjs`, `ui/test/format.test.mjs`.

**Interfaces — Produces** (every later task relies on these exact names):

```js
// ui/backend.js
export const BACKEND_SHAPE = {
  wallet:   ['exists', 'create', 'import', 'unlock', 'lock', 'isUnlocked', 'info', 'parseAddress', 'viewingKey', 'exportSpendKey', 'wipe'],
  sync:     ['scan', 'cached'],
  assets:   ['list'],
  send:     ['canProve', 'estimate', 'send'],
  faucet:   ['request'],
  rpc:      ['call'],
  settings: ['get', 'set'],
  platform: ['openExternal', 'copy'],   // plus string field platform.name
};
export function assertBackend(b) { /* throws Error('backend.<group>.<fn> missing') */ }
```

Return shapes: `wallet.info()` → `{address, pk}`; `sync.scan(onProgress)` and `sync.cached()` → `{notes: [...], activity: [{kind:'in'|'out'|'faucet'|'pending', asset, amount, time, hash?, index?}], scannedHeight, head, lastSyncMs}`; `assets.list()` → `[{index, id, symbol, decimals, balance: string, pending: string}]` with index 0 first; `send.canProve()` → `{ok: boolean, reason?: string}`; `send.estimate({asset, to, amount})` → `{fee: string, inputs: number, change: string, proofs: 1|2}`; `send.send(req, onPhase)` → `{hash, txKey}` where `onPhase(phase)` gets `'selecting'|'witness'|'proving'|'proving-asset'|'submitting'|'confirming'`; `settings.get()` → `{rpcUrl, theme, autoLockMin, explorerUrl, chainId}`. Amounts are decimal strings of units.

`ui/lib/dom.js`: `export function h(html)` (tagged-template that escapes interpolations unless wrapped in `raw()`), `export function raw(s)`, `export function on(root, selector, event, fn)` (delegation).

- [ ] **Step 1: Failing tests.**

```js
// ui/test/backend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBackend, BACKEND_SHAPE } from '../backend.js';
import { fakeBackend } from './fake-backend.mjs';

test('fake backend satisfies the contract', () => assertBackend(fakeBackend()));
test('a missing method is named', () => {
  const b = fakeBackend(); delete b.send.estimate;
  assert.throws(() => assertBackend(b), /backend\.send\.estimate missing/);
});
test('platform.name is required', () => {
  const b = fakeBackend(); b.platform.name = '';
  assert.throws(() => assertBackend(b), /backend\.platform\.name/);
});
```

```js
// ui/test/format.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, parseUnits, shortAddress } from '../lib/format.js';
import { h, raw } from '../lib/dom.js';

test('formatUnits honours decimals', () => {
  assert.equal(formatUnits('1500000000'), '1.5');
  assert.equal(formatUnits('1500000', 9, 6), '1.5');   // (units, maxFrac, decimals)
});
test('parseUnits round-trips', () => assert.equal(parseUnits('0.25').toString(), '250000000'));
test('h escapes, raw does not', () => {
  assert.equal(h`<p>${'<b>'}</p>`, '<p>&lt;b&gt;</p>');
  assert.equal(h`<p>${raw('<b>x</b>')}</p>`, '<p><b>x</b></p>');
});
```

- [ ] **Step 2:** `node --test ui/test/` — FAIL (modules missing).
- [ ] **Step 3: Implement** `backend.js`, `dom.js`; add the third `decimals = 9` parameter to `formatUnits` and a second to `parseUnits(text, decimals = 9)`; write `fake-backend.mjs` exporting `fakeBackend(overrides = {})`: in-memory, starts with no wallet, `create`/`import` set `{address: 'shrugg1' + 'q'.repeat(40), pk: 'ab'.repeat(32)}`, `assets.list()` returns RAND `{index:0,symbol:'RAND',decimals:9,balance:'3500000000',pending:'0'}` and one RPL `{index:1,symbol:'wETH',decimals:9,balance:'120000000',pending:'0'}`, `canProve` returns `{ok:false, reason:'test'}` unless overridden, every call is recorded in `b.calls`.
- [ ] **Step 4:** `node --test ui/test/` — PASS.
- [ ] **Step 5:** Commit `ui: backend contract, fake backend, dom and format helpers`.

### Task 1.3: App shell — router, theme, lock gate, navigation

**Files:** Create `ui/app.js`, `ui/lib/icons.js`, `ui/screens/{onboarding,lock}.js`, `ui/test/app.test.mjs`, `ui/test/dom-env.mjs` (tiny DOM for node tests using `linkedom`; add `ui/package.json` with `"devDependencies": {"linkedom": "^0.18"}`, `"type": "module"`, `"private": true` — dev-only, never shipped).

**Interfaces:**
- Produces: `export async function mount(container, backend, { mode = 'app' } = {})` returning `{ go(hash), destroy() }`; `export function registerScreen(name, { render(ctx, arg), after?(ctx, root), tab? })`; `ctx = { backend, go, toast, sheet(html), closeSheet, state, mode, canProve }`. Routes are `#name` or `#name/arg`. `resolveRoute({exists, unlocked}, hash)` is exported for tests: no wallet → `welcome` (or `create`/`import`/`backup`), wallet but locked → `lock`, else the requested screen, default `home`. `mode: 'popup'` forces `body.compact`; otherwise `matchMedia('(min-width: 900px)')` toggles `compact`/`wide` live. Theme: `document.documentElement.dataset.theme = settings.theme`.
- Tabs: `home`, `activity`, `explore`, `settings` — tab bar when compact, sidebar when wide (sidebar also shows a lock button and the network status dot).

- [ ] **Step 1: Failing test** `ui/test/app.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount, resolveRoute } from '../app.js';
import { fakeBackend } from './fake-backend.mjs';

test('route gating', () => {
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#home').name, 'welcome');
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#import').name, 'import');
  assert.equal(resolveRoute({ exists: true, unlocked: false }, '#send').name, 'lock');
  assert.deepEqual(resolveRoute({ exists: true, unlocked: true }, '#asset/1'), { name: 'asset', arg: '1' });
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '').name, 'home');
});
test('first run shows welcome with create and import', async () => {
  const root = document.createElement('div'); document.body.append(root);
  await mount(root, fakeBackend());
  assert.ok(root.querySelector('[data-go="create"]'));
  assert.ok(root.querySelector('[data-go="import"]'));
  assert.equal(root.querySelector('.tabbar, .sidebar'), null);
});
test('create → password → backup check → home', async () => {
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend(); const app = await mount(root, b);
  await app.go('#create');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal(b.calls.filter(c => c[0] === 'wallet.create').length, 1);
  assert.match(location.hash, /^#backup/);
});
```

  (`app.idle()` resolves when the pending render settles; add it to the returned object.)
- [ ] **Step 2:** `cd ui && npm i && node --test test/` — FAIL.
- [ ] **Step 3: Implement** `app.js` (hashchange listener, delegated `[data-go]` clicks, `toast`, `sheet` — appends `.sheet`/`.modal` + scrim to `container`, Escape and scrim close it, focus is trapped and restored), `icons.js` (inline 24 px stroke SVGs: home, activity, compass, settings, arrow-up-right, arrow-down-left, droplet, bridge, copy, lock, eye, check, chevron, warning, shield), `onboarding.js` (`welcome`: logo, one-line pitch, two buttons; `create`/`import`: password ≥ 10 chars with a strength meter and confirm field, `import` adds a key textarea; `backup`: shows the spend key behind a press-and-hold reveal, then asks for characters 1-4 of it before `home`), `lock.js` (password field, error inline on reject, "Forgot? Wipe and restore" link to a confirm sheet).
- [ ] **Step 4:** `node --test ui/test/` — PASS.
- [ ] **Step 5:** Commit `ui: app shell, onboarding and lock`.

### Task 1.4: Home, asset detail, activity, receive, faucet, detail screens

**Files:** Create `ui/screens/{home,asset,activity,detail,receive,faucet}.js`, `ui/lib/assets.js`, `ui/test/screens.test.mjs`.

**Interfaces:** Consumes `registerScreen`, `ctx`, Backend shapes. Produces `ui/lib/assets.js`: `export function totalInRand(assets)` (RAND balance only — RPL assets have no price; returns units string), `export function groupByDay(activity, now = Date.now())` → `[{label: 'Today'|'Yesterday'|'12 Sep 2026', items}]`, `export function avatarFor(asset)` → `{text, hue}` deterministic from `asset.id` (RAND gets the aurora gradient).

- [ ] **Step 1: Failing test** `ui/test/screens.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount } from '../app.js';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';
import { groupByDay } from '../lib/assets.js';

async function at(hash, b = unlockedBackend()) {
  const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, b); await app.go(hash); await app.idle(); return { root, b, app };
}
test('home shows RAND hero, four actions, both assets', async () => {
  const { root } = await at('#home');
  assert.match(root.querySelector('.hero .amount').textContent, /3\.5/);
  assert.match(root.querySelector('.hero').textContent, /RAND/);
  assert.deepEqual([...root.querySelectorAll('.btn-round')].map(n => n.dataset.go), ['receive', 'send', 'faucet', 'explore/bridge']);
  assert.equal(root.querySelectorAll('.row[data-go^="asset/"]').length, 2);
});
test('home renders skeletons before the scan resolves', async () => {
  const b = unlockedBackend(); let release; b.sync.cached = () => new Promise(r => { release = r; });
  const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, b); app.go('#home');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(root.querySelector('.skeleton'));
  release({ notes: [], activity: [], scannedHeight: 0, head: 0, lastSyncMs: 0 });
});
test('rpc failure shows a retry banner, not a blank screen', async () => {
  const b = unlockedBackend(); b.sync.scan = async () => { throw new Error('cannot reach http://x: timed out'); };
  const { root } = await at('#home', b);
  assert.match(root.querySelector('.banner').textContent, /cannot reach/);
  assert.ok(root.querySelector('.banner [data-action="sync"]'));
  assert.ok(root.querySelector('.banner [data-go="settings"]'));
});
test('receive shows the address and a QR canvas', async () => {
  const { root } = await at('#receive');
  assert.ok(root.querySelector('canvas'));
  assert.match(root.querySelector('.mono').textContent, /^shrugg1/);
});
test('groupByDay labels', () => {
  const now = Date.UTC(2026, 8, 19, 12);
  const g = groupByDay([{ time: now / 1000 }, { time: now / 1000 - 86400 }, { time: now / 1000 - 7 * 86400 }], now);
  assert.deepEqual(g.map(x => x.label), ['Today', 'Yesterday', '12 Sep 2026']);
});
```

  Add `unlockedBackend()` to `fake-backend.mjs`: a fake with a wallet that is already unlocked and three activity items.
- [ ] **Step 2:** `node --test ui/test/` — FAIL.
- [ ] **Step 3: Implement** the screens. Home: render from `sync.cached()` immediately, then `sync.scan()` in the background with a thin progress bar under the hero and "Synced Ns ago"; pull-to-refresh is the sync icon. Asset rows: avatar, symbol, "RPL" chip when `index ≥ 1`, balance right-aligned, pending beneath in `--text-mute`. Activity rows: direction icon in a tinted circle (`--positive` in, `--text-soft` out, `--warning` pending), amount signed and coloured. Detail (`#tx/<hash>`, `#note/<index>`): fields as label/value rows, copy buttons, tx key behind reveal, "Open in randscan" via `platform.openExternal` (never put a key in the URL). Receive: QR on a white rounded card (QR needs light background in both themes), address with copy, share-safe note "This address is reusable". Faucet: one button, result toast, cooldown text from the node's error.
- [ ] **Step 4:** `node --test ui/test/` — PASS.
- [ ] **Step 5:** Commit `ui: home, asset, activity, receive, faucet and detail screens`.

### Task 1.5: Send flow and settings

**Files:** Create `ui/screens/{send,settings}.js`, `ui/test/send.test.mjs`.

**Interfaces:** Consumes `send.canProve/estimate/send` and `wallet.parseAddress(address)` → `{valid, reason?}` (in `BACKEND_SHAPE` since Task 1.2; the fake accepts any string starting `shrugg1` of length ≥ 47). Produces `export function explainProvingError(msg)` in `send.js` (moved from `views.js`, plus: `/unreachable|out of memory|alloc/i` → "This device ran out of memory while proving. Send from the desktop app.").

- [ ] **Step 1: Failing test** `ui/test/send.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount } from '../app.js';
import { unlockedBackend } from './fake-backend.mjs';
import { explainProvingError } from '../screens/send.js';

async function review(b) {
  const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, b); await app.go('#send'); await app.idle();
  root.querySelector('[data-asset="0"]').click(); await app.idle();
  root.querySelector('textarea[name=to]').value = 'shrugg1' + 'q'.repeat(40);
  root.querySelector('input[name=amount]').value = '1';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle(); return { root, app };
}
test('a shell that cannot prove shows the reason and no prove button', async () => {
  const b = unlockedBackend(); b.send.canProve = async () => ({ ok: false, reason: 'Proving needs about 5.5 GB; browsers allow 4 GB.' });
  const { root } = await review(b);
  assert.equal(root.querySelector('[data-action="prove"]'), null);
  assert.match(root.textContent, /5\.5 GB/);
  assert.match(root.textContent, /desktop app/i);
});
test('a shell that can prove walks the phases and lands on sent', async () => {
  const b = unlockedBackend(); b.send.canProve = async () => ({ ok: true });
  const phases = [];
  b.send.send = async (req, onPhase) => { for (const p of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) { onPhase(p); phases.push(p); } return { hash: 'ab'.repeat(32), txKey: 'cd'.repeat(32) }; };
  const { root, app } = await review(b);
  root.querySelector('[data-action="prove"]').click(); await app.idle();
  assert.equal(phases.length, 5);
  assert.match(location.hash, /^#sent\//);
});
test('amount above balance is refused before estimate', async () => {
  const b = unlockedBackend(); const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, b); await app.go('#send/0'); await app.idle();
  root.querySelector('textarea[name=to]').value = 'shrugg1' + 'q'.repeat(40);
  root.querySelector('input[name=amount]').value = '999';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await app.idle();
  assert.match(root.querySelector('.field-error').textContent, /balance/i);
  assert.equal(b.calls.filter(c => c[0] === 'send.estimate').length, 0);
});
test('explainProvingError maps wasm OOM', () => assert.match(explainProvingError('RuntimeError: unreachable'), /memory/));
```

- [ ] **Step 2:** `node --test ui/test/` — FAIL.
- [ ] **Step 3: Implement.** Send steps as one screen with internal state: asset picker (skipped when `#send/<index>`), recipient (paste button, live validation), amount (Max button that subtracts the fee for asset 0, fiat-less), review (to, amount, fee in RAND, change, "2 proofs · about 3 min" when `estimate.proofs === 2`), proving (`.ring` with the phase label and elapsed timer, "Keep this window open", no cancel once submitting), `#sent/<hash>` (check animation, tx key with copy, randscan link). Settings: sections Network (RPC URL, Test connection → `rpc.call('shrugg_status')` shows height and chain id), Appearance (system/dark/light segmented control, applies instantly), Security (auto-lock minutes, viewing key, export spend key behind password re-entry and a written warning, wipe behind typing `WIPE`), About (version from `rpc`-free `backend.platform`, links).
- [ ] **Step 4:** `node --test ui/test/` — PASS.
- [ ] **Step 5:** Commit `ui: send flow and settings`.

### Task 1.6: Web wallet shell

**Files:** Create `web/wallet/{index.html,main.js,backend-web.js,idb.js,worker.js,build.sh,serve.sh,serve.mjs,README.md}`, `web/wallet/test/idb.test.mjs`; `git mv extension/shared/lib/{wallet,crypto,rpc}.js ui/engine/` and make them storage-agnostic: `ui/engine/wallet.js` takes `{core, rpc, store}` instead of importing `./store.js` (`store` = `{getNoteStore, setNoteStore}`), so both wasm shells share it; leave re-export shims in `extension/shared/lib/` until Task 2.1.

**Interfaces:** Produces `export function makeWasmBackend({ core, storage, platform })` in `ui/engine/backend-wasm.js` — the Backend used by **both** web and extension; `storage` = `{get(key), set(key, value), clear(), session: {get, set, remove}}`. `canProve()` returns `{ok:false, reason:'A transfer proof needs about 5.5 GB of memory and browsers give WebAssembly 4 GB. Send from the Rand Wallet desktop app — your keys import there.'}`. `web/wallet/idb.js`: `export function idbStorage(dbName = 'rand-wallet')` implementing `storage` with `session` held in a module-level `Map` (memory only).

- [ ] **Step 1: Failing test** `web/wallet/test/idb.test.mjs` using `fake-indexeddb` (dev dep in `ui/package.json`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { idbStorage } from '../idb.js';

test('set/get/clear round-trip and session is memory only', async () => {
  const s = idbStorage('t1');
  await s.set('vault', { iv: 'aa' });
  assert.deepEqual(await s.get('vault'), { iv: 'aa' });
  await s.session.set('unlocked', { spend_key: 'k' });
  const again = idbStorage('t1');
  assert.deepEqual(await again.get('vault'), { iv: 'aa' });
  await s.clear();
  assert.equal(await again.get('vault'), undefined);
});
```

  And `ui/test/backend-wasm.test.mjs`: build `makeWasmBackend` with a stub `core` (`keygen` → fixed keys, `walletInfo`) and a `Map`-backed storage; assert `assertBackend` passes, `create('pw…')` stores a vault that `unlock('wrong')` rejects and `unlock('pw…')` accepts, `canProve().ok === false`, and `wipe()` empties storage.
- [ ] **Step 2:** `node --test ui/test web/wallet/test` — FAIL.
- [ ] **Step 3: Implement.** `build.sh`: `rsync -a ui/ web/wallet/dist/ui/ --exclude test --exclude node_modules --exclude scripts --exclude gallery.html`, copy shell files and `extension/shared/core/rand_wallet*` into `dist/core/` (build wasm if missing). `serve.mjs`: `node:http` static server bound to `127.0.0.1:8787`, `application/wasm` MIME, headers `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src *; img-src 'self' data:; style-src 'self'`, path traversal refused. `serve.sh`: `build.sh && node serve.mjs`. `index.html` links the three CSS files and `main.js`, which does `mount(root, makeWasmBackend({core, storage: idbStorage(), platform: {name:'web', openExternal: u => window.open(u, '_blank', 'noopener'), copy: t => navigator.clipboard.writeText(t)}}))`.
- [ ] **Step 4:** Tests PASS. Then `web/wallet/serve.sh &`, open `http://127.0.0.1:8787` in Chrome: create a wallet, reload (lock screen appears), unlock, set RPC URL, Receive shows QR, Send ends in the 5.5 GB explanation, toggle light theme, resize across 900 px. No console errors.
- [ ] **Step 5:** Commit `web: local wasm wallet on the shared ui`.

### Task 1.7: Wide layout — list and detail side by side

Deferred from Task 1.4 (spec §3.3: "≥ 900 px: left sidebar, content pane + detail pane"). Today a
detail route (`#tx/<hash>`, `#note/<index>`, `#asset/<index>`) replaces the content pane at every
width, and the `.detail` aside in the wide grid is never used.

**Behaviour.** At ≥ 900 px (`body.wide`, never in `mode: 'popup'`): a *detail* route renders into the
detail pane while its *parent list* stays mounted in the content pane — `#tx/…` and `#note/…` keep
whichever of `#home` / `#activity` / `#asset/<i>` the user came from (default `#activity`);
`#asset/<i>` keeps `#home`. The selected row is marked (`aria-current="true"` + a selected style).
Closing the detail (its close button, Escape, or selecting the same row again) returns to the parent
route. Below 900 px nothing changes: the detail replaces the content pane with a back button, as now.
Crossing the breakpoint live re-lays-out without losing the route. Flows (`#send`, `#receive`,
`#faucet`, `#settings`, onboarding, lock) are never two-pane.

**Shell.** `registerScreen(name, { …, pane: 'detail', parent: (arg, from) => '#activity' })`. `doRender`
renders parent and detail as two independent screen instances, each with its own per-render token
(`ctx.isCurrent()`, `ctx.signal`), its own `after()` cleanup and its own container; re-rendering the
detail must NOT re-render (or re-fetch) the parent when the parent route is unchanged — selecting
another row swaps only the detail pane and moves the `aria-current` marker. Session rules are
unchanged (a session end tears down both panes). `app.idle()` covers both. Focus: opening a detail
moves focus to the detail pane's title; closing returns it to the row that opened it.

**Files:** `ui/app.js`, `ui/base.css`, `ui/components.css`, `ui/screens/{detail,asset,activity,home}.js`,
`ui/lib/rows.js`, `ui/gallery.html`, `ui/test/twopane.test.mjs`.

- [ ] **Step 1: Failing tests** (`ui/test/twopane.test.mjs`, linkedom; the test env's `matchMedia` shim
  must be switchable between compact and wide): wide + `#activity` then `#tx/<hash>` → the activity list
  is still in the content pane (same DOM node identity — not re-rendered), the detail pane holds the
  transaction, the row has `aria-current="true"`; selecting a second row swaps only the detail pane and
  the parent's first backend call count is unchanged; close → `#activity`, detail pane empty, focus on
  the originating row; Escape closes; deep link straight to `#tx/<hash>` wide → parent defaults to
  `#activity`; from `#home` the parent stays home; `#asset/1` wide → home in content, asset in detail;
  compact → detail replaces content with a back button (existing behaviour, existing tests still pass);
  `mode: 'popup'` is never two-pane even if wide; switching the media query from wide to compact on
  `#tx/<hash>` re-lays-out to single pane and back; a stale parent fetch cannot write into the new
  parent, a stale detail fetch cannot write into the next detail (hold each screen's first backend
  promise, navigate, release); lock while a detail is open tears down both panes and lands on `#lock`.
- [ ] **Step 2:** `node --test ui/test/twopane.test.mjs` — FAIL.
- [ ] **Step 3:** Implement. Keep `doRender` readable: extract the pane bookkeeping into
  `ui/lib/panes.js` if `app.js` grows past what one module should hold.
- [ ] **Step 4:** Full `node --test ui/test web/wallet/test` PASS (run under a watchdog; the suite must
  exit by itself). Playwright screenshots at 1200×800 light and dark: activity + tx detail, home + asset
  detail, home + tx detail, and the same routes at 360×600 to show nothing changed; iterate until the
  two panes read as one designed surface (aligned top edges, the detail pane's own scroll, a quiet
  empty state "Select a transaction" when nothing is selected on `#activity`).
- [ ] **Step 5:** Commit `ui: list and detail side by side on wide screens`.

---

### Task 1.8: Two residuals from Task 1.6 (the compact-blocks scan rewrite is DEFERRED)

Originally scoped as "scan with `rand_getCompactBlocks` instead of prefix-paged nullifiers", to
close the last narrow gap in Task 1.6's node-trust boundary: prefix-paged `rand_getNullifiers`
replies are validated only as a *prefix* of the true set (bounded, self-healing via rescan, never
able to cause fund loss — the chain itself refuses a spend of an already-nullified note — but not
literally checkable against the request). `rand_getCompactBlocks(from_height, to_height)` would
make a reply checkable by height alone and remove the `NodeLimitError` dead end for a block with
≥ 500 nullifiers.

**DEFERRED 2026-09-20**, before any code was written, after the assigned implementer's mandated
pre-flight read of the node's real handler (`core/vendor/fullnode/crates/randprotocol-node/src/rpc.rs:28-31,1063-1089`,
pinned by node-side tests at `rpc.rs:3594-3619`, documented at `docs/rpc.md:146-172`) found
`MAX_COMPACT_BLOCKS = 128` — not "a few thousand" as this task assumed when it was written. At
chain 13's reference height 54 489 that makes the rewrite cost **426** requests for a first sync
against today's **≈150** (`ceil(54489/500)` nullifier pages + leaf-paged commitments), a ~2.8×
regression, and shrinks one scan's safe reach from 256 000 heights to 65 536. The cap has been
128 since the RAND rename (`git log -S MAX_COMPACT_BLOCKS`) and predates every fleet this project
has used, so it is not a chain-14 artifact that might lift on its own.

**Ruling:** given the residual risk the rewrite would close is already bounded and self-healing
(Task 1.6, five rounds), and closing it fully would cost real, permanent first-sync time on an
assumption already wrong once, this repository does NOT take that trade now. If request count or
the `NodeLimitError` edge case ever becomes a real complaint, revisit with one of the priced
options on record in `task-1.8-report.md` §3: (a) accept `RANGE = 128` and the 426-request cost;
(b) add JSON-RPC batching to `ui/engine/rpc.js` (the node accepts batches up to 20 —
`MAX_BATCH`, `rpc.rs:38-40` — giving 22 round trips at H = 54 489, but `rpc.js` has no batch path
today: new wire code and a new id↔request trust surface, its own task); (c) a hybrid — compact
blocks for a recent window only, prefix-paging below it. None is scheduled.

**What Task 1.8 actually builds** is the two items below, carried forward from Task 1.6's final
review (round 5, cap adjudicated 2026-09-20) as REQUIRED regardless of the scan mechanism above,
because both are load-bearing for Phase 3 (Tasks 3.1–3.2, the Tauri desktop backend reuses this
engine and can really send/mint):

- [ ] **(A)** `ui/engine/wallet.js`'s `send()` calls its post-commit re-scan
  (`await scan(spendKey, {}, s)`) without the verified client, so that one call resolves its own
  client instead of reusing the one `requireVerifiedChain()` verified for the send — thread it
  through, with a test (mirror Task 1.6's `p1-scan-race.mjs`-style probe: after a send, the
  post-commit re-scan's RPC calls all target the verified client's URL even if `settings.rpcUrl`
  changed in the same tick).
- [ ] **(B)** `scan`/`rescan` record `recordVerdict(url, 'ok')` with no identity, so
  `requireVerifiedChain()` afterwards returns `identity: undefined` and `send()` silently falls
  back to the store's `chain_id` — safe today only because that chain id was itself just verified
  by the same scan, but undocumented. Either record the identity on the scan path too (preferred)
  or state the fallback explicitly in `ui/backend.js`'s JSDoc, and add a test that pins whichever
  is chosen and would fail loudly if a future refactor removed the fallback.
- [ ] While these functions are open, in the same commit(s): fix the stale `chainIdentity`
  docstring (`ui/engine/wallet.js:441-448`, still describes a deleted settings-fallback); correct
  `task-1.6-report.md`'s two remaining wrong line-citations (`chainIdentity` is `:449-470`, not
  `:449-484`; `chainVerdict` is `:490-524`, not `:490-545`); make `ui/screens/home.js`'s rescan
  path re-scan on a `staleNode` result the way its scan path already does (`home.js:377-385` vs
  `:338`); update the `chainState` map's type comment in `ui/engine/backend-wasm.js:288` (it omits
  `'anonymous'`/`identity`); and make `scan`'s and `rescan`'s `scan-done` broadcast-on-`staleNode`
  behaviour consistent with each other.
- [ ] `node --test --test-timeout=20000 ui/test web/wallet/test` PASS under a watchdog (exits by
  itself, nothing left running); rename guard clean; commit
  `engine: thread the verified client through send()'s re-scan; record identity with a scan
  verdict`.

---

## Phase 2 — Extension on `ui/`

### Task 2.1: Extension backend and mounts

**Rewritten 2026-09-20** against the Backend contract and `makeWasmBackend` as they actually stand
after Tasks 1.1–1.8 (the original one-paragraph version predates all of it and would have bounced
back NEEDS_CONTEXT). Facts established by reading the current code (not assumed):

- Task 1.2 left `extension/shared/lib/{crypto,rpc,format,qr}.js` as one-line re-export shims into
  `../../../ui/{engine,lib}/...` — each file's own header comment says it is "deleted with that UI
  in task 2.1" — but `popup.js`/`app.js` still mount the pre-redesign `extension/shared/lib/views.js`,
  which imports the ORIGINAL `wallet.js` and `store.js` (not shims — real, self-consistent
  pre-redesign code that was simply never migrated). None of the six screens tasks (1.3–1.5, 1.7)
  ever touched the extension. This task is the actual migration, not a formality.
- `chrome/pack.sh`/`firefox/pack.sh` only `rsync` `extension/shared/` into `dist/<browser>/`, so
  the four shims' `../../../ui/...` imports resolve in the repo layout and 404 once packed — the
  packed extension has been broken since Task 1.2. `extension/test/smoke.mjs` never caught it
  because it only smoke-tests the raw wasm core, never the packed tree.
- `platform.openFlowInTab?` (the reason the original brief planned a tab-escape for Send) is DEAD
  CODE from the UI's side: no screen calls it, because `send.canProve()` is unconditionally
  `{ok:false, …}` in every wasm backend (`ui/engine/backend-wasm.js` — proving needs ~5.6 GB,
  wasm32 caps at 4 GiB), so Send's proving/witness/submitting steps — the ones that would outlive
  a closed 360×600 popup — are never reached. **Do not implement `openFlowInTab` in this task.**
  Send renders normally in the popup and ends at the "cannot prove here" explanation.
- `makeWasmBackend`'s auto-lock (`ui/engine/backend-wasm.js`, `rearmAutoLock`/`autoLockNow`) is a
  plain `setTimeout` (unref'd for Node), re-armed only by `wallet.noteActivity()` and by a fresh
  `unlock`/`create`/`import`. That is correct for a shell whose JS process outlives the wallet
  session (the web wallet, the future Tauri app) but **wrong for a browser-extension popup**: the
  popup's JS context is destroyed the instant it loses focus, so a `setTimeout` armed while it was
  open never fires — auto-lock would silently never happen. A background service worker doesn't
  fix this either: Chrome evicts an idle MV3 service worker after ~30 s with no pending work, well
  before any real `autoLockMin`. The only mechanism in this codebase that survives both is
  `chrome.alarms` (already in both manifests' `permissions`), which is exactly what the
  *pre-redesign* `extension/shared/background.js` already uses — this task keeps that mechanism,
  wires it to the new backend instead of the old `store.js`, and does not touch
  `makeWasmBackend` (which stays fully storage/platform-agnostic; confirmed by grep: it contains
  zero `chrome.*`/`browser.*`/`window.*`/`document.*` calls today, and this task must not add any).
- `storage.compareAndSet?` is optional everywhere it's read (two call sites, both feature-detected,
  both fall back to a plain `set`) — `chrome.storage` has no compare-and-swap primitive, so the
  extension's storage adapter simply omits it. This only loses the two-tab race guard the web
  wallet gets from IndexedDB transactions; the popup and an app tab can still both be open, so note
  it as a known, accepted gap (same failure mode Task 1.6 already made non-destructive: at worst a
  concurrent write is retried as a scan, never silently corrupted).

**Files:**
- Create: `extension/shared/backend-extension.js` (composes `makeWasmBackend`; owns the
  `chrome.alarms` wiring described below), `extension/shared/lib/idle-lock.js` (the alarm glue,
  factored out so it can be unit-tested with a fake `ext` — see Interfaces).
- Rewrite: `popup.js`, `app.js`, `popup.html`, `app.html`, `background.js` (rewired to the new
  backend's storage key, not `store.js`'s).
- Delete: `extension/shared/lib/{views,wallet,store,crypto,rpc,format,qr}.js`, `styles.css`. Keep
  `extension/shared/lib/core.js` (a generic Worker↔promise wrapper, not tied to the old UI — reused
  as-is, its shape already matches `makeWasmBackend`'s `core.call(method, params)` requirement) and
  `extension/shared/{worker.js,lib/browser.js}` unchanged.
- Modify: `chrome/pack.sh`, `firefox/pack.sh` (copy real `ui/` files, not a shim that reaches
  outside `dist/`), `extension/test/smoke.mjs` (a real packed-tree check — see Step 1).

**Interfaces — Produces:**

```js
// extension/shared/backend-extension.js
export function extensionBackend() { … }   // → a Backend; called once from popup.js and app.js
```
Composition, mirroring `web/wallet/main.js`'s pattern (`makeCore`/`makePlatform`/`boot`) but over
`chrome.storage` instead of IndexedDB:
- `storage`: `get/set/remove/clear` over `ext.storage.local`; `session.get/set/remove` over
  `ext.storage.session` (this is the same MV3 session-storage area the pre-redesign code already
  used — it is a browser-level store, not page memory, so it survives a killed-and-restarted
  service worker within one browsing session, which matters below). No `compareAndSet`.
- `platform`: `{name: IS_FIREFOX ? 'firefox' : 'chrome', openExternal: url => ext.tabs.create({url}),
  copy: text => navigator.clipboard.writeText(text), paste: navigator.clipboard?.readText ?
  () => navigator.clipboard.readText() : undefined, ensureHostPermission: url => ext.permissions
  .request({origins: [new URL(url).origin + '/*']})}`. No `openFlowInTab`, no `version` (nothing
  to show yet).
- `core`: reuse `extension/shared/lib/core.js`'s existing Worker-wrapping `call(method, params)`
  against `extension/shared/worker.js` (unchanged) — do not reimplement it.

**Auto-lock — `extension/shared/lib/idle-lock.js`:**
```js
export function wireIdleLock(backend, ext) { … }   // called once inside extensionBackend()
```
It does two things to the object `makeWasmBackend` returned, without modifying
`ui/engine/backend-wasm.js`:
1. Wraps `wallet.noteActivity`, `wallet.unlock`, `wallet.create`, `wallet.import` (call through to
   the original, then on success/no-throw) to also re-arm a `chrome.alarms.create('autolock',
   {delayInMinutes: settings.autoLockMin})` alarm (read `autoLockMin` via `backend.settings.get()`;
   `0` or absent means never — clear any existing alarm instead of creating one). Wraps
   `wallet.lock` and `wallet.wipe` to also `ext.alarms.clear('autolock')`.
2. Implements `wallet.onLocked(cb)` (overwriting whatever `makeWasmBackend` provided, since that
   one is driven by the internal timer this design bypasses) by subscribing to
   `ext.storage.onChanged`: when the session area's unlocked-session key transitions from present
   to `undefined` **and this page did not just call `wallet.lock()`/`wallet.wipe()` itself**, call
   `cb({reason: 'idle'})`. Read the exact storage key `backend-wasm.js` uses for the unlocked
   session from its own exports/constants rather than hard-coding a string that could drift —
   if it isn't already exported, export it (a one-line addition to `ui/engine/backend-wasm.js`,
   the only touch this task makes there, and only if truly necessary).

**`background.js` (rewritten, not deleted):** on `ext.alarms.onAlarm` named `'autolock'`, remove
the unlocked-session key from `ext.storage.session` directly (the same key `idle-lock.js` watches
for) — this is the actual lock action; it works whether or not any popup/tab is currently open,
and if one is open, `idle-lock.js`'s `storage.onChanged` listener there notices and routes to
`#lock` via the shell's normal `wallet.onLocked` path. Keep the existing `onInstalled` (open
`app.html#welcome` on fresh install) and drop the old direct `store.js`-based `unlocked` removal
it used to do inline, since that key name and mechanism no longer exist.

**Manifest:** `alarms` is already declared in both `chrome/manifest.json` and
`firefox/manifest.json` — no permission change needed, only how it's used changes (backend-driven
key, not `store.js`'s).

- [ ] **Step 1: Failing test.** Extend `extension/test/smoke.mjs`: after the existing raw-core
  checks, `execSync('chrome/pack.sh')`, then assert `dist/chrome/ui/app.js`,
  `dist/chrome/ui/tokens.css`, `dist/chrome/ui/backend.js`, `dist/chrome/ui/engine/backend-wasm.js`,
  `dist/chrome/core/rand_wallet_bg.wasm` all exist as real files (not symlinks into the repo);
  `dist/chrome/ui/test` does not exist; nothing under `dist/chrome` matches
  `/\beval\(|new Function\(/`; `dist/chrome/lib/{crypto,rpc,format,qr,wallet,views,store}.js` do
  not exist. Also a unit test for `idle-lock.js` against a fake `ext` (`{alarms:{create,clear},
  storage:{onChanged:{addListener,removeListener}, session:{get,set,remove}}}`): `noteActivity()`
  creates an alarm with the configured minutes; `autoLockMin: 0` clears rather than creates;
  `lock()`/`wipe()` clear the alarm; a storage change removing the unlocked key fires `onLocked`'s
  callback; a storage change caused by this page's own `lock()` call does NOT re-fire it (no
  double-handling).
- [ ] **Step 2:** `node extension/test/smoke.mjs` and `node --test ui/test/idle-lock.test.mjs` (or
  wherever you put it) — FAIL.
- [ ] **Step 3:** Implement everything above. HTML links `ui/tokens.css`, `ui/base.css`,
  `ui/components.css`; popup body fixed 360×600; `pack.sh` gains
  `rsync -a --exclude test --exclude node_modules --exclude scripts --exclude gallery.\* --exclude dev.\* --exclude package*.json ui/ dist/<browser>/ui/`
  (both browsers) alongside the existing wasm-core copy.
- [ ] **Step 4:** Smoke PASS; the idle-lock unit test PASS; `node --test ui/test web/wallet/test`
  still PASS (nothing there should change). Load `dist/chrome` unpacked in Chrome
  (`chrome://extensions`, Developer mode): popup renders at 360×600 with the tab bar; create a
  wallet; Send shows the "cannot prove here" explanation with no Prove button; lock/unlock works;
  set auto-lock to 1 minute in Settings, close the popup, wait over a minute, reopen — locked.
  Repeat the popup + lock/unlock check in Firefox via `about:debugging` → "Load Temporary Add-on…".
- [ ] **Step 5:** Commit `extension: run on the shared ui, with alarms-based auto-lock`.

---

## Phase 3 — Tauri desktop

### Task 3.1: Extract the shared backend factory (behavior-preserving refactor)

**Split from the original Task 3.1 rewrite, 2026-09-20.** Given the stakes of Phase 3 — this is
where real money moves for the first time in the whole project — the original single "scaffold
Tauri" task is split into two sequentially-reviewable pieces. This task is the first: a
refactor-only change with no new capability and no Tauri code at all, small enough to review on
its own and prove safe before Task 3.2 builds native proving on top of it. Facts established by
reading the current code (not assumed):

- `backend-wasm.js`'s only gate on real proving is one early return inside `send.send`
  (`ui/engine/backend-wasm.js:1046-1128`: `canProve()` returns `{ok:false, reason:
  CANNOT_PROVE_REASON}`, checked first, and `send.send` throws before calling `wallet.js`'s
  `send()` if it isn't `ok`). `canProve` and the send-execution function are the *only* two things
  that differ between a shell that can prove and one that can't — everything else in
  `backend-wasm.js` (session lifecycle, storage, chain-identity verification, scan, rescan,
  password throttle — roughly 1100 lines) has nothing to do with wasm specifically and is exactly
  what Task 3.2's native backend also needs, unchanged.
- Reusing that logic via a shared factory — instead of duplicating or reimplementing it — means
  Task 3.2 inherits Task 1.6's five rounds of adversarial node-trust hardening for free, in the one
  shell that can lose real money to a mistake there. That is the entire reason this refactor exists.

**Ruling:** extract the ~1100 lines of session/storage/chain-identity/scan/throttle logic that has
nothing to do with wasm specifically into a factory, with `canProve` and the send-execution
function as parameters that `makeWasmBackend` and (in Task 3.2) `makeNativeBackend` each supply.
**This refactor must be behavior-preserving for the wasm path**: the full existing
`ui/test/backend-wasm.test.mjs` and `ui/test/engine-wallet.test.mjs` suites pass with zero
modifications after it, proving nothing regressed. No native code, no `desktop/` changes, and no
new capability are in scope for this task — those are Task 3.2, built on this task's reviewed
result.

**Files:**
- Create or modify: extract the shared factory as a new `ui/engine/backend-shared.js` with
  `backend-wasm.js` reduced to a thin wrapper supplying wasm's `canProve`/send-execution — or, if
  the extraction is cleanest some other way, choose that shape instead. Whichever shape you choose,
  `backend-wasm.js`'s exported names and behavior must not change, and the factory's parameter
  shape (`canProve`, the send-execution function, and whatever else a second backend will need to
  supply) must be documented in the file, since Task 3.2 depends on it directly.

**Interfaces — Produces:** the shared factory's signature (name and parameter shape are this
task's choice, but must be recorded in `ui/engine/backend-shared.js`'s own header comment) — Task
3.2's `makeNativeBackend` is built on this factory and needs its exact name, parameters, and
return shape.

- [ ] **Step 1: Failing tests (the safety net, not new behavior).** Run the full existing
  `node --test ui/test/backend-wasm.test.mjs ui/test/engine-wallet.test.mjs` and record the
  baseline pass count — this is what "behavior-preserving" is checked against. There is no new
  test to write for new behavior, because this task adds none; the "failing" step is confirming
  you have a precise baseline to hold the refactor to.
- [ ] **Step 2:** Do the extraction. `backend-wasm.js` keeps its current exported names and
  behavior exactly.
- [ ] **Step 3:** `node --test ui/test/backend-wasm.test.mjs ui/test/engine-wallet.test.mjs` passes
  with the exact same count as the Step-1 baseline and **zero test-file edits** — this is the proof
  the refactor is safe. If a test needed to change to keep passing, the refactor changed behavior:
  stop and reconsider the extraction rather than editing the test to match.
- [ ] **Step 4:** `node --test ui/test web/wallet/test` still fully green (whatever the current
  full count is); `core/scripts/check-rename.sh` still `rename clean`.
- [ ] **Step 5:** Commit `ui: extract the shared backend factory; canProve and send-execution
  become parameters`.

### Task 3.2: Scaffold Tauri — native proving on the shared factory

**Split from the original Task 3.1 rewrite, 2026-09-20; depends on Task 3.1's reviewed shared
factory.** The original version of this task (before either the 2026-09-20 rewrite or this split)
predates `ui/`, `ui/backend.js` and `ui/engine/*.js` entirely — it was written before Task 1.1 and
planned a from-scratch native Rust reimplementation of everything the JS engine now does (scanning,
chain-identity verification, atomic rescan, password throttling, the vault). Facts established by
reading the current code before rewriting this task (not assumed):

- `desktop/Cargo.toml` already depends on `wallet-core` **directly as a Rust crate**, not through
  the C ABI (`wallet-ffi` is for iOS/Android only). `core/crates/wallet-core/src/lib.rs:926`:
  `pub fn call(method: &str, params_json: &str) -> String` is the exact same JSON-string-in,
  JSON-string-out entry point the wasm build exposes — calling it natively from a Tauri command is
  a one-line wrapper, not new logic.
- The 4 GiB wasm32 address-space cap that makes `send.canProve()` unconditionally false in every
  browser shell is a property of **wasm**, not of the host machine's memory — running natively
  removes it entirely, with no size limit but the machine's real RAM. Desktop is the one shell
  where a transfer can actually complete.
- `ui/engine/wallet.js`'s `send()` (the function the send-execution parameter calls when
  `canProve()` is true) is **already a complete, correct implementation**: it selects inputs, gets
  the anchor and witnesses, calls `core.call('prove_transfer', …)`, submits, waits for
  confirmation, and — because of Task 1.8's fix — re-scans afterward with the *same verified
  client* the send used, not a freshly resolved one. It has simply never run end-to-end in
  production because every existing caller of `core` is wasm. **Nothing about proving needs to be
  written from scratch; it needs a `core` that doesn't trap.**
- `ui/engine/rpc.js`'s `makeRpc(url, {fetch})` already takes an injectable `fetch`
  (`ui/engine/rpc.js:36-38`) matching the standard Fetch API shape (`fetch(url, {method, headers,
  body, signal}) -> {ok, status, json()}`) — a Tauri webview's own built-in `fetch()` satisfies
  this with no wrapper needed, so the RPC layer needs **no native code at all**; only `core.call`
  does.
- `desktop/src/secrets.rs` today stores the spend key **in plaintext** in the OS keyring (a
  pre-existing gap in the current, egui-based app — every other shell encrypts the spend key at
  rest with a password-derived key; this one relies solely on OS keychain ACLs). This task fixes
  it as a side effect of using the same vault format everywhere, not as a separate migration.

**Ruling:** do not port the trust boundary to Rust. Reuse `ui/` and `ui/engine/{wallet,validate,
crypto,rpc}.js` completely unmodified, and build on Task 3.1's shared factory rather than
duplicating what it extracted. The only native work is: (1) one generic Tauri command proxying
`core.call` to real `wallet-core`; (2) a real `send.canProve()` (a system-memory check); (3) a
storage adapter (a JSON file for the persistent half, in-memory Rust state for the session half —
the same vault-as-an-encrypted-blob format as every other shell, no OS keyring); (4) a `platform`
adapter (open-in-browser, clipboard, app version). Everything else — the webview, the screens, the
scanning, the RPC calls, the chain-identity gate — is identical code, identical tests, running
unmodified.

**Files:**
- Create: `ui/engine/backend-native.js` (`makeNativeBackend({core, storage, platform, fetch})`,
  built on Task 3.1's shared factory with a real `canProve` and a `send.send` that calls
  `wallet.js`'s `send()` for real).
- Create: `desktop/src-tauri/{Cargo.toml, tauri.conf.json, capabilities/default.json,
  src/{main.rs,commands.rs,storage.rs}}`, `desktop/ui-shell/{index.html,main.js,backend-tauri.js}`,
  `desktop/scripts/stage-ui.sh` (copies `ui/` — minus `test`, `scripts`, `gallery.*`, `dev.*`,
  `package*.json`, `node_modules` — plus `ui-shell/` into `desktop/dist-ui/`; used as Tauri's
  `beforeBuildCommand`/`beforeDevCommand`).
- Delete: `desktop/src/{ui,theme,engine,rpc,main}.rs` (superseded — `ui.rs`/`theme.rs` were already
  slated for removal with egui; `engine.rs`/`rpc.rs`'s scan/send/HTTP orchestration is superseded
  by the JS engine running unmodified), `desktop/src/secrets.rs`'s OS-keyring code (superseded by
  the shared vault-as-a-file format — no native biometric/keyring convenience-unlock in v1; note
  it as a possible future enhancement, not built here), `desktop/Cargo.toml`, `desktop/Cargo.lock`
  (replaced by `desktop/src-tauri/Cargo.toml`). Keep and reuse `desktop/src/store.rs`'s
  `data_dir()` (the only piece of it that survives) and the app bundle metadata/icons.
  Prune Cargo dependencies to what a thin IPC shell actually needs: keep `wallet-core`, add
  `tauri` 2.x (+ `tauri-plugin-opener` for `openExternal`), `sysinfo` (memory check), `serde`/
  `serde_json`, `dirs`; drop `eframe`, `egui` (obsolete), `keyring` (vault is a file now), `ureq`
  (RPC is webview `fetch`, not native HTTP), `qrcode` (QR is drawn in JS via `ui/lib/qr.js`),
  `open` (superseded by `tauri-plugin-opener`).

**Interfaces — Consumes:** Task 3.1's shared factory (`ui/engine/backend-shared.js`, or whatever
shape that task chose) — read its header comment for the exact signature before writing
`backend-native.js`.

**Interfaces — Produces:**

Tauri commands — deliberately few, because most of the Backend's logic stays in JS:
- `core_call(method: String, params: String) -> String` — a direct, one-line passthrough to
  `wallet_core::call(&method, &params)`. No validation, no interpretation: the JS engine already
  validates every reply from a *node*, and this is a call to the *local, trusted* wallet-core
  crate, not the network.
- `system_memory_gib() -> f64` — via the `sysinfo` crate; used only by `canProve`.
- `storage_get/set/remove/clear(key: String, value: Option<String>) -> Result<…>` — the persistent
  half, one JSON file under `data_dir()` (reuse it from `store.rs`), read/written whole (no need
  for partial updates or `compareAndSet` — desktop is a single process; there is no second tab to
  race).
- `storage_session_get/set/remove(key: String, value: Option<String>)` — an in-memory
  `Mutex<HashMap<String,String>>` in Tauri-managed state; cleared on process exit by construction
  (nothing persists it), exactly matching "session storage" in every other shell.
- Everything else (assets, sync, faucet, settings, rpc) reaches the JS engine's own logic via
  `core_call` and the webview's own `fetch()` — no separate command needed for any of them.

```js
// desktop/ui-shell/backend-tauri.js
import { makeNativeBackend } from '../../ui/engine/backend-native.js';
const { invoke } = window.__TAURI__.core;   // "withGlobalTauri": true in tauri.conf.json

const core = { call: (method, params) => invoke('core_call', { method, params: JSON.stringify(params) }).then(JSON.parse) };
const storage = { /* get/set/remove/clear over storage_*; session.{get,set,remove} over storage_session_* */ };
const platform = {
  name: 'desktop',
  openExternal: (url) => invoke('plugin:opener|open_url', { url }),   // capability scoped to https://randscan.org/* and https://randprotocol.org/*
  copy: (text) => navigator.clipboard.writeText(text),
  paste: () => navigator.clipboard.readText(),
  version: /* injected at build time from Cargo.toml, or read via a tiny command */,
};
export const backend = makeNativeBackend({ core, storage, platform }); // no `fetch` override — the webview's own fetch satisfies rpc.js as-is
```

`canProve()` in `backend-native.js`: `{ok: true}` when `system_memory_gib() >= 8` (leaving headroom
above the ~5.5 GB proof peak), else `{ok:false, reason: "Proving needs about 5.5 GB of free
memory; this computer reports N GB."}` with the real number filled in.

`tauri.conf.json`: `productName "Rand Wallet"`, identifier `org.randprotocol.wallet.desktop`,
`frontendDist "../dist-ui"`, `withGlobalTauri: true`, window 1100×760 min 380×600 (matches Task
1.7's two-pane breakpoint), CSP `default-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src ipc: http://ipc.localhost https: http://127.0.0.1:* http://localhost:*` (the last two
patterns are for a user tunnelling a local node — e.g. `ssh -L 8545:127.0.0.1:8545`), no
`worker-src`/`wasm-unsafe-eval` needed (no wasm loaded in this shell at all), bundle targets `dmg,
msi, appimage, deb`, icon from `desktop/assets`. **If the plain webview `fetch()` turns out to hit
mixed-content blocking against an `http://` tunnel in practice** (verify empirically in Step 4
before assuming it), the fallback is a generic `http_post(url, body) -> Result<String,String>`
Tauri command and a thin `fetch`-shaped JS wrapper passed as `rpc.js`'s injectable `fetch` — do not
build this unless the plain path is actually observed to fail.

- [ ] **Step 1: Failing tests.** Write `ui/test/backend-native.test.mjs` (stub `core`/`storage`/
  `platform`, mirroring `backend-wasm.test.mjs`'s fixtures): `canProve()` reflects an injected
  memory value (`{ok:true}` at 8 GiB, `{ok:false, …}` at 4 GiB, with the real number in the
  message); `send.send()` on a `canProve: {ok:true}` backend actually calls through to
  `wallet.js`'s `send` (spy on `core.call('prove_transfer', …)` and assert it was called with the
  verified chain id, mirroring the property Task 1.8 already tests at the `wallet.js` level); the
  verified-chain gate, session lifecycle, password throttle and every other inherited behavior are
  identical to `makeWasmBackend`'s (run the SAME shared test cases parameterized over both
  factories where practical, rather than copy-pasting). Also `desktop/src-tauri/src/commands.rs`
  `#[cfg(test)]`: `core_call` round-trips `wallet_core::call` exactly (e.g. `"version"` →
  the same JSON `wallet_core::call("version", "{}")` would return directly); `storage_*`
  read-your-writes against a temp `data_dir` (env override); `system_memory_gib` returns a
  plausible positive number.
- [ ] **Step 2:** `node --test ui/test/backend-native.test.mjs` and
  `cd desktop/src-tauri && cargo test` — FAIL (module/commands don't exist).
- [ ] **Step 3:** Implement `backend-native.js` on Task 3.1's shared factory, the Tauri scaffold,
  `backend-tauri.js`, `stage-ui.sh`.
- [ ] **Step 4:** All new tests GREEN; `node --test ui/test web/wallet/test` still fully green
  (429+ , exact count depends on what Step 1 added); `cargo test` in `desktop/src-tauri` PASS;
  `cargo tauri dev` — the app opens at 1100×760 with the sidebar; create a wallet (real native
  proving path reachable — confirm `send.canProve()` reports `{ok:true}` on this machine, or
  `{ok:false}` with a real, correct memory number if it doesn't have 8 GiB); sync against a
  tunnelled node if one is reachable (`ssh -N -L 8545:127.0.0.1:8545 root@<node>`); if reachable,
  attempt one real send end-to-end and confirm it actually proves and confirms (this is the first
  point in the whole project a real transfer can complete — treat a failure here as high priority,
  not a footnote); narrow the window below 900 px → tab bar (Task 1.7's breakpoint). Verify the
  `connect-src` CSP question from the Interfaces section empirically against a real `http://`
  tunnel if one is available.
- [ ] **Step 5:** Commit the Tauri scaffold (`desktop: Tauri shell on the shared ui — native
  proving, egui removed`).

### Task 3.3: Packaging and platform READMEs

**Files:** Modify `desktop/scripts/*` (replace cargo-bundle calls with `cargo tauri build`),
`desktop/README.md`, `macosx/README.md`, `linux/README.md`, `windows/README.md`, root `README.md`
table row (`Rust (Tauri)`), `web/clients.astro` if it names egui.

- [ ] **Step 1:** `cd desktop/src-tauri && cargo tauri build --bundles dmg` — expected: a `.dmg`
  under `target/release/bundle/dmg/`.
- [ ] **Step 2:** Mount it, launch the app from the image, confirm the window renders. **Do not
  reference a keyring prompt** (Task 3.2 deleted OS-keyring use) — instead confirm the vault file
  exists under the platform's config directory (`~/Library/Application Support/RandWallet` /
  `%APPDATA%\RandWallet` / `~/.config/RandWallet`) after creating a wallet, and that it is the
  same encrypted-blob format `ui/engine/crypto.js` produces (starts the same way a browser
  shell's exported vault would).
- [ ] **Step 3:** Update the docs: build prerequisites per OS (Linux:
  `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`; Windows: WebView2 runtime,
  bundled by the msi bootstrapper), commands, output paths, and the licence note (GPL-3.0-only,
  per Task 0.5).
- [ ] **Step 4:** `core/scripts/check-rename.sh` still `rename clean`.
- [ ] **Step 5:** Commit `desktop: tauri packaging and platform notes`.

---

## Phase 4 — Multi-asset and RPL transfers

### Task 4.1: Establish what chain 8 admits for asset transfers (read-only)

- [ ] **Step 1:** Read `core/vendor/fullnode/crates/shrugg-core/src/types/transaction.rs` (the `Action` enum), `ledger/bridge_notes.rs`, `gas.rs:75-95`, and `crates/shrugg-client/src/main.rs` + `wallet.rs` for any subcommand that moves asset ≠ 0 between shielded addresses.
- [ ] **Step 2:** Write the finding at the top of `core/crates/wallet-core/src/lib.rs`'s module docs in three lines: which `Action` variant carries a plain asset transfer (or that only `BridgeBurn` carries an asset bundle), how the fee bundle is attached, and the guest rule `asset != 0 ⇒ fee = 0`.
- [ ] **Step 3:** If a plain transfer variant exists → do Task 4.2a. If not → do Task 4.2b. Commit the doc note.

### Task 4.2a: `prove_transfer` with `asset ≥ 1` (only if 4.1 found a variant)

**Files:** `core/crates/wallet-core/src/lib.rs`.

**Interfaces:** `prove_transfer` request gains optional `"asset": u32` (default 0) and, when `asset ≥ 1`, `"fee_inputs": [...]` beside `"inputs"` (asset notes). Reply gains `"proofs": 1|2`. New dispatch method `plan_transfer {notes, asset, amount, fee}` → `{inputs, fee_inputs, change, fee_change, proofs}` so clients never pick notes themselves.

- [ ] **Step 1: Failing tests:**

```rust
#[test]
fn plan_transfer_picks_fee_notes_separately_for_rpl() {
    let notes = vec![owned(0, 0, 2_000_000_000), owned(1, 1, 500), owned(2, 1, 700)];
    let p = plan_transfer(&notes, 1, 1_000, 10_000).unwrap();
    assert_eq!(p.proofs, 2);
    assert!(p.inputs.iter().all(|n| n.asset == 1));
    assert!(p.fee_inputs.iter().all(|n| n.asset == 0));
    assert_eq!(p.change, 200); assert_eq!(p.fee_change, 2_000_000_000 - 10_000);
}
#[test]
fn plan_transfer_rpl_without_rand_for_fee_says_so() {
    let e = plan_transfer(&[owned(1, 1, 500)], 1, 100, 10_000).unwrap_err().to_string();
    assert!(e.contains("RAND") && e.contains("fee"), "{e}");
}
#[test]
fn asset_bundle_has_zero_fee() {
    let req = fixture_asset_prove_request("test").unwrap();   // added in this task, mirrors fixture_prove_request
    let (fee_bundle, asset_bundle) = build_bundles_unproven(&req).unwrap();
    assert_eq!(asset_bundle.fee, 0); assert_eq!(asset_bundle.asset, 1);
    assert_eq!(fee_bundle.asset, 0); assert!(fee_bundle.fee > 0);
}
```

  (`owned(index, asset, amount)` is a test helper building an `OwnedNote`; split the existing `prove_transfer` body into `build_bundles_unproven` + proving so the structure is testable without a 95 s proof.)
- [ ] **Step 2:** `cargo test -p wallet-core plan_transfer asset_bundle` — FAIL.
- [ ] **Step 3:** Implement; remove the `note.asset != 0` refusal in favour of "all inputs must share `req.asset`"; prove the fee bundle, drop its prover state, then prove the asset bundle (never concurrently: 5.5 GB each); assemble the variant found in 4.1.
- [ ] **Step 4:** `cargo test -p wallet-core` PASS; `cargo run --release --example prove_fixture -- asset` proves both (≈ 3 min) and the node's own `Transaction::validate_stateless` (or the equivalent named in 4.1) accepts the result.
- [ ] **Step 5:** Commit `core: RPL transfers — a RAND fee bundle plus an asset bundle`.

### Task 4.2b: Report RPL sends as unsupported (only if 4.1 found none)

- [ ] **Step 1: Failing test:** `plan_transfer(&notes, 1, 1, 1)` errors with text containing `"RPL transfers are not available on this network"`; `version` reply has `"rpl_transfer": false`.
- [ ] **Step 2–4:** Implement `plan_transfer` for asset 0 only plus that error and flag; in `ui/screens/send.js` assets with `index ≥ 1` stay listed with balance but their Send row is disabled with that sentence (add a `send.test.mjs` case using a fake whose `send.estimate` rejects with it). Tests PASS.
- [ ] **Step 5:** Commit `core, ui: RPL balances shown; RPL send reported unavailable on chain 8`.

### Task 4.3: Per-asset balances in every backend

**Files:** `ui/engine/backend-wasm.js`, `ui/engine/wallet.js`, `desktop/src-tauri/src/{commands,store,engine}.rs`, tests beside each.

**Interfaces:** `assets.list()` joins local note sums with `shrugg_getAssets` (cache the registry in storage for offline start; unknown index → symbol `RPL#<index>`, decimals 9). `send.estimate/send` call `plan_transfer` and pass `asset` through. `NoteStore::balance(asset: u32)`, `pending_out(asset)`.

- [ ] **Step 1: Failing tests:** in `ui/test/backend-wasm.test.mjs` — stub rpc returns `shrugg_getAssets` = `[{index:1, asset_id:'ee'.repeat(32), symbol:'wETH', decimals:18}]`, store holds notes of assets 0, 1 and 7 → `list()` is `[RAND, wETH(decimals 18), RPL#7]` with correct string sums, and with rpc throwing it still returns all three from cache/defaults. Rust: `store.balance(1)` sums only asset 1 and ignores spent/pending.
- [ ] **Step 2–4:** FAIL → implement → `node --test ui/test && (cd desktop/src-tauri && cargo test)` PASS.
- [ ] **Step 5:** Commit `multi-asset balances in the wasm and desktop backends`.

### Task 4.4: RPL bridge withdrawal (`BridgeBurn`) — desktop only

Added 2026-09-19 on the owner's instruction, after Task 4.1 established that the ledger admits no
shielded→shielded transfer of an asset ≥ 1 (`ledger/mod.rs` rejects a transaction bundle with
`asset != 0`): the one thing an RPL note can do is be burned back to its origin chain.

**What the chain requires** (mirror `randprotocol-client`'s `wallet::submit_burn`, never improvise):
one `Transaction { bundle: <RAND fee bundle: asset 0, fee ≥ BRIDGE_BURN_FEE = 10_000_000 units, burn 0>,
action: Action::BridgeBurn { asset_bundle: <asset bundle: asset = index, fee 0, burn == amount, both
outputs back to the sender>, asset, amount, relayer_fee ≤ amount, to_chain: u16, to: [u8; 32] } }`.
Two proofs, generated one after the other (≈ 2 × 98 s, 5.6 GB peak each, never concurrently).

**Files:** `core/crates/wallet-core/src/lib.rs` (+ `examples/`), `desktop/src-tauri/src/{commands,engine}.rs`,
`ui/backend.js`, `ui/test/fake-backend.mjs`, `ui/engine/backend-wasm.js`, `ui/screens/{asset,withdraw}.js`,
`ui/test/withdraw.test.mjs`.

**Interfaces — Produces:**
- `wallet-core` dispatch `plan_burn {notes, asset, amount, fee?}` → `{inputs, fee_inputs, change, fee_change, fee, proofs: 2}`
  (errors: no RAND for the fee → message containing "RAND" and "fee"; `asset == 0` → "RAND is not a bridged asset";
  amount above the two largest notes → the existing consolidate-first message) and `prove_burn {spend_key, asset,
  amount, relayer_fee, to_chain, to, inputs, fee_inputs, witnesses…}` → `{tx, hash, tx_bytes, proofs: 2}`. `version`
  reply gains `"bridge_burn": true` and `"bridge_burn_fee"`.
- Backend group `bridge: ['state', 'canWithdraw', 'estimate', 'withdraw']`: `state()` → `rand_getBridgeState`
  summary `{enabled, chains: [...]}`; `canWithdraw()` → `{ok, reason?}` (false on the wasm shells with the 5.5 GB
  sentence; false when the bridge is disabled); `estimate({asset, amount, relayerFee, toChain, to})` →
  `{fee, relayerFee, receive, proofs: 2}`; `withdraw(req, onPhase)` → `{hash}` with phases
  `'selecting'|'witness'|'proving'|'proving-asset'|'submitting'|'confirming'`.
- UI: asset detail for `index ≥ 1` gains a **Withdraw** action beside the disabled Send (`#withdraw/<index>`).
  Steps: destination chain (from `bridge.state()`, preselected to the asset's origin `chain`) → destination
  address (validated per chain family: 20-byte hex for EVM chains, left-padded to 32 bytes; anything else must be
  64 hex characters) → amount (Max; relayer fee shown as "deducted on the destination chain") → review with an
  explicit warning "This leaves the shielded pool. The destination address and amount become public on the other
  chain." and a typed confirmation of the last 4 characters of the destination → proving (two rings) → done,
  linking to the burn in randscan. No Withdraw button where `canWithdraw().ok` is false; the reason is shown instead.

- [ ] **Step 1: Failing core tests** — `plan_burn_picks_fee_notes_separately`, `plan_burn_without_rand_for_fee_says_so`,
  `plan_burn_refuses_asset_zero`, and `burn_bundles_have_the_ledger_shape` (asset bundle: `fee == 0`,
  `burn == amount`, `asset == index`; fee bundle: `asset == 0`, `burn == 0`, `fee ≥ BRIDGE_BURN_FEE`), built on a
  `build_burn_unproven` split so the shape is testable without a 3-minute proof; plus `fixture_burn_request(profile)`.
- [ ] **Step 2:** `cd core && cargo test -p wallet-core burn` — FAIL.
- [ ] **Step 3:** Implement by mirroring upstream `submit_burn` line for line (input selection `Plan::select`
  semantics, output addressing, action fields); take `BRIDGE_BURN_FEE` from `randprotocol_core::gas`.
- [ ] **Step 4:** `cargo test -p wallet-core` PASS; `cargo run --release --example prove_fixture -- burn` proves both
  bundles and upstream's own stateless validation accepts the transaction (name the function used in the report).
- [ ] **Step 5:** Failing UI tests (`ui/test/withdraw.test.mjs`, fake backend): no Withdraw button when
  `canWithdraw` is false, reason shown; EVM address validation and padding; relayer fee > amount refused before
  `estimate`; the typed confirmation gates the button; phases include `'proving-asset'`; lands on `#withdrawn/<hash>`.
  Implement the screen, the fake, the wasm backend (`canWithdraw` false) and the Tauri commands
  (`bridge_state`, `bridge_can_withdraw`, `bridge_estimate`, `bridge_withdraw`) with Rust tests against the stub RPC.
- [ ] **Step 6:** All suites PASS; screenshots of the four steps in both themes; commit
  `bridge: withdraw an RPL asset to its origin chain (BridgeBurn), desktop only`.

Runs after Task 4.3 and Task 3.2 (it needs the desktop backend).

---

## Phase 5 — Full RPC set and Explore

### Task 5.0: Default RPC endpoints with failover (owner's decision, 2026-09-19)

The default endpoint set is `https://rpc1.randprotocol.org`, `https://rpc2.randprotocol.org`, `https://rpc3.randprotocol.org` (replacing the single `https://rpc.randprotocol.org`). Settings keeps one user-editable "RPC URL" that, when set, overrides the list.

**Interfaces:** `ui/engine/rpc.js` `makeRpc(urls: string | string[], opts)` — tries endpoints in order starting from the last one that worked; on a transport failure (unreachable, timeout, HTTP 5xx, non-JSON body) moves to the next and retries the same request once per remaining endpoint; a JSON-RPC *error reply* is an answer and is never retried elsewhere; `rand_sendTransaction` and `rand_mint` are retried on another endpoint only when the failure happened before any response bytes arrived (connection refused / DNS / TLS), never after a timeout — a timed-out submit may have landed. Every endpoint must answer `rand_chainId` with the expected chain id before it is used for anything else; one that reports a different chain or genesis (`rand_getGenesisHash`) is skipped and named in the error. The same policy in `desktop/src-tauri/src/rpc.rs`, Swift `RpcClient` and Java `RpcClient`. `settings.get()` gains `rpcUrls: string[]` (defaults) alongside `rpcUrl` (override, empty by default).
**Tests:** stub transports — first endpoint down → second answers; error reply not retried; timed-out `sendTransaction` not resubmitted; wrong-chain endpoint skipped with a clear message; override URL disables the list. Extension manifests: `host_permissions` for the three hosts. CSP `connect-src` in the web wallet and Tauri stays as designed (web: `*`; Tauri: RPC goes through Rust).
**Docs:** `docs/rpc-endpoints.md` — what a node operator must run for an endpoint to work (the Caddy recipe from the README with CORS, `POST`-only, request-size and rate limits, and the advice to front full nodes/observers rather than validators, ). **Owner's decision (2026-09-20): `rand_mint` IS reachable through the public proxy for now** — the recipe therefore allows it, with a much tighter per-IP rate limit on that one method than on reads (the node's own faucet cap still applies), and the doc says how to block it later (one matcher) when the faucet moves behind something else. The fleet is on DigitalOcean (the owner's personal account); DNS for `randprotocol.org` is on Cloudflare. The DNS records and the proxies themselves are infrastructure outside this repository.

### Task 5.1: Typed RPC client, all 27 methods

**Files:** Create `ui/lib/rpc-methods.js`, `ui/test/rpc-methods.test.mjs`; modify `ui/engine/rpc.js`, `desktop/src-tauri/src/rpc.rs`.

**Interfaces:**

```js
export const RPC_NAMESPACE = 'shrugg';           // the node's; see spec §10
export const METHODS = {                          // name → {params: [...names], wallet?: true, explore?: 'group'}
  chainId: {params: []}, tokenInfo: {params: []}, status: {params: [], explore: 'network'},
  getHead: {params: [], explore: 'network'}, getEpoch: {params: [], explore: 'network'},
  getValidators: {params: [], explore: 'network'}, getPeers: {params: [], explore: 'network'},
  getSupply: {params: [], explore: 'network'}, getAssets: {params: [], explore: 'assets'},
  getTreeInfo: {params: []}, getAnchor: {params: []}, getWitness: {params: ['index']},
  getCommitments: {params: ['from', 'limit']}, getNullifiers: {params: ['fromHeight', 'limit']},
  getBlockByHeight: {params: ['height'], explore: 'lookup'}, getBlockByHash: {params: ['hash'], explore: 'lookup'},
  getTransaction: {params: ['hash'], explore: 'lookup'}, getReceipt: {params: ['hash'], explore: 'lookup'},
  getProgram: {params: ['id'], explore: 'lookup'}, getProgramCode: {params: ['id'], explore: 'lookup'},
  getCallEnvelope: {params: ['hash'], explore: 'lookup'},
  getBridgeState: {params: [], explore: 'bridge'}, getBridgeBurn: {params: ['id'], explore: 'bridge'},
  bridgeAssetId: {params: ['tokenChain', 'tokenAddress'], explore: 'bridge'},
  estimateFee: {params: ['shape']}, sendTransaction: {params: ['hex']}, mint: {params: ['address']},
};
export function wireName(name) { return `${RPC_NAMESPACE}_${name}`; }
export function typed(call) { /* → object with one async fn per METHODS key */ }
```

  Before finalising, confirm each parameter list against `core/vendor/fullnode/docs/rpc.md` and correct the table; the test below pins the method *set* to the node's dispatch table.

- [ ] **Step 1: Failing test:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METHODS, wireName, typed } from '../lib/rpc-methods.js';

test('covers exactly the methods the vendored node dispatches', () => {
  const src = readFileSync(new URL('../../core/vendor/fullnode/crates/shrugg-node/src/rpc.rs', import.meta.url), 'utf8');
  const node = new Set([...src.matchAll(/"(shrugg_[A-Za-z]+)"\s*(?:\||=>)/g)].map(m => m[1]));
  node.delete('shrugg_syncStatus');                       // alias of shrugg_status
  for (const gone of ['shrugg_getBalance', 'shrugg_getAccount', 'shrugg_getAssetBalance']) node.delete(gone);
  assert.deepEqual(new Set(Object.keys(METHODS).map(wireName)), node);
});
test('typed() maps positional params', async () => {
  const seen = []; const rpc = typed(async (m, p) => { seen.push([m, p]); return 1; });
  await rpc.getCommitments(10, 500);
  assert.deepEqual(seen[0], ['shrugg_getCommitments', [10, 500]]);
});
```

- [ ] **Step 2–4:** FAIL → implement; `ui/engine/rpc.js`'s hand-written list is replaced by `typed(rpc)`; `desktop/src-tauri/src/rpc.rs` gets `pub const RPC_NAMESPACE` and a `fn wire(name)`; grep confirms no other file spells `'shrugg_` except these two and tests → PASS.
- [ ] **Step 5:** Commit `rpc: one typed client for every node method`.

### Task 5.2: Explore screen

**Files:** Create `ui/screens/explore.js`, `ui/test/explore.test.mjs`.

- [ ] **Step 1: Failing test:** with a fake whose `rpc.call` answers from a fixture map: `#explore` renders cards Network (height, epoch, validators count, peers count, supply formatted in RAND), Assets (registry rows with RPL chips), Bridge (state summary), and a Lookup field; typing a 64-hex string and submitting calls `shrugg_getTransaction` then, on null, `shrugg_getBlockByHash`; typing digits calls `shrugg_getBlockByHeight`; results render as a collapsible JSON tree with copy; a rejected call renders inside its own card without breaking the others.
- [ ] **Step 2–4:** FAIL → implement (each card fetches independently with its own skeleton and error state; `#explore/bridge` scrolls to the bridge card) → PASS.
- [ ] **Step 5:** Commit `ui: explore — network, assets, bridge and lookup`.

### Task 5.3: Final verification

- [ ] `node --test ui/test web/wallet/test && node extension/test/smoke.mjs && (cd core && cargo test) && (cd desktop/src-tauri && cargo test) && core/scripts/check-rename.sh` — all pass.
- [ ] Visual pass, both themes, 360 px and ≥ 900 px, in: web wallet (Chrome), extension popup + tab (Chrome and Firefox), Tauri app. Check: focus rings visible by keyboard, no layout shift when balances load, sheets trap focus, reduced-motion honoured, long addresses wrap, amounts align.
- [ ] Desktop end-to-end against a tunnelled node: faucet → sync → send 0.1 RAND to a second wallet → appears in the recipient after sync.
- [ ] Update `README.md` (table, new `ui/` and `web/wallet/` sections, RAND wording) and the memory notes. Commit.
