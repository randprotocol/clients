# Rand Wallet — lightweight clients

Wallets for the Rand Protocol RAND chain (the fully shielded pool served by
[`rand-node`](https://github.com/randprotocol/fullnode)), one per platform, sharing one Rust core:

| client | language | directory | ships as | can send |
|---|---|---|---|---|
| iOS | Swift (SwiftUI) | `ios/` | TestFlight / App Store | on a device with about 8 GB of memory; otherwise through a paired prover over TLS |
| Android | Java | `android/` | Google Play (`.aab`) | on a device with about 8 GB of memory; otherwise through a paired prover over TLS |
| Chrome | JavaScript, Manifest V3 | `chrome/` + `extension/` | Chrome Web Store | through a paired prover |
| Firefox | JavaScript, Manifest V3 | `firefox/` + `extension/` | addons.mozilla.org | through a paired prover |
| Windows, Linux, macOS | Tauri (shared UI + Rust core) | `desktop/` | .msi / .deb / AppImage / .dmg | yes, and proves for your other wallets |
| Local web wallet | JavaScript (shared UI + WebAssembly core) | `web/wallet/` + `ui/` | nothing — served from a checkout | through a paired prover |

The two extensions, the desktop app and the local web wallet share more than the core: `ui/` is one
copy of the whole interface — the screens, the app shell and router, the design tokens, and
`ui/engine/` (the vault, the JSON-RPC client and the scan/send orchestration). Each of them is only
a shell around it, saying how to store a key and how to reach the core. iOS and Android have their
own native UIs over the same `core/`.

Every client creates a wallet (spend key → viewing key → `rand1…` address), scans the
commitment tree for its own notes, asks the testnet faucet, and hands the user the viewing key
and per-transaction keys that [randscan.org](https://randscan.org) opens confidential
transactions with. The shells that can fit a proof in memory — the desktop app and the mobile
apps — also prove and submit shielded transfers of RAND and of any listed RPL token; the browser
extension and the web wallet build and submit the same transfers but have the proof made by a
prover you pair — the desktop app on the same machine, or your own `rand-prover` (see the known
limitation below and [`docs/prover.md`](docs/prover.md)); a phone without the memory can pair your
own `rand-prover` too, reached over https. Downloads are listed at https://randprotocol.org/clients (`web/`).

Design: `docs/superpowers/specs/2026-09-13-rand-wallet-clients-design.md`.

## Why there is a Rust core

Chain 14 has no accounts and no signatures: a transfer is a 2-in-2-out bundle authorised by a
STARK proof, keys are Poseidon2 hashes, envelopes are ML-KEM-768 + ChaCha20-Poly1305. Those
primitives exist only in the fullnode's Rust crates, and a wallet that re-implemented them in
Swift, Java or JavaScript would have to be byte-identical to the node or every transfer is
refused. So `core/` vendors the fullnode crates (`core/vendor/fullnode`,
a submodule at `e6d1327`, fullnode's delegated-proving branch (v0.6 + constraint set 7); TODO(v0.6.2): re-pin to fullnode's v0.6.2 tag when it is released — the tag does not exist yet) and exposes one JSON entry point, `call(method, params)`, that each
client wraps: an XCFramework on iOS, a `.so` on Android, WebAssembly in the browser. Everything
above that line — the RPC client, note store, scan and send flow, key storage and the UI — is
Swift, Java and JavaScript.

## Prerequisite: an RPC endpoint

The public endpoint is **`https://rpc.randprotocol.org`** — a synced chain-14 node behind a
CORS-open reverse proxy, and the default in every client. Settings keeps one editable "RPC URL"
that replaces it while filled in (a saved URL is probed before it is kept: an unreachable or
wrong-chain node is refused rather than saved); clearing the field goes back to the default.

More public endpoints are planned (`rpc1`/`rpc2`/`rpc3.randprotocol.org`), and the clients
already fail over between whatever set they ship with — standing them up one at a time needs no
client change. To run one, put a reverse proxy with CORS in front of one synced node's RPC
(every node binds JSON-RPC to `127.0.0.1:8545`).
[`docs/rpc-endpoints.md`](docs/rpc-endpoints.md) is the whole recipe — Caddy, CORS, POST-only,
request-size and rate limits, and what to front. The short version:

```
rpc1.randprotocol.org {
    @rpc method POST
    header Access-Control-Allow-Origin *
    header Access-Control-Allow-Headers content-type
    @preflight method OPTIONS
    respond @preflight 204
    reverse_proxy @rpc 127.0.0.1:8545
}
```

To use your own node instead, point a client at one you can reach (an SSH tunnel to a droplet
works: `ssh -N -L 8545:127.0.0.1:8545 root@<node>` and RPC URL `http://127.0.0.1:8545`; on
Android use `10.0.2.2` from the emulator).

## Known limitation: the proof does not fit on small devices yet

A bundle proof (what authorises a transfer — of RAND, of an RPL token, or a bridge burn; on
chain 14 they are all the same one proof) peaks at about **5.7 GB of memory** on chain 14's
build, measured with `core/crates/wallet-core/examples/prove_fixture.rs`:

```bash
cd core && cargo build --release --example prove_fixture
/usr/bin/time -l target/release/examples/prove_fixture production      # macOS; Linux: /usr/bin/time -v
```

Consequences today, per shell: the desktop app proves natively and sends everything; the browser
extensions and the local web wallet cannot prove for themselves (WebAssembly is capped at 4 GB), so
they prove through a paired prover — the desktop app on the same machine (Settings → **Prove for
my other devices**), or your own `rand-prover` on a server — and without one the Send screen
explains the wall. A prover in this release receives the wallet's spend key with every job, so pair
only a machine you run yourself; [`docs/prover.md`](docs/prover.md) is the whole guide. Phones with less than
about 8 GB of RAM will have the app terminated mid-proof (the review step warns with the device's
numbers) unless they pair your own `rand-prover` over https (Settings → Prover,
[`docs/prover.md`](docs/prover.md) §6). Every other feature — creating and importing wallets, receiving, scanning, the faucet,
activity, viewing keys and per-transaction keys for randscan.org — works on all five shells
(iOS, Android, the browser extension, the desktop app and the web wallet), and the whole send
path is implemented and tested against the chain's own verifier in the core. The fix is in the
prover (`randprotocol-zkvm`: it materialises every table's low-degree extension at once); when
its peak drops, update `PROVER_PEAK_MEMORY_BYTES` in `core/crates/wallet-core/src/lib.rs` and
the two mirrored constants in the mobile apps, rebuild, and the Send flows light up unchanged.
Until then, a phone without the memory sends through a paired prover of your own, or from the
desktop app or the `rand` command-line wallet using the key file every client exports.

## Build

```bash
git submodule update --init                    # core/vendor/fullnode @ e6d1327
cd core && cargo test --release                # the core, including a real proof (~1 min)

core/scripts/build-wasm.sh                     # → extension/shared/core/   (installs wasm-bindgen-cli)
core/scripts/build-ios.sh                      # → ios/Frameworks/RandWalletCore.xcframework
core/scripts/build-android.sh                  # → android/app/src/main/jniLibs/ (needs an NDK)

node --test ui/test web/wallet/test            # the shared UI and the web wallet
web/wallet/serve.sh                            # the local web wallet at http://127.0.0.1:8787/
```

Then per platform: `ios/README.md`, `android/README.md`, `chrome/README.md`, `firefox/README.md`,
`desktop/README.md`, `web/wallet/README.md`.

Toolchain: Rust 1.98.1 (pinned in `core/rust-toolchain.toml`; rustup installs it), Xcode 16+,
JDK 17+ with Android SDK 35 and NDK 27, Node 20+.

## Repository layout

```
core/            Rust: wallet-core (library), wallet-ffi (C + JNI), wallet-wasm; vendored chain crates
ui/              the shared interface, one copy for every JavaScript client: screens/, the app shell
                 and router (app.js), design tokens and CSS, lib/ helpers, and engine/ — the vault,
                 the JSON-RPC client and the scan/send orchestration. gallery.html and dev.html run
                 it against a fake backend; test/ is its suite (node --test ui/test)
ios/             xcodegen project.yml → RandWallet.xcodeproj; SwiftUI app
android/         Gradle project; Java app
extension/       the extension's code, one copy for both browsers
chrome/          Chrome manifest, packaging, store notes
firefox/         Firefox manifest, packaging, store notes
web/             the /clients page for randprotocol.org
web/wallet/      the local web wallet: index.html and main.js (the shell), worker.js (the wasm core
                 off the UI thread), idb.js (IndexedDB, and a Map for what must never be written),
                 and serve.mjs — a loopback-only static server. Built and served by serve.sh from a
                 checkout; it is not deployed anywhere, and it sends only through a paired prover
                 (docs/prover.md)
design/          tokens.json, make-icons.py, generated icons
docs/            prover.md (proving through your own prover), rpc-endpoints.md, design specs
desktop/         Tauri app for Windows, Linux and macOS: ui/ in a webview, wallet-core linked
                 directly — the one client that can prove a transfer locally, and a prover for
                 the extension and the web wallet on the same machine
linux/ macosx/ windows/   per-OS packaging notes pointing at desktop/
```

## Status

Experimental testnet software, like the chain itself: not audited, not for real value.

## Licence

This repository is **GPL-3.0-only**; the full text is in [`LICENSE`](LICENSE). Every client links
the fullnode's crates, which are GPL-3.0-only, so the wallets that link them are too.
Third-party components keep their own licences: the Inter and JetBrains Mono fonts in `ui/fonts/`
are under the SIL Open Font License 1.1, and the vendored node and circuits crates under
`core/vendor/` stay under their own terms.
