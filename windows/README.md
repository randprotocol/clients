# Rand Wallet — Windows

The Windows client is the Tauri desktop app in [`../desktop`](../desktop): one codebase for
Windows, Linux and macOS — the shared wallet UI in a system webview, over the shared Rust core.
It proves transfers on this computer where it has the memory (8 GiB or more); elsewhere the
RandProtocol provers prove them by default, as in every other client.

```
cd desktop/src-tauri && cargo tauri dev     # run from source
scripts/release/build-desktop.sh            # package: .msi and -setup.exe; run it from Git Bash
```

Published builds are on the [releases page](https://github.com/randprotocol/clients/releases/latest),
with `SHA256SUMS`; the root [`README`](../README.md#download) says how to check one and what Windows
says the first time it is opened.

The desktop app sends, swaps, withdraws over the bridge (burns) and makes confidential program
calls. For staking and deploys, use the `rand` command-line wallet from the fullnode repository.
