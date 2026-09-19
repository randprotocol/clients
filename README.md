# Rand Wallet — lightweight clients

Wallets for the Rand Protocol RAND chain (the fully shielded pool served by
[`shrugg-node`](https://github.com/randprotocol/fullnode)), one per platform, sharing one Rust core:

| client | language | directory | ships as |
|---|---|---|---|
| iOS | Swift (SwiftUI) | `ios/` | TestFlight / App Store |
| Android | Java | `android/` | Google Play (`.aab`) |
| Chrome | JavaScript, Manifest V3 | `chrome/` + `extension/` | Chrome Web Store |
| Firefox | JavaScript, Manifest V3 | `firefox/` + `extension/` | addons.mozilla.org |
| Windows, Linux, macOS | Rust (egui) | `desktop/` | .msi / tarball / .dmg |

Every client creates a wallet (spend key → viewing key → `rand1…` address), scans the
commitment tree for its own notes, proves and submits shielded transfers, asks the testnet
faucet, and hands the user the viewing key and per-transaction keys that
[randscan.org](https://randscan.org) opens confidential transactions with. Downloads are listed
at https://randprotocol.org/clients (`web/`).

Design: `docs/superpowers/specs/2026-09-13-rand-wallet-clients-design.md`.

## Why there is a Rust core

Chain 8 has no accounts and no signatures: a transfer is a 2-in-2-out bundle authorised by a
STARK proof, keys are Poseidon2 hashes, envelopes are ML-KEM-768 + ChaCha20-Poly1305. Those
primitives exist only in the fullnode's Rust crates, and a wallet that re-implemented them in
Swift, Java or JavaScript would have to be byte-identical to the node or every transfer is
refused. So `core/` vendors the fullnode crates at the chain 10 commit (`core/vendor/fullnode`,
a submodule at `a00c88c`) and exposes one JSON entry point, `call(method, params)`, that each
client wraps: an XCFramework on iOS, a `.so` on Android, WebAssembly in the browser. Everything
above that line — the RPC client, note store, scan and send flow, key storage and the UI — is
Swift, Java and JavaScript.

## Prerequisite: an RPC endpoint

Every node today binds JSON-RPC to `127.0.0.1:8545`; there is no public RPC. The clients default
to `https://rpc.randprotocol.org` and let the user change it in Settings. To make that default
real, put a reverse proxy with CORS in front of one synced node's RPC, for example with Caddy on
the node:

```
rpc.randprotocol.org {
    @rpc method POST
    header Access-Control-Allow-Origin *
    header Access-Control-Allow-Headers content-type
    @preflight method OPTIONS
    respond @preflight 204
    reverse_proxy @rpc 127.0.0.1:8545
}
```

Until then, point a client at a node you can reach (an SSH tunnel to a droplet works: `ssh -N -L
8545:127.0.0.1:8545 root@<node>` and RPC URL `http://127.0.0.1:8545`; on Android use `10.0.2.2`
from the emulator).

## Known limitation: the proof does not fit on small devices yet

A bundle proof (what authorises a transfer) peaks at about **5.6 GB of memory** on chain 8's
build, measured with `core/crates/wallet-core/examples/prove_fixture.rs`:

```bash
cd core && cargo build --release --example prove_fixture
/usr/bin/time -l target/release/examples/prove_fixture production      # macOS; Linux: /usr/bin/time -v
```

Consequences today: the browser extensions cannot prove at all (WebAssembly is capped at 4 GB;
the proof aborts with an out-of-memory error, which the Send screen explains), and phones with
less than about 8 GB of RAM will have the app terminated mid-proof (the review step warns with
the device's numbers). Every other feature — creating and importing wallets, receiving,
scanning, the faucet, activity, viewing keys and per-transaction keys for randscan.org — works
on all four clients, and the whole send path is implemented and tested against the chain's own
verifier in the core. The fix is in the prover (`randprotocol-zkvm`: it materialises every table's
low-degree extension at once); when its peak drops, update `PROVER_PEAK_MEMORY_BYTES` in
`core/crates/wallet-core/src/lib.rs` and the two mirrored constants in the mobile apps, rebuild,
and the Send flows light up unchanged. Until then, send from the `rand` command-line wallet
using the key file every client exports.

## Build

```bash
git submodule update --init                    # core/vendor/fullnode @ a00c88c
cd core && cargo test --release                # the core, including a real proof (~1 min)

core/scripts/build-wasm.sh                     # → extension/shared/core/   (installs wasm-bindgen-cli)
core/scripts/build-ios.sh                      # → ios/Frameworks/RandWalletCore.xcframework
core/scripts/build-android.sh                  # → android/app/src/main/jniLibs/ (needs an NDK)
```

Then per platform: `ios/README.md`, `android/README.md`, `chrome/README.md`, `firefox/README.md`.

Toolchain: Rust 1.98.1 (pinned in `core/rust-toolchain.toml`; rustup installs it), Xcode 16+,
JDK 17+ with Android SDK 35 and NDK 27, Node 20+.

## Repository layout

```
core/            Rust: wallet-core (library), wallet-ffi (C + JNI), wallet-wasm; vendored chain crates
ios/             xcodegen project.yml → RandWallet.xcodeproj; SwiftUI app
android/         Gradle project; Java app
extension/       the extension's code, one copy for both browsers
chrome/          Chrome manifest, packaging, store notes
firefox/         Firefox manifest, packaging, store notes
web/             the /clients page for randprotocol.org
design/          tokens.json, make-icons.py, generated icons
docs/            design spec
desktop/         Rust egui app for Windows, Linux and macOS (links wallet-core directly)
linux/ macosx/ windows/   per-OS packaging notes pointing at desktop/
```

## Status

Experimental testnet software, like the chain itself: not audited, not for real value.
