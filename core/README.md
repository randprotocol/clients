# Rand Wallet core

The one implementation of the chain's cryptography every client shares: the Poseidon2 key
hierarchy (spend key → viewing key → address), ML-KEM-768 + ChaCha20-Poly1305 envelopes, note
commitments and nullifiers, coin selection, and the STARK proof of a 2-in-2-out bundle. It is the
fullnode's own crates (`shrugg-core`, `shrugg-zkvm`, vendored as the submodule `vendor/fullnode`
at commit `03c9fb9`, the build chain 8 runs) behind one JSON entry point.

```
crates/wallet-core   the library and its tests; `wallet_core::call(method, params_json) -> reply_json`
crates/wallet-ffi    C ABI (`shrugg_wallet_call`, `shrugg_wallet_free`) and JNI
                     (`org.randprotocol.wallet.core.NativeCore.call`); lib name `shrugg_wallet`
crates/wallet-wasm   wasm-bindgen `call()` for the extensions
scripts/             build-ios.sh (XCFramework), build-android.sh (.so per ABI), build-wasm.sh
vendor/circuits      a stub manifest for shrugg-zkvm's optional GPU dependency; never compiled
```

Every reply is `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`; a panic in the prover is
caught and reported the same way. Methods and parameter shapes are documented on
`wallet_core::dispatch` in `crates/wallet-core/src/lib.rs`. Nothing here does I/O: the clients
fetch commitments, anchors and witnesses over JSON-RPC and pass them in.

```bash
cargo test --release            # includes a full proved transfer checked by the chain's verifier
scripts/build-ios.sh            # needs Xcode; rustup targets are added on demand
scripts/build-android.sh        # needs ANDROID_NDK_HOME (or an NDK under $ANDROID_HOME/ndk)
scripts/build-wasm.sh           # cargo `wasm` profile + wasm-bindgen-cli (installed on demand)
```

Toolchain 1.98.1 is pinned (`rust-toolchain.toml`), the same as the fullnode. Release builds use
fat LTO; the iOS static library is about 8 MB, the wasm a few MB.

To move to a new chain build: `cd vendor/fullnode && git fetch && git checkout <rev>`, update
`CHAIN_BUILD`/`DEFAULT_CHAIN_ID` in `wallet-core`, run the tests, rebuild the three targets.
