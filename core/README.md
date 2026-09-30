# Rand Wallet core

The one implementation of the chain's cryptography every client shares: the Poseidon2 key
hierarchy (spend key → viewing key → address), ML-KEM-768 + ChaCha20-Poly1305 envelopes, note
commitments and nullifiers, coin selection, and the STARK proof of one **hidden-asset bundle** —
four input and four output slots, tier 14. It is the fullnode's own crates (`randprotocol-core`,
`randprotocol-zkvm`, `randprotocol-prover`'s wire — vendored as the submodule `vendor/fullnode` at
fullnode's tag `v0.6.7`, commit `86941a1`, the build chains 18 and 19 run) behind one JSON entry
point. Constraint set 8 adds one public value to every proof (`pv::GAS`, the declared gas limit) and
moves every verifier key: a bundle this core proves declares the guest's ceiling, 20 479 gas, which
the genesis pins as `bundle_gas_limit` (`version.bundle_gas_limit`; a chain naming another
value is refused before proving), and verifies on no chain before 18.

**Split authorisation** (fullnode v0.6.3, every chain since 17). A transaction carries two proofs.
The **auth proof** is tiny (tier 10: ~7 s natively, ~25 s and under 400 MiB in wasm32, 1.36 MB at
the production profile) and is made from the **spend key** and a fresh 32-byte salt — always on
the device, by `prove_*` and `prepare_*` alike. The **bundle proof** (tier 14, ~100 s, 6.2 GB) is
made by bundle guest v3 from the **viewing key** `nk` and that salt, so it can be handed to a
paired prover that then learns this wallet's whole history and can spend nothing. The bundle
carries `auth_commit = H(AUTH, nk, salt)`, which both proofs are bound to, and the transaction id
domain is `rand-txid-3`. `prove_*`/`prepare_*` take the chain's two guests (`hc_bundle`, `hc_auth`,
from `rand_status`) and refuse, before anything is proved, a v3 chain whose auth guest is absent
or not this build's, and an auth guest beside a v1/v2 bundle guest; both absent means the default
chain's (`version.hc_bundle`, `version.hc_auth`). The tag `v0.6.6` (`d742a9b`) this core was on
before is a pre-rebase line without any of this: a wallet built on it scans chain 18 and every
send is refused `AuthMissing`.

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

Since chain 14 every shielded transfer is **one** bundle and **one** proof, whatever it moves.
Slots 0–1 carry a private asset `A` — a witness word the chain never sees, so nobody without a key
can tell whether RAND, a bridged coin or an RPL token moved — and slots 2–3 carry RAND and pay the
fee. `plan_transfer`, `max_sendable` and `prove_transfer` therefore all take an `asset`: at 0
(the default, and the shape the existing JS, Swift and Java callers send) the value and the fee
share slots 2–3 exactly as before; at an index ≥ 1 the token is spent from slots 0–1 and
`fee_inputs` names the RAND notes that pay from slots 2–3. A wallet holding a token and no
spendable RAND is refused before anything is proved (`NO_SPENDABLE_RAND`).

A bridge withdrawal is the same bundle with the amount moved from the payment to the burn
(`burn_a == amount`, `burn_asset == asset`, `burn_r == 0`), so `plan_burn` returns the same shape
as `plan_transfer` and `prove_burn` proves **once** — chain 13's two-bundle burn is gone. Chain 14
also requires a burn to name the coin it redeems (`token`, since one bridged token has several
backings), and `burn_is_possible` — upstream's own pre-flight, ported whole — screens a
`rand_getBridgeState` reply the client fetched for the five things only the chain knows. **Call it
before `prove_burn`**, or a typo costs a proof.

A bundle has four slots, so `prove_transfer`'s and `prove_burn`'s `nullifiers`, `commitments` and
`tx_keys` are four-wide and in **slot** order. Two of those slots are always dummies sealed to a
throwaway key that opens to nobody, the sender included — so a receipt must **never** be built
from index 0, which is what every client did when a bundle had two slots. Core resolves it
instead: `payment_slot`, `payment_tx_key` and `payment_commitment` name the note that pays the
recipient, and are `null` on a burn, which pays nobody inside the pool.

Every bundle proof is made over, and verified against, its transaction's `binding`: the wallet
assembles the whole transaction with the proof empty, takes the binding, proves against it and
fills the proof in. `version`'s reply carries `bundle_inputs` (2, per group), `bundle_slots` (4),
`rpl_transfer` (`true`), `bridge_burn` (`true`), `bridge_burn_proofs` (1), `transfer_proofs` (1)
and `bridge_burn_fee` (0.01 RAND, the chain's `BRIDGE_BURN_FEE`) so a client never hard-codes these.

Sharing an address and the memo (fullnode spec 2026-09-26, §2): `address_fingerprint` gives the
address's display fingerprint (`1WCV-YC8F-47BY-5RZY` — two people compare it out loud, nothing on
the wire carries it); `uri_parse`/`uri_format` read and write `randpay:<address>?amount=&asset=&memo=`
links (the QR every client shows encodes the link, never the bare address). `prove_transfer`
takes `memo` (default `""`) and `envelope_bytes` (default `null`, from the chain's
`rand_getLimits`): every output is sealed in the chain's one envelope format — 1 860 bytes on a
chain that declares it, the 1 348-byte legacy one otherwise — and only the payment carries the
memo. A legacy chain has no room for one, so a non-empty memo there is refused before anything is
proved. `prove_burn` takes `envelope_bytes` too. `scan_page` returns `memo` (or `null`) on every
received note and sent row, and `open_with_tx_key` on the note it opens.

```bash
# each proved for real, then put in front of the chain's own Ledger::validate
cargo run --release --example prove_fixture -- transfer   # RAND:   [nobody, nobody, pay, change]
cargo run --release --example prove_fixture -- token      # a token: [pay, change_a, change_r, nobody]
cargo run --release --example prove_fixture -- burn       # a burn:  burn_a == amount, burn_asset == asset
```

```bash
cargo test --release            # includes a full proved transfer checked by the chain's verifier
scripts/build-ios.sh            # needs Xcode; rustup targets are added on demand
scripts/build-android.sh        # needs ANDROID_NDK_HOME (or an NDK under $ANDROID_HOME/ndk)
scripts/build-wasm.sh           # cargo `wasm` profile + wasm-bindgen-cli (installed on demand)
```

Toolchain 1.98.1 is pinned (`rust-toolchain.toml`), the same as the fullnode. Release builds use
fat LTO; the iOS static library is about 8 MB, the wasm a few MB.

Delegated proving (`prepare_transfer` / `prepare_burn` → the prover → `finish_proof`): what the
sealed job carries follows the chain's guest and is never the caller's choice — the viewing key on
a split-authorisation chain (any paired prover), the spend key on an older one (only a prover with
`own: true`, the pairing link's `own=1`). `pending` holds the transaction with its auth proof
already in place, so it is ~2.8 MB of hex at the production profile. A prover that quotes a fee
(`prover.fee`, its `prover_info.fee` passed through) is refused: this build pays none.

To move to a new chain build: `cd vendor/fullnode && git fetch && git checkout <rev>`, update
`CHAIN_BUILD`/`DEFAULT_CHAIN_ID` in `wallet-core`, run the tests (`cargo test --release`, and
`-- --ignored` for the two real delegated-proof tests), rebuild the three targets. `version`'s
`hc_bundle`/`hc_auth` are pinned in a test against the digests the live chain's `rand_status`
answers: if the vendored build assembles either guest differently, that test says so first.
