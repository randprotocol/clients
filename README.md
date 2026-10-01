# Rand Wallet — lightweight clients

Wallets for the Rand Protocol RAND chain (the fully shielded pool served by
[`rand-node`](https://github.com/randprotocol/fullnode)), one per platform, sharing one Rust core:

| client | language | directory | ships as | can send |
|---|---|---|---|---|
| iOS | Swift (SwiftUI) | `ios/` | TestFlight / App Store | on a device with about 8 GB of memory; otherwise through a paired prover over TLS |
| Android | Java | `android/` | Google Play (`.aab`) | on a device with about 8 GB of memory; otherwise through a paired prover over TLS |
| Chrome | JavaScript, Manifest V3 | `chrome/` + `extension/` | Chrome Web Store | through a paired prover |
| Firefox | JavaScript, Manifest V3 | `firefox/` + `extension/` | addons.mozilla.org | through a paired prover |
| Windows, Linux, macOS | Tauri (shared UI + Rust core) | `desktop/` | .msi / .AppImage, .deb, .rpm, .tar.gz / .dmg | yes, and proves for your other wallets |
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
extension and the web wallet build, authorise and submit the same transfers but have the bundle
proof made by a prover you pair — the desktop app on the same machine, or a `rand-prover` (see the
known limitation below and [`docs/prover.md`](docs/prover.md)); a phone without the memory can
pair a `rand-prover` too, reached over https. Downloads are listed at https://randprotocol.org/clients (`web/`).

Design: `docs/superpowers/specs/2026-09-13-rand-wallet-clients-design.md`.

## Download

Every release is on [GitHub Releases](https://github.com/randprotocol/clients/releases/latest),
and https://randprotocol.org/clients links the same files with their checksums. `<v>` below is
the version, `0.6.8` today.

| you have | download | then |
|---|---|---|
| macOS, Apple silicon | `rand-wallet-<v>-macos-arm64.dmg` | open it, drag Rand Wallet to Applications |
| macOS, Intel | `rand-wallet-<v>-macos-x64.dmg` | the same |
| Windows 10 or 11 | `rand-wallet-<v>-windows-x64.msi` | run it; `…-windows-x64-setup.exe` is the same app in an `.exe` installer |
| Debian, Ubuntu | `rand-wallet-<v>-linux-x86_64.deb` | `sudo apt install ./rand-wallet-<v>-linux-x86_64.deb` |
| Fedora, openSUSE | `rand-wallet-<v>-linux-x86_64.rpm` | `sudo dnf install ./rand-wallet-<v>-linux-x86_64.rpm` |
| any other Linux | `rand-wallet-<v>-linux-x86_64.AppImage` | `chmod +x` it and run it |
| a Linux none of those fit | `rand-wallet-<v>-linux-x86_64.tar.gz` | the bare binary; its `INSTALL` says where the files go |
| Linux on arm64 | the same four, named `…-linux-arm64.…` | |
| Chrome, Edge, Brave | `rand-wallet-chrome-<v>.zip` | unzip; `chrome://extensions` → Developer mode → Load unpacked |
| Firefox | `rand-wallet-firefox-<v>.zip` | `about:debugging` → This Firefox → Load Temporary Add-on… → the zip |
| Android 8 or later | `rand-wallet-<v>-android.apk` | open it on the phone and allow the install, or `adb install` |
| to build it yourself | `rand-wallet-<v>-source.tar.gz` | this repository and the submodule in one archive; see Build from source |

The Linux desktop app is the same interface the browser extension shows — one `ui/` directory
drives both — in a native window, and it is the one that proves.

iOS has no download: Apple installs an app only from the App Store or TestFlight, and the
listing is pending. Until then build it in Xcode (below). The store listings for Android, Chrome
and Firefox are pending as well; the files above are the same builds that are submitted.

### Check what you downloaded

`SHA256SUMS` is attached to every release. Download it next to the file and compare:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing     # macOS
sha256sum -c SHA256SUMS --ignore-missing         # Linux
```
```powershell
Get-FileHash .\rand-wallet-0.6.8-windows-x64.msi -Algorithm SHA256   # Windows: compare with the line in SHA256SUMS
```

A matching sum says the file is the one that was published. It does not say the file was built
from this source: the builds are not bit-for-bit reproducible yet, so if that is the question
you are asking, build it yourself.

### What your OS will say

Nothing here is signed with a paid developer certificate yet, and each OS says so in its own
words. None of these messages is about the file being damaged; check the sum, then:

- **macOS** — the app is ad-hoc signed and not notarised, so the first launch says Apple could
  not verify it. Open **System Settings → Privacy & Security**, scroll to the message about Rand
  Wallet and choose **Open Anyway**; or remove the quarantine flag yourself:
  `xattr -dr com.apple.quarantine "/Applications/Rand Wallet.app"`.
- **Windows** — SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**.
  The installer adds the WebView2 runtime if the machine does not have it.
- **Android** — the `.apk` is signed with this project's upload key (certificate SHA-256
  `75:22:2E:BF:22:D3:95:80:A5:11:2A:AC:B7:EC:2E:03:93:91:07:77:96:E0:45:1D:7B:CF:E3:7E:FA:06:53:52`);
  the phone asks you to allow installs from the app you opened it with. A later install from
  Google Play is signed by Play's own key, so Android will ask you to remove this one first —
  export your key file from Settings before you do.
- **Firefox** — a temporary add-on is removed when Firefox restarts; release Firefox installs
  permanently only what addons.mozilla.org has signed.

## Why there is a Rust core

Chain 14 has no accounts and no signatures: a transfer is a 2-in-2-out bundle authorised by a
STARK proof, keys are Poseidon2 hashes, envelopes are ML-KEM-768 + ChaCha20-Poly1305. Those
primitives exist only in the fullnode's Rust crates, and a wallet that re-implemented them in
Swift, Java or JavaScript would have to be byte-identical to the node or every transfer is
refused. So `core/` vendors the fullnode crates (`core/vendor/fullnode`,
a submodule at fullnode's `v0.6.7` tag, `86941a1` — the build chains 18 and 19 run: **constraint set 8**, whose proofs carry a declared gas limit and verify on no earlier chain, and **split authorisation**, where a transaction carries a bundle proof made from the viewing key and a small authorisation proof the wallet always makes itself from the spend key) and exposes one JSON entry point, `call(method, params)`, that each
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
chain 14 they are all the same one proof) peaks at about **6.2 GB of memory** on chain 14's
build, measured with `core/crates/wallet-core/examples/prove_fixture.rs`:

```bash
cd core && cargo build --release --example prove_fixture
/usr/bin/time -l target/release/examples/prove_fixture production      # macOS; Linux: /usr/bin/time -v
```

Consequences today, per shell: the desktop app proves natively and sends everything; the browser
extensions and the local web wallet cannot prove for themselves (WebAssembly is capped at 4 GB), so
they prove through a paired prover — the desktop app on the same machine (Settings → **Prove for
my other devices**), or your own `rand-prover` on a server — and without one the Send screen
explains the wall. A prover receives the wallet's viewing key and a one-time salt with every job —
it can read that wallet's whole history and cannot spend; the spend key stays on the device, which
makes the small authorisation proof itself — so it need not be yours, though running your own is
what keeps your history to yourself; [`docs/prover.md`](docs/prover.md) is the whole guide. Phones with less than
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

## Build from source

Everything that is published is built from this repository by the commands below. Pick the
client you want; each one starts from the same checkout.

### 1. What to install first

| for | you need |
|---|---|
| every client | `git`; [rustup](https://rustup.rs) (it installs Rust 1.98.1, the version pinned in `core/rust-toolchain.toml`, the first time `cargo` runs here); Node 22 or later |
| desktop, any OS | `cargo install tauri-cli --version "^2" --locked` |
| desktop on Linux | `sudo apt install build-essential libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm file` (Debian and Ubuntu names; other distributions carry equivalents) |
| desktop on Windows | Visual Studio Build Tools with "Desktop development with C++"; Git for Windows, whose Git Bash runs the scripts |
| desktop on macOS | Xcode Command Line Tools: `xcode-select --install` |
| Chrome, Firefox, the web wallet | nothing more: the build installs `wasm-bindgen-cli` itself |
| Android | JDK 17 or later; the Android SDK with platform 36, build-tools 36 and NDK 27 (`sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;27.2.12479018"`) |
| iOS | a Mac with Xcode 16 or later |

The first build of any client compiles the prover and takes several minutes.

### 2. Get the source

```bash
git clone --recurse-submodules https://github.com/randprotocol/clients.git
cd clients
git checkout v0.6.8 && git submodule update --init   # a release, rather than main
```

or unpack `rand-wallet-<v>-source.tar.gz` from a release, which has the submodule in it already.
The submodule is the full node (`core/vendor/fullnode`, at its `v0.6.7` tag): the wallet's
cryptography is the node's own code.

### 3. Test the core (optional, about a minute)

```bash
cd core && cargo test --release && cd ..      # includes a real proof, checked by the chain's verifier
```

### 4. Build the client you want

**Desktop — Linux, Windows, macOS**

```bash
scripts/release/build-desktop.sh              # → dist/release/v<version>/
```

It builds the packages of the OS it runs on, under the names the releases use: on Linux an
AppImage, a `.deb`, an `.rpm` and the bare binary in a `.tar.gz`; on Windows (from Git Bash) the
`.msi` and the `-setup.exe`; on macOS the `.dmg`. `--target x86_64-apple-darwin` builds the Intel
dmg on an Apple-silicon Mac. To run it without packaging anything:

```bash
cd desktop/src-tauri && cargo tauri dev
```

[`desktop/README.md`](desktop/README.md) has the details.

**Chrome and Firefox extensions**

```bash
core/scripts/build-wasm.sh                    # the core as WebAssembly → extension/shared/core/
chrome/pack.sh                                # → dist/chrome/  and dist/rand-wallet-chrome-<version>.zip
firefox/pack.sh                               # → dist/firefox/ and dist/rand-wallet-firefox-<version>.zip
```

Load `dist/chrome` with **Load unpacked** at `chrome://extensions` (Developer mode on), or
`dist/firefox/manifest.json` with **Load Temporary Add-on…** at `about:debugging`.
[`chrome/README.md`](chrome/README.md), [`firefox/README.md`](firefox/README.md).

**Android**

```bash
core/scripts/build-android.sh                 # the core → android/app/src/main/jniLibs/
cd android
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties   # wherever your SDK is
./gradlew assembleDebug                       # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

A release build (`./gradlew bundleRelease assembleRelease`) is signed with your own key:
[`android/README.md`](android/README.md).

**iOS**

```bash
core/scripts/build-ios.sh                     # the core → ios/Frameworks/RandWalletCore.xcframework
open ios/RandWallet.xcodeproj                 # choose a simulator or your own device, then Run
```

Running on your own iPhone needs your Apple ID in Xcode → Settings → Accounts and your team
selected under Signing & Capabilities. [`ios/README.md`](ios/README.md).

**The local web wallet**

```bash
web/wallet/serve.sh                           # builds, then serves http://127.0.0.1:8787/
```

[`web/wallet/README.md`](web/wallet/README.md).

### 5. Run the tests

```bash
npm ci --prefix ui
node --test "ui/test/**/*.test.mjs" "web/wallet/test/**/*.test.mjs" "extension/test/*.test.mjs"
                                                     # the shared interface, the web wallet, the extension
cd desktop/src-tauri && cargo test                   # the desktop app's own crate
cd android && ./gradlew testDebugUnitTest            # Android
```

### How a release is made

`scripts/release/` holds the whole release build, and the three places it runs use the same
scripts:

- `.github/workflows/release.yml` — on a `v*` tag, GitHub's runners build the desktop app for
  macOS (arm64, x64), Windows and Linux (x86_64, arm64), both extension zips and the source
  tarball, and attach them to a draft release with `SHA256SUMS`.
- `Jenkinsfile` — the same pipeline for a Jenkins with agents labelled `linux`, `macos` and
  `windows`, as a backup.
- `scripts/release/build-local.sh` — on a Mac: the extension zips, the dmg, the signed Android
  `.aab` and `.apk`, an unsigned iOS archive and the source tarball. Android and iOS are built
  only here, because their signing keys are in no CI.

`scripts/release/checksums.sh <tag> [files…]` attaches more files to a release and rewrites
`SHA256SUMS` over everything in it. What each store then needs — the listing text, the review
notes, the privacy answers — is [`docs/store/README.md`](docs/store/README.md).

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
web/             the icon for the randprotocol.org /clients pages (the pages themselves live in
                 that repository: web/README.md), and wallet/ below
web/wallet/      the local web wallet: index.html and main.js (the shell), worker.js (the wasm core
                 off the UI thread), idb.js (IndexedDB, and a Map for what must never be written),
                 and serve.mjs — a loopback-only static server. Built and served by serve.sh from a
                 checkout; it is not deployed anywhere, and it sends only through a paired prover
                 (docs/prover.md)
design/          tokens.json, make-icons.py, generated icons
docs/            prover.md (proving through a prover), rpc-endpoints.md, design specs
desktop/         Tauri app for Windows, Linux and macOS: ui/ in a webview, wallet-core linked
                 directly — the one client that can prove a transfer locally, and a prover for
                 the extension and the web wallet on the same machine
linux/ macosx/ windows/   per-OS packaging notes pointing at desktop/
scripts/release/ the release build: build-desktop.sh, build-local.sh, source-tarball.sh,
                 checksums.sh — run by .github/workflows/release.yml, by the Jenkinsfile, and by hand
docs/store/      what each store upload needs: listing text, review notes, privacy answers
PRIVACY.md       the privacy policy the store listings link to
```

## Status

Experimental testnet software, like the chain itself: not audited, not for real value.

## Licence

This repository is **GPL-3.0-only**; the full text is in [`LICENSE`](LICENSE). Every client links
the fullnode's crates, which are GPL-3.0-only, so the wallets that link them are too.
Third-party components keep their own licences: the Inter and JetBrains Mono fonts in `ui/fonts/`
are under the SIL Open Font License 1.1, and the vendored node and circuits crates under
`core/vendor/` stay under their own terms.
