# Rand Wallet — Windows

The Windows client is the Tauri desktop app in [`../desktop`](../desktop): one codebase for
Windows, Linux and macOS — the shared wallet UI in a system webview, over the shared Rust core.
It is the one client that can prove a transfer locally.

```
cd desktop/src-tauri && cargo tauri dev     # run from source
scripts/release/build-desktop.sh            # package: .msi and -setup.exe; run it from Git Bash
```

Published builds are on the [releases page](https://github.com/randprotocol/clients/releases/latest),
with `SHA256SUMS`; the root [`README`](../README.md#download) says how to check one and what Windows
says the first time it is opened.

For every chain action the desktop app does not offer (bridge burns, staking, deploys and
confidential calls), use the `rand` command-line wallet from the fullnode repository.
