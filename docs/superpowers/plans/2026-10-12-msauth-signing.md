# Private Multisig Signing in Every App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method (decided): **subagent-driven**.

**Goal:** Every wallet app — web, extension, desktop, iOS, Android — can hold signer profiles for a private multisig account and check, show, sign and share a proposal (`i:<sig hex>`), through fullnode's `randprotocol-msig`, with every signature re-authenticated and nothing signed without a live chain head.

**Architecture:** `wallet-core` gains five `msauth_*` arms in `dispatch`, in a new module `core/crates/wallet-core/src/msauth.rs` over the vendored `randprotocol-msig` (pure, wasm32-clean); the wasm, FFI and Tauri bindings pick them up through the generic `call`. The shared JS engine gains an optional `signers` group (`ui/engine/signers.js`) that keeps profiles in the vault (policies in one record opened at unlock, each seed in its own record decrypted per signature with the password), compares the proposal's expiry with `rand_getHead`, and refuses with no node. Screens `#signers` / `#signer/<id>` sit behind Settings. iOS (Keychain, seed item under `.userPresence`) and Android (Keystore AES key with per-use auth, BiometricPrompt `CryptoObject`) mirror it natively. A final devnet run signs one proposal from the web engine and from iOS, and the CLI proves and submits it.

**Tech Stack:** Rust 1.98.1 (wallet-core, vendored fullnode crates), JavaScript ES modules (ui/, `node --test`, linkedom), Tauri 2 (desktop), Swift/SwiftUI + XCTest (iOS, xcodegen), Java + JUnit 4 (Android, Gradle).

**Spec:** `docs/superpowers/specs/2026-10-11-msauth-signing-design.md` (this branch, head `639cae7` — §4 step 3: the signer enters each payee's address). Fullnode companions (read with `git -C ~/Github/randprotocol/fullnode show <rev>:<path>`, never check out there): `e34117be:crates/randprotocol-msig/src/lib.rs`, `e34117be:crates/randprotocol-msig/tests/checks.rs`, `d5b2e652:docs/cli.md` §`rand multisig-private`.

**Branch / base:** `feat/msauth-signing` in `~/rand-worktrees/clients-msauth` (local only, **never push**), off `main`. Task 1 runs on `feat/msauth-repin` in `~/rand-worktrees/clients-msauth-repin` and is merged into `feat/msauth-signing` before Task 2.

## Global Constraints

- Source of truth: the spec above. The library is fullnode `e34117be` `crates/randprotocol-msig` (API verified 2026-10-12): `check_proposal(&str, &str) -> Result<ProposalSummary, MsigError>`; `ProposalSummary::lines() -> Vec<String>`; `sign(&str, &str, &[u8; 32]) -> Result<(u8, Vec<u8>), MsigError>` (deterministic Dilithium2 via `randprotocol_core::Keypair::from_seed`); `verify_share(&str, &str, &str) -> Result<(), MsigError>`; `Policy` (pub fields `version, threshold, signers, msk`; `check()`, `pks()`, `policy_hash()`, `address()`, `fingerprint()`); `Proposal` (pub `chain_id, genesis, binding_domain, expires_at, …`); `PK_BYTES = 1312`, `SIG_BYTES = 2420`.
- **Pending crate API (confirm against the final crate commit — 0e will send):** the fix wave adds to `randprotocol-msig` `owner_fingerprint_of(&ShieldedAddress) -> String`; an optional expected-recipients input to `check_proposal` — named here `check_proposal_expecting(proposal_json: &str, policy_json: &str, expected_recipients: Option<&[ShieldedAddress]>) -> Result<ProposalSummary, MsigError>`, with `check_proposal(p, q)` kept as the wrapper passing `None`; a per-output match field — named here `OutputSummary::matches: Option<String>` (the matched address's fingerprint); output lines ending "matches <address fingerprint>" or "no expected recipient given: the payee was NOT checked"; a chain-id + genesis line in `lines()`; a new fixture `proposal-substituted-recipient.json` and a changed `expected.json`. Every place this plan uses one of these names carries the tag **[confirm: 0e]**; on the final commit, rename to match and adjust nothing else.
- **Payees are checked, never assumed (spec §4 step 3, 2026-10-12):** before review the app asks for the expected recipient address of every output that is not `to_account` and pays a non-zero amount (a zero-amount output is a dummy slot — **[confirm: 0e]** that the crate treats it as needing no payee; if it does need one, drop the `amount != "0"` filter); `msauth_check` takes them as `expected_recipients: [address strings]`; signing is **refused** while any such output is unmatched or its address was left empty (refusal code `unchecked-recipient`). The app never signs on "no expected recipient given: the payee was NOT checked".
- The proposal's chain id and genesis (shown as the crate's chain-id/genesis line, and returned as `chain_id`/`genesis`/`binding_domain`) are compared with the node's `rand_chainId` and `rand_getGenesisHash`; a mismatch refuses.
- Output lines are fullnode's `lines()` **verbatim**; each output line carries the owner-key caveat `(owner key verified; delivery key NOT verifiable from this proposal)` at `e34117be`, and after the fix wave also "matches <address fingerprint>" or "no expected recipient given: the payee was NOT checked" plus a chain-id/genesis line **[confirm: 0e]** for the exact wording — tests assert on the structured fields (`matches`, `recipients_checked`) and on `lines` being the crate's own output, not on a hand-copied sentence. They are never translated, reworded, or replaced by the proposal's informational `summary` (which no app shows).
- No node reachable → **refuse to sign**, naming the node URL tried, with Retry. Refuse when `head + 16 >= expires_at` (`EXPIRY_MARGIN = 16`, the CLI's `multisig-private prove` rule, fullnode `d5b2e652` `main.rs:1392/1505`). The head comes from `rand_getHead` on a node that passed the wallet's own chain check.
- Every signature re-authenticates: web/extension/desktop ask for the password and decrypt that profile's seed for one call; iOS reads the seed Keychain item (`.userPresence`) per signature with a fresh `LAContext`; Android decrypts with a Keystore key `setUserAuthenticationRequired(true)` through a per-use `BiometricPrompt` `CryptoObject`. The seed is never cached, logged, or held past the call. Listing/viewing a profile needs only the normal unlock.
- JavaScript cannot wipe a string: the engine decrypts the seed into a `Uint8Array` and `fill(0)`s it in `finally`; the hex copy it passes to the core becomes unreachable after the call; wallet-core keeps its copy in `zeroize::Zeroizing`. Say exactly this in code comments; claim no more.
- A proposal is never stored: not in `storage`, not in the session, not in a log, not in Settings. It lives in a screen-local variable and is dropped on leaving the screen.
- Profiles live only where the spend key lives: the vault (`ui/engine/crypto.js` AES-256-GCM / PBKDF2-SHA256 600 000), the iOS Keychain (`ThisDeviceOnly`), Android `KeyVault`'s EncryptedSharedPreferences + Keystore. Wiping the wallet removes every profile.
- Wire rule (wallet-core): amounts are decimal strings, heights/indices/counts JSON numbers. `msauth_check` therefore re-shapes `ProposalSummary` (whose amounts are `u64`).
- Confirmation before signing types the **last four characters of `policy_fingerprint`** (dashes ignored, case-insensitive) — the withdraw screen's pattern (`ui/screens/withdraw.js:109,403,848`).
- Profiles need an existing wallet on every platform in this plan (the vault password / the app's device-auth unlock gate them). The spec's "a profile does not need a spend key" is **deferred** (onboarding change in five apps) — flagged to the user, not built.
- 20 locales everywhere: `ui/locales/*.js` (held to `en.js` by `ui/test/i18n.test.mjs`), `ios/l10n/<code>.json` merged into `ios/RandWallet/Localizable.xcstrings` (`scripts/i18n/native_check.py ios <code>` / `ios-merge`), `android/app/src/main/res/values*/strings.xml` (`native_check.py android values-<x>`, `StringsParityTest`).
- After Task 1 `main` of this branch is **chain-21-only** (constraint set 9, `DEFAULT_CHAIN_ID = 21`); chain-20 fixes go to `origin/release/chain20` (`201757c`).
- Commits: every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01L6dmK1EC4QerMmqWR1h7d8`. No `cargo fmt`. Never edit `desktop/dist-ui/`, `web/wallet/dist/`, `extension/shared/core/` by hand (built copies). Never push.
- Disk: run `df -h /` before any build; **stop and report if free < 25 GiB** (46 GiB free on 2026-10-12). Standing approval exists to delete Time Machine local snapshots when free < ~40 GiB (`tmutil listlocalsnapshots /`, `tmutil deletelocalsnapshots <date>`).
- Test commands (all from the worktree root unless stated):
  - core: `cd core && cargo test --release` (the real-proof tests take minutes); one test: `cd core && cargo test --release -p wallet-core <name>`; wasm32 check: `cd core && cargo check --target wasm32-unknown-unknown -p wallet-wasm --profile wasm`; wasm build: `core/scripts/build-wasm.sh` (writes `extension/shared/core/`).
  - JS: `npm ci --prefix ui` once, then `node --test "ui/test/**/*.test.mjs"`; web/extension: `node --test "web/wallet/test/**/*.test.mjs" "extension/test/*.test.mjs"` (real-core tests skip unless the wasm is built).
  - desktop: `cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test`.
  - iOS (**runs here**: Xcode 27.0, xcodegen, simulators): `core/scripts/build-ios.sh` once (writes `ios/Frameworks/RandWalletCore.xcframework`, absent in this worktree), then `cd ios && xcodegen generate && xcodebuild -project RandWallet.xcodeproj -scheme RandWallet -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` (the README's `iPhone 17` does not exist on this Mac). The simulator has no passcode: `.userPresence` items cannot be created there, so the Keychain ACL is unit-tested through a fake and checked by hand on a device (Task 10 Step 8).
  - Android (**JVM unit tests run here** with env set; `/usr/bin/java` has no runtime): `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest`. JVM tests cannot load the native core (`NativeCore` → `System.loadLibrary`), so core-dependent logic goes behind interfaces (the `ProverCore` pattern). No device/emulator run is part of the plan; BiometricPrompt + Keystore is checked by hand (Task 12 Step 9).

## Review Focus

0. **A substituted recipient** (the coordinator pays its own key; every other check passes): with the payee's real address entered, that output is unmatched and signing is refused — Task 3 (`a_substituted_recipient_is_unmatched`), Task 7 (`an unmatched or unchecked payee refuses signing`).
1. **A proposal for another chain or genesis** (prepared on a testnet, opened by a mainnet wallet): the head comparison is meaningless, so it must be refused by name, never signed — Task 7 (`a proposal for another chain or genesis is refused`).
2. **Signing twice, or a wrong password at signing**: each signature asks again, a wrong password counts toward the unlock throttle and decrypts nothing, and no seed is left in session or storage — Task 7 (`every signature asks for the password and caches nothing`, `a wrong password at signing is throttled like an unlock`).
3. **A node that answers `rand_chainId` but fails `rand_getHead`, or is on the wrong chain**: treated exactly as no node (refuse, name the URL, offer Retry) — Task 7 (`a node that cannot give a head is no node`).
4. **A file with a BOM or trailing newline** (a share saved by another app, a proposal from Windows): accepted — core strips `U+FEFF` and trims; the engine trims shares — Task 3 (`a_bom_and_whitespace_around_a_file_are_tolerated`) and Task 7.
5. **Choosing a file from the extension popup** (Chrome closes the popup when the file dialog takes focus, losing the in-memory proposal): in popup mode the screens offer "Open in the side panel" instead of a file input — Task 8 (`the popup offers the side panel instead of a file picker`).

---

### Task 1: Re-pin `core/vendor/fullnode` to `e34117be`, move to chain 21, link `randprotocol-msig` — **in progress on `feat/msauth-repin`** (`~/rand-worktrees/clients-msauth-repin`)

This task is the record of the step another session is running. Tasks 2+ assume its result: the submodule at `e34117be`, `CHAIN_BUILD = "e34117b"`, `DEFAULT_CHAIN_ID = 21`, and `wallet-core` depending on `randprotocol-msig`. Before Task 2, merge it: `git -C ~/rand-worktrees/clients-msauth merge --no-ff feat/msauth-repin`.

**Files:**
- Modify: `core/vendor/fullnode` (submodule → `e34117bedc634d2d2def3d2c2506bd03aa59e81d`), `core/Cargo.toml` (workspace dep), `core/crates/wallet-core/Cargo.toml`, `core/crates/wallet-core/src/lib.rs` (`CHAIN_BUILD` doc + value ~line 57–85, `DEFAULT_CHAIN_ID` ~line 86–105, tests at ~5287, ~5301, ~6122, `DeployExec` ~7254), `core/Cargo.lock`, `desktop/src-tauri/Cargo.lock`, `android/app/src/main/java/org/randprotocol/wallet/security/Prefs.java:11`, `ios/RandWallet/Storage/Settings.swift:52`, `ios/RandWalletTests/CoreSmokeTests.swift`, `ios/RandWalletTests/LiveSendTests.swift` (`chainId = 21`), `web/wallet/test/core.integration.test.mjs:248,252`, `web/wallet/test/prover.e2e.test.mjs:68`, `web/wallet/test/withdraw.e2e.test.mjs:75`, `README.md` (submodule line)

**Interfaces:**
- Produces: workspace dependency `randprotocol-msig = { path = "vendor/fullnode/crates/randprotocol-msig" }`; `wallet-core` `[dependencies] randprotocol-msig = { workspace = true }`; `wallet_core::CHAIN_BUILD == "e34117b"`; `wallet_core::DEFAULT_CHAIN_ID == 21`.

- [ ] **Step 0: Disk.** `df -h /` — stop if free < 25 GiB.
- [ ] **Step 1: Fill the submodule from the local fullnode** (the commit is not on GitHub; the shared `.git/config` keeps its GitHub URL — the `-c` override is per-command):

```bash
cd ~/rand-worktrees/clients-msauth-repin
git -c protocol.file.allow=always -c submodule.core/vendor/fullnode.url=/Users/dendisuhubdy/Github/randprotocol/fullnode \
  submodule update --init core/vendor/fullnode
git -C core/vendor/fullnode fetch /Users/dendisuhubdy/Github/randprotocol/fullnode feat/private-multisig
git -C core/vendor/fullnode checkout --detach e34117bedc634d2d2def3d2c2506bd03aa59e81d
git config --get submodule.core/vendor/fullnode.url   # must still print https://github.com/randprotocol/fullnode.git
```

- [ ] **Step 2: Failing tests.** In `core/crates/wallet-core/src/lib.rs` change the three `default_chain_id` asserts from `20` to `21` and `assert_eq!(v["chain_build"], "37c4fdd")` to `"e34117b"`, and add beside `version_reports_chain_fourteen`:

```rust
#[test]
fn the_vendored_msig_crate_is_linked() {
    assert_eq!(randprotocol_msig::POLICY_VERSION, 1);
    assert_eq!(randprotocol_msig::SIG_BYTES, 2420);
    assert_eq!(randprotocol_msig::PK_BYTES, 1312);
}
```

Run: `cd core && cargo test --release -p wallet-core the_vendored_msig_crate_is_linked` — Expected: compile error `unresolved crate randprotocol_msig` (and `DeployExec` missing trait items).

- [ ] **Step 3: Implement.**
  - `core/Cargo.toml` `[workspace.dependencies]`, after `randprotocol-prover`:
    ```toml
    # Private multisig signer checks (fullnode e34117be, spec 2026-10-11 phase 4 §6.5): pure,
    # wasm32-clean; every app's check/sign/verify-share goes through it.
    randprotocol-msig = { path = "vendor/fullnode/crates/randprotocol-msig" }
    ```
  - `core/crates/wallet-core/Cargo.toml` `[dependencies]`: `randprotocol-msig = { workspace = true }`.
  - `CHAIN_BUILD = "e34117b"`; prepend to its doc: "fullnode `feat/private-multisig` `e34117be` — constraint set 9 (the MODQ chip: every proof key and the proof encoding move; `hc_bundle` `60af094a…` and `hc_auth` `1e4e347f…` unchanged), the `msauth` guest, `randprotocol-msig`; a node on it refuses chains 18–20, so this build is chain-21-only. Before it: …".
  - `DEFAULT_CHAIN_ID`: `None => 21,` and its doc's first sentence: "The chain the defaults below describe: chain 21 (fullnode v0.8.0, constraint set 9; perps, multisig, the `fees` section, `hc_auth_multisig`), cut from chain 20's state."
  - `DeployExec` (inside the RPL-2 test module): forward the six new `ConfidentialExecutor` methods:
    ```rust
    fn auth_header(&self, proof: &[u8]) -> std::result::Result<(randprotocol_core::confidential::AuthShape, Word8, Option<u64>), ConfidentialError> {
        self.0.auth_header(proof)
    }
    fn warm_auth_multisig(&self) {
        self.0.warm_auth_multisig()
    }
    fn auth_multisig_key_ready(&self) -> bool {
        self.0.auth_multisig_key_ready()
    }
    fn install_msauth_vk(&self, blob: &[u8]) -> std::result::Result<(), String> {
        self.0.install_msauth_vk(blob)
    }
    fn enable_auth_multisig(&self) {
        self.0.enable_auth_multisig()
    }
    fn build_msauth_key(&self) -> std::result::Result<(), String> {
        self.0.build_msauth_key()
    }
    ```
  - Any other compile error from the vendored move: fix only if it is a mechanical rename; anything else, stop and report.
  - `Prefs.java`: `DEFAULT_CHAIN_ID = 21`; `Settings.swift:52`: `?? 21`; `CoreSmokeTests`: `XCTAssertEqual(c.defaultChainId, 21)`, `XCTAssertEqual(c.chainBuild, "e34117b", "fullnode e34117be (private multisig, constraint set 9), chain 21")`; `core.integration.test.mjs`: `assert.equal(k.default_chain_id, 21, 'chain 21 from e34117b (constraint set 9); 20 from 2026-10-01 before that')`, `assert.equal(k.chain_build, 'e34117b')` (hc pins unchanged); both e2e files `const CHAIN_ID = 21;`; `LiveSendTests`: `settings.chainId = 21`.
  - `cd desktop/src-tauri && cargo update -p wallet-core` (adds `randprotocol-msig` to the lock).
- [ ] **Step 4: Verify.** `cd core && cargo check --target wasm32-unknown-unknown -p wallet-wasm --profile wasm` → `Finished` (proves `dilithium-core` is gated off wasm32). `cd core && cargo test --release` → all pass, hc pins unchanged. `node --test "ui/test/**/*.test.mjs"` → pass. `core/scripts/build-wasm.sh && node --test web/wallet/test/core.integration.test.mjs` → pass. `cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test` → pass.
- [ ] **Step 5: Commit.**

```bash
git add core/vendor/fullnode core/Cargo.toml core/Cargo.lock core/crates/wallet-core desktop/src-tauri/Cargo.lock \
  android/app/src/main/java/org/randprotocol/wallet/security/Prefs.java ios/RandWallet/Storage/Settings.swift \
  ios/RandWalletTests/CoreSmokeTests.swift ios/RandWalletTests/LiveSendTests.swift web/wallet/test README.md
git commit -m "core: vendor fullnode e34117be (private multisig, constraint set 9) — chain-21-only; randprotocol-msig linked; DeployExec forwards the msauth executor methods

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01L6dmK1EC4QerMmqWR1h7d8"
```

---

### Task 2: Real-node prover e2e on a chain-21 shape

**Files:**
- Modify: `web/wallet/test/prover.e2e.test.mjs` (assert the multisig auth guest when the chain names one)

**Interfaces:**
- Consumes: Task 1's vendored build (`scripts/e2e-prover.sh` builds `rand-node`/`rand-prover` from `core/vendor/fullnode`).

- [ ] **Step 1: The assertion.** In the send test, after `const status = await rpc(env.rpcUrl, 'rand_status');`:

```js
    // A chain-21 shape (RAND_E2E_GENESIS_ARGS carries --auth-multisig-guest): the node names the
    // msauth guest and loaded its pinned verifier key, and this wallet's single-key spend still lands.
    if ((process.env.RAND_E2E_GENESIS_ARGS || '').includes('--auth-multisig-guest')) {
      assert.match(String(status.hc_auth_multisig), /^[0-9a-f]{64}$/, 'the node names its multisig auth guest');
      assert.equal(status.msauth_key, 'loaded', 'the node loaded the Test msauth key (RAND_MSAUTH_VK)');
    }
```

- [ ] **Step 2: Run on the chain-21 shape** (`df -h /` first; ~2.5 min of proving plus the release build; nothing else proving):

```bash
cd ~/rand-worktrees/clients-msauth
S=/private/tmp/claude-501/msauth-e2e && mkdir -p $S && echo '{"burn_base": true, "burn_floor": true}' > $S/fees.json
RAND_MSAUTH_VK=$PWD/core/vendor/fullnode/crates/randprotocol-zkvm/keys/msauth-vk-test.bin \
RAND_E2E_GENESIS_ARGS="--auth-multisig-guest --fees $S/fees.json --binding-domain 1" \
  scripts/e2e-prover.sh 2>&1 | tee $S/prover-e2e.log
```

Expected: `# pass 3`, `# fail 0` (the either-runs test, the no-prover test, the send). If `rand-node genesis` refuses `--binding-domain` twice (it is also in `chainArgs`), drop it from the env value.

- [ ] **Step 3: Commit** (`git add web/wallet/test/prover.e2e.test.mjs`, message `e2e: the prover e2e asserts the msauth guest and key on a chain-21 shape (passed on e34117be: <wall time>)` + trailer).

---

### Task 3: Core — fixtures, `msauth_check`, `msauth_verify_share`, `msauth_policy_info`

**Files:**
- Create: `ui/test/fixtures/msauth/*.json` (copies of every vendored fixture — 10 at `e34117be`, 11 once `proposal-substituted-recipient.json` lands), `ui/test/fixtures/msauth.sha256` (the ONE hash list; the re-vendor rewrites it), `ui/test/msauth-fixtures.test.mjs`, `core/crates/wallet-core/src/msauth.rs`
- Modify: `core/crates/wallet-core/src/lib.rs` (`mod msauth;`, three dispatch arms, dispatch doc)

**Interfaces:**
- Consumes: `randprotocol_msig::{check_proposal, verify_share, Policy, Proposal, MsigError}`.
- Produces: `msauth::check(proposal: &str, policy: &str, expected_recipients: &[String]) -> Result<Value>` (addresses parsed with `ShieldedAddress::parse`, passed to `check_proposal_expecting` **[confirm: 0e]**; an empty list means none given) → `{outputs: [{owner_fingerprint, to_account, amount: "<units>", asset, memo, matches: <address fingerprint>|null, needs_payee: bool}], recipients_checked: bool, fee: "<units>", burns: {burn_a: "<units>", burn_asset, burn_r: "<units>"}, expires_at: <height>, signing_message: "<hex>", policy_fingerprint, lines: [String], chain_id, genesis, binding_domain}`; `msauth::verify_share(proposal, policy, share) -> Result<Value>` → `true`; `msauth::policy_info(policy) -> Result<Value>` → `{fingerprint, threshold, signers: <count>, address, policy_hash}`; `msauth::clean(&str) -> &str` (strips a leading `U+FEFF`, trims). Dispatch: `msauth_check {proposal, policy, expected_recipients?: [address]}`, `msauth_verify_share {proposal, policy, share}`, `msauth_policy_info {policy}`.

- [ ] **Step 0: Precondition — the fix-wave crate.** `check_proposal_expecting`, `OutputSummary::matches` and `proposal-substituted-recipient.json` **[confirm: 0e]** are not in `e34117be`. Before this task, re-pin `core/vendor/fullnode` to the fix-wave commit 0e sends (Task 1 Steps 1–4 with that SHA; `CHAIN_BUILD` its first 7 characters), then rename this task's tagged names to the crate's real ones. Until that commit exists, run Tasks 5–9 first (they use the stub core and do not need it); Tasks 3, 4, 10 Step 5 and 14 wait.

- [ ] **Step 1: Copy the fixtures and pin them in one list.**

```bash
mkdir -p ui/test/fixtures/msauth
cp core/vendor/fullnode/crates/randprotocol-msig/tests/fixtures/*.json ui/test/fixtures/msauth/
( cd ui/test/fixtures/msauth && shasum -a 256 *.json ) > ui/test/fixtures/msauth.sha256
```

At `e34117be` the list must read (check before committing; every re-vendor re-runs the three lines above and commits the new list, nothing else changes):

```
5b937523f177f1b2133214d36f99e678d9d104767481e6f7cf8c86eb7876ffb3  expected.json
31fbeb3212e024e5839e29f9bdf23c0bbd6e34eb2ffcefb5c9085b3196992ff2  policy.json
2144cafbbd06c1cd165105754a8ee1043167ed68b2256e150c991f82b055b8f7  proposal-expired.json
457f0ab49d28ba0c18e3be1e266ed09fa94f1bd7f3105155b88c8dc95fc786c2  proposal-fee-raised.json
c621fc9531f95a04be2aa83d217d0040b19b27254d7bce483dbf6243a558b81b  proposal-tampered-output.json
6f2135c940a38af710e137d2da0ff42147bd6d9a2bf18bd3fc6973bef044b3bd  proposal-unbound.json
50f1f1cc5df58bfc1126bc9279a96fc1a47c0d0a192fa6239988d8f4d828129b  proposal-valid.json
dddb4624c6f290948be9769735b13a445d7e4d201c85bf8e044438d808f91016  proposal-value-mismatch.json
7ce496a463c09dec560070875c12e10781b14a31f944bfb1905c07e6cd751832  proposal-wrong-expected.json
f75a09d8ec62da397010202e053d192a429710ecb566faf29d8d1381f07ee8aa  signer-seeds.json
```

`ui/test/msauth-fixtures.test.mjs`:

```js
// The private-multisig vectors every app's tests read (iOS bundles the directory, Android adds it to
// its test resources, wallet-core reads it): fullnode's crates/randprotocol-msig/tests/fixtures,
// byte for byte. The hashes live in ONE list, ui/test/fixtures/msauth.sha256 (`shasum -a 256`
// format), which a re-vendor rewrites; wallet-core's `the_fixture_copies_are_the_vendored_vectors`
// holds the copies to the submodule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('./fixtures/msauth/', import.meta.url);
const SUMS = readFileSync(new URL('./fixtures/msauth.sha256', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([hash, name]) => [name, hash]);

test('every msauth fixture is listed once, and hashes to its listed SHA-256', () => {
  assert.deepEqual(readdirSync(DIR).sort(), SUMS.map(([n]) => n).sort());
  for (const [name, want] of SUMS) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, DIR))).digest('hex'), want, name);
  }
});
```

Run `node --test ui/test/msauth-fixtures.test.mjs` → PASS.

- [ ] **Step 2: Failing Rust tests.** Create `core/crates/wallet-core/src/msauth.rs` with only the test module (the functions do not exist yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../ui/test/fixtures/msauth/");
    const VENDORED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vendor/fullnode/crates/randprotocol-msig/tests/fixtures/");
    pub(super) fn fx(name: &str) -> String {
        std::fs::read_to_string(format!("{DIR}{name}.json")).unwrap()
    }
    pub(super) fn expected() -> Value {
        serde_json::from_str(&fx("expected")).unwrap()
    }

    /// The valid proposal's real payee: the address its informational summary names
    /// ("pay 10 RAND to rand1…", fullnode's generator). Read from there, never from the app's view.
    pub(super) fn payee() -> String {
        let p: Value = serde_json::from_str(&fx("proposal-valid")).unwrap();
        p["summary"][0].as_str().unwrap().rsplit(' ').next().unwrap().to_string()
    }

    /// [confirm: 0e] the fixture name and that the crate reports the substituted output unmatched
    /// (rather than refusing outright — if it refuses, assert the refusal names the output instead).
    #[test]
    fn a_substituted_recipient_is_unmatched() {
        let v = check(&fx("proposal-substituted-recipient"), &fx("policy"), &[payee()]).unwrap();
        assert_eq!(v["recipients_checked"], false);
        assert!(v["outputs"].as_array().unwrap().iter().any(|o| o["needs_payee"] == true && o["matches"].is_null()));
    }

    #[test]
    fn the_valid_proposal_matches_its_payee_and_nothing_given_checks_nothing() {
        let v = check(&fx("proposal-valid"), &fx("policy"), &[payee()]).unwrap();
        assert_eq!(v["recipients_checked"], true);
        assert!(v["outputs"][2]["matches"].is_string(), "{}", v["outputs"][2]);
        assert!(v["lines"][2].as_str().unwrap().contains("matches "));
        let none = check(&fx("proposal-valid"), &fx("policy"), &[]).unwrap();
        assert_eq!(none["recipients_checked"], false);
        assert!(none["lines"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("no expected recipient given: the payee was NOT checked")));
        assert!(check(&fx("proposal-valid"), &fx("policy"), &["rand1nope".into()]).unwrap_err().contains("expected recipient"));
    }

    #[test]
    fn the_fixture_copies_are_the_vendored_vectors() {
        let names = |d: &str| -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            v.sort();
            v
        };
        assert_eq!(names(DIR), names(VENDORED), "the same files: re-copy after a re-pin (Task 3 Step 1)");
        for n in names(VENDORED) {
            assert_eq!(std::fs::read(format!("{DIR}{n}")).unwrap(), std::fs::read(format!("{VENDORED}{n}")).unwrap(), "{n}");
        }
    }

    #[test]
    fn check_returns_the_expected_summary_with_amounts_as_strings() {
        let v = check(&fx("proposal-valid"), &fx("policy"), &[payee()]).unwrap();
        let want = &expected()["summary"];
        for (i, o) in want["outputs"].as_array().unwrap().iter().enumerate() {
            let got = &v["outputs"][i];
            assert_eq!(got["owner_fingerprint"], o["owner_fingerprint"]);
            assert_eq!(got["to_account"], o["to_account"]);
            assert_eq!(got["amount"], json!(o["amount"].as_u64().unwrap().to_string()), "amounts are strings");
            assert_eq!((&got["asset"], &got["memo"]), (&o["asset"], &o["memo"]));
        }
        assert_eq!(v["fee"], "1000000");
        assert_eq!(v["burns"], json!({ "burn_a": "0", "burn_asset": 0, "burn_r": "0" }));
        assert_eq!(v["expires_at"], 2024);
        assert_eq!(v["signing_message"], expected()["signing_message"]);
        assert_eq!(v["policy_fingerprint"], "NFYW-K8E9-E5K9-AAK3");
        assert_eq!((&v["chain_id"], &v["binding_domain"], &v["genesis"]), (&json!(7), &json!(0), &json!("0".repeat(64))));
        let lines = randprotocol_msig::check_proposal_expecting(&fx("proposal-valid"), &fx("policy"), Some(&[parse_address(&payee()).unwrap()])).unwrap().lines(); // [confirm: 0e]
        assert_eq!(v["lines"], json!(lines), "fullnode's lines, verbatim");
        for l in &lines[..4] {
            assert!(l.contains("owner key verified"), "{l}"); // [confirm: 0e] the final caveat/match wording
        }
        assert!(lines.iter().any(|l| l.contains("chain 7")), "the chain-id/genesis line [confirm: 0e]");
        assert!(lines[3].contains("this account 4333dd507bcc4286"), "change is labelled: {}", lines[3]);
        assert!(lines.iter().all(|l| !l.contains("rand1")), "no address from the proposal's summary");
    }

    #[test]
    fn each_bad_proposal_is_refused_by_name() {
        for (name, words) in [
            ("proposal-tampered-output", "does not open as this account's"),
            ("proposal-unbound", "does not hash to the proposal's binding"),
            ("proposal-wrong-expected", "expected digest is not its bundle's"),
            ("proposal-fee-raised", "the witness's value does not match the outputs: asset 0"),
            ("proposal-value-mismatch", "the witness's value does not match"),
            ("proposal-expired", "the proposal expires at"),
        ] {
            let e = check(&fx(name), &fx("policy"), &[]).unwrap_err();
            assert!(e.contains(words), "{name}: {e}");
        }
    }

    #[test]
    fn a_bom_and_whitespace_around_a_file_are_tolerated() {
        check(&format!("\u{feff}{}\r\n", fx("proposal-valid")), &format!("\u{feff}  {}\n", fx("policy")), &[format!(" {}\n", payee())]).unwrap();
        verify_share(&fx("proposal-valid"), &fx("policy"), &format!("{}\n", expected()["share_0"].as_str().unwrap())).unwrap();
    }

    #[test]
    fn verify_share_takes_the_expected_shares_and_refuses_others() {
        let (prop, pol) = (fx("proposal-valid"), fx("policy"));
        for k in ["share_0", "share_2"] {
            assert_eq!(verify_share(&prop, &pol, expected()[k].as_str().unwrap()).unwrap(), Value::Bool(true));
        }
        let sig = expected()["share_2"].as_str().unwrap().split_once(':').unwrap().1.to_string();
        assert!(verify_share(&prop, &pol, &format!("1:{sig}")).unwrap_err().contains("signer 1's signature does not verify"));
        assert!(verify_share(&prop, &pol, &format!("7:{sig}")).unwrap_err().contains("signer 7 is not in this policy"));
        assert!(verify_share(&prop, &pol, "2:zz").unwrap_err().contains("not hex"));
    }

    #[test]
    fn policy_info_names_the_account_every_signer_compares() {
        let v = policy_info(&fx("policy")).unwrap();
        assert_eq!((&v["fingerprint"], &v["threshold"], &v["signers"]), (&json!("NFYW-K8E9-E5K9-AAK3"), &json!(2), &json!(3)));
        let prop: Value = serde_json::from_str(&fx("proposal-valid")).unwrap();
        assert_eq!(v["policy_hash"], prop["policy"], "the hash a proposal names");
        assert!(v["address"].as_str().unwrap().starts_with("rand1"));
        assert!(policy_info("{\"version\":1,\"threshold\":0,\"signers\":[],\"msk\":\"00\"}").is_err());
    }

    #[test]
    fn the_dispatch_arms_answer_through_call() {
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "expected_recipients": [payee()] });
        let r: Value = serde_json::from_str(&crate::call("msauth_check", &p.to_string())).unwrap();
        assert_eq!(r["ok"], true, "{r}");
        let r: Value = serde_json::from_str(&crate::call("msauth_policy_info", &json!({ "policy": fx("policy") }).to_string())).unwrap();
        assert_eq!(r["value"]["threshold"], 2);
        let s = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "share": expected()["share_0"] });
        let r: Value = serde_json::from_str(&crate::call("msauth_verify_share", &s.to_string())).unwrap();
        assert_eq!(r["value"], true);
    }
}
```

Add `mod msauth;` near the top of `lib.rs` (after the `use` block). Run `cd core && cargo test --release -p wallet-core msauth` → FAIL: `cannot find function check`.

- [ ] **Step 3: Implement** (top of `msauth.rs`, above the tests):

```rust
//! Private multisig signing (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md §2): the
//! `msauth_*` methods of [`crate::dispatch`], over fullnode's `randprotocol-msig` — the same checks
//! the `rand multisig-private` CLI makes. Pure: no I/O. A policy carries the account's `msk` and a
//! proposal its witness; neither is ever written into an error.
use crate::Result;
use randprotocol_core::notes::word8_to_hex;
use randprotocol_msig::{self as msig, Policy, Proposal};
use serde_json::{json, Value};

fn err(e: msig::MsigError) -> String {
    e.to_string()
}

/// A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed.
pub fn clean(s: &str) -> &str {
    s.trim_start_matches('\u{feff}').trim()
}

fn parse_policy(policy: &str) -> Result<Policy> {
    let p: Policy = serde_json::from_str(clean(policy)).map_err(|e| format!("the policy does not parse: {e}"))?;
    p.check().map_err(err)?;
    Ok(p)
}

/// An output a signer must name the payee of: not change, and paying something (a zero-amount
/// output is a dummy slot) — [confirm: 0e] that the crate needs no payee for a dummy.
fn needs_payee(o: &msig::OutputSummary) -> bool {
    !o.to_account && o.amount != 0
}

fn parse_address(a: &str) -> Result<randprotocol_core::notes::ShieldedAddress> {
    randprotocol_core::notes::ShieldedAddress::parse(a.trim()).map_err(|e| format!("expected recipient {}: {e}", a.trim()))
}

/// `check_proposal_expecting` [confirm: 0e], re-shaped to this crate's wire rule (amounts as
/// decimal strings), with fullnode's `lines()` verbatim, each output's `matches` (the expected
/// recipient's address fingerprint, or null) and `needs_payee`, `recipients_checked` (every output
/// that needs a payee matched one — the apps refuse to sign otherwise), and the chain the proposal
/// names (`chain_id`, `genesis`, `binding_domain`) for the caller's comparison with its node.
pub fn check(proposal: &str, policy: &str, expected_recipients: &[String]) -> Result<Value> {
    let (proposal, policy) = (clean(proposal), clean(policy));
    let expected = expected_recipients.iter().map(|a| parse_address(a)).collect::<Result<Vec<_>>>()?;
    let given = (!expected.is_empty()).then_some(&expected[..]);
    let s = msig::check_proposal_expecting(proposal, policy, given).map_err(err)?; // [confirm: 0e]
    let p: Proposal = serde_json::from_str(proposal).map_err(|e| format!("the proposal does not parse: {e}"))?;
    let outputs: Vec<Value> = s
        .outputs
        .iter()
        .map(|o| json!({
            "owner_fingerprint": o.owner_fingerprint, "to_account": o.to_account, "amount": o.amount.to_string(),
            "asset": o.asset, "memo": o.memo,
            "matches": o.matches, // [confirm: 0e] the field's name and type (Option<String>)
            "needs_payee": needs_payee(o),
        }))
        .collect();
    let recipients_checked = s.outputs.iter().filter(|o| needs_payee(o)).all(|o| o.matches.is_some());
    Ok(json!({
        "outputs": outputs,
        "recipients_checked": recipients_checked,
        "fee": s.fee.to_string(),
        "burns": { "burn_a": s.burns.burn_a.to_string(), "burn_asset": s.burns.burn_asset, "burn_r": s.burns.burn_r.to_string() },
        "expires_at": s.expires_at,
        "signing_message": hex::encode(s.signing_message),
        "policy_fingerprint": s.policy_fingerprint,
        "lines": s.lines(),
        "chain_id": p.chain_id,
        "genesis": p.genesis,
        "binding_domain": p.binding_domain,
    }))
}

/// `verify_share`: `true`, or the refusal.
pub fn verify_share(proposal: &str, policy: &str, share: &str) -> Result<Value> {
    msig::verify_share(clean(proposal), clean(policy), clean(share)).map_err(err)?;
    Ok(Value::Bool(true))
}

/// What a signer compares out of band before saving a profile.
pub fn policy_info(policy: &str) -> Result<Value> {
    let p = parse_policy(policy)?;
    Ok(json!({
        "fingerprint": p.fingerprint(),
        "threshold": p.threshold,
        "signers": p.signers.len(),
        "address": p.address().to_string(),
        "policy_hash": word8_to_hex(&p.policy_hash()),
    }))
}
```

`lib.rs` `dispatch`, before `other =>`:

```rust
        // Private multisig signing (msauth.rs).
        "msauth_check" => {
            let expected: Vec<String> = match params.get("expected_recipients") {
                None | Some(Value::Null) => vec![],
                Some(v) => serde_json::from_value(v.clone()).map_err(|_| "expected_recipients must be a list of addresses".to_string())?,
            };
            msauth::check(str_param(params, "proposal")?, str_param(params, "policy")?, &expected)
        }
        "msauth_verify_share" => msauth::verify_share(str_param(params, "proposal")?, str_param(params, "policy")?, str_param(params, "share")?),
        "msauth_policy_info" => msauth::policy_info(str_param(params, "policy")?),
```

Add to the `dispatch` doc list:

```rust
/// - `msauth_check` `{proposal, policy, expected_recipients?}` → the checked summary (each output's
///   `matches`/`needs_payee`, `recipients_checked`) (fullnode `check_proposal`, amounts as
///   strings, `lines` verbatim, the proposal's `chain_id`/`genesis`/`binding_domain`). No RPC: the
///   caller compares `expires_at` with its node's head (refuse at `head + 16 >= expires_at`)
/// - `msauth_verify_share` `{proposal, policy, share}` → `true` when `share` (`i:hex`) verifies
/// - `msauth_policy_info` `{policy}` → `{fingerprint, threshold, signers, address, policy_hash}`
```

- [ ] **Step 4: Run** `cd core && cargo test --release -p wallet-core msauth` → all PASS.
- [ ] **Step 5: Commit** `git add ui/test/fixtures/msauth ui/test/msauth-fixtures.test.mjs core/crates/wallet-core/src` — message `core: msauth_check, msauth_verify_share, msauth_policy_info over randprotocol-msig; the ten e34117be vectors under ui/test/fixtures/msauth` + trailer.

---

### Task 4: Core — `msauth_signer_import`, `msauth_sign`; the real wasm on the vectors

**Files:**
- Modify: `core/crates/wallet-core/src/msauth.rs`, `core/crates/wallet-core/src/lib.rs` (two arms + doc), `web/wallet/test/core.integration.test.mjs` (new test)

**Interfaces:**
- Produces: `msauth::signer_import(input: &str, policy: Option<&str>) -> Result<Value>` → `{seed: "<64 hex>", public_key: "<hex>", address: "<base58>", index: <n>|null}`; `msauth::sign(proposal, policy, seed_hex) -> Result<Value>` → `"i:hex"`. Dispatch `msauth_signer_import {input, policy?}`, `msauth_sign {proposal, policy, seed}`. Sentences: `SIGNER_KEY_SHAPE = "a signer key is a rand-node keygen file or 64 hex characters"`, `"a signer seed is 64 hex characters"`, `"the key file's public_key is not the one its seed derives"`, `"the key file's address is not the one its seed derives"`, `"this key is not one of the policy's signers"` (fullnode's wording).

- [ ] **Step 1: Failing tests** (append to `msauth.rs` tests):

```rust
    fn seeds() -> (Vec<String>, String) {
        let v: Value = serde_json::from_str(&fx("signer-seeds")).unwrap();
        (v["members"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect(), v["non_member"].as_str().unwrap().to_string())
    }

    #[test]
    fn members_0_and_2_sign_the_expected_shares() {
        let (m, _) = seeds();
        for (i, want) in [(0usize, "share_0"), (2, "share_2")] {
            let share = sign(&fx("proposal-valid"), &fx("policy"), &m[i]).unwrap();
            assert_eq!(share, expected()[want], "deterministic Dilithium2 reproduces the vector");
        }
    }

    #[test]
    fn an_outsider_a_bad_proposal_or_a_bad_seed_signs_nothing() {
        let (m, outsider) = seeds();
        assert!(sign(&fx("proposal-valid"), &fx("policy"), &outsider).unwrap_err().contains("not one of the policy's signers"));
        assert!(sign(&fx("proposal-unbound"), &fx("policy"), &m[0]).unwrap_err().contains("binding"));
        let e = sign(&fx("proposal-valid"), &fx("policy"), "zz").unwrap_err();
        assert_eq!(e, "a signer seed is 64 hex characters", "never echoes the seed");
    }

    #[test]
    fn import_reads_a_keygen_file_or_bare_hex_and_finds_the_position() {
        let (m, outsider) = seeds();
        let kp = randprotocol_core::Keypair::from_seed(hex::decode(&m[2]).unwrap().try_into().unwrap()).unwrap();
        let file = json!({ "seed": m[2], "address": kp.address().to_base58(), "public_key": kp.public_key().to_hex() }).to_string();
        let v = signer_import(&file, Some(&fx("policy"))).unwrap();
        assert_eq!((&v["seed"], &v["index"], &v["public_key"]), (&json!(m[2]), &json!(2), &json!(kp.public_key().to_hex())));
        assert_eq!(signer_import(&m[0], Some(&fx("policy"))).unwrap()["index"], 0);
        assert_eq!(signer_import(&m[0], None).unwrap()["index"], Value::Null);
        assert_eq!(signer_import(&outsider, Some(&fx("policy"))).unwrap_err(), "this key is not one of the policy's signers");
        let lying = json!({ "seed": m[2], "address": kp.address().to_base58(), "public_key": "00".repeat(1312) }).to_string();
        assert_eq!(signer_import(&lying, None).unwrap_err(), "the key file's public_key is not the one its seed derives");
        assert_eq!(signer_import("{\"spend_key\":\"aa\"}", None).unwrap_err(), SIGNER_KEY_SHAPE);
        assert_eq!(signer_import("nope", None).unwrap_err(), SIGNER_KEY_SHAPE);
    }

    #[test]
    fn sign_answers_through_call() {
        let (m, _) = seeds();
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "seed": m[0] });
        let r: Value = serde_json::from_str(&crate::call("msauth_sign", &p.to_string())).unwrap();
        assert_eq!(r["value"], expected()["share_0"]);
    }
```

Run `cd core && cargo test --release -p wallet-core msauth` → FAIL (`sign`, `signer_import` undefined).

- [ ] **Step 2: Implement** (in `msauth.rs`, above the tests):

```rust
use randprotocol_core::Keypair;
use zeroize::Zeroizing;

pub const SIGNER_KEY_SHAPE: &str = "a signer key is a rand-node keygen file or 64 hex characters";

/// A seed in a buffer that is wiped when dropped. The error never repeats the input.
fn seed_from_hex(s: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mut seed = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(s.trim(), &mut seed[..]).map_err(|_| "a signer seed is 64 hex characters".to_string())?;
    Ok(seed)
}

/// A `rand-node keygen` file (`{seed, address, public_key}`) or a bare 64-hex seed: the seed, the
/// key it derives, and — given the policy — this key's position in it (refused if absent). A file
/// whose `public_key` or `address` is not its seed's is refused.
pub fn signer_import(input: &str, policy: Option<&str>) -> Result<Value> {
    let input = clean(input);
    let (seed, claimed_pk, claimed_address) = if input.starts_with('{') {
        let v: Value = serde_json::from_str(input).map_err(|_| SIGNER_KEY_SHAPE.to_string())?;
        let s = v["seed"].as_str().ok_or(SIGNER_KEY_SHAPE)?;
        (seed_from_hex(s).map_err(|_| SIGNER_KEY_SHAPE.to_string())?, v["public_key"].as_str().map(str::to_owned), v["address"].as_str().map(str::to_owned))
    } else {
        (seed_from_hex(input).map_err(|_| SIGNER_KEY_SHAPE.to_string())?, None, None)
    };
    let kp = Keypair::from_seed(*seed).map_err(|e| format!("the signer seed: {e}"))?;
    let public_key = kp.public_key().to_hex();
    if claimed_pk.is_some_and(|c| !c.trim().eq_ignore_ascii_case(&public_key)) {
        return crate::bad("the key file's public_key is not the one its seed derives");
    }
    let address = kp.address().to_base58();
    if claimed_address.is_some_and(|a| a.trim() != address) {
        return crate::bad("the key file's address is not the one its seed derives");
    }
    let index = match policy {
        None => Value::Null,
        Some(pol) => {
            let pks = parse_policy(pol)?.pks().map_err(err)?;
            let i = pks.iter().position(|k| k[..] == kp.public_key().as_bytes()[..]).ok_or("this key is not one of the policy's signers")?;
            json!(i)
        }
    };
    Ok(json!({ "seed": hex::encode(&seed[..]), "public_key": public_key, "address": address, "index": index }))
}

/// `sign`: the share `"i:hex"`. Every check `check` makes runs first (fullnode's `sign` re-runs them).
pub fn sign(proposal: &str, policy: &str, seed_hex: &str) -> Result<Value> {
    let seed = seed_from_hex(seed_hex)?;
    let (i, sig) = msig::sign(clean(proposal), clean(policy), &seed).map_err(err)?;
    Ok(Value::String(format!("{i}:{}", hex::encode(sig))))
}
```

Dispatch arms:

```rust
        "msauth_signer_import" => msauth::signer_import(str_param(params, "input")?, params.get("policy").and_then(Value::as_str)),
        "msauth_sign" => msauth::sign(str_param(params, "proposal")?, str_param(params, "policy")?, str_param(params, "seed")?),
```

Doc lines:

```rust
/// - `msauth_signer_import` `{input, policy?}` → `{seed, public_key, address, index}`: a `rand-node
///   keygen` file or 64 hex; a file whose `public_key`/`address` is not its seed's is refused; with
///   `policy`, a key outside it is refused ("this key is not one of the policy's signers")
/// - `msauth_sign` `{proposal, policy, seed}` → `"i:hex"`: every `msauth_check` check, then the
///   deterministic Dilithium2 share. `seed` is wiped here after use; the caller wipes its own copy
```

- [ ] **Step 3: Run** `cd core && cargo test --release -p wallet-core msauth` → PASS; then `cd core && cargo test --release` → all PASS.
- [ ] **Step 4: Real wasm test.** Append to `web/wallet/test/core.integration.test.mjs` (it already loads the real wasm and skips without it; reuse its core-loading helper — the variable it calls `call`/`core` there):

```js
test('the wasm core checks and signs fullnode\'s private-multisig vectors exactly', { skip }, async () => {
  const fx = (n) => readFileSync(new URL(`../../../ui/test/fixtures/msauth/${n}.json`, import.meta.url), 'utf8');
  const expected = JSON.parse(fx('expected'));
  const seeds = JSON.parse(fx('signer-seeds'));
  const payee = JSON.parse(fx('proposal-valid')).summary[0].split(' ').pop();
  const s = await core.call('msauth_check', { proposal: fx('proposal-valid'), policy: fx('policy'), expected_recipients: [payee] });
  assert.equal(s.recipients_checked, true);
  assert.equal(s.policy_fingerprint, 'NFYW-K8E9-E5K9-AAK3');
  assert.equal(s.outputs[2].amount, '10000000000');
  assert.ok(s.lines.slice(0, 4).every((l) => l.includes('owner key verified')));
  assert.equal(await core.call('msauth_sign', { proposal: fx('proposal-valid'), policy: fx('policy'), seed: seeds.members[2] }), expected.share_2);
  assert.equal(await core.call('msauth_verify_share', { proposal: fx('proposal-valid'), policy: fx('policy'), share: expected.share_0 }), true);
  await assert.rejects(core.call('msauth_check', { proposal: fx('proposal-unbound'), policy: fx('policy') }), /does not hash to the proposal's binding/);
});
```

Run `core/scripts/build-wasm.sh && node --test web/wallet/test/core.integration.test.mjs` → PASS (df check first).
- [ ] **Step 5: Commit** `core: msauth_signer_import and msauth_sign (seed in Zeroizing); the wasm signs the e34117be vectors exactly` + trailer.

---

### Task 5: JS core layer — `coreApi` wrappers, byte vault records, msig sentences

**Files:**
- Modify: `ui/engine/wallet.js` (`coreApi`), `ui/engine/crypto.js`, `ui/engine/core-errors.js`, `ui/test/core-errors.test.mjs`
- Create: `ui/test/crypto-bytes.test.mjs`

**Interfaces:**
- Produces: `coreApi(core).msauthCheck(proposal, policy, expectedRecipients = [])`, `.msauthSign(proposal, policy, seedHex)`, `.msauthVerifyShare(proposal, policy, share)`, `.msauthSignerImport(input, policy?)`, `.msauthPolicyInfo(policy)`; `crypto.js` `encryptBytes(password, Uint8Array) -> vault`, `decryptBytes(password, vault) -> Uint8Array` (throws `wrong password`); `encryptSecret` becomes `encryptBytes(password, enc.encode(plaintext))`.

- [ ] **Step 1: Failing tests.** `ui/test/crypto-bytes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBytes, decryptBytes, encryptSecret, decryptSecret } from '../engine/crypto.js';

test('a byte record opens to the same bytes, and only with its password', async () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const rec = await encryptBytes('pw-long-enough', seed);
  assert.deepEqual(await decryptBytes('pw-long-enough', rec), seed);
  await assert.rejects(decryptBytes('another-password', rec), /wrong password/);
  assert.equal(await decryptSecret('pw-long-enough', await encryptSecret('pw-long-enough', 'text')), 'text', 'string records unchanged');
});
```

In `ui/test/core-errors.test.mjs` add:

```js
test('the private-multisig refusals are translated, values kept', async (t) => {
  await setLocale('de', { dictionary: {
    'output {slot} does not open as this account\'s: refusing to sign value it cannot see': 'DE: Ausgabe {slot} öffnet nicht',
    'this key is not one of the policy\'s signers': 'DE: kein Unterzeichner',
  } });
  t.after(() => setLocale('en'));
  assert.equal(translateCoreError('output 2 does not open as this account\'s: refusing to sign value it cannot see'), 'DE: Ausgabe 2 öffnet nicht');
  assert.equal(translateCoreError('this key is not one of the policy\'s signers'), 'DE: kein Unterzeichner');
});

test('coreApi names the five msauth methods', async () => {
  const seen = [];
  const api = coreApi({ async call(m, p) { seen.push([m, p]); return true; } });
  await api.msauthCheck('P', 'Q', ['rand1a']);
  await api.msauthSign('P', 'Q', 'S');
  await api.msauthVerifyShare('P', 'Q', '0:aa');
  await api.msauthSignerImport('K', 'Q');
  await api.msauthSignerImport('K');
  await api.msauthPolicyInfo('Q');
  assert.deepEqual(seen, [
    ['msauth_check', { proposal: 'P', policy: 'Q', expected_recipients: ['rand1a'] }], ['msauth_sign', { proposal: 'P', policy: 'Q', seed: 'S' }],
    ['msauth_verify_share', { proposal: 'P', policy: 'Q', share: '0:aa' }], ['msauth_signer_import', { input: 'K', policy: 'Q' }],
    ['msauth_signer_import', { input: 'K' }], ['msauth_policy_info', { policy: 'Q' }],
  ]);
});
```

Run `node --test ui/test/crypto-bytes.test.mjs ui/test/core-errors.test.mjs` → FAIL.

- [ ] **Step 2: Implement.** `crypto.js`:

```js
/** Returns a vault object safe to persist, over raw bytes (a signer seed). */
export async function encryptBytes(password, bytes) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { v: VAULT_VERSION, kdf: 'pbkdf2-sha256', iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Returns a vault object safe to persist. */
export async function encryptSecret(password, plaintext) {
  return encryptBytes(password, enc.encode(plaintext));
}

/**
 * Opens a byte record into a fresh `Uint8Array` the caller must `fill(0)` when done — the one
 * buffer JavaScript can wipe (a string cannot be). Same refusals as `decryptSecret`.
 */
export async function decryptBytes(password, vault) {
  const iterations = checkVault(vault);
  const key = await deriveKey(password, unb64(vault.salt), iterations, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct)));
  } catch {
    throw new Error('wrong password');
  }
}

export async function decryptSecret(password, vault) {
  const bytes = await decryptBytes(password, vault);
  return dec.decode(bytes);
}
```

(Replace the old `encryptSecret`/`decryptSecret` bodies; keep their doc comments.)

`wallet.js` `coreApi` return object, after `proverFingerprint`:

```js
    // Private multisig signing (wallet-core msauth.rs): check, sign, verify a share, import a
    // signer key, describe a policy. `seed` is 64 hex; never log a call's params.
    msauthCheck: (proposal, policy, expected_recipients = []) => call('msauth_check', { proposal, policy, expected_recipients }),
    msauthSign: (proposal, policy, seed) => call('msauth_sign', { proposal, policy, seed }),
    msauthVerifyShare: (proposal, policy, share) => call('msauth_verify_share', { proposal, policy, share }),
    msauthSignerImport: (input, policy) => call('msauth_signer_import', policy ? { input, policy } : { input }),
    msauthPolicyInfo: (policy) => call('msauth_policy_info', { policy }),
```

`core-errors.js` — `EXACT` additions:

```js
  // ---- private multisig signing (`msauth_*`, fullnode randprotocol-msig) ----
  ['the transaction does not hash to the proposal\'s binding', () => t('the transaction does not hash to the proposal\'s binding')],
  ['the proposal\'s signing_message is not its binding\'s', () => t('the proposal\'s signing_message is not its binding\'s')],
  ['the proposal\'s auth_commit is not this policy\'s account', () => t('the proposal\'s auth_commit is not this policy\'s account')],
  ['the proposal\'s expected digest is not its bundle\'s', () => t('the proposal\'s expected digest is not its bundle\'s')],
  ['the transaction carries no bundle', () => t('the transaction carries no bundle')],
  ['the transaction carries an action; a private multisig proposal is a payment from its bundle alone',
    () => t('the transaction carries an action; a private multisig proposal is a payment from its bundle alone')],
  ['the witness\'s value cannot be checked: its nk or salt is not this proposal\'s', () => t('the witness\'s value cannot be checked: its nk or salt is not this proposal\'s')],
  ['this key is not one of the policy\'s signers', () => t('this key is not one of the policy\'s signers')],
  ['a share is index:hex', () => t('a share is index:hex')],
  ['a signer key is a rand-node keygen file or 64 hex characters', () => t('a signer key is a rand-node keygen file or 64 hex characters')],
  ['a signer seed is 64 hex characters', () => t('a signer seed is 64 hex characters')],
  ['expected_recipients must be a list of addresses', () => t('expected_recipients must be a list of addresses')],
  ['the key file\'s public_key is not the one its seed derives', () => t('the key file\'s public_key is not the one its seed derives')],
  ['the key file\'s address is not the one its seed derives', () => t('the key file\'s address is not the one its seed derives')],
```

`PATTERNED` additions (before the `// ---- proving on this device ----` block):

```js
  // ---- private multisig signing ----
  [/^this proposal is for another policy: it names ([0-9a-f]+), this policy is ([0-9a-f]+)$/,
    (m) => t('this proposal is for another policy: it names {theirs}, this policy is {ours}', { theirs: m[1], ours: m[2] })],
  [/^output (\d+) does not open as this account's: refusing to sign value it cannot see$/,
    (m) => t('output {slot} does not open as this account\'s: refusing to sign value it cannot see', { slot: m[1] })],
  [/^the witness's value does not match the transaction: input (\d+) does not nullify to the bundle's nullifier$/,
    (m) => t('the witness\'s value does not match the transaction: input {input} does not nullify to the bundle\'s nullifier', { input: m[1] })],
  [/^the witness's value does not match the outputs: asset (\d+) has (\d+) in and (\d+) out with the fee and burns$/,
    (m) => t('the witness\'s value does not match the outputs: asset {asset} has {held} in and {spent} out with the fee and burns', { asset: m[1], held: m[2], spent: m[3] })],
  [/^the proposal expires at (\d+), outside its bundle's window \((\d+), (\d+)\]$/,
    (m) => t('the proposal expires at {expires}, outside its bundle\'s window ({from}, {to}]', { expires: m[1], from: m[2], to: m[3] })],
  [/^the transaction is for chain (\d+), the proposal says chain (\d+)$/,
    (m) => t('the transaction is for chain {tx}, the proposal says chain {proposal}', { tx: m[1], proposal: m[2] })],
  [/^signer (\d+)'s signature does not verify over this proposal$/, (m) => t('signer {index}\'s signature does not verify over this proposal', { index: m[1] })],
  [/^signer (\d+) is not in this policy \(it has (\d+) signers\)$/, (m) => t('signer {index} is not in this policy (it has {count} signers)', { index: m[1], count: m[2] })],
  [/^expected recipient (\S+): ([\s\S]+)$/, (m, inner) => t('expected recipient {address}: {reason}', { address: m[1], reason: inner(m[2]) })],
  [/^the policy does not parse: ([\s\S]+)$/, (m) => t('the policy does not parse: {reason}', { reason: m[1] })],
  [/^the proposal does not parse: ([\s\S]+)$/, (m) => t('the proposal does not parse: {reason}', { reason: m[1] })],
```

Then `node ui/scripts/extract-strings.mjs` (regenerates `en.js`; the locales are filled in Task 9 — until then `i18n.test.mjs` fails on the dictionaries only, which Task 9 fixes; run the two new test files here).

- [ ] **Step 3: Run** `node --test ui/test/crypto-bytes.test.mjs ui/test/core-errors.test.mjs ui/test/backend-wasm.test.mjs ui/test/backend-native.test.mjs` → PASS.
- [ ] **Step 4: Commit** `ui: coreApi's msauth methods, byte vault records, the msig refusals in core-errors` + trailer.

---

### Task 6: Engine — signer profiles (`list`, `preview`, `add`, `remove`) in the vault

**Files:**
- Create: `ui/engine/signers.js`, `ui/test/signers-engine.test.mjs`
- Modify: `ui/engine/backend-shared.js` (`passwordAttempt`, `openVault` over it, `startSession`, `unlock`, backend object), `ui/backend.js` (contract doc for optional `signers`), `ui/test/fake-backend.mjs` (`signers` group)

**Interfaces:**
- Consumes: Task 5's `coreApi` methods, `encryptSecret`, `decryptSecret`, `encryptBytes`.
- Produces: `makeSigners(deps) -> { group, openOnUnlock(password) }` where `deps = { c, storage, requireUnlocked, setSession(record), openVault(password), passwordAttempt(open), requireVerifiedChain(), getSettings(), currentRpcUrl() }`. `group` (= `backend.signers`): `list() -> [{id, label, index, fingerprint, threshold, signers, address}]`; `preview({policy, key}) -> {fingerprint, threshold, signers, address, policyHash, index, publicKey}`; `add({label, policy, key, password}) -> list`; `remove(id, password) -> list`. Storage keys `SIGNER_POLICIES_KEY = 'signerPolicies'` (one `encryptSecret` record of `JSON [{id, label, policy, index, policyHash}]`), `SIGNER_SEEDS_KEY = 'signerSeeds'` (`{[id]: encryptBytes record}`). Session record `unlocked.signers` = that decrypted array. Exports `cleanText(s)`, `EXPIRY_MARGIN = 16`, `SignerRefusal`.

- [ ] **Step 1: Failing tests.** `ui/test/signers-engine.test.mjs`:

```js
// The engine's signer profiles (spec 2026-10-11-msauth-signing-design.md §3): kept in the vault,
// policies opened at unlock, seeds only under the password, nothing in plain storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend } from '../engine/backend-wasm.js';
import { PASSWORD, mapStorage, stubCore, stubFetch, stubPlatform, GENESIS } from './backend-fixtures.mjs';

export const POLICY = '{"version":1,"threshold":2,"signers":["aa","bb","cc"],"msk":"' + '11'.repeat(32) + '"}';
export const KEY = '{"seed":"' + '22'.repeat(32) + '","address":"A","public_key":"bb"}';
export const SEED_HEX = '22'.repeat(32);
export function msauthCore(extra = {}) {
  return stubCore({
    msauth_policy_info: () => ({ fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60), policy_hash: '33'.repeat(32) }),
    msauth_signer_import: ({ input, policy }) => {
      if (!String(input).includes(SEED_HEX)) throw new Error('this key is not one of the policy\'s signers');
      return { seed: SEED_HEX, public_key: 'bb', address: 'A', index: policy ? 1 : null };
    },
    ...extra,
  });
}
export async function unlockedWithSigner(opts = {}) {
  const storage = opts.storage || mapStorage();
  const core = opts.core || msauthCore();
  const fetch = opts.fetch || stubFetch();
  const backend = makeWasmBackend({ core, storage, platform: stubPlatform(), fetch, locks: null, broadcast: null });
  await backend.wallet.create(PASSWORD);
  const [row] = await backend.signers.add({ label: 'treasury', policy: POLICY, key: KEY, password: PASSWORD });
  return { backend, storage, core, fetch, row };
}

test('adding a signer keeps policy and seed only in vault records', async () => {
  const { storage, row } = await unlockedWithSigner();
  assert.deepEqual({ ...row, id: 'x' }, { id: 'x', label: 'treasury', index: 1, fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60) });
  const everything = JSON.stringify([...storage.local.entries()]);
  assert.ok(!everything.includes(SEED_HEX), 'no seed in plain storage');
  assert.ok(!everything.includes('11'.repeat(32)), 'no msk in plain storage');
  assert.ok(!everything.includes('treasury'), 'no label in plain storage');
  assert.ok(storage.local.get('signerPolicies').ct && storage.local.get('signerSeeds')[row.id].ct);
  const session = JSON.stringify([...storage.sessionMap.entries()]);
  assert.ok(!session.includes(SEED_HEX), 'the seed is never in the session');
});

test('profiles survive a lock and come back with the normal unlock', async () => {
  const { backend, row } = await unlockedWithSigner();
  await backend.wallet.lock();
  await assert.rejects(backend.signers.list());
  await backend.wallet.unlock(PASSWORD);
  assert.deepEqual((await backend.signers.list()).map((r) => r.id), [row.id]);
});

test('add refuses a wrong password, a key outside the policy and a duplicate', async () => {
  const { backend } = await unlockedWithSigner();
  await assert.rejects(backend.signers.add({ label: 'x', policy: POLICY, key: KEY, password: 'wrong-password-here' }), /already saved as treasury/);
  await assert.rejects(backend.signers.add({ label: 'y', policy: POLICY, key: '{"seed":"' + '44'.repeat(32) + '"}', password: PASSWORD }), /not one of the policy's signers/);
  await assert.rejects(backend.signers.add({ label: '', policy: POLICY, key: KEY, password: PASSWORD }), /1-64 characters/);
  const fresh = await unlockedWithSigner({ core: msauthCore() }).then(async ({ backend: b, row }) => { await b.signers.remove(row.id, PASSWORD); return b; });
  await assert.rejects(fresh.signers.add({ label: 'z', policy: POLICY, key: KEY, password: 'wrong-password-here' }), /wrong password/);
});

test('remove deletes both halves, and only with the password', async () => {
  const { backend, storage, row } = await unlockedWithSigner();
  await assert.rejects(backend.signers.remove(row.id, 'wrong-password-here'), /wrong password/);
  assert.deepEqual(await backend.signers.remove(row.id, PASSWORD), []);
  assert.equal(storage.local.get('signerSeeds')[row.id], undefined);
});

test('a BOM-prefixed policy or key file is read like any other', async () => {
  const { backend } = await unlockedWithSigner();
  const p = await backend.signers.preview({ policy: `﻿${POLICY}\n`, key: `﻿${KEY}\r\n` });
  assert.equal(p.index, 1);
});

test('a wipe removes every profile', async () => {
  const { backend, storage } = await unlockedWithSigner();
  await backend.wallet.wipe();
  assert.equal(storage.local.get('signerPolicies'), undefined);
});
```

Run `node --test ui/test/signers-engine.test.mjs` → FAIL (`backend.signers` undefined).

- [ ] **Step 2: `ui/engine/signers.js`** (the profile half; Task 7 adds `check`/`sign`/`verifyShare` to the same `group`):

```js
// Private multisig signer profiles (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md
// §3, §4) for the shared engine: web, extension, desktop.
//
// A profile is {label, policy, seed}; both halves are secret (the seed signs, the policy's `msk`
// sees every note of the account). Storage holds two vault records: `signerPolicies`, ONE
// `encryptSecret` record of every profile's {id, label, policy, index, policyHash}, opened at unlock
// into the session beside the spend key; and `signerSeeds`, one `encryptBytes` record per seed,
// opened only by `sign()` with the password typed for that signature — never at unlock, never kept.
import { encryptSecret, decryptSecret, encryptBytes, decryptBytes } from './crypto.js';
import { t } from '../i18n.js';

export const SIGNER_POLICIES_KEY = 'signerPolicies';
export const SIGNER_SEEDS_KEY = 'signerSeeds';
/** Blocks a proposal needs before its window closes: the CLI's `EXPIRY_MARGIN` (fullnode d5b2e652). */
export const EXPIRY_MARGIN = 16;

export class SignerRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SignerRefusal';
    this.code = code;
    this.definite = true;
    Object.assign(this, detail);
  }
}

/** A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed. */
export function cleanText(s) {
  return String(s ?? '').replace(/^﻿/, '').trim();
}

export const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export function bytesOf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const randomId = () => hexOf(crypto.getRandomValues(new Uint8Array(8)));

function validProfiles(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((p) => p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.policy === 'string'
    && Number.isInteger(p.index) && typeof p.policyHash === 'string');
}

export function makeSigners(deps) {
  const { c, storage, requireUnlocked, setSession, openVault } = deps;

  async function profiles() {
    const u = await requireUnlocked();
    return validProfiles(u.signers);
  }
  async function profileOf(id) {
    const p = (await profiles()).find((x) => x.id === id);
    if (!p) throw new Error(t('No such signer profile.'));
    return p;
  }
  async function requirePassword(password) {
    if ((await openVault(password)) === null) throw new Error('wrong password');
  }
  async function writeProfiles(password, list) {
    await storage.set(SIGNER_POLICIES_KEY, await encryptSecret(password, JSON.stringify(list)));
    await setSession({ ...(await requireUnlocked()), signers: list });
  }
  async function row(p) {
    const info = await c.msauthPolicyInfo(p.policy);
    return { id: p.id, label: p.label, index: p.index, fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address };
  }
  async function list() {
    return Promise.all((await profiles()).map(row));
  }

  const group = {
    list,
    async preview({ policy, key }) {
      const pol = cleanText(policy);
      const info = await c.msauthPolicyInfo(pol);
      const signer = await c.msauthSignerImport(cleanText(key), pol);
      return { fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address, policyHash: info.policy_hash, index: signer.index, publicKey: signer.public_key };
    },
    async add({ label, policy, key, password }) {
      const name = String(label ?? '').trim();
      if (!name || [...name].length > 64) throw new Error(t('a signer label is 1-64 characters'));
      const pol = cleanText(policy);
      const info = await c.msauthPolicyInfo(pol);
      const signer = await c.msauthSignerImport(cleanText(key), pol);
      const current = await profiles();
      const same = current.find((p) => p.policyHash === info.policy_hash && p.index === signer.index);
      if (same) throw new Error(t('this signer is already saved as {label}', { label: same.label }));
      await requirePassword(password);
      const id = randomId();
      const seed = bytesOf(signer.seed);
      try {
        const seeds = (await storage.get(SIGNER_SEEDS_KEY)) || {};
        seeds[id] = await encryptBytes(password, seed);
        await storage.set(SIGNER_SEEDS_KEY, seeds);
      } finally {
        seed.fill(0);
      }
      await writeProfiles(password, [...current, { id, label: name, policy: pol, index: signer.index, policyHash: info.policy_hash }]);
      return list();
    },
    async remove(id, password) {
      await profileOf(id);
      await requirePassword(password);
      const seeds = (await storage.get(SIGNER_SEEDS_KEY)) || {};
      delete seeds[id];
      await storage.set(SIGNER_SEEDS_KEY, seeds);
      await writeProfiles(password, (await profiles()).filter((p) => p.id !== id));
      return list();
    },
  };

  /** The profiles, opened with the password that just opened the vault; `[]` if none or unreadable. */
  async function openOnUnlock(password) {
    const rec = await storage.get(SIGNER_POLICIES_KEY);
    if (!rec) return [];
    try { return validProfiles(JSON.parse(await decryptSecret(password, rec))); } catch { return []; }
  }

  return { group, openOnUnlock, profileOf, deps, decryptBytes };
}
```

- [ ] **Step 3: Wire into `backend-shared.js`.**
  - Import: `import { makeSigners } from './signers.js';`
  - Replace `openVault` with a shared attempt and the vault read:

```js
  /**
   * One password attempt through the shared throttle: queued, delayed by the failure count, counted
   * before the KDF runs, cleared on success. `open()` resolves the plaintext or throws; a record
   * error (`isVaultRecordError`) is rethrown and not counted as a wrong password. Used by the
   * unlock and by every signer signature (signers.js).
   */
  function passwordAttempt(open) {
    return enqueueAttempt(async () => {
      const rec = await failureRecord();
      await sleep(unlockDelayMs(rec.count));
      await bumpFailures(rec);
      let value;
      try {
        value = await open();
      } catch (err) {
        if (isVaultRecordError(err)) throw err;
        return null;
      }
      await clearFailures();
      return value;
    });
  }

  async function openVault(password) {
    const vault = await storage.get(K.vault);
    if (!vault) throw new Error(t('no wallet on this device'));
    checkVault(vault); // VaultVersionError / VaultDamagedError — not an attempt
    return passwordAttempt(() => decryptSecret(password, vault));
  }
```

  (Keep `openVault`'s doc comment; the `no wallet` and `checkVault` checks still run before any count.)
  - `startSession(info, pairing, signerProfiles = [])`: add `record.signers = signerProfiles;` after `record.prover`.
  - After `const engine = makeWallet(...)`:

```js
  const signers = makeSigners({
    c, storage, requireUnlocked, openVault, passwordAttempt, requireVerifiedChain, getSettings, currentRpcUrl,
    setSession: (record) => storage.session.set(K.unlocked, record),
  });
```

  - `wallet.unlock`: `await startSession(info, await openProverPairing(password), await signers.openOnUnlock(password));`
  - Backend object: `const backend = { wallet, sync, assets, send, faucet, rpc, settings, platform, address, contacts, prover, signers: signers.group, dispose };`
  - `ui/backend.js` optional-groups doc: add

```js
 *  - `signers?` — private multisig signer profiles (spec 2026-10-11-msauth-signing-design.md):
 *    `list()`, `preview({policy, key})`, `add({label, policy, key, password})`, `remove(id, password)`,
 *    `check(id, proposal, expectedRecipients)` → `{summary, signable, refusal?, head?, blocksLeft?}`,
 *    `sign(id, proposal, expectedRecipients, password)` → `{share, index}`, `verifyShare(id, proposal, share)` → `{index}`.
 *    Screens offer Settings → Multisig signers only where it exists.
```

  - `ui/test/fake-backend.mjs`: add `signers: []` to `state` and a group (Task 8's screen tests drive it):

```js
  const signersDefs = {
    list: () => state.signers.map(({ id, label, index }) => ({ id, label, index, fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(40) })),
    preview: () => ({ fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(40), policyHash: '33'.repeat(32), index: 1, publicKey: 'bb' }),
    add: ({ label, password }) => {
      if (password !== state.wallet.password) throw new Error('wrong password');
      state.signers.push({ id: `s${state.signers.length + 1}`, label, index: 1 });
      return signersDefs.list();
    },
    remove: (id) => { state.signers = state.signers.filter((s) => s.id !== id); return signersDefs.list(); },
    check: () => state.signerCheck,
    sign: (id, proposal, expected, password) => {
      if (password !== state.wallet.password) throw new Error('wrong password');
      state.signCalls = (state.signCalls || 0) + 1;
      return { share: '1:' + 'ab'.repeat(8), index: 1 };
    },
    verifyShare: (id, proposal, share) => ({ index: Number(String(share).split(':')[0]) }),
  };
```

  with `signers: buildGroup('signers', signersDefs, overrides.signers, calls),` in the backend object, and `state.signerCheck` defaulting to `{ summary: FAKE_SUMMARY, signable: true, head: 100, blocksLeft: 1924 }` where

```js
export const FAKE_SUMMARY = Object.freeze({
  outputs: [
    { owner_fingerprint: 'cb5c9747f9a2ef35', to_account: false, amount: '0', asset: 0, memo: '', matches: null, needs_payee: false },
    { owner_fingerprint: '2c94b28813d4ce65', to_account: false, amount: '0', asset: 0, memo: '', matches: null, needs_payee: false },
    { owner_fingerprint: '35bad5bd21a6f0f7', to_account: false, amount: '10000000000', asset: 0, memo: '', matches: 'ABCD-EFGH-JKMN-PQRS', needs_payee: true },
    { owner_fingerprint: '4333dd507bcc4286', to_account: true, amount: '14999000000', asset: 0, memo: '', matches: null, needs_payee: false },
  ], recipients_checked: true, fee: '1000000', burns: { burn_a: '0', burn_asset: 0, burn_r: '0' }, expires_at: 2024,
  signing_message: '00', policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', chain_id: 21, genesis: '00'.repeat(32), binding_domain: 1,
  lines: [
    '0: → 0 RAND to cb5c9747f9a2ef35 memo "" (owner key verified; delivery key NOT verifiable from this proposal)',
    '1: → 0 RAND to 2c94b28813d4ce65 memo "" (owner key verified; delivery key NOT verifiable from this proposal)',
    '2: → 10 RAND to 35bad5bd21a6f0f7 memo "" (owner key verified; delivery key NOT verifiable from this proposal)',
    '3: → 14.999 RAND to this account 4333dd507bcc4286 memo "" (owner key verified; delivery key NOT verifiable from this proposal)',
    'fee 0.001 RAND', 'burn 0 of asset 0, 0 RAND',
  ],
});
```

- [ ] **Step 4: Run** `node --test ui/test/signers-engine.test.mjs ui/test/backend-wasm.test.mjs ui/test/backend-native.test.mjs ui/test/backend.test.mjs` → PASS (the unlock-throttle cases in `backend-cases.mjs` still pass over `passwordAttempt`).
- [ ] **Step 5: Commit** `ui/engine: signer profiles in the vault — policies opened at unlock, seeds under the password only; passwordAttempt shared with the unlock` + trailer.

---

### Task 7: Engine — `check`, `sign`, `verifyShare` (head, chain, per-signature password)

**Files:**
- Modify: `ui/engine/signers.js`, `ui/test/signers-engine.test.mjs`

**Interfaces:**
- Consumes: Task 6's `makeSigners` deps (`requireVerifiedChain() -> {client, url, identity: {chainId, genesis}}`, `client.head() -> {height}`, `getSettings().chainId`, `currentRpcUrl()`, `passwordAttempt`).
- Produces: `verdict({summary, head, chainId, genesis, url}) -> {signable: true, head, blocksLeft} | {signable: false, refusal: {code: 'unchecked-recipient'|'no-node'|'wrong-chain'|'wrong-genesis'|'expired', message, node?}}` (exported); `group.check(id, proposal, expectedRecipients = [])`, `group.sign(id, proposal, expectedRecipients, password) -> {share, index}` (throws `SignerRefusal` with `.code`), `group.verifyShare(id, proposal, share) -> {index}`.

- [ ] **Step 1: Failing tests** (append):

```js
import { verdict, EXPIRY_MARGIN } from '../engine/signers.js';

const SUMMARY = { expires_at: 200, chain_id: 13, genesis: GENESIS, binding_domain: 1, lines: ['x'], policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', recipients_checked: true,
  outputs: [{ to_account: false, amount: '5', needs_payee: true, matches: 'FP' }] };
const signingCore = (extra = {}) => msauthCore({
  msauth_check: () => ({ ...SUMMARY }),
  msauth_sign: ({ seed }) => { if (seed !== SEED_HEX) throw new Error('bad seed'); return '1:' + 'ab'.repeat(8); },
  msauth_verify_share: ({ share }) => { if (!share.startsWith('0:')) throw new Error('signer 1\'s signature does not verify over this proposal'); return true; },
  ...extra,
});
const atHead = (height, table = {}) => stubFetch({ rand_getHead: () => ({ height, hash: 'ff'.repeat(32), view: 1 }), ...table });

test('an unmatched or unchecked payee refuses signing, before anything else', async () => {
  const unchecked = { ...SUMMARY, recipients_checked: false, outputs: [{ to_account: false, amount: '5', needs_payee: true, matches: null }] };
  assert.equal(verdict({ summary: unchecked, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'unchecked-recipient');
  assert.equal(verdict({ summary: unchecked, head: null, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'unchecked-recipient');
  const seen = [];
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: ({ expected_recipients }) => { seen.push(expected_recipients); return unchecked; } }), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'unchecked-recipient');
  assert.deepEqual(seen, [['rand1payee']], 'the payees reach the core');
});

test('the expiry rule is the CLI\'s: refuse at head + 16 >= expires_at', () => {
  assert.equal(EXPIRY_MARGIN, 16);
  assert.equal(verdict({ summary: SUMMARY, head: 183, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true);
  assert.equal(verdict({ summary: SUMMARY, head: 184, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'expired');
});

test('a proposal for another chain or genesis is refused', async () => {
  assert.equal(verdict({ summary: { ...SUMMARY, chain_id: 21 }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'wrong-chain');
  assert.equal(verdict({ summary: { ...SUMMARY, genesis: 'bb'.repeat(32) }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'wrong-genesis');
  assert.equal(verdict({ summary: { ...SUMMARY, binding_domain: 0, genesis: 'bb'.repeat(32) }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true, 'a chain-id-bound proposal binds no genesis');
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => ({ ...SUMMARY, chain_id: 21 }) }), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'wrong-chain');
});

test('with no node the proposal is shown but not signed, naming the node', async () => {
  const dead = async () => { throw new TypeError('fetch failed'); };
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: dead });
  const r = await backend.signers.check(row.id, 'P', ['rand1payee']);
  assert.equal(r.signable, false);
  assert.equal(r.refusal.code, 'no-node');
  assert.match(r.refusal.message, /rpc\.randprotocol\.org/);
  assert.deepEqual(r.summary.lines, ['x'], 'the review still shows what was checked');
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'no-node');
});

test('a node that cannot give a head is no node', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: stubFetch({ rand_getHead: () => { throw new Error('busy'); } }) });
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1payee'])).refusal.code, 'no-node');
});

test('every signature asks for the password and caches nothing', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  const before = JSON.stringify([...storage.sessionMap.entries()]);
  assert.deepEqual(await backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), { share: '1:' + 'ab'.repeat(8), index: 1 });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], ''), /wrong password/, 'the second signature asks again');
  assert.equal(JSON.stringify([...storage.sessionMap.entries()]), before, 'the session gained nothing');
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes(SEED_HEX));
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes('"P"'), 'the proposal is never stored');
});

test('a wrong password at signing is throttled like an unlock', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], 'wrong-password-here'), /wrong password/);
  assert.equal(storage.local.get('unlockFailures').count, 1);
  await backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD);
  assert.equal(storage.local.get('unlockFailures'), undefined, 'a right password clears the count');
});

test('verifyShare names the position and trims a saved file\'s newline', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  assert.deepEqual(await backend.signers.verifyShare(row.id, 'P', '0:abcd\n'), { index: 0 });
  await assert.rejects(backend.signers.verifyShare(row.id, 'P', '1:abcd'), /does not verify/);
});
```

Run → FAIL (`verdict` not exported, `check` missing).

- [ ] **Step 2: Implement** in `signers.js`:

```js
/** Whether a checked proposal may be signed now, by the CLI's rule, on this wallet's chain. */
export function verdict({ summary, head, chainId, genesis, url }) {
  // Spec §4 step 3: never sign on an unchecked payee (a coordinator could pay its own key).
  if (summary.recipients_checked !== true) {
    return { signable: false, refusal: { code: 'unchecked-recipient', message: t('Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.') } };
  }
  if (head == null) {
    return { signable: false, refusal: { code: 'no-node', node: url, message: t('No node answered at {url}, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.', { url: url || '—' }) } };
  }
  if (Number(summary.chain_id) !== Number(chainId)) {
    return { signable: false, refusal: { code: 'wrong-chain', message: t('This proposal is for chain {theirs}; this wallet is on chain {ours}.', { theirs: String(summary.chain_id), ours: String(chainId) }) } };
  }
  if (Number(summary.binding_domain) >= 1 && String(summary.genesis).toLowerCase() !== String(genesis || '').toLowerCase()) {
    return { signable: false, refusal: { code: 'wrong-genesis', message: t('This proposal is bound to another genesis than the one this wallet\'s node serves.') } };
  }
  if (head + EXPIRY_MARGIN >= Number(summary.expires_at)) {
    return { signable: false, refusal: { code: 'expired', message: t('This proposal expires at height {expires} and the chain is at {head}: too late to sign. Ask for a new proposal.', { expires: String(summary.expires_at), head: String(head) }) } };
  }
  return { signable: true, head, blocksLeft: Number(summary.expires_at) - head };
}
```

Inside `makeSigners`, destructure `passwordAttempt, requireVerifiedChain, getSettings, currentRpcUrl` from `deps` and add:

```js
  /** The head from a node that passed this wallet's chain check; any failure is "no node". */
  async function judge(summary) {
    const settings = await getSettings();
    let url = '';
    try { url = await currentRpcUrl(); } catch { /* no endpoint configured */ }
    try {
      const { client, url: u, identity } = await requireVerifiedChain();
      const h = await client.head();
      const height = Number(h && h.height);
      if (!Number.isSafeInteger(height) || height < 0) throw new Error('no height');
      return verdict({ summary, head: height, chainId: settings.chainId, genesis: identity && identity.genesis, url: u });
    } catch {
      return verdict({ summary, head: null, url });
    }
  }
```

and, at module level, `const payees = (list) => (Array.isArray(list) ? list : []).map(cleanText).filter(Boolean);`, and to `group`:

```js
    // The proposal is a parameter, never stored: it carries the account's witness (§3).
    async check(id, proposal, expectedRecipients = []) {
      const p = await profileOf(id);
      const summary = await c.msauthCheck(cleanText(proposal), p.policy, payees(expectedRecipients));
      return { summary, ...(await judge(summary)) };
    },
    async sign(id, proposal, expectedRecipients, password) {
      const p = await profileOf(id);
      const text = cleanText(proposal);
      const v = await judge(await c.msauthCheck(text, p.policy, payees(expectedRecipients)));
      if (!v.signable) throw new SignerRefusal(v.refusal.code, v.refusal.message, { node: v.refusal.node });
      const rec = ((await storage.get(SIGNER_SEEDS_KEY)) || {})[id];
      if (!rec) throw new Error(t('This signer profile has no key on this device: remove it and add it again.'));
      const seed = await passwordAttempt(() => decryptBytes(password, rec));
      if (!seed) throw new Error('wrong password');
      try {
        // The hex copy below cannot be wiped (a JS string); it is unreachable after this call, and
        // wallet-core holds its own copy in Zeroizing. The bytes are wiped here.
        const share = await c.msauthSign(text, p.policy, hexOf(seed));
        return { share, index: Number(String(share).split(':')[0]) };
      } finally {
        seed.fill(0);
      }
    },
    async verifyShare(id, proposal, share) {
      const p = await profileOf(id);
      const s = cleanText(share);
      await c.msauthVerifyShare(cleanText(proposal), p.policy, s);
      return { index: Number(s.split(':')[0].trim()) };
    },
```

(`decryptBytes` is imported at the top already; drop it from the returned object.)

- [ ] **Step 3: Run** `node --test ui/test/signers-engine.test.mjs` → PASS.
- [ ] **Step 4: Commit** `ui/engine: signers check/sign/verifyShare — the CLI's expiry margin against a verified head, no node no signature, the password per signature` + trailer.

---

### Task 8: Screens — `#signers`, `#signer/<id>`, the file picker, saving a share

**Files:**
- Create: `ui/screens/signers.js`, `ui/test/signers-screens.test.mjs`
- Modify: `ui/app.js` (import the screen module beside `contacts.js`), `ui/screens/settings.js` (entry), `ui/test/i18n.test.mjs` (`SCREENS` += `['signers', …]`, `['signer/s1', …]`), `web/wallet/main.js` and `extension/shared/lib/platform.js` (`platform.saveText`), `desktop/ui-shell/backend-tauri.js`, `desktop/src-tauri/src/commands.rs`, `desktop/src-tauri/src/main.rs` (command registration), `ui/backend.js` (doc `platform.saveText?`)

**Interfaces:**
- Consumes: `backend.signers` (Task 6/7), `ctx.go`, `ctx.mode`, `ctx.isCurrent`, `platform.copy`, `platform.share?`, `platform.openSidebar?`.
- Produces: exports `lastFourOf(fp)`, `confirmsFingerprint(fp, typed)`, `MAX_FILE_BYTES = 1048576`; `platform.saveText?({name, text}) -> Promise<string|void>`; Tauri command `save_text_to_downloads(name: String, text: String) -> Result<String, String>` over `save_text_in(dir: &Path, name: &str, text: &str) -> Result<PathBuf, String>`.

- [ ] **Step 1: Failing screen tests.** `ui/test/signers-screens.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { confirmsFingerprint, lastFourOf } from '../screens/signers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const signerBackend = (over = {}) => {
  const b = unlockedBackend(over);
  return b;
};

test('confirmation is the fingerprint\'s last four, without case or dashes', () => {
  assert.equal(lastFourOf('NFYW-K8E9-E5K9-AAK3'), 'aak3');
  assert.ok(confirmsFingerprint('NFYW-K8E9-E5K9-AAK3', ' aak3 '));
  assert.ok(!confirmsFingerprint('NFYW-K8E9-E5K9-AAK3', 'AAK'));
  assert.ok(!confirmsFingerprint('', ''));
});

test('settings offers the signers screen only where the backend has the group', async (t) => {
  const { app, root } = await mountApp(t, signerBackend(), { hash: '#settings' });
  await app.idle();
  assert.ok(root.querySelector('[data-go="signers"]'));
});

test('a proposal\'s lines are shown verbatim, as text, with the caveat', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const lines = [...root.querySelectorAll('[data-role="line"]')].map((n) => n.textContent);
  assert.equal(lines.length, 6);
  assert.ok(lines.slice(0, 4).every((l) => l.endsWith('(owner key verified; delivery key NOT verifiable from this proposal)')));
});

test('sign stays disabled until the last four are typed, and asks for the password each time', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const sign = root.querySelector('[data-role="sign"]');
  assert.equal(sign.disabled, true);
  const confirm = root.querySelector('input[data-role="confirm"]');
  confirm.value = 'aak3'; confirm.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(sign.disabled, false);
  root.querySelector('input[data-role="password"]').value = 'unlocked-password-1';
  sign.click();
  await app.idle(); await tick();
  assert.equal(root.querySelector('[data-role="share"]').value, '1:' + 'ab'.repeat(8));
  assert.equal(root.querySelector('input[data-role="password"]').value, '', 'the password field is emptied');
});

test('every paying output asks for its payee, and the typed addresses reach check and sign', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const seen = [];
  const original = b.signers.check;
  b.signers.check = async (id, proposal, payees) => { seen.push(payees); return original(id, proposal, payees); };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const inputs = root.querySelectorAll('input[data-role="payee"]');
  assert.equal(inputs.length, 1, 'only output 2 pays someone: dummies and change ask nothing');
  inputs[0].value = 'rand1payee';
  root.querySelector('[data-role="check-payees"]').click();
  await app.idle(); await tick();
  assert.deepEqual(seen.at(-1), ['rand1payee']);
});

test('a refused check names the node and offers Retry, and nothing can be signed', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  b.signers.check = async () => ({ summary: { outputs: [], recipients_checked: true, lines: ['fee 0.001 RAND'], policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', expires_at: 2024, fee: '1000000', burns: { burn_a: '0', burn_asset: 0, burn_r: '0' } },
    signable: false, refusal: { code: 'no-node', node: 'https://rpc.example', message: 'No node answered at https://rpc.example, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.' } });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  assert.match(root.querySelector('[data-role="refusal"]').textContent, /rpc\.example/);
  assert.ok(root.querySelector('[data-role="retry"]'));
  assert.equal(root.querySelector('[data-role="sign"]'), null);
});

test('the popup offers the side panel instead of a file picker', async (t) => {
  const b = signerBackend();
  b.platform.openSidebar = async () => {};
  const { app, root } = await mountApp(t, b, { hash: '#signers', mode: 'popup' });
  await app.idle();
  assert.equal(root.querySelector('input[type=file]'), null);
  assert.ok(root.querySelector('[data-role="to-sidebar"]'));
});

test('a profile label from storage is text, never markup', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: '<img src=x onerror=alert(1)>', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signers' });
  await app.idle();
  assert.equal(root.querySelector('img'), null);
});
```

(If `mountApp` names its mode option differently, read `ui/test/helpers.mjs` and use its name.) Run → FAIL.

- [ ] **Step 2: `ui/screens/signers.js`.**

```js
// Private multisig signing (spec 2026-10-11-msauth-signing-design.md §4): `#signers` lists the
// signer profiles and adds one; `#signer/<id>` checks a proposal, shows exactly what the core
// checked, signs it after the fingerprint's last four characters and the password, and checks a
// share. Every value from a file, a paste, storage or the core reaches the page as text. The
// proposal lives in this screen's closure only and is dropped when it unmounts.
import { h, raw } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits } from '../lib/format.js';
import { t } from '../i18n.js';

export const MAX_FILE_BYTES = 1 << 20;
export function lastFourOf(fingerprint) {
  return String(fingerprint || '').replace(/-/g, '').slice(-4).toLowerCase();
}
export function confirmsFingerprint(fingerprint, typed) {
  const want = lastFourOf(fingerprint);
  return want.length === 4 && String(typed || '').replace(/[-\s]/g, '').toLowerCase() === want;
}
async function readPicked(input) {
  const file = input.files && input.files[0];
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES) throw new Error(t('That file is larger than a proposal, a policy or a key file can be.'));
  return file.text();
}
const topbar = (title, back) => h`<div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="${back}" aria-label="${t('Back')}">${raw(icons.chevron())}</button><span class="topbar-title">${title}</span><span class="spacer"></span></div>`;
function fileField(ctx, { role, label }) {
  const popup = ctx.mode === 'popup';
  const picker = popup ? '' : raw(h`<label class="btn sm" for="f-${role}">${t('Open file')}</label><input id="f-${role}" data-file="${role}" type="file" accept=".json,.txt,application/json,text/plain" hidden>`);
  return h`<div class="field"><div class="field-top"><label class="label" for="t-${role}">${label}</label><span class="cluster">${picker}</span></div><textarea id="t-${role}" data-role="${role}" rows="3" spellcheck="false" autocomplete="off"></textarea></div>`;
}
function sidebarOffer(ctx) {
  return ctx.mode === 'popup' && typeof ctx.backend.platform.openSidebar === 'function'
    ? h`<button class="btn block" type="button" data-role="to-sidebar">${t('Open in the side panel to choose files')}</button>` : '';
}
function wireFiles(ctx, root, onError) {
  for (const input of root.querySelectorAll('input[type=file][data-file]')) {
    input.addEventListener('change', async () => {
      try {
        const text = await readPicked(input);
        if (text != null && ctx.isCurrent()) root.querySelector(`textarea[data-role="${input.dataset.file}"]`).value = text;
      } catch (err) { onError(err.message); }
      input.value = '';
    });
  }
  const side = root.querySelector('[data-role="to-sidebar"]');
  if (side) side.addEventListener('click', () => { Promise.resolve(ctx.backend.platform.openSidebar()).catch(() => {}); });
}
function showError(el, message) {
  el.textContent = message || '';
  if (message) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

registerScreen('signers', {
  render: () => h`<h1 class="sr-only">${t('Multisig signers')}</h1>${raw(topbar(t('Multisig signers'), 'settings'))}<div class="stack" data-role="body"><div class="skeleton block"></div></div>`,
  async after(ctx, root) {
    const group = ctx.backend.signers;
    const body = root.querySelector('[data-role="body"]');
    if (!group || typeof group.list !== 'function') {
      body.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">${t('Multisig signing is not available in this app.')}</span></div></div>`;
      return;
    }
    body.innerHTML = h`
      <div data-role="list"></div>
      <h2 class="section-title">${t('Add a signer')}</h2>
      <div class="card stack">
        ${raw(sidebarOffer(ctx))}
        <div class="field"><label class="label" for="signer-label">${t('Label')}</label><input id="signer-label" data-role="label" type="text" maxlength="64" autocomplete="off"></div>
        ${raw(fileField(ctx, { role: 'policy', label: t('Policy file') }))}
        ${raw(fileField(ctx, { role: 'key', label: t('Signer key file, or its 64-hex seed') }))}
        <p class="error field-error" data-role="error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="preview">${t('Check')}</button>
        <div data-role="preview-out"></div>
      </div>
      <p class="caption">${t('A signer profile is kept in this wallet\'s encrypted vault. Every signature asks for your password again.')}</p>`;
    const errorEl = body.querySelector('[data-role="error"]');
    const out = body.querySelector('[data-role="preview-out"]');
    const field = (r) => body.querySelector(`[data-role="${r}"]`);
    wireFiles(ctx, body, (m) => showError(errorEl, m));
    for (const r of ['label', 'policy', 'key']) field(r).addEventListener('input', () => { out.textContent = ''; });

    async function paintList() {
      const listEl = body.querySelector('[data-role="list"]');
      const rows = await group.list();
      if (!ctx.isCurrent()) return;
      if (rows.length === 0) {
        listEl.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">${t('No signer profiles yet')}</span><span>${t('Add the policy file and your signer key to sign for a private multisig account.')}</span></div></div>`;
        return;
      }
      listEl.innerHTML = h`<div class="card flush"><ul class="list" role="list">${raw(rows.map((r) => h`<li><button class="row" type="button" data-go="signer/${r.id}"><span class="row-main"><span class="row-title"><span class="truncate" data-role="row-label"></span></span><span class="row-sub mono" data-role="row-fp"></span><span class="row-sub">${t('{threshold} of {count} · signer {index}', { threshold: String(r.threshold), count: String(r.signers), index: String(r.index) })}</span></span></button></li>`).join(''))}</ul></div>`;
      listEl.querySelectorAll('li').forEach((li, i) => {
        li.querySelector('[data-role="row-label"]').textContent = rows[i].label;
        li.querySelector('[data-role="row-fp"]').textContent = rows[i].fingerprint;
      });
    }

    field('preview').addEventListener('click', async () => {
      showError(errorEl, '');
      try {
        const p = await group.preview({ policy: field('policy').value, key: field('key').value });
        if (!ctx.isCurrent()) return;
        out.innerHTML = h`<div class="stack">
          <span class="label">${t('Account fingerprint — compare it with every other signer before you save')}</span>
          <span class="mono" data-role="pv-fp"></span><span class="mono row-sub" data-role="pv-address"></span>
          <span>${t('{threshold} of {count} · this key is signer {index}', { threshold: String(p.threshold), count: String(p.signers), index: String(p.index) })}</span>
          <div class="field"><label class="label" for="signer-password">${t('Password')}</label><input id="signer-password" data-role="add-password" type="password" autocomplete="current-password"></div>
          <button class="btn btn-primary block" type="button" data-role="save">${t('Save signer')}</button></div>`;
        out.querySelector('[data-role="pv-fp"]').textContent = p.fingerprint;
        out.querySelector('[data-role="pv-address"]').textContent = p.address;
        out.querySelector('[data-role="save"]').addEventListener('click', async () => {
          const pw = out.querySelector('[data-role="add-password"]');
          try {
            await group.add({ label: field('label').value, policy: field('policy').value, key: field('key').value, password: pw.value });
            for (const r of ['label', 'policy', 'key']) field(r).value = '';
            out.textContent = '';
            await paintList();
          } catch (err) { showError(errorEl, err.message); } finally { pw.value = ''; }
        });
      } catch (err) { showError(errorEl, err.message); }
    });
    await paintList();
  },
});

registerScreen('signer', {
  render: () => h`<h1 class="sr-only">${t('Sign a proposal')}</h1>${raw(topbar(t('Sign a proposal'), 'signers'))}<div class="stack" data-role="body"><div class="skeleton block"></div></div>`,
  async after(ctx, root, id) {
    const group = ctx.backend.signers;
    const body = root.querySelector('[data-role="body"]');
    const profile = (await group.list()).find((p) => p.id === id);
    if (!ctx.isCurrent()) return;
    if (!profile) { body.textContent = t('No such signer profile.'); return; }
    let proposal = null; // this screen's only copy; never stored
    let payees = []; // the addresses the signer typed, in the order of the outputs that need one
    const inHand = new Set();
    body.innerHTML = h`
      <div class="card stack"><span class="row-title" data-role="p-label"></span><span class="mono" data-role="p-fp"></span>
        <span>${t('{threshold} of {count} · signer {index}', { threshold: String(profile.threshold), count: String(profile.signers), index: String(profile.index) })}</span></div>
      <div class="card stack">${raw(sidebarOffer(ctx))}${raw(fileField(ctx, { role: 'proposal', label: t('Proposal (proposal.json)') }))}
        <p class="error field-error" data-role="error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="check">${t('Check proposal')}</button></div>
      <div data-role="review"></div>
      <h2 class="section-title">${t('Check a share')}</h2>
      <div class="card stack"><textarea data-role="share-in" rows="2" spellcheck="false" autocomplete="off" placeholder="${t('index:hex')}"></textarea>
        <button class="btn block" type="button" data-role="verify">${t('Check share')}</button><p data-role="verify-out" role="status"></p></div>
      <div class="card stack"><div class="field"><label class="label" for="remove-password">${t('Password')}</label><input id="remove-password" data-role="remove-password" type="password" autocomplete="current-password"></div>
        <button class="btn block" type="button" data-role="remove">${t('Remove this signer')}</button></div>`;
    body.querySelector('[data-role="p-label"]').textContent = profile.label;
    body.querySelector('[data-role="p-fp"]').textContent = profile.fingerprint;
    const errorEl = body.querySelector('[data-role="error"]');
    const review = body.querySelector('[data-role="review"]');
    wireFiles(ctx, body, (m) => showError(errorEl, m));

    function paintReview(r) {
      const s = r.summary;
      review.innerHTML = h`<div class="card stack">
        <span class="label">${t('What this proposal does, as checked against your policy')}</span>
        <div class="stack mono" data-role="lines">${raw(s.lines.map(() => '<div data-role="line"></div>').join(''))}</div>
        <span>${t('Fee: {fee} RAND · expires at height {height}', { fee: formatUnits(s.fee), height: String(s.expires_at) })}</span>
        <span class="caption">${t('Enter the address you mean to pay for each payment below. An output that does not match it cannot be signed.')}</span>
        <div class="stack" data-role="payees">${raw(s.outputs.filter((o) => o.needs_payee).map((o, i) => h`<div class="field"><label class="label" for="payee-${i}">${t('Payee address for {amount} (owner key {key})', { amount: o.asset === 0 ? `${formatUnits(o.amount)} RAND` : t('{units} units of asset {asset}', { units: o.amount, asset: String(o.asset) }), key: o.owner_fingerprint })}</label><input id="payee-${i}" data-role="payee" type="text" autocomplete="off" spellcheck="false" placeholder="rand1…"></div>`).join(''))}
          <button class="btn block" type="button" data-role="check-payees">${t('Check payees')}</button></div>
        <div data-role="act"></div></div>`;
      review.querySelectorAll('[data-role="line"]').forEach((n, i) => { n.textContent = s.lines[i]; });
      review.querySelectorAll('input[data-role="payee"]').forEach((n, i) => { n.value = payees[i] || ''; });
      review.querySelector('[data-role="check-payees"]').addEventListener('click', () => {
        payees = [...review.querySelectorAll('input[data-role="payee"]')].map((n) => n.value.trim());
        runCheck();
      });
      const act = review.querySelector('[data-role="act"]');
      if (!r.signable) {
        act.innerHTML = h`<p class="error" data-role="refusal" role="alert"></p><button class="btn block" type="button" data-role="retry">${t('Retry')}</button>`;
        act.querySelector('[data-role="refusal"]').textContent = r.refusal.message;
        act.querySelector('[data-role="retry"]').addEventListener('click', runCheck);
        return;
      }
      act.innerHTML = h`
        <span>${t('{blocks} blocks left to prove it.', { blocks: String(r.blocksLeft) })}</span>
        <div class="field"><label class="label" for="sign-confirm">${t('Type the last four characters of the account fingerprint')}</label><input id="sign-confirm" data-role="confirm" type="text" autocomplete="off" spellcheck="false" maxlength="9"></div>
        <div class="field"><label class="label" for="sign-password">${t('Password')}</label><input id="sign-password" data-role="password" type="password" autocomplete="current-password"></div>
        <p class="error" data-role="sign-error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="sign" disabled>${t('Sign')}</button><div data-role="share-out"></div>`;
      const confirm = act.querySelector('[data-role="confirm"]');
      const sign = act.querySelector('[data-role="sign"]');
      confirm.addEventListener('input', () => { sign.disabled = !confirmsFingerprint(s.policy_fingerprint, confirm.value); });
      sign.addEventListener('click', async () => {
        const pw = act.querySelector('[data-role="password"]');
        const errEl = act.querySelector('[data-role="sign-error"]');
        showError(errEl, '');
        try {
          const { share, index } = await group.sign(id, proposal, payees, pw.value);
          if (!ctx.isCurrent()) return;
          paintShare(act.querySelector('[data-role="share-out"]'), share, index);
        } catch (err) { showError(errEl, err.message); } finally { pw.value = ''; }
      });
    }
    function paintShare(el, share, index) {
      const p = ctx.backend.platform;
      el.innerHTML = h`<div class="stack"><label class="label" for="share-text">${t('Your share — send it to whoever proves the proposal')}</label>
        <textarea id="share-text" data-role="share" class="mono" rows="3" readonly></textarea>
        <span class="cluster"><button class="btn sm" type="button" data-role="copy">${t('Copy')}</button>
        ${raw(typeof p.saveText === 'function' ? h`<button class="btn sm" type="button" data-role="save-share">${t('Save as file')}</button>` : '')}
        ${raw(typeof p.share === 'function' ? h`<button class="btn sm" type="button" data-role="share-sheet">${t('Share')}</button>` : '')}</span></div>`;
      el.querySelector('[data-role="share"]').value = share;
      el.querySelector('[data-role="copy"]').addEventListener('click', () => p.copy(share));
      el.querySelector('[data-role="save-share"]')?.addEventListener('click', () => p.saveText({ name: `share-${index}.txt`, text: `${share}\n` }));
      el.querySelector('[data-role="share-sheet"]')?.addEventListener('click', () => p.share({ title: t('Multisig share'), text: share }));
    }
    async function runCheck() {
      showError(errorEl, '');
      const text = body.querySelector('textarea[data-role="proposal"]').value;
      if (text !== proposal) payees = []; // a new proposal: its payees are asked again
      proposal = text;
      try {
        const r = await group.check(id, proposal, payees);
        if (ctx.isCurrent()) paintReview(r);
      } catch (err) { review.textContent = ''; showError(errorEl, err.message); }
    }
    body.querySelector('[data-role="check"]').addEventListener('click', runCheck);
    body.querySelector('[data-role="verify"]').addEventListener('click', async () => {
      const outEl = body.querySelector('[data-role="verify-out"]');
      try {
        const { index } = await group.verifyShare(id, proposal ?? '', body.querySelector('[data-role="share-in"]').value);
        inHand.add(index);
        outEl.textContent = t('Signer {index}\'s share verifies. {have} of {threshold} in hand: signers {list}.', { index: String(index), have: String(inHand.size), threshold: String(profile.threshold), list: [...inHand].sort((a, b) => a - b).join(', ') });
      } catch (err) { outEl.textContent = err.message; }
    });
    body.querySelector('[data-role="remove"]').addEventListener('click', async () => {
      const pw = body.querySelector('[data-role="remove-password"]');
      try { await group.remove(id, pw.value); ctx.go('#signers'); } catch (err) { showError(errorEl, err.message); } finally { pw.value = ''; }
    });
    return () => { proposal = null; };
  },
});
```

(If `after` cannot return a cleanup in `app.js`, use the screen's existing cleanup hook — read how `send.js` registers one — to null `proposal`.)

- [ ] **Step 3: Entry and platforms.**
  - `ui/app.js`: add `import('./screens/signers.js'),` after `contacts.js` in the screen import list.
  - `ui/screens/settings.js`, beside `contactsMarkup`:

```js
// Offered only where the backend has the (optional) `signers` group.
function signersMarkup() {
  return raw(h`<h2 class="section-title">${t('Multisig signers')}</h2>
    <button class="btn block" type="button" data-go="signers">${t('Manage multisig signers')}</button>`);
}
```

  and in the render, after the contacts line: `${raw(ctx.backend.signers && typeof ctx.backend.signers.list === 'function' ? signersMarkup() : '')}` (match how `contactsMarkup()` is spliced).
  - `web/wallet/main.js` and `extension/shared/lib/platform.js` platform objects:

```js
    // A share (`i:hex`) or other small text as a downloaded file. Not secret.
    saveText: ({ name, text }) => {
      const url = URL.createObjectURL(new Blob([String(text)], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = String(name); a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
```

  - `desktop/src-tauri/src/commands.rs`:

```rust
/// A share file in the user's Downloads, never over an existing file. `name` is
/// `share-<n>.txt`-shaped: letters, digits, `.`, `_`, `-`, ending `.txt`.
pub fn save_text_in(dir: &std::path::Path, name: &str, text: &str) -> Result<std::path::PathBuf, String> {
    let ok = name.ends_with(".txt") && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !name.starts_with('.');
    if !ok {
        return Err(format!("{name:?} is not a file name this app writes"));
    }
    let path = dir.join(name);
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn save_text_to_downloads(app: tauri::AppHandle, name: String, text: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    save_text_in(&dir, &name, &text).map(|p| p.display().to_string())
}
```

  with a test in its `mod tests`:

```rust
    #[test]
    fn save_text_in_writes_once_and_refuses_a_path() {
        let dir = std::env::temp_dir().join(format!("rand-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = save_text_in(&dir, "share-1.txt", "1:ab\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "1:ab\n");
        assert!(save_text_in(&dir, "share-1.txt", "x").is_err(), "never overwrites");
        assert!(save_text_in(&dir, "../evil.txt", "x").is_err());
        assert!(save_text_in(&dir, "a.sh", "x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
```

  register `commands::save_text_to_downloads` in `main.rs`'s `invoke_handler(tauri::generate_handler![...])`; `desktop/ui-shell/backend-tauri.js` platform: `saveText: ({ name, text }) => invoke('save_text_to_downloads', { name, text }),` (use the file's existing `invoke` import name). If the desktop capability file (`desktop/src-tauri/capabilities/*.json`) lists commands, add it there.
  - `ui/test/i18n.test.mjs` `SCREENS`: `['signers', () => unlockedBackend()], ['signer/s1', () => { const b = unlockedBackend(); b.signers.add({ label: 'x', password: 'unlocked-password-1' }); return b; }],`.
  - `node ui/scripts/extract-strings.mjs`.
- [ ] **Step 4: Run** `node --test ui/test/signers-screens.test.mjs ui/test/settings.test.mjs ui/test/screens.test.mjs` → PASS; `cd desktop/src-tauri && node ../scripts/stage-ui.mjs && cargo test` → PASS. (`i18n.test.mjs` dictionary cases fail until Task 9; its completeness walk for `signers` must already pass in `en`.)
- [ ] **Step 5: Commit** `ui: Settings → Multisig signers — add a profile from files, check/review/sign a proposal (last four + password), save or share the share, check others' shares; desktop saves to Downloads` + trailer.

---

### Task 9: Shared-UI strings in all 20 locales

**Files:**
- Modify: `ui/locales/{ar,de,es,fa,fr,hi,id,it,ja,ko,ms,pl,ps,pt,ru,ta,ur,zh,zh-hk}.js` (`en.js` is generated)

- [ ] **Step 1: Failing test.** `node --test ui/test/i18n.test.mjs` → FAIL: `<code>: keys differ from en.js` for all 19 (the keys Tasks 5–8 added).
- [ ] **Step 2: Translate.** List the new keys: `git diff main -- ui/locales/en.js | grep '^+  "'`. Add each to every dictionary, in the file's alphabetical position (the order `extract-strings.mjs` renders), keeping every `{hole}`, the glossary (RAND, rand-node, `index:hex`, `public_key`, `signing_message`, `auth_commit`, `nk`), and the file's register. Use these terms throughout (signer / proposal / share):
  ar موقّع / اقتراح / حصة التوقيع · de Unterzeichner / Vorschlag / Signaturanteil · es firmante / propuesta / parte de firma · fa امضاکننده / پیشنهاد / سهم امضا · fr signataire / proposition / part de signature · hi हस्ताक्षरकर्ता / प्रस्ताव / हस्ताक्षर अंश · id penanda tangan / proposal / bagian tanda tangan · it firmatario / proposta / quota di firma · ja 署名者 / 提案 / 署名シェア · ko 서명자 / 제안 / 서명 조각 · ms penandatangan / cadangan / bahagian tandatangan · pl sygnatariusz / propozycja / udział podpisu · ps لاسلیک کوونکی / وړاندیز / د لاسلیک برخه · pt signatário / proposta / parte da assinatura · ru подписант / предложение / доля подписи · ta கையொப்பமிடுபவர் / முன்மொழிவு / கையொப்பப் பங்கு · ur دستخط کنندہ / تجویز / دستخطی حصہ · zh 签名人 / 提案 / 签名份额 · zh-hk 簽署人 / 提案 / 簽署份額.
  The fullnode `lines()` text is not a key anywhere (it is shown verbatim).
- [ ] **Step 3: Run** `node --test "ui/test/**/*.test.mjs"` → all PASS (including the pseudo-language completeness walk over `#signers` and `#signer/s1`).
- [ ] **Step 4: Commit** `ui/locales: multisig signing in all 20 languages` + trailer.

---

### Task 10: iOS — core wrappers, the signer store (Keychain, `.userPresence`), the signing rules

**Files:**
- Create: `ios/RandWallet/Core/Msauth.swift` (models + `MsauthRules`), `ios/RandWallet/Storage/SignerStore.swift`, `ios/RandWalletTests/MsauthTests.swift`, `ios/RandWalletTests/FakeSignerSecrets.swift`
- Modify: `ios/RandWallet/Core/RandCore.swift` (five wrappers), `ios/RandWallet/Core/CoreErrors.swift` (the Task 5 sentences), `ios/project.yml` (fixtures as test resources), `ios/RandWallet/Services/WalletService.swift` (`forgetWallet` also `SignerStore.shared.removeAll()`)

**Interfaces:**
- Produces: `RandCore.msauthCheck(proposal:policy:expectedRecipients:) -> MsauthSummary`, `.msauthSign(proposal:policy:seed: Data) -> String`, `.msauthVerifyShare(proposal:policy:share:)`, `.msauthSignerImport(_:policy:) -> MsauthSigner`, `.msauthPolicyInfo(_:) -> MsauthPolicyInfo`; `MsauthRules.expiryMargin = 16`, `MsauthRules.verdict(summary:head:chainId:genesis:url:) -> MsauthVerdict` (`.signable(blocksLeft:)`, `.uncheckedRecipient`, `.noNode(url:)`, `.wrongChain(proposal:wallet:)`, `.wrongGenesis`, `.expired(head:expiresAt:)`), `MsauthRules.confirms(fingerprint:typed:) -> Bool`, `MsauthRules.clean(_:)`; `protocol SignerSecrets`; `KeychainSignerSecrets`; `final class SignerStore: ObservableObject` with `profiles: [SignerProfile]`, `add(label:policy:key:) throws -> SignerProfile`, `remove(_ id:)`, `removeAll()`, `policy(_ id:) throws -> String`, `withSeed<T>(_ id:, reason:, _ body: (Data) throws -> T) throws -> T`.

- [ ] **Step 1: Test resources.** `ios/project.yml` `RandWalletTests.sources` add:

```yaml
      # The private-multisig vectors (fullnode e34117be), the files ui/test/msauth-fixtures.test.mjs pins.
      - path: ../ui/test/fixtures/msauth
        buildPhase: resources
```

Run `cd ios && xcodegen generate`.

- [ ] **Step 2: Failing tests.** `ios/RandWalletTests/FakeSignerSecrets.swift`:

```swift
@testable import RandWallet
import Foundation

/// The Keychain stand-in: records, per item, whether it was stored behind user presence and how
/// often it was read with a prompt. The simulator has no passcode, so `.userPresence` cannot be
/// created there; a device check is in the plan (Task 10 Step 8).
final class FakeSignerSecrets: SignerSecrets {
    var items: [String: (data: Data, presence: Bool)] = [:]
    var promptedReads: [String] = []
    var canRequireUserPresence = true
    func save(_ data: Data, account: String, requireUserPresence: Bool) throws { items[account] = (data, requireUserPresence) }
    func load(account: String, prompt: String?) throws -> Data? {
        if prompt != nil { promptedReads.append(account) }
        return items[account]?.data
    }
    func delete(account: String) { items[account] = nil }
}
```

`ios/RandWalletTests/MsauthTests.swift`:

```swift
import XCTest
@testable import RandWallet

final class MsauthTests: XCTestCase {
    private func fx(_ name: String) throws -> String {
        let url = try XCTUnwrap(Bundle(for: MsauthTests.self).url(forResource: name, withExtension: "json"))
        return try String(contentsOf: url, encoding: .utf8)
    }
    private func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try fx(name).utf8)) as? [String: Any])
    }

    private func payee() throws -> String {
        ((try json("proposal-valid")["summary"] as! [String])[0]).split(separator: " ").last.map(String.init)!
    }

    func testASubstitutedRecipientIsUnmatchedAndRefused() throws {   // [confirm: 0e] fixture name
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-substituted-recipient"), policy: try fx("policy"), expectedRecipients: [try payee()])
        XCTAssertFalse(s.recipientsChecked)
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 1, chainId: s.chainId, genesis: s.genesis, url: "u"), .uncheckedRecipient)
        let none = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"))
        XCTAssertEqual(MsauthRules.verdict(summary: none, head: 1, chainId: 7, genesis: nil, url: "u"), .uncheckedRecipient, "no payee given, nothing signed")
    }

    func testTheCoreChecksAndSignsTheVectors() throws {
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payee()])
        XCTAssertTrue(s.recipientsChecked)
        XCTAssertEqual(s.policyFingerprint, "NFYW-K8E9-E5K9-AAK3")
        XCTAssertEqual(s.outputs[2].amount, "10000000000")
        XCTAssertTrue(s.outputs[3].toAccount)
        XCTAssertTrue(s.lines.prefix(4).allSatisfy { $0.contains("owner key verified") })
        let seeds = try json("signer-seeds")["members"] as! [String]
        let expected = try json("expected")
        let share = try RandCore.msauthSign(proposal: try fx("proposal-valid"), policy: try fx("policy"), seed: Data(hex: seeds[2])!)
        XCTAssertEqual(share, expected["share_2"] as? String)
        XCTAssertNoThrow(try RandCore.msauthVerifyShare(proposal: try fx("proposal-valid"), policy: try fx("policy"), share: expected["share_0"] as! String))
        XCTAssertThrowsError(try RandCore.msauthCheck(proposal: try fx("proposal-unbound"), policy: try fx("policy"))) { e in
            XCTAssertTrue((e as! RandCore.CoreError).message.contains("does not hash to the proposal's binding"))
        }
    }

    func testTheExpiryAndChainRules() throws {
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payee()])   // chain 7, domain 0, expires 2024
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 2007, chainId: 7, genesis: nil, url: "u"), .signable(blocksLeft: 17))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 2008, chainId: 7, genesis: nil, url: "u"), .expired(head: 2008, expiresAt: 2024))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: nil, chainId: 7, genesis: nil, url: "http://n"), .noNode(url: "http://n"))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 1, chainId: 21, genesis: nil, url: "u"), .wrongChain(proposal: 7, wallet: 21))
        XCTAssertTrue(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: " aak3"))
        XCTAssertFalse(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: "aak"))
    }

    func testTheStoreKeepsTheSeedBehindPresenceAndReadsItPerSignature() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        let seeds = try json("signer-seeds")["members"] as! [String]
        let p = try store.add(label: "treasury", policy: try fx("policy"), key: seeds[0])
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(secrets.items["msauth.\(p.id).seed"]?.presence, true)
        XCTAssertEqual(secrets.items["msauth.\(p.id).policy"]?.presence, false)
        for _ in 0..<2 { _ = try store.withSeed(p.id, reason: "sign") { $0.count } }
        XCTAssertEqual(secrets.promptedReads, ["msauth.\(p.id).seed", "msauth.\(p.id).seed"], "one prompted read per signature, nothing cached")
        XCTAssertThrowsError(try store.add(label: "again", policy: try fx("policy"), key: seeds[0]))
        store.remove(p.id)
        XCTAssertNil(secrets.items["msauth.\(p.id).seed"])
        XCTAssertNil(secrets.items["msauth.\(p.id).policy"])
    }

    func testNoPasscodeNoProfile() throws {
        let secrets = FakeSignerSecrets(); secrets.canRequireUserPresence = false
        let seeds = try json("signer-seeds")["members"] as! [String]
        XCTAssertThrowsError(try SignerStore(secrets: secrets).add(label: "x", policy: try fx("policy"), key: seeds[0]))
    }
}
```

(If `Data(hex:)` does not exist in the app target, add it in `Msauth.swift` as `extension Data { init?(hex: String) }` and a `hexString` property.) Run the iOS test command (Global Constraints) `-only-testing:RandWalletTests/MsauthTests` → FAIL (types missing).

- [ ] **Step 3: `Msauth.swift`.**

```swift
import Foundation

/// `msauth_check`'s reply (wallet-core msauth.rs): amounts are decimal strings; `lines` is
/// fullnode's text, shown verbatim, never translated.
struct MsauthOutput: Decodable, Equatable {
    let ownerFingerprint: String; let toAccount: Bool; let amount: String; let asset: UInt32; let memo: String
    let matches: String?; let needsPayee: Bool   // [confirm: 0e] `matches`
    enum CodingKeys: String, CodingKey { case ownerFingerprint = "owner_fingerprint", toAccount = "to_account", amount, asset, memo, matches, needsPayee = "needs_payee" }
}
struct MsauthBurns: Decodable, Equatable {
    let burnA: String; let burnAsset: UInt32; let burnR: String
    enum CodingKeys: String, CodingKey { case burnA = "burn_a", burnAsset = "burn_asset", burnR = "burn_r" }
}
struct MsauthSummary: Decodable, Equatable {
    let outputs: [MsauthOutput]; let fee: String; let burns: MsauthBurns; let expiresAt: UInt64
    let signingMessage: String; let policyFingerprint: String; let lines: [String]
    let chainId: UInt64; let genesis: String; let bindingDomain: UInt32; let recipientsChecked: Bool
    enum CodingKeys: String, CodingKey {
        case outputs, fee, burns, lines, genesis
        case recipientsChecked = "recipients_checked"
        case expiresAt = "expires_at", signingMessage = "signing_message", policyFingerprint = "policy_fingerprint"
        case chainId = "chain_id", bindingDomain = "binding_domain"
    }
}
struct MsauthSigner: Decodable { let seed: String; let publicKey: String; let address: String; let index: Int?
    enum CodingKeys: String, CodingKey { case seed, address, index, publicKey = "public_key" } }
struct MsauthPolicyInfo: Decodable { let fingerprint: String; let threshold: Int; let signers: Int; let address: String; let policyHash: String
    enum CodingKeys: String, CodingKey { case fingerprint, threshold, signers, address, policyHash = "policy_hash" } }

enum MsauthVerdict: Equatable {
    case signable(blocksLeft: UInt64), uncheckedRecipient, noNode(url: String), wrongChain(proposal: UInt64, wallet: UInt64), wrongGenesis, expired(head: UInt64, expiresAt: UInt64)
}

/// The signing rules every app shares (spec §4): the CLI's 16-block margin, no node no signature,
/// the proposal's chain and genesis against this wallet's node, the fingerprint's last four.
enum MsauthRules {
    static let expiryMargin: UInt64 = 16
    static func clean(_ s: String) -> String {
        var t = s; if t.hasPrefix("\u{FEFF}") { t.removeFirst() }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func verdict(summary s: MsauthSummary, head: UInt64?, chainId: UInt64, genesis: String?, url: String) -> MsauthVerdict {
        guard s.recipientsChecked else { return .uncheckedRecipient }
        guard let head else { return .noNode(url: url) }
        if s.chainId != chainId { return .wrongChain(proposal: s.chainId, wallet: chainId) }
        if s.bindingDomain >= 1 && s.genesis.lowercased() != (genesis ?? "").lowercased() { return .wrongGenesis }
        if head + expiryMargin >= s.expiresAt { return .expired(head: head, expiresAt: s.expiresAt) }
        return .signable(blocksLeft: s.expiresAt - head)
    }
    static func confirms(fingerprint: String, typed: String) -> Bool {
        let want = String(fingerprint.replacingOccurrences(of: "-", with: "").suffix(4)).lowercased()
        let got = typed.replacingOccurrences(of: "-", with: "").trimmingCharacters(in: .whitespaces).lowercased()
        return want.count == 4 && got == want
    }
    /// Head, chain id and genesis from `rpc`; any failure is `.noNode`.
    static func check(proposal: String, policy: String, payees: [String], rpc: RpcClient, chainId: UInt64) async throws -> (MsauthSummary, MsauthVerdict) {
        let s = try RandCore.msauthCheck(proposal: clean(proposal), policy: policy, expectedRecipients: payees.map(clean).filter { !$0.isEmpty })
        do {
            let node = try await rpc.chainId()
            guard node == chainId else { return (s, .noNode(url: rpc.url.absoluteString)) }
            let head = try await rpc.headHeight()
            let genesis = try await rpc.genesisHash()
            return (s, verdict(summary: s, head: head, chainId: chainId, genesis: genesis, url: rpc.url.absoluteString))
        } catch {
            return (s, .noNode(url: rpc.url.absoluteString))
        }
    }
}
```

`RandCore.swift` (MARK: private multisig signing):

```swift
    static func msauthCheck(proposal: String, policy: String, expectedRecipients: [String] = []) throws -> MsauthSummary {
        try call("msauth_check", ["proposal": proposal, "policy": policy, "expected_recipients": expectedRecipients], as: MsauthSummary.self)
    }
    /// `seed` is the caller's; it zeroes its own buffer after (SignerStore.withSeed does).
    static func msauthSign(proposal: String, policy: String, seed: Data) throws -> String {
        guard let s = try call("msauth_sign", ["proposal": proposal, "policy": policy, "seed": seed.hexString]) as? String else {
            throw CoreError(message: "msauth_sign returned no share")
        }
        return s
    }
    static func msauthVerifyShare(proposal: String, policy: String, share: String) throws {
        _ = try call("msauth_verify_share", ["proposal": proposal, "policy": policy, "share": share])
    }
    static func msauthSignerImport(_ input: String, policy: String?) throws -> MsauthSigner {
        var p: [String: Any] = ["input": input]; if let policy { p["policy"] = policy }
        return try call("msauth_signer_import", p, as: MsauthSigner.self)
    }
    static func msauthPolicyInfo(_ policy: String) throws -> MsauthPolicyInfo {
        try call("msauth_policy_info", ["policy": policy], as: MsauthPolicyInfo.self)
    }
```

- [ ] **Step 4: `SignerStore.swift`.**

```swift
import Foundation
import Security
import LocalAuthentication

protocol SignerSecrets {
    func save(_ data: Data, account: String, requireUserPresence: Bool) throws
    /// `prompt` non-nil: the item is behind user presence and the system asks now.
    func load(account: String, prompt: String?) throws -> Data?
    func delete(account: String)
    var canRequireUserPresence: Bool { get }
}

/// Keychain items beside the spend key's (`WhenUnlockedThisDeviceOnly`); the seed's item also
/// carries `.userPresence`, so each read asks for Face ID / Touch ID / the passcode.
final class KeychainSignerSecrets: SignerSecrets {
    private let service = "org.randprotocol.wallet"
    var canRequireUserPresence: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
    func save(_ data: Data, account: String, requireUserPresence: Bool) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        if requireUserPresence {
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil) else { throw Keychain.KeychainError(status: errSecParam) }
            add[kSecAttrAccessControl as String] = ac
        } else {
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Keychain.KeychainError(status: status) }
    }
    func load(account: String, prompt: String?) throws -> Data? {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        if let prompt {
            let ctx = LAContext()            // fresh per read: no reuse window between signatures
            ctx.localizedReason = prompt
            ctx.touchIDAuthenticationAllowableReuseDuration = 0
            q[kSecUseAuthenticationContext as String] = ctx
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Keychain.KeychainError(status: status) }
        return item as? Data
    }
    func delete(account: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }
}

struct SignerProfile: Codable, Identifiable, Equatable {
    let id: String; var label: String; let index: Int; let fingerprint: String
    let threshold: Int; let signers: Int; let address: String; let policyHash: String
}

/// Signer profiles (spec §3): `msauth.index` (the list), `msauth.<id>.policy`, `msauth.<id>.seed`
/// (behind user presence). The seed is read per signature and zeroed after; never cached.
final class SignerStore: ObservableObject {
    static let shared = SignerStore(secrets: KeychainSignerSecrets())
    @Published private(set) var profiles: [SignerProfile] = []
    private let secrets: SignerSecrets
    init(secrets: SignerSecrets) {
        self.secrets = secrets
        if let d = try? secrets.load(account: "msauth.index", prompt: nil), let list = try? JSONDecoder().decode([SignerProfile].self, from: d) { profiles = list }
    }
    struct StoreError: LocalizedError { let errorDescription: String? }

    func add(label: String, policy: String, key: String) throws -> SignerProfile {
        guard secrets.canRequireUserPresence else {
            throw StoreError(errorDescription: String(localized: "Set a device passcode first: a signer key is read only after Face ID, Touch ID or the passcode."))
        }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.unicodeScalars.count <= 64 else { throw StoreError(errorDescription: String(localized: "a signer label is 1-64 characters")) }
        let pol = MsauthRules.clean(policy)
        let info = try RandCore.msauthPolicyInfo(pol)
        let signer = try RandCore.msauthSignerImport(MsauthRules.clean(key), policy: pol)
        guard let index = signer.index else { throw StoreError(errorDescription: "this key is not one of the policy's signers") }
        if let same = profiles.first(where: { $0.policyHash == info.policyHash && $0.index == index }) {
            throw StoreError(errorDescription: String(localized: "this signer is already saved as \(same.label)"))
        }
        let id = UUID().uuidString.lowercased()
        guard var seed = Data(hex: signer.seed) else { throw StoreError(errorDescription: "a signer seed is 64 hex characters") }
        defer { seed.resetBytes(in: 0..<seed.count) }
        try secrets.save(seed, account: "msauth.\(id).seed", requireUserPresence: true)
        try secrets.save(Data(pol.utf8), account: "msauth.\(id).policy", requireUserPresence: false)
        let p = SignerProfile(id: id, label: name, index: index, fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address, policyHash: info.policyHash)
        profiles.append(p)
        try writeIndex()
        return p
    }
    func remove(_ id: String) {
        secrets.delete(account: "msauth.\(id).seed"); secrets.delete(account: "msauth.\(id).policy")
        profiles.removeAll { $0.id == id }
        try? writeIndex()
    }
    func removeAll() { for p in profiles { remove(p.id) }; secrets.delete(account: "msauth.index") }
    func policy(_ id: String) throws -> String {
        guard let d = try secrets.load(account: "msauth.\(id).policy", prompt: nil) else { throw StoreError(errorDescription: String(localized: "No such signer profile.")) }
        return String(decoding: d, as: UTF8.self)
    }
    /// One prompted read of the seed for `body`; the buffer is zeroed when `body` returns.
    func withSeed<T>(_ id: String, reason: String, _ body: (Data) throws -> T) throws -> T {
        guard var seed = try secrets.load(account: "msauth.\(id).seed", prompt: reason) else {
            throw StoreError(errorDescription: String(localized: "This signer profile has no key on this device: remove it and add it again."))
        }
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try body(seed)
    }
    private func writeIndex() throws {
        try secrets.save(try JSONEncoder().encode(profiles), account: "msauth.index", requireUserPresence: false)
    }
}
```

`CoreErrors.swift`: add the Task 5 exact sentences to `exact` and the patterns to `patterns` (same English, `String(localized:)` with interpolation, as the file's existing entries do). `WalletService.forgetWallet(...)`: call `SignerStore.shared.removeAll()`.
- [ ] **Step 5: Run** `core/scripts/build-ios.sh` (df first), then the iOS test command → `MsauthTests` 4 PASS, the rest unchanged.
- [ ] **Step 6: Commit** `ios: msauth core wrappers, MsauthRules, SignerStore (seed behind .userPresence, read per signature)` + trailer.
- [ ] **Step 7:** (no code) note in the commit body which tests ran on which simulator.
- [ ] **Step 8: Device check (manual, report the result):** on a passcode-protected iPhone, add a profile, sign twice: each signature shows Face ID/passcode; with the passcode removed, the seed item is gone and signing says the profile has no key.

---

### Task 11: iOS — screens and strings

**Files:**
- Create: `ios/RandWallet/UI/SignersView.swift`, `ios/RandWallet/UI/SignProposalView.swift`
- Modify: `ios/RandWallet/UI/SettingsView.swift` (a `NavigationLink`), `ios/RandWallet/RandWalletApp.swift` (inject `SignerStore.shared` as an `environmentObject`), `ios/RandWallet/Localizable.xcstrings`, `ios/l10n/*.json` (19)

**Interfaces:**
- Consumes: Task 10's `SignerStore`, `MsauthRules`, `RandCore.msauth*`, `WalletService`'s RPC URL (`settings.rpcURL`) and `settings.chainId`.

- [ ] **Step 1: Failing test** (add to `MsauthTests`): the review model shows the core's lines verbatim and the sign button gate:

```swift
    func testTheReviewShowsTheCoreLinesVerbatim() throws {
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payee()])
        let model = SignProposalModel(summary: s, verdict: .signable(blocksLeft: 100))
        XCTAssertEqual(model.lines, s.lines)
        XCTAssertFalse(model.canSign(typed: ""))
        XCTAssertTrue(model.canSign(typed: "AAK3"))
        XCTAssertFalse(SignProposalModel(summary: s, verdict: .noNode(url: "u")).canSign(typed: "AAK3"))
    }
```

Run → FAIL.

- [ ] **Step 2: Views.** `SignProposalView.swift`:

```swift
import SwiftUI
import UniformTypeIdentifiers

struct SignProposalModel {
    let summary: MsauthSummary; let verdict: MsauthVerdict
    var lines: [String] { summary.lines }
    func canSign(typed: String) -> Bool {
        if case .signable = verdict { return MsauthRules.confirms(fingerprint: summary.policyFingerprint, typed: typed) }
        return false
    }
    var refusal: String? {
        switch verdict {
        case .signable: return nil
        case .uncheckedRecipient: return String(localized: "Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.")
        case .noNode(let url): return String(localized: "No node answered at \(url), so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.")
        case .wrongChain(let p, let w): return String(localized: "This proposal is for chain \(String(p)); this wallet is on chain \(String(w)).")
        case .wrongGenesis: return String(localized: "This proposal is bound to another genesis than the one this wallet's node serves.")
        case .expired(let h, let e): return String(localized: "This proposal expires at height \(String(e)) and the chain is at \(String(h)): too late to sign. Ask for a new proposal.")
        }
    }
}

/// Paste or open proposal.json, review what the core checked, type the last four, Face ID, share.
/// The proposal is @State of this view only and is dropped with it.
struct SignProposalView: View {
    let profile: SignerProfile
    @EnvironmentObject var store: SignerStore
    @EnvironmentObject var settings: Settings
    @State private var proposal = ""
    @State private var model: SignProposalModel?
    @State private var typed = ""
    @State private var share: String?
    @State private var error: String?
    @State private var importing = false
    @State private var checking = false
    @State private var shareToVerify = ""
    @State private var payees: [String] = []   // one per output with needsPayee, in order
    @State private var inHand = Set<Int>()

    var body: some View {
        Form {
            Section(profile.label) {
                Text(profile.fingerprint).font(.mono)
                Text("\(profile.threshold) of \(profile.signers) · signer \(profile.index)")
            }
            Section("Proposal") {
                TextEditor(text: $proposal).font(.mono).frame(minHeight: 80).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Open file") { importing = true }
                Button(checking ? "Checking…" : "Check proposal") { Task { await check() } }.disabled(checking || proposal.isEmpty)
                if let error { Text(error).foregroundColor(.red) }
            }
            if let m = model {
                Section("What this proposal does, as checked against your policy") {
                    ForEach(Array(m.lines.enumerated()), id: \.offset) { Text(verbatim: $0.element).font(.mono) }
                }
                Section("Enter the address you mean to pay for each payment below. An output that does not match it cannot be signed.") {
                    let paying = m.summary.outputs.filter(\.needsPayee)
                    ForEach(paying.indices, id: \.self) { i in
                        TextField("rand1…", text: Binding(get: { i < payees.count ? payees[i] : "" },
                                                         set: { v in while payees.count <= i { payees.append("") }; payees[i] = v }))
                            .font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                    }
                    Button("Check payees") { Task { await check() } }
                }
                if let r = m.refusal {
                    Section { Text(r).foregroundColor(.red); Button("Retry") { Task { await check() } } }
                } else {
                    Section("Type the last four characters of the account fingerprint") {
                        TextField("", text: $typed).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                        Button("Sign") { sign(m) }.disabled(!m.canSign(typed: typed))
                    }
                }
            }
            if let share {
                Section("Your share — send it to whoever proves the proposal") {
                    Text(verbatim: share).font(.mono).textSelection(.enabled).lineLimit(3)
                    Button("Copy") { UIPasteboard.general.string = share }
                    ShareLink(item: share)
                }
            }
            Section("Check a share") {
                TextField("index:hex", text: $shareToVerify).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Check share") { verifyShare() }
                if !inHand.isEmpty { Text("\(inHand.count) of \(profile.threshold) in hand: signers \(inHand.sorted().map(String.init).joined(separator: ", "))") }
            }
        }
        .navigationTitle("Sign a proposal")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            if case .success(let url) = result, url.startAccessingSecurityScopedResource() {
                defer { url.stopAccessingSecurityScopedResource() }
                if let d = try? Data(contentsOf: url), d.count <= 1 << 20 { proposal = String(decoding: d, as: UTF8.self) }
                else { error = String(localized: "That file is larger than a proposal, a policy or a key file can be.") }
            }
        }
        .onDisappear { proposal = ""; model = nil }
    }

    private func check() async {
        checking = true; defer { checking = false }
        error = nil; model = nil; share = nil
        do {
            let policy = try store.policy(profile.id)
            guard let url = settings.rpcURL else { throw RpcClient.RpcError(code: 0, message: String(localized: "Set a valid RPC URL in Settings")) }
            let (s, v) = try await MsauthRules.check(proposal: proposal, policy: policy, payees: payees, rpc: RpcClient(url: url), chainId: UInt64(settings.chainId))
            model = SignProposalModel(summary: s, verdict: v)
        } catch { self.error = error.localizedDescription }
    }
    private func sign(_ m: SignProposalModel) {
        Task {
            await check()                     // a fresh head right before signing
            guard let fresh = model, fresh.canSign(typed: typed) else { return }
            do {
                let policy = try store.policy(profile.id)
                let text = MsauthRules.clean(proposal)
                share = try store.withSeed(profile.id, reason: String(localized: "Sign a multisig proposal")) { seed in
                    try RandCore.msauthSign(proposal: text, policy: policy, seed: seed)
                }
            } catch { self.error = error.localizedDescription }
        }
    }
    private func verifyShare() {
        do {
            let s = MsauthRules.clean(shareToVerify)
            try RandCore.msauthVerifyShare(proposal: MsauthRules.clean(proposal), policy: try store.policy(profile.id), share: s)
            if let i = Int(s.split(separator: ":").first ?? "") { inHand.insert(i) }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
```

`SignersView.swift`: a `List` of `store.profiles` (label, fingerprint, "T of N · signer i") with `NavigationLink { SignProposalView(profile:) }` and swipe-to-delete (asks `Keychain.authenticate(reason:)` first, then `store.remove`); an "Add a signer" sheet with a label `TextField`, two `TextEditor`s (policy, key) each with an "Open file" `.fileImporter`, a "Check" button that calls `RandCore.msauthPolicyInfo` + `msauthSignerImport(_:policy:)` and shows fingerprint (large mono), address, "T of N · this key is signer i", the compare-out-of-band sentence, then "Save signer" → `store.add` (errors shown by `localizedDescription`). `SettingsView`: `Section { NavigationLink("Manage multisig signers") { SignersView() } } header: { Text("Multisig signers") }`. `RandWalletApp`: `.environmentObject(SignerStore.shared)`.

- [ ] **Step 3: Strings.** Build once (`xcodebuild … build`), confirm `git diff ios/RandWallet/Localizable.xcstrings` shows the new keys (add `"key" : { }` entries by hand for any missing), add every new key to each `ios/l10n/<code>.json` using Task 9's term table, then `python3 scripts/i18n/native_check.py ios <code>` for each of `ar de es fa fr hi id it ja ko ms pl ps pt-BR ru ta ur zh-Hans zh-Hant-HK` → `0 problem(s)`, then `python3 scripts/i18n/native_check.py ios-merge`.
- [ ] **Step 4: Run** the iOS test command → all PASS.
- [ ] **Step 5: Commit** `ios: Settings → Multisig signers — add from files, check, review the core's lines, last four + Face ID, ShareLink; 20 languages` + trailer.

---

### Task 12: Android — core wrappers, signer vault (Keystore per-use key), signing rules

**Files:**
- Create: `android/app/src/main/java/org/randprotocol/wallet/wallet/MsauthCore.java`, `.../wallet/NativeMsauthCore.java`, `.../wallet/SignFlow.java`, `.../security/SignerProfiles.java`, `.../security/KeystoreSeedCipher.java`, `android/app/src/test/java/org/randprotocol/wallet/wallet/SignFlowTest.java`, `android/app/src/test/java/org/randprotocol/wallet/security/SignerProfilesTest.java`
- Modify: `.../core/Core.java` (five wrappers), `.../security/KeyVault.java` (`KeyValue` adapter; `erase()` also removes profiles and Keystore keys), `.../ui/CoreErrors.java` (Task 5 sentences), `android/app/build.gradle` (test resources)

**Interfaces:**
- Produces: `Core.msauthCheck(String proposal, String policy, List<String> expectedRecipients) -> JSONObject`, `Core.msauthSign(String proposal, String policy, String seedHex) -> String`, `Core.msauthVerifyShare(...)`, `Core.msauthSignerImport(String input, String policy) -> JSONObject`, `Core.msauthPolicyInfo(String policy) -> JSONObject`; `interface MsauthCore` (same five, `throws Exception`); `SignFlow.EXPIRY_MARGIN = 16`, `enum SignFlow.Verdict { SIGNABLE, UNCHECKED_RECIPIENT, NO_NODE, WRONG_CHAIN, WRONG_GENESIS, EXPIRED }`, `SignFlow.verdict(JSONObject summary, Long head, long chainId, String genesis)`, `SignFlow.confirms(String fingerprint, String typed)`, `SignFlow.clean(String)`, `SignFlow.lines(JSONObject summary) -> List<String>`; `interface SignerProfiles.KeyValue { String get(String); void put(String, String); void remove(String); }`; `SignerProfiles(KeyValue)` with `list() -> List<Profile>`, `add(Profile, String policy, String sealedSeed)`, `remove(String id)`, `policy(String id)`, `sealedSeed(String id)`, `Profile {id, label, index, policyHash}`; `KeystoreSeedCipher.createKey(id)`, `.encryptCipher(id)`, `.decryptCipher(id, byte[] iv)`, `.deleteKey(id)`, `seal(byte[] iv, byte[] ct) -> "ivB64:ctB64"`, `unseal(String) -> byte[][]`.

- [ ] **Step 1: Test resources.** `android/app/build.gradle`, inside `android { … }`:

```groovy
    // The private-multisig vectors (fullnode e34117be), held to their SHA-256s by ui/test/msauth-fixtures.test.mjs.
    sourceSets { test { resources.srcDirs += ['../../ui/test/fixtures/msauth'] } }
```

- [ ] **Step 2: Failing tests.** `SignFlowTest.java`:

```java
package org.randprotocol.wallet.wallet;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class SignFlowTest {
    private static JSONObject expectedSummary() throws Exception {
        try (InputStream in = SignFlowTest.class.getResourceAsStream("/expected.json")) {
            JSONObject s = new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getJSONObject("summary");
            // msauth_check adds these beside fullnode's summary (wallet-core msauth.rs).
            return s.put("recipients_checked", true).put("chain_id", 7).put("genesis", "0".repeat(64)).put("binding_domain", 0)
                    .put("lines", new org.json.JSONArray().put("0: x (owner key verified; delivery key NOT verifiable from this proposal)"));
        }
    }

    @Test public void theExpiryRuleIsTheClis() throws Exception {
        JSONObject s = expectedSummary(); // expires_at 2024
        assertEquals(16, SignFlow.EXPIRY_MARGIN);
        assertEquals(SignFlow.Verdict.SIGNABLE, SignFlow.verdict(s, 2007L, 7, null));
        assertEquals(SignFlow.Verdict.EXPIRED, SignFlow.verdict(s, 2008L, 7, null));
        assertEquals(SignFlow.Verdict.NO_NODE, SignFlow.verdict(s, null, 7, null));
        assertEquals(SignFlow.Verdict.WRONG_CHAIN, SignFlow.verdict(s, 1L, 21, null));
        s.put("binding_domain", 1);
        assertEquals(SignFlow.Verdict.WRONG_GENESIS, SignFlow.verdict(s, 1L, 7, "ab".repeat(32)));
        s.put("recipients_checked", false);
        assertEquals("an unchecked payee refuses before anything else", SignFlow.Verdict.UNCHECKED_RECIPIENT, SignFlow.verdict(s, null, 7, null));
    }

    @Test public void confirmationIsTheLastFour() {
        assertTrue(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", " aak3"));
        assertFalse(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", "aak"));
        assertFalse(SignFlow.confirms("", ""));
    }

    @Test public void linesAreTheCoresVerbatimAndFilesAreCleaned() throws Exception {
        assertEquals("0: x (owner key verified; delivery key NOT verifiable from this proposal)", SignFlow.lines(expectedSummary()).get(0));
        assertEquals("{}", SignFlow.clean("﻿ {}\r\n"));
    }
}
```

`SignerProfilesTest.java`:

```java
package org.randprotocol.wallet.security;

import static org.junit.Assert.*;

import org.junit.Test;
import java.util.HashMap;
import java.util.Map;

public class SignerProfilesTest {
    static final class MapKv implements SignerProfiles.KeyValue {
        final Map<String, String> m = new HashMap<>();
        public String get(String k) { return m.get(k); }
        public void put(String k, String v) { m.put(k, v); }
        public void remove(String k) { m.remove(k); }
    }

    @Test public void addListRemoveKeepsBothHalvesUnderTheirNames() throws Exception {
        MapKv kv = new MapKv();
        SignerProfiles p = new SignerProfiles(kv);
        p.add(new SignerProfiles.Profile("a1", "treasury", 2, "33".repeat(32)), "{policy}", "iv:ct");
        assertEquals(1, p.list().size());
        assertEquals("{policy}", kv.get("msauth.a1.policy"));
        assertEquals("iv:ct", kv.get("msauth.a1.seed"));
        try { p.add(new SignerProfiles.Profile("b2", "again", 2, "33".repeat(32)), "{policy}", "x:y"); fail("duplicate"); }
        catch (IllegalStateException e) { assertTrue(e.getMessage().contains("treasury")); }
        p.remove("a1");
        assertNull(kv.get("msauth.a1.policy"));
        assertNull(kv.get("msauth.a1.seed"));
        assertTrue(p.list().isEmpty());
    }

    @Test public void aSealedSeedRoundTrips() {
        byte[][] parts = KeystoreSeedCipher.unseal(KeystoreSeedCipher.seal(new byte[] {1, 2}, new byte[] {3, 4, 5}));
        assertArrayEquals(new byte[] {1, 2}, parts[0]);
        assertArrayEquals(new byte[] {3, 4, 5}, parts[1]);
    }
}
```

Run the Android test command → FAIL (classes missing).

- [ ] **Step 3: Implement.** `SignFlow.java`:

```java
package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The signing rules every app shares (spec 2026-10-11-msauth-signing-design.md §4). Pure: JVM-tested. */
public final class SignFlow {
    private SignFlow() {}
    /** The CLI's margin (fullnode d5b2e652 `EXPIRY_MARGIN`): refuse at head + 16 >= expires_at. */
    public static final long EXPIRY_MARGIN = 16;
    public enum Verdict { SIGNABLE, UNCHECKED_RECIPIENT, NO_NODE, WRONG_CHAIN, WRONG_GENESIS, EXPIRED }

    public static Verdict verdict(JSONObject s, Long head, long chainId, String genesis) {
        // Spec §4 step 3: never sign on an unmatched or unchecked payee.
        if (!s.optBoolean("recipients_checked", false)) return Verdict.UNCHECKED_RECIPIENT;
        if (head == null) return Verdict.NO_NODE;
        if (s.optLong("chain_id", -1) != chainId) return Verdict.WRONG_CHAIN;
        if (s.optInt("binding_domain", 0) >= 1 && !s.optString("genesis", "").equalsIgnoreCase(genesis == null ? "" : genesis)) return Verdict.WRONG_GENESIS;
        if (head + EXPIRY_MARGIN >= s.optLong("expires_at", 0)) return Verdict.EXPIRED;
        return Verdict.SIGNABLE;
    }
    public static boolean confirms(String fingerprint, String typed) {
        String fp = fingerprint == null ? "" : fingerprint.replace("-", "");
        if (fp.length() < 4) return false;
        String want = fp.substring(fp.length() - 4).toLowerCase(Locale.ROOT);
        return typed != null && typed.replace("-", "").trim().toLowerCase(Locale.ROOT).equals(want);
    }
    public static String clean(String s) {
        String t = s == null ? "" : s;
        if (t.startsWith("﻿")) t = t.substring(1);
        return t.trim();
    }
    /** fullnode's lines, verbatim — never translated. */
    public static List<String> lines(JSONObject s) {
        List<String> out = new ArrayList<>();
        JSONArray a = s.optJSONArray("lines");
        for (int i = 0; a != null && i < a.length(); i++) out.add(a.optString(i));
        return out;
    }
}
```

`SignerProfiles.java`:

```java
package org.randprotocol.wallet.security;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Signer profiles beside the spend key (spec §3): {@code msauth.index}, {@code msauth.<id>.policy},
 * {@code msauth.<id>.seed} (the seed sealed by {@link KeystoreSeedCipher}, "ivB64:ctB64").
 */
public final class SignerProfiles {
    public interface KeyValue { String get(String k); void put(String k, String v); void remove(String k); }
    public static final class Profile {
        public final String id, label, policyHash; public final int index;
        public Profile(String id, String label, int index, String policyHash) { this.id = id; this.label = label; this.index = index; this.policyHash = policyHash; }
        JSONObject toJson() throws JSONException { return new JSONObject().put("id", id).put("label", label).put("index", index).put("policyHash", policyHash); }
        static Profile of(JSONObject o) { return new Profile(o.optString("id"), o.optString("label"), o.optInt("index"), o.optString("policyHash")); }
    }
    private final KeyValue kv;
    public SignerProfiles(KeyValue kv) { this.kv = kv; }

    public List<Profile> list() {
        List<Profile> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(kv.get("msauth.index") == null ? "[]" : kv.get("msauth.index"));
            for (int i = 0; i < a.length(); i++) out.add(Profile.of(a.getJSONObject(i)));
        } catch (JSONException e) { /* an unreadable index is an empty one */ }
        return out;
    }
    public void add(Profile p, String policy, String sealedSeed) throws JSONException {
        List<Profile> all = list();
        for (Profile q : all) if (q.policyHash.equals(p.policyHash) && q.index == p.index) throw new IllegalStateException("this signer is already saved as " + q.label);
        kv.put("msauth." + p.id + ".policy", policy);
        kv.put("msauth." + p.id + ".seed", sealedSeed);
        all.add(p);
        writeIndex(all);
    }
    public void remove(String id) {
        kv.remove("msauth." + id + ".policy");
        kv.remove("msauth." + id + ".seed");
        List<Profile> all = list();
        all.removeIf(p -> p.id.equals(id));
        try { writeIndex(all); } catch (JSONException e) { throw new IllegalStateException(e); }
    }
    public String policy(String id) { return kv.get("msauth." + id + ".policy"); }
    public String sealedSeed(String id) { return kv.get("msauth." + id + ".seed"); }
    private void writeIndex(List<Profile> all) throws JSONException {
        JSONArray a = new JSONArray();
        for (Profile p : all) a.put(p.toJson());
        kv.put("msauth.index", a.toString());
    }
}
```

`KeystoreSeedCipher.java`:

```java
package org.randprotocol.wallet.security;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * One Keystore AES-256-GCM key per signer profile, usable only right after the user authenticates
 * (spec §3: every signature re-authenticates). API 30+: biometric or device credential, per use
 * (timeout 0). API 26–29: per-use auth exists only for biometrics (validity -1), so on those
 * devices a profile needs an enrolled biometric. The cipher goes through BiometricPrompt's
 * CryptoObject; nothing here prompts.
 */
public final class KeystoreSeedCipher {
    private KeystoreSeedCipher() {}
    private static final String STORE = "AndroidKeyStore";
    static String alias(String id) { return "msauth." + id; }

    public static void createKey(String id) throws GeneralSecurityException {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias(id), KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        else b.setUserAuthenticationValidityDurationSeconds(-1);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        g.init(b.build());
        g.generateKey();
    }
    private static SecretKey key(String id) throws GeneralSecurityException {
        KeyStore ks = KeyStore.getInstance(STORE);
        try { ks.load(null); } catch (java.io.IOException e) { throw new GeneralSecurityException(e); }
        return (SecretKey) ks.getKey(alias(id), null);
    }
    public static Cipher encryptCipher(String id) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(id));
        return c;
    }
    public static Cipher decryptCipher(String id, byte[] iv) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(id), new GCMParameterSpec(128, iv));
        return c;
    }
    public static void deleteKey(String id) {
        try { KeyStore ks = KeyStore.getInstance(STORE); ks.load(null); ks.deleteEntry(alias(id)); } catch (Exception ignored) { }
    }
    public static String seal(byte[] iv, byte[] ct) { return Base64.getEncoder().encodeToString(iv) + ":" + Base64.getEncoder().encodeToString(ct); }
    public static byte[][] unseal(String s) {
        String[] p = s.split(":", 2);
        return new byte[][] { Base64.getDecoder().decode(p[0]), Base64.getDecoder().decode(p[1]) };
    }
}
```

`MsauthCore.java` (interface, the five methods returning `JSONObject`/`String`/`void`, `throws Exception`), `NativeMsauthCore.java` (delegates to `Core`), `Core.java`:

```java
    // ---- private multisig signing (wallet-core msauth.rs) ----
    public static JSONObject msauthCheck(String proposal, String policy, java.util.List<String> expectedRecipients) throws CoreException {
        return object("msauth_check", p("proposal", proposal, "policy", policy, "expected_recipients", new org.json.JSONArray(expectedRecipients)));
    }
    /** {@code seedHex} is the caller's; it wipes its byte[] after (the String cannot be wiped). */
    public static String msauthSign(String proposal, String policy, String seedHex) throws CoreException {
        Object v = call("msauth_sign", p("proposal", proposal, "policy", policy, "seed", seedHex));
        if (v instanceof String) return (String) v;
        throw new CoreException("msauth_sign returned no share");
    }
    public static void msauthVerifyShare(String proposal, String policy, String share) throws CoreException { call("msauth_verify_share", p("proposal", proposal, "policy", policy, "share", share)); }
    public static JSONObject msauthSignerImport(String input, String policy) throws CoreException {
        return object("msauth_signer_import", policy == null ? p("input", input) : p("input", input, "policy", policy));
    }
    public static JSONObject msauthPolicyInfo(String policy) throws CoreException { return object("msauth_policy_info", p("policy", policy)); }
```

`KeyVault.java`: add

```java
    /** The signer profiles' storage, in this same encrypted file (spec §3). */
    public SignerProfiles.KeyValue signerStore() {
        return new SignerProfiles.KeyValue() {
            public String get(String k) { return prefs.getString(k, null); }
            public void put(String k, String v) { prefs.edit().putString(k, v).commit(); }
            public void remove(String k) { prefs.edit().remove(k).commit(); }
        };
    }
```

and in `erase()`, before the commit: `for (SignerProfiles.Profile p : new SignerProfiles(signerStore()).list()) { KeystoreSeedCipher.deleteKey(p.id); new SignerProfiles(signerStore()).remove(p.id); } prefs.edit().remove("msauth.index").commit();`. `CoreErrors.java`: Task 5's sentences (EXACT + PATTERNED, the file's pattern; new `R.string.msauth_*` ids added in Task 13's strings — add them to `values/strings.xml` now so this compiles).

- [ ] **Step 4: Run** the Android test command → PASS (`SignFlowTest`, `SignerProfilesTest`, `CoreErrorsTest`, `StringsParityTest`).
- [ ] **Step 5: Commit** `android: msauth core wrappers, SignFlow rules, signer profiles in KeyVault, a per-use Keystore key per seed` + trailer.
- [ ] **Step 9 (manual, later with Task 13): device check** — API 30+ device with a screen lock: add a profile (prompt), sign twice (prompt each time); an API 26–29 emulator without biometrics: adding a profile is refused with the "needs a fingerprint" sentence.

---

### Task 13: Android — screens and strings

**Files:**
- Create: `.../ui/SignersActivity.java`, `.../ui/SignProposalActivity.java`, `android/app/src/main/res/layout/activity_signers.xml`, `android/app/src/main/res/layout/activity_sign_proposal.xml`
- Modify: `AndroidManifest.xml` (two activities, `exported=false`), `.../ui/SettingsActivity.java` + `activity_settings.xml` (a "Manage multisig signers" button), `res/values/strings.xml` and the 19 `res/values-*/strings.xml`

**Interfaces:**
- Consumes: Task 12's `SignFlow`, `SignerProfiles`, `KeystoreSeedCipher`, `Core.msauth*`, `RpcClient(prefs.rpcUrl())` (`chainId()`, `headHeight()`, `genesisHash()`), `Unlock.authenticators()`.

- [ ] **Step 1: Failing test** — extend `StringsParityTest` coverage automatically: add the new `L10n.t(R.string.msauth_*, "…")` calls in the activities first; `StringsParityTest` then fails until `values/strings.xml` holds them. Run the Android test command → FAIL on the missing resources.
- [ ] **Step 2: Activities.**
  - `SignersActivity`: list of `SignerProfiles.list()` rows (label, fingerprint from `Core.msauthPolicyInfo(policy)`, "T of N · signer i"); "Add a signer": label `EditText`, two `EditText`s with "Open file" buttons launching `registerForActivityResult(new ActivityResultContracts.OpenDocument(), …)` with `new String[]{"application/json", "text/plain"}` (refuse > 1 MiB), "Check" → `Core.msauthPolicyInfo` + `Core.msauthSignerImport(key, policy)` → shows fingerprint/address/position/compare sentence → "Save signer": `KeystoreSeedCipher.createKey(id)`, `BiometricPrompt` with `CryptoObject(encryptCipher(id))` (authenticators: `Unlock.authenticators()` on API 30+, `BIOMETRIC_STRONG` + negative button below), on success `doFinal(seedBytes)` → `SignerProfiles.add(profile, policy, KeystoreSeedCipher.seal(cipher.getIV(), ct))`; `Arrays.fill(seedBytes, (byte) 0)` in `finally`. If `BiometricManager.canAuthenticate(...)` is not `BIOMETRIC_SUCCESS`, refuse with `msauth_needs_device_auth` ("Set a screen lock (and on Android 10 or older, a fingerprint) first: a signer key is used only right after you authenticate.").
  - `SignProposalActivity` (extra `id`): proposal `EditText` + Open file; "Check proposal" on a background thread: `Core.msauthCheck(SignFlow.clean(text), policy, payees)` (first with no payees; then one `EditText` per output with `needs_payee`, labelled with its amount and owner key, and "Check payees" re-runs the check with the typed addresses; a new proposal clears them; UNCHECKED_RECIPIENT shows "Enter the address of every payee…" and no Sign), then `rpc.chainId()`, `rpc.headHeight()`, `rpc.genesisHash()` (any exception → head `null`), `SignFlow.verdict(...)`; shows `SignFlow.lines(summary)` verbatim (monospace `TextView`s), fee/expiry, the out-of-band sentence; a refusal shows its sentence (NO_NODE names `prefs.rpcUrl()`) with Retry; SIGNABLE shows the last-four `EditText` gating "Sign". Sign: re-run the check, then `BiometricPrompt` with `CryptoObject(decryptCipher(id, iv))` → `doFinal(ct)` → `Core.msauthSign(text, policy, hex(seed))` → `Arrays.fill(seed, 0)` → share shown with Copy and Share (`Intent.ACTION_SEND`, `text/plain`, `Intent.createChooser`). "Check a share": `Core.msauthVerifyShare` → positions in hand vs T. The proposal is a field of the activity only, cleared in `onDestroy`; `FLAG_SECURE` on both windows.
  - Settings: button → `startActivity(new Intent(this, SignersActivity.class))`.
- [ ] **Step 3: Strings.** Add every `msauth_*` string to `values/strings.xml` (the English the `L10n.t` literal carries), then each `values-{ar,de,es,fa,fr,hi,in,it,ja,ko,ms,pl,ps,pt-rBR,ru,ta,ur,zh-rCN,zh-rHK}` with Task 9's term table; `python3 scripts/i18n/native_check.py android values-<x>` for each → `0 problem(s)`.
- [ ] **Step 4: Run** the Android test command → PASS; `cd android && JAVA_HOME=… ANDROID_HOME=… ./gradlew assembleDebug` → BUILD SUCCESSFUL (needs the `.so`: `core/scripts/build-android.sh` with `ANDROID_NDK_HOME=$HOME/Library/Android/sdk/ndk/27.2.12479018`; df first).
- [ ] **Step 5: Commit** `android: Settings → Multisig signers — add from files (Keystore key, per-use auth), check, review, last four + BiometricPrompt, ACTION_SEND; 20 languages` + trailer.

---

### Task 14: One end-to-end on a devnet — the CLI prepares, web and iOS sign, the CLI proves, the payout lands

**Files:**
- Create: `scripts/e2e-msauth.sh`, `web/wallet/test/msauth.devnet.e2e.test.mjs`, `ios/RandWalletTests/LiveMsauthTests.swift`
- Modify: `core/vendor/fullnode` + `CHAIN_BUILD` + the three version asserts (re-pin, below)

**Interfaces:**
- Consumes: everything above; fullnode's CLI `rand multisig-private new-policy|address|balance|prepare|check|prove|submit` — **not in `e34117be`**: it lands at `2fb491a9`/`d5b2e652` on `feat/private-multisig` (e2e at `187af10b`).

- [ ] **Step 1: Re-pin** to the private-multisig merge commit on fullnode `main` (or, if not merged yet, the `feat/private-multisig` head, which must contain `d5b2e652`): Task 1 Steps 1–4 with that SHA (`CHAIN_BUILD` = its first 7 characters), and re-copy the fixtures if `the_fixture_copies_are_the_vendored_vectors` fails (then rewrite `ui/test/fixtures/msauth.sha256` with Task 3 Step 1's three lines and say so in the commit). Commit `core: vendor fullnode <sha> (private multisig merged; rand multisig-private)`.
- [ ] **Step 2: Build the binaries** (df ≥ 25 GiB): 

```bash
cd core/vendor/fullnode && cp Cargo.lock /private/tmp/claude-501/fullnode-lock.bak
CARGO_TARGET_DIR=$PWD/../../target/e2e cargo build --release -p randprotocol-node -p randprotocol-client
cp /private/tmp/claude-501/fullnode-lock.bak Cargo.lock; cd ../../..
core/scripts/build-wasm.sh && core/scripts/build-ios.sh
```

- [ ] **Step 3: The web signer.** `web/wallet/test/msauth.devnet.e2e.test.mjs`:

```js
// One private-multisig signature from the web wallet's engine over the real wasm core, against the
// devnet scripts/e2e-msauth.sh runs. Skipped unless MSAUTH_E2E_DIR and MSAUTH_E2E_RPC are set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';
import { mapStorage } from '../../../ui/test/backend-fixtures.mjs';

const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);
const DIR = process.env.MSAUTH_E2E_DIR || '';
const RPC = process.env.MSAUTH_E2E_RPC || '';
const SIGNER = process.env.MSAUTH_E2E_SIGNER ?? '0';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const skip = !DIR || !RPC || !existsSync(CORE_WASM) ? 'run scripts/e2e-msauth.sh' : false;
const read = (n) => readFileSync(join(DIR, n), 'utf8');

test('a web wallet signs a private-multisig proposal on a devnet', { skip, timeout: 120_000 }, async () => {
  const mod = await import(CORE_JS.href);
  mod.initSync({ module: readFileSync(CORE_WASM) });
  const core = { async call(m, p = {}) { const r = JSON.parse(mod.call(m, JSON.stringify(p))); if (!r.ok) throw new Error(r.error); return r.value; } };
  const backend = makeWasmBackend({ core, storage: mapStorage(), fetch, platform: { name: 'node-e2e', openExternal() {}, copy() {} }, locks: null, broadcast: null });
  await backend.wallet.create(PASSWORD);
  await backend.settings.set({ rpcUrl: RPC });
  const [row] = await backend.signers.add({ label: 'web signer', policy: read('policy.json'), key: read(`signer${SIGNER}.key.json`), password: PASSWORD });
  assert.equal(row.index, Number(SIGNER));
  const payee = read('payee.txt').trim();
  const unchecked = await backend.signers.check(row.id, read('proposal.json'));
  assert.equal(unchecked.refusal.code, 'unchecked-recipient', 'no payee entered, nothing signable');
  const checked = await backend.signers.check(row.id, read('proposal.json'), [payee]);
  assert.equal(checked.signable, true, JSON.stringify(checked.refusal));
  const { share, index } = await backend.signers.sign(row.id, read('proposal.json'), [payee], PASSWORD);
  assert.equal(index, Number(SIGNER));
  assert.deepEqual(await backend.signers.verifyShare(row.id, read('proposal.json'), share), { index });
  writeFileSync(join(DIR, `share${SIGNER}.txt`), `${share}\n`);
});
```

- [ ] **Step 4: The iOS signer.** `ios/RandWalletTests/LiveMsauthTests.swift`:

```swift
import XCTest
@testable import RandWallet

/// One private-multisig signature through RandCore on the simulator, against the devnet
/// scripts/e2e-msauth.sh runs (it passes the files' contents: TEST_RUNNER_RAND_MSAUTH_*). The
/// Keychain's `.userPresence` cannot exist on a passcode-less simulator, so the store runs over
/// FakeSignerSecrets here; the device check is Task 10 Step 8.
@MainActor
final class LiveMsauthTests: XCTestCase {
    func testSignsADevnetProposalThroughTheCore() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let proposal = env["RAND_MSAUTH_PROPOSAL"], let policy = env["RAND_MSAUTH_POLICY"], let key = env["RAND_MSAUTH_KEY"],
              let rpc = env["RAND_MSAUTH_RPC"].flatMap(URL.init(string:)) else {
            throw XCTSkip("run scripts/e2e-msauth.sh")
        }
        let store = SignerStore(secrets: FakeSignerSecrets())
        let profile = try store.add(label: "ios signer", policy: policy, key: key)
        guard let payee = env["RAND_MSAUTH_PAYEE"] else { throw XCTSkip("run scripts/e2e-msauth.sh") }
        let (summary, verdict) = try await MsauthRules.check(proposal: proposal, policy: try store.policy(profile.id), payees: [payee], rpc: RpcClient(url: rpc), chainId: 21)
        guard case .signable = verdict else { return XCTFail("\(verdict)") }
        XCTAssertTrue(summary.recipientsChecked)
        let share = try store.withSeed(profile.id, reason: "e2e") { try RandCore.msauthSign(proposal: MsauthRules.clean(proposal), policy: policy, seed: $0) }
        try RandCore.msauthVerifyShare(proposal: proposal, policy: policy, share: share)
        print("MSAUTH-SHARE \(share)")
    }
}
```

- [ ] **Step 5: `scripts/e2e-msauth.sh`.**

```bash
#!/usr/bin/env bash
# Private-multisig signing end to end (spec 2026-10-11-msauth-signing-design.md §6.5): a 2-of-3
# account on a one-validator Test-profile devnet (chain 21 shape: split authorisation + the multisig
# auth guest), the CLI prepares, signer 0 signs in the web wallet's engine (real wasm core), signer 2
# in iOS through RandCore on the simulator, the CLI proves (msauth tier 18 + bundle, on this Mac)
# and submits, and the payee's scan finds the payout.
#
#   RAND_NODE_BIN=core/target/e2e/release/rand-node RAND_BIN=core/target/e2e/release/rand scripts/e2e-msauth.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
: "${RAND_NODE_BIN:?set RAND_NODE_BIN}" "${RAND_BIN:?set RAND_BIN}"
DIR=${MSAUTH_E2E_DIR:-$(mktemp -d)}
PORT=${MSAUTH_E2E_PORT:-18545}
RPC="http://127.0.0.1:$PORT"
export RAND_MSAUTH_VK="$ROOT/core/vendor/fullnode/crates/randprotocol-zkvm/keys/msauth-vk-test.bin"
export RAND_ALLOW_TEST_FRI_PROFILE=1
R() { "$RAND_BIN" --rpc "$RPC" "$@"; }
rpc() { curl -sf -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC"; }
echo "workdir $DIR"

"$RAND_NODE_BIN" keygen --out "$DIR/node.key.json"
for i in 0 1 2; do "$RAND_NODE_BIN" keygen --out "$DIR/signer$i.key.json"; done
R --key "$DIR/b.key.json" keygen
B=$(R --key "$DIR/b.key.json" address | grep -Eo 'rand1[1-9A-HJ-NP-Za-km-z]+' | head -1)
"$RAND_NODE_BIN" genesis --chain-id 21 --fri-profile test --faucet --validator "$DIR/node.key.json,1000,$B" \
  --gas-price 100 --byte-price 800 --bundle-gas-limit 20479 --bundle-guest v3 --auth-guest --auth-multisig-guest \
  --max-proof-bytes 4194304 --max-block-bytes 20971520 --binding-domain 1 --proof-window-blocks 1024 --out "$DIR/genesis.json"
"$RAND_NODE_BIN" init --datadir "$DIR/data" --genesis "$DIR/genesis.json"
"$RAND_NODE_BIN" run --datadir "$DIR/data" --key "$DIR/node.key.json" --validator --rpc "127.0.0.1:$PORT" \
  --listen /ip4/127.0.0.1/tcp/0 --no-mdns --block-interval-ms 3000 --view-timeout-ms 6000 --min-free-disk-mb 0 > "$DIR/node.log" 2>&1 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT
for _ in $(seq 120); do rpc rand_status | grep -q '"msauth_key":"loaded"' && break; sleep 1; done
rpc rand_status | grep -q '"msauth_key":"loaded"' || { tail -40 "$DIR/node.log"; exit 1; }

pk() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$1"; }
R multisig-private new-policy --signer "$(pk "$DIR/signer0.key.json")" --signer "$(pk "$DIR/signer1.key.json")" \
  --signer "$(pk "$DIR/signer2.key.json")" --threshold 2 --out "$DIR/policy.json"
ACCT=$(R multisig-private address --policy "$DIR/policy.json" | sed -n 's/^address: //p')
R faucet "$ACCT" --amount 100
R multisig-private balance --policy "$DIR/policy.json"
R multisig-private prepare --policy "$DIR/policy.json" --to "$B" --amount 10 --out "$DIR/proposal.json"
echo "$B" > "$DIR/payee.txt"   # what each signer is told out of band, and types in

MSAUTH_E2E_DIR="$DIR" MSAUTH_E2E_RPC="$RPC" MSAUTH_E2E_SIGNER=0 node --test web/wallet/test/msauth.devnet.e2e.test.mjs

( cd ios && TEST_RUNNER_RAND_MSAUTH_PROPOSAL="$(cat "$DIR/proposal.json")" TEST_RUNNER_RAND_MSAUTH_POLICY="$(cat "$DIR/policy.json")" \
  TEST_RUNNER_RAND_MSAUTH_KEY="$(cat "$DIR/signer2.key.json")" TEST_RUNNER_RAND_MSAUTH_RPC="$RPC" TEST_RUNNER_RAND_MSAUTH_PAYEE="$B" \
  xcodebuild -project RandWallet.xcodeproj -scheme RandWallet -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test -only-testing:RandWalletTests/LiveMsauthTests ) 2>&1 | tee "$DIR/ios.log"
sed -n 's/.*MSAUTH-SHARE //p' "$DIR/ios.log" | head -1 > "$DIR/share2.txt"
grep -q '^2:' "$DIR/share2.txt" || { echo "iOS printed no share"; exit 1; }

/usr/bin/time -l "$RAND_BIN" --rpc "$RPC" --cpu multisig-private prove --proposal "$DIR/proposal.json" --policy "$DIR/policy.json" \
  --signature "$(tr -d '\n' < "$DIR/share0.txt")" --signature "$(tr -d '\n' < "$DIR/share2.txt")" --out "$DIR/proposal.tx" 2> "$DIR/prove.time"
grep 'maximum resident set size' "$DIR/prove.time"
R multisig-private submit --tx "$DIR/proposal.tx"
R --key "$DIR/b.key.json" sync
R --key "$DIR/b.key.json" balance | tee "$DIR/b.balance"
grep -Eq '(^|[^0-9.])10(\.0+)? RAND' "$DIR/b.balance" || { echo "the payee does not hold 10 RAND"; exit 1; }
echo "msauth e2e: OK"
```

`chmod +x scripts/e2e-msauth.sh`. If `genesis` refuses a flag, read `"$RAND_NODE_BIN" genesis --help` and adjust to the fullnode `187af10b` test genesis (`genesis_private_multisig`: proof window 1024, 4 MiB proofs, 20 MiB blocks, gas section).
- [ ] **Step 6: Run** (nothing else proving; df ≥ 25 GiB): `RAND_NODE_BIN=core/target/e2e/release/rand-node RAND_BIN=core/target/e2e/release/rand scripts/e2e-msauth.sh 2>&1 | tee /private/tmp/claude-501/msauth-e2e.log` → `msauth e2e: OK`. Record the prove's wall time and peak RSS (fullnode's CLI says "at least 48 GB" for tier 18; the Test-profile peak is unmeasured in fullnode's docs — this run measures it; this Mac has 48 GB: if the peak passes ~40 GB, stop and report rather than swap).
- [ ] **Step 7: Commit** `e2e: private multisig end to end — CLI prepares, the web engine and iOS sign through the core, CLI proves and submits, the payout lands (<prove time>, <peak RSS>)` + trailer.

---

## Self-review notes (2026-10-12)

- Spec coverage: §2 table → Tasks 3–4 (+ wrappers 5, 10, 12); §3 storage and re-auth → 6, 10, 12; §4 steps 1–5 → 6–8, 11, 13; file pickers → 8, 11, 13; error mapping → 5, 10, 12; §6.1 re-pin + prover e2e → 1, 2; §6.3 locales → 9, 11, 13; §6.5 devnet → 14. Deferred by decision: profiles without a wallet (Global Constraints).
- Spec `639cae7` (§4 step 3, payees entered; chain-id/genesis line compared with the node): Tasks 3, 5, 7, 8, 10–14; the crate half is still moving — every dependent name is tagged **[confirm: 0e]**; the re-vendor to the fix-wave commit (Task 14 Step 1, or earlier if 0e lands first) re-copies the fixtures, rewrites `msauth.sha256`, and renames to match.
- Spec facts corrected here: the msig crate signs through `randprotocol_core::Keypair` (no direct `crystals-dilithium` dependency; that is a zkvm dev-dependency); a tampered output is refused as "output N does not open as this account's: refusing to sign value it cannot see"; `core-errors.js` maps English sentences, not codes; `ProposalSummary` amounts are `u64` and are re-shaped to strings; the CLI (`rand multisig-private`) is not in `e34117be` (it lands at `2fb491a9`/`d5b2e652`, e2e `187af10b`); the CLI's own prove line says "at least 48 GB"; JS strings cannot be zeroed; Android per-use device-credential auth with a `CryptoObject` needs API 30 (minSdk is 26).
- Names checked across tasks: `msauth_check|sign|verify_share|signer_import|policy_info`; `coreApi.msauth*`; `makeSigners` → `{group, openOnUnlock}`; `signers.{list,preview,add,remove,check,sign,verifyShare}`; `verdict`, `EXPIRY_MARGIN`, `SignerRefusal`, `cleanText`; iOS `MsauthRules`, `SignerStore`, `SignerSecrets`; Android `SignFlow`, `SignerProfiles`, `KeystoreSeedCipher`.
