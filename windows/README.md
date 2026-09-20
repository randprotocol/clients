# Rand Wallet — Windows

The Windows client is the Tauri desktop app in [`../desktop`](../desktop): one codebase for
Windows, Linux and macOS — the shared wallet UI in a system webview, over the shared Rust core.
It is the one client that can prove a transfer locally.

```
cd desktop/src-tauri && cargo tauri dev     # run from source
cd desktop/src-tauri && cargo tauri build   # package (msi) — see desktop/README.md
```

For every chain action the desktop app does not offer (bridge burns, staking, deploys and
confidential calls), use the `rand` command-line wallet from the fullnode repository.
