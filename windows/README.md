# Rand Wallet — Windows

The Windows client is the native Rust desktop app in [`../desktop`](../desktop): one codebase
for Windows, Linux and macOS on the shared wallet core.

```
cd desktop && cargo run --release       # run from source
desktop\scripts\build-windows.ps1                                    # package for Windows (see desktop/README.md)
```

For every chain action the desktop app does not offer (bridge burns, staking, deploys and
confidential calls), use the `rand` command-line wallet from the fullnode repository.
