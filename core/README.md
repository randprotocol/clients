# Rand Wallet core

The one implementation of the chain's cryptography every client shares: the Poseidon2 key
hierarchy (spend key → viewing key → address), ML-KEM-768 + ChaCha20-Poly1305 envelopes, note
commitments and nullifiers, coin selection, and the STARK proof of a 2-in-2-out bundle. It is the
fullnode's own crates (`randprotocol-core`, `randprotocol-zkvm`, vendored as the submodule
`vendor/fullnode` at commit `142e1f7`, the build chain 13 runs) behind one JSON entry point.

```
crates/wallet-core   the library and its tests; `wallet_core::call(method, params_json) -> reply_json`
crates/wallet-ffi    C ABI (`rand_wallet_call`, `rand_wallet_free`) and JNI
                     (`org.randprotocol.wallet.core.NativeCore.call`); lib name `rand_wallet`
crates/wallet-wasm   wasm-bindgen `call()` for the extensions
scripts/             build-ios.sh (XCFramework), build-android.sh (.so per ABI), build-wasm.sh
vendor/circuits      randprotocol-zkvm's sibling-checkout path dependencies: the `evm-core` and
                     `sbpf-core` guest interpreters it links, plus a stub manifest for its
                     optional GPU backend, which is never compiled
```

Every reply is `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`; a panic in the prover is
caught and reported the same way. Methods and parameter shapes are documented on
`wallet_core::dispatch` in `crates/wallet-core/src/lib.rs` — including `plan_transfer` (which
notes a send will spend, and the resulting change) and `max_sendable` (the largest one-bundle
send). Nothing here does I/O: the clients fetch commitments, anchors and witnesses over JSON-RPC
and pass them in.

A transfer today moves only the native asset (RAND, asset index 0): the chain's ledger rejects any
bundle with `asset != 0`, so a registry asset ("RPL" in this wallet, index ≥ 1) cannot move between
two shielded addresses yet — `plan_transfer`, `max_sendable` and `prove_transfer` all refuse it
with the same sentence (`RPL_TRANSFER_UNAVAILABLE`). `version`'s reply carries `bundle_inputs` (2),
`rpl_transfer` and `bridge_burn` (both `false` today) so a client never hard-codes these.

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
