# Rand Wallet for Windows, Linux and macOS

A [Tauri](https://tauri.app) app: the **shared wallet UI** (`../ui`) in a system webview, over the
**shared Rust core** (`../core/crates/wallet-core`) linked directly as a crate, no FFI.

**This is the one shell in which a transfer can actually complete.** A bundle proof peaks at about
5.7 GB and wasm32 stops at 4 GiB, so the web wallet and the browser extension do everything except
the proof itself and say so (`send.canProve()`). Here the chain crypto is native, and the only
limit is the machine's real RAM.

```
src-tauri/src/main.rs        the window, the plugins, the command list
src-tauri/src/commands.rs    core_call, system_memory_gib, app_version, storage_*
src-tauri/src/storage.rs     the JSON file and the in-process session map
src-tauri/tauri.conf.json    window, CSP, bundle targets
src-tauri/capabilities/      what the webview may ask the app for
ui-shell/                    index.html, main.js, backend-tauri.js — this shell's ~200 lines
scripts/stage-ui.sh          assembles dist-ui/ (ui/ + ui-shell/) for the webview
```

Everything else the user sees — every screen, the scanning, the note store, the JSON-RPC client,
the verified-chain gate — is `../ui` and `../ui/engine/*.js`, running unmodified and covered by
the same `node --test ui/test` suite the other shells are. There is no second implementation of
any of it here, on purpose.

## Build and run

```bash
cargo install tauri-cli --version "^2.0.0" --locked   # once
cd desktop/src-tauri
cargo tauri dev                # stages dist-ui/ and opens the window
cargo tauri build              # …and bundles a dmg / msi / AppImage / deb
cargo test                     # the commands and the store (Rust 1.98.1 via rust-toolchain.toml)
```

The first build compiles the prover and takes a few minutes. The crate is its own workspace, so
its `target/` is separate from `core/target/`.

**Build prerequisites, per OS:**

- **Linux** — the webkit2gtk and appindicator dev packages Tauri's bundler and runtime link
  against (Debian/Ubuntu names; other distros' package managers carry equivalents):
  `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`. `cargo tauri build` produces
  an AppImage and a deb.
- **Windows** — the WebView2 runtime, which the app's webview needs at run time. Nothing to
  install for `cargo tauri build` itself: the `.msi` bundler embeds a WebView2 bootstrapper, so a
  machine without it gets it installed alongside the app.
- **macOS** — Xcode Command Line Tools (`xcode-select --install`) for the linker; nothing else.
  `cargo tauri build --bundles dmg` produces the `.dmg` under
  `src-tauri/target/release/bundle/dmg/`.

`cargo tauri build` with no `--bundles` flag builds every target configured in
`tauri.conf.json` (`dmg`, `msi`, `appimage`, `deb`) that the host OS can produce; pass
`--bundles <target>` to build just one, as in the dmg command above. Every target lands under
`src-tauri/target/release/bundle/<target>/` — `bundle/dmg/`, `bundle/msi/`, `bundle/deb/`,
`bundle/appimage/` — a platform can only build its own targets, so a Linux CI runner never
produces the dmg or msi and vice versa.

## What is native, and what is not

Four commands, and nothing else crosses the boundary:

| command | why it cannot be JavaScript |
|---|---|
| `core_call(method, params)` | a passthrough to `wallet_core::call` — the prover. Runs on the **blocking pool**, never the main thread: a proof takes minutes and would otherwise freeze the window. |
| `system_memory_gib()` | a webview cannot see the machine. It is the whole of `send.canProve()`'s evidence; below 8 GiB the app refuses to start a proof rather than be killed half-way through one. |
| `storage_*` | a JSON file under the data directory: the vault, the settings, the note store. |
| `storage_session_*` | a `HashMap` in this process — where the plaintext spend key lives while unlocked, and nowhere else. |

**Not** native: HTTP. `ui/engine/rpc.js` takes an injectable `fetch` and the webview's own
satisfies it, so every JSON-RPC call goes straight from JavaScript and no node reply ever passes
through Rust. Verified empirically, not assumed: a `fetch` from the app's `tauri://localhost`
origin to a plain `http://127.0.0.1:…` node is **not** blocked as mixed content, so a tunnelled
local node (`ssh -N -L 8545:127.0.0.1:8545 root@<node>`) works with no native HTTP shim. The node
does have to answer the CORS preflight, exactly as it must for the web wallet.

## Where things live

- **Keys.** The spend key is encrypted at rest with the same password-derived vault every other
  shell uses (PBKDF2-SHA256, 600 000 iterations, AES-GCM) and stored as an opaque blob in the data
  file. This replaces the previous desktop app's plaintext-in-the-OS-keyring, which was the one
  shell that did not encrypt it. A native convenience-unlock (Keychain, Touch ID) is a possible
  future enhancement and is deliberately not built: it would be a second way to reach the key.
- **Data directory.** `~/Library/Application Support/RandWallet` (macOS), `%APPDATA%\RandWallet`
  (Windows), `~/.config/RandWallet` (Linux) — one `wallet.json`, owner-only (0600 on Unix).
- **Network.** Only the RPC URL in Settings, plus randscan.org / randprotocol.org when a link is
  clicked. `openExternal` is scoped to those two hosts in `src-tauri/capabilities/default.json`,
  so a URL from anywhere else cannot open anything.
- **Proving.** A transfer is a tier-14 STARK proved on this computer's CPU, about a minute on a
  laptop. The Send flow reports `selecting → witness → proving → submitting → confirming`, and the
  idle auto-lock waits for a transfer in flight rather than dropping the key mid-proof.
- **Window.** 1100×760, minimum 380×600 — the same two-pane breakpoint the other shells use, so
  narrowing the window below 900 px swaps the sidebar for a tab bar.

## Licence

**GPL-3.0-only**, like the rest of this repository (see the root [`LICENSE`](../LICENSE)): this
app links `wallet-core`, which vendors the fullnode's GPL-3.0-only crates directly as a Rust
crate rather than over FFI, so the same terms apply to the compiled binary and to any bundle
(`.dmg` / `.msi` / `.deb` / AppImage) built from it.
