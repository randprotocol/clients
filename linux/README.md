# Rand Wallet — Linux

The Linux client is the Tauri desktop app in [`../desktop`](../desktop): one codebase for
Windows, Linux and macOS — the shared wallet UI in a system webview, over the shared Rust core.
It is the one client that can prove a transfer locally.

```
cd desktop/src-tauri && cargo tauri dev     # run from source
scripts/release/build-desktop.sh            # package: AppImage, .deb, .rpm and a .tar.gz of the bare binary
```

Published builds are on the [releases page](https://github.com/randprotocol/clients/releases/latest),
with `SHA256SUMS`; the root [`README`](../README.md#download) says how to check one and what Linux
says the first time it is opened.

The `.tar.gz` is for a distribution the three packages do not fit; [`INSTALL`](INSTALL) is the
file inside it that says where things go. The app is the same interface the browser extension
shows (`../ui`), in a native window.

For every chain action the desktop app does not offer (bridge burns, staking, deploys and
confidential calls), use the `rand` command-line wallet from the fullnode repository.
