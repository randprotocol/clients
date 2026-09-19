# Rand Wallet: shared UI, Tauri desktop, web wallet, RAND/RPL — design

Date: 2026-09-19. Status: approved by the user in session; amended the same day (§11) when the
owner confirmed the fullnode is already renamed. Builds on
`2026-09-13-rand-wallet-clients-design.md`; iOS and Android get the rename of §10 and a rebuild,
no UI work.

## 1. Goal

One interface at the polish level of Phantom or MetaMask, shared by three shells:

| shell | directory | backend | can prove |
|---|---|---|---|
| Desktop (macOS, Linux, Windows) | `desktop/` — Tauri 2, still a Rust app | Tauri commands over the existing `engine.rs`, `store.rs`, `rpc.rs`, `secrets.rs`; `wallet-core` linked natively | yes |
| Chrome / Firefox extension | `extension/shared/` | the existing wasm worker, `storage.local`, AES-GCM vault | no |
| Local web wallet (new) | `web/wallet/` | the same wasm worker, IndexedDB, the same vault; served on 127.0.0.1 by `web/wallet/serve.sh` | no |

Plus: the native token is displayed as **RAND**, the wallet becomes multi-asset (**RPL** =
every registry asset with index ≥ 1), and the RPC client covers every method the node dispatches.

## 2. Constraints carried over

- A bundle proof peaks at ~5.5 GB; wasm32 has a 4 GiB address space. The extension and the web
  wallet therefore run Send up to the proving step, then say why they cannot continue and point
  at the desktop app. Nothing is simulated.
- No chain crypto outside `wallet-core`. New behaviour is a new `dispatch` method.
- The extension stays vanilla ES modules with no bundler and `script-src 'self'
  'wasm-unsafe-eval'`, so a store reviewer reads what runs. That rule now applies to `ui/`.
- The node has no balance RPC by design (`shrugg_getBalance`, `shrugg_getAccount`,
  `shrugg_getAssetBalance` return -32601). Balances are wallet-local, from the scan.
- Wire names are the node's, not ours: RPC methods stay `shrugg_*`, addresses stay `shrugg1…`,
  `shrugg_tokenInfo` still answers `SHRUGG`, and the vendored crates keep their names
  (`shrugg-core`, `shrugg-zkvm`; submodule at `03c9fb9`). Everything else is renamed — §10.

## 3. Shared UI (`ui/`)

```
ui/
  tokens.css        generated from design/tokens.json (dark default, light theme)
  base.css          reset, type scale, focus rings, motion, layout breakpoints
  components.css    buttons, sheets, tab bar / sidebar, list rows, avatars, skeletons, toasts
  app.js            mount(container, backend): hash router, theme, lock state
  backend.js        the Backend interface (JSDoc typedef) and a guard that checks an implementation
  screens/          one module per screen (below)
  lib/              format.js, qr.js, icons.js (inline SVG), assets.js (per-asset grouping)
  fonts/            Inter and JetBrains Mono, self-hosted woff2 (no network fonts: CSP)
```

`extension/shared/lib/views.js` is split into `ui/screens/*`; `format.js` and `qr.js` move to
`ui/lib/`. Each shell copies `ui/` at pack time (`chrome/pack.sh`, `firefox/pack.sh`,
`web/wallet/build.sh`, Tauri's `frontendDist`), so there is one source and no symlinks.

### 3.1 Backend interface

```
wallet:   exists() create(password) import(key, password) unlock(password) lock() info()
          viewingKey() exportSpendKey() wipe()
sync:     scan(onProgress) → {notes, activity, scannedHeight}
assets:   list() → [{index, id, symbol, decimals, balance, pending}]
send:     canProve() → {ok, reason}
          estimate({asset, to, amount}) → {fee, inputs, change}
          send({asset, to, amount}, onPhase) → {hash, txKey}
faucet:   request()
rpc:      call(method, params)            (the typed client in §5 sits on this)
settings: get() set(patch)                (rpcUrl, theme, autolockMinutes)
platform: name ('desktop' | 'extension' | 'web'), openExternal(url), copy(text)
```

Screens never touch `chrome.*`, Tauri or IndexedDB directly.

### 3.2 Screens

Onboarding: welcome → create or import → password → backup check (re-enter 4 characters of the
key) → done. Lock. Home: aurora balance hero (total in RAND), round actions Receive / Send /
Faucet / Bridge-state, asset list, recent activity. Asset detail: balance, notes, activity for
that asset. Activity: grouped by day, filter by asset. Transaction and note detail, with the
per-transaction key and a randscan.org link. Receive: QR + address. Send: asset → recipient →
amount → review → proving (phase ring, elapsed time) → sent; on a shell where
`canProve().ok` is false the review step ends in the explanation instead of a Prove button.
Explore: §5. Settings: RPC URL + test, theme, auto-lock, viewing key, export, wipe.

### 3.3 Layout and look

- < 900 px (popup 360×600, narrow windows): single column, bottom tab bar Home / Activity /
  Explore / Settings, flows as bottom sheets.
- ≥ 900 px (desktop, web): left sidebar, content pane + detail pane, flows as centred modals.
- Aurora gradient only on the balance hero and the primary action. Radius, spacing and colours
  from `design/tokens.json`; tabular numerals for amounts; mono for keys and hashes.
- Motion 150–250 ms ease-out, disabled under `prefers-reduced-motion`. Skeletons while
  scanning. 44 px targets, visible focus, WCAG AA contrast in both themes.

## 4. Shells

**Desktop.** `desktop/src-tauri/` (Tauri 2). `ui.rs`, `theme.rs` and the eframe/egui
dependencies go; `engine.rs`, `store.rs`, `rpc.rs`, `secrets.rs` stay and are called from
`commands.rs`, one command per Backend method. Engine `Event`s are forwarded as Tauri events for
scan progress and proving phases. The spend key stays in the OS keyring; the password gate on
desktop unlocks the keyring entry as today. CSP: `default-src 'self'`; the webview makes no
network calls — RPC goes through Rust. Bundles: .dmg, .msi, .AppImage/.deb via `cargo tauri
build`; `macosx/`, `linux/`, `windows/` READMEs are updated.

**Extension.** `popup.html` and `app.html` mount `ui/app.js` with `backend-extension.js`
(today's `wallet.js`, `store.js`, `crypto.js`, `core.js` behind the interface). Send still opens
in a tab.

**Web wallet.** `web/wallet/index.html` mounts the same app with `backend-web.js`: IndexedDB
for the vault and note store, the unlocked key held in memory only, the wasm core in a Worker.
`serve.sh` serves the built directory on `127.0.0.1:8787` with the right wasm MIME type and
`Cross-Origin-Opener-Policy`/`Embedder-Policy` headers. Static, so it can be hosted later.

## 5. RPC coverage

`ui/lib/rpc-methods.js` names all 27 dispatched methods with their parameter shapes; the Rust
`rpc.rs` gains the same set. Wallet flows use the 15 already in use plus `shrugg_getAssets`,
`shrugg_tokenInfo`, `shrugg_getReceipt`. Explore surfaces the read-only rest: supply, assets,
validators, epoch, peers, status, block by height/hash, transaction/receipt lookup, program and
call-envelope lookup, bridge state and burns.

## 6. RAND and RPL in the core

- `token_symbol` and user-facing strings in `wallet-core` say RAND; identifiers imported from
  the vendored crates (`UNITS_PER_SHRUGG`, …) are re-exported under RAND names
  (`UNITS_PER_RAND`) at the top of `wallet-core` so our code never spells the old one. Clients
  stop hard-coding the symbol and read it from `version`.
- `scan_page` already returns `asset` per note; `assets.list()` groups by it and joins
  `shrugg_getAssets` for symbol and decimals.
- `prove_transfer` accepts `asset`. For `asset == 0` nothing changes. For `asset ≥ 1` it
  builds the two-bundle transaction the ledger requires: a RAND fee bundle (asset 0, pays the
  fee) and an asset bundle (`fee = 0`), proving them one after the other (~2 × 95 s, 5.5 GB peak
  each, not concurrent). `select_inputs` is called once per asset. The exact action variant is
  taken from `shrugg-client`'s asset transfer path in the vendored node; if chain 8 at
  `03c9fb9` only admits asset bundles inside `BridgeBurn`, plain RPL transfers are reported as
  unsupported by this network and the UI shows that state — this is verified first in the plan.

## 7. Errors

RPC unreachable → inline banner with Retry and a link to Settings. Wrong password → field
error, no lockout. Proving failure → the existing `explainProvingError` mapping, extended with
the out-of-memory case. A shell that cannot prove never offers the Prove button.

## 8. Testing

Core: unit tests for RAND strings and the asset transfer request builder (fixture profile).
UI: `node --test` over screens with a fake Backend (routing, send steps, canProve gating, asset
grouping, amount formatting). Extension: `extension/test/smoke.mjs` extended. Desktop: Rust
tests for each command against a stub RPC. Finally a manual pass of all three shells in both
themes at 360 px and ≥ 900 px.

## 9. Build order

0. The shrugg → rand rename (§10), first, so nothing new is written under the old name.
1. `ui/` + web wallet (fastest visual loop). 2. Extension on `ui/`. 3. Tauri desktop.
4. Multi-asset balances, RPL transfer. 5. Explore tab and the full RPC set.

## 10. Rename: shrugg → rand

Everything this repository owns (69 files today) is renamed; nothing on the wire is.

| what | from | to |
|---|---|---|
| display symbol, prose, error strings | `SHRUGG` | `RAND` |
| FFI/wasm/JNI library and header | `shrugg_wallet`, `libshrugg_wallet.{a,so}`, `shrugg_wallet.h`, `shrugg_wallet{.js,_bg.wasm}`, `SHRUGG_WALLET_*` | `rand_wallet`, … , `RAND_WALLET_*` |
| iOS framework and wrapper | `ShruggWalletCore.xcframework`, `ShruggCore.swift` | `RandWalletCore.xcframework`, `RandCore.swift` |
| Android | `System.loadLibrary("shrugg_wallet")` and JNI symbol names | `rand_wallet` |
| our identifiers, comments, READMEs, STORE notes, `web/clients.astro`, `design/tokens.json` | `shrugg…` | `rand…` |

Kept, because the node at `03c9fb9` defines them and a client that changes them alone stops
working: the `shrugg_` RPC namespace, the `shrugg1` address prefix, test vectors containing
such addresses, the `shrugg-node` binary name where docs tell the user to run it, and the
vendored crate names in `Cargo.toml`. Each lives in exactly one place per language —
`RPC_NAMESPACE` and `ADDRESS_HRP` in `wallet-core` (returned by `version`), mirrored once in
`ui/lib/rpc-methods.js`, `desktop/src/rpc.rs`, Swift and Java — so the day the fullnode renames,
the client change is those constants and a submodule bump.

Native artefacts are rebuilt with `core/scripts/build-{wasm,ios,android}.sh` after the rename;
iOS and Android get the rename and a rebuild only, no UI work. Verification: `grep -ri shrugg`
over our tree returns only the kept items above; core tests, the extension smoke test, the
desktop build, `xcodebuild` and `gradlew assembleDebug` pass.

## 11. Amendment: the node is already RAND (supersedes §2's last bullet and §10's "Kept")

Fullnode `main` (142e1f7) carries upstream commit ed96c39, "rename: SHRUGG/SESH → RAND,
everywhere": crates `randprotocol-{core,zkvm,client,node,rvm}`, binary `rand-node`, RPC namespace
`rand_`, address prefix `rand1`, new hash domains. The owner's instruction: no "shrugg" anywhere
in this repository, in any case, including crate, file and directory names.

So the submodule moves from `03c9fb9` to `main`, `wallet-core` is ported to the renamed crates,
every client calls `rand_<method>` and validates `rand1…`, `RPC_NAMESPACE = "rand"`,
`ADDRESS_HRP = "rand1"`, the default chain id is 13 (the testnet `deploy/README.md` names at that commit; chains 10–12
were cut and retired between the rename and today), and `core/scripts/check-rename.sh` allows
nothing (only the inline `rename-guard: allow` marker, and these design records, are exempt).
Wherever §3–§9 write `shrugg_…` or `shrugg1…`, read `rand_…` and `rand1…`. Keys and addresses
made on chain 8 do not carry over: the hash domains changed.

`main` also has RPC methods chain 8 lacked (`rand_getCompactBlocks`, `rand_getWitnesses`,
`rand_getTransactionStatus`, `rand_getHealth`, `rand_getFinality`, `rand_getEmission`,
`rand_getMempoolInfo`, `rand_getLimits`, `rand_getVersion`, …). §5's "every method the node
dispatches" now means that larger set; the count is taken from the node's source by the test,
not written here.

Open, for the owner: upstream is now `GPL-3.0-only`; this repository declares Apache-2.0 and
links those crates into every binary it ships.
