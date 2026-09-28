# Delegated Proving, Phase 1 (clients) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension, the web wallet, the desktop app and the phones can send and withdraw through a prover the user paired — the extension proving through the desktop app on the same machine first — while the spend key leaves the device only inside a sealed job to a prover paired as the user's own.

**Architecture:** `wallet-core` splits `prove_transfer`/`prove_burn` into `prepare_*` (everything but the proof, returning the sealed job and a `pending` blob that carries no spend key) and `finish_proof` (opens the reply, checks digest and size, verifies, inserts the proof, encodes). The shared engine gains a `prover` group (pair/probe/forget), keeps the pairing token in the vault, and routes `send`/`burn` through the prover when the device cannot prove; `pending` and the job id sit in `storage.session` so a closed popup resumes. The desktop app hosts the fullnode's `randprotocol-prover` service behind a Settings toggle.

**Tech Stack:** Rust (wallet-core; the fullnode crates vendored as a submodule — bumped to the `v0.6.2` tag, which adds `crates/randprotocol-prover` whose `wire` module builds without its `service` feature for wasm), JavaScript (ui/engine, screens, extension), Tauri 2 (desktop), Swift (iOS), Java (Android). Tests: `node --test ui/test web/wallet/test`, `cd core && cargo test --release`.

**Spec:** `docs/superpowers/specs/2026-09-28-delegated-proving-design.md` (this repo, branch `docs/delegated-proving-spec` — merge it into this branch first: Task 0). Fullnode companion: `../fullnode/docs/superpowers/specs/2026-09-28-delegated-proving-design.md` §3 (the wire), and its Phase 1 plan `../fullnode/docs/superpowers/plans/2026-09-28-delegated-proving-phase1.md` (the `randprotocol_prover::wire` API this plan consumes).

**Branch / base:** `feat/delegated-proving` in `/private/tmp/clients-deleg`, off `main` @ `a711bc1`. **Prerequisite:** fullnode tag `v0.6.2` exists (Task 1 bumps the submodule to it).

## Global Constraints

- The wire is the fullnode's: `randprotocol_prover::wire::{ProveJob, ProveReply, WitnessKind, seal_job, open_reply, fresh_reply_key, WIRE_VERSION, MAX_SEALED_JOB_BYTES}`; JSON-RPC `prover_info | prover_submit [sealed_hex] | prover_status [job] | prover_cancel [job]`, positional params, error `-32005` busy, `-32003` unpaired (fullnode spec §3.2).
- A `SpendKey` job is built only for a pairing with `own: true` (spec §4.5); the spend key reaches `fetch` only inside a sealed job; `assertKeyNeverLeaked` covers the prover's requests.
- A reply with the wrong digest, an oversized proof (`> max_proof_bytes` from `rand_getLimits`, default the vendored `MAX_PROOF_BYTES`), or a proof that does not verify never reaches `rand_sendTransaction` (spec §3, §4.5).
- A prover URL follows the node's rule: `https` anywhere, `http` for `localhost`/`127.0.0.1`/`[::1]` only (`ui/screens/settings.js::checkRpcUrl`).
- `settings.get()` gains `prover: {mode: 'device'|'remote', name, url, kemEk, fingerprint, own}`; the token is never in `settings` (spec §4.1).
- `send.canProve()` order: device first, then a paired prover that answers `prover.probe()`, else `{ok:false, reason}` with the wasm sentence: *"This browser cannot make a transfer proof (it needs about 5.7 GB). Pair your own prover in Settings, or send from the desktop app."* (spec §4.2). `bridge.canWithdraw()` follows it.
- Phase 1 copy before saving a pairing (spec §4.4): *"This prover will receive your spend key each time it makes a proof. Anyone who controls it can spend your funds. Pair only a machine you run yourself."*
- No default prover, no directory (spec §2.4). The desktop prover binds `127.0.0.1` by default with `--accept-spend-key`, one job at a time, refuses to start under 8 GB (spec §5).
- `version` gains `prover_wire: 1` (spec §3).
- Do not edit `desktop/dist-ui/` or `web/wallet/dist/` (built copies). No `cargo fmt`.

## Rulings (controller, 2026-09-28, recorded here because the spec is silent or its assumption does not hold)

- **R1 — `pending` is not sealed by the core.** The extension runs one wasm worker per page; a session key inside the core dies with the popup, which breaks §4.3's resume. `pending` is plain JSON that carries **no spend key**: the unproven transaction (hex), the expected digest, the reply key, the per-transaction keys and the result scalars. It lives in `storage.session` (cleared on lock, like the unlocked spend key already is). Cost if wrong: an attacker with the session store learns one pending transaction's plaintext keys — the same exposure the unlocked spend key there already has.
- **R2 — the pairing token is a second vault record.** `encryptSecret(password, token)` under `K.prover_token`; pairing therefore asks for the password (Settings already verifies it for reveal flows). On unlock, `startSession` also copies the decrypted token into the session record. Cost if wrong: pairing needs one extra password entry.
- **R3 — `onPhase` gains a second argument** `detail` (`{position?, prover?}`) rather than new phase names, so every existing screen keeps working.
- **R4 — Phase 1 mobile.** iOS/Android get the Settings section and the remote path (spec Q2 is open: a phone reaches a desktop only over TLS the operator provides); they are last (Task 8) and ship even if only the LAN-with-TLS case works.

## Review Focus

1. **A popup closed mid-proof**: reopening must resume polling the same job and submit once; never submit twice — Task 3 (`a_closed_popup_resumes_the_same_job_and_submits_once`).
2. **A prover that answers `busy`**: the send must fail with the depth in the sentence, not spin — Task 3.
3. **Two pairings in a row** (re-pair to another prover): the old token must be gone from the vault and the session — Task 3 (`re_pairing_replaces_the_token_everywhere`).
4. **A reply for a different transaction** (digest mismatch): `finish_proof` refuses and the engine surfaces a definite error — Task 2 (`finish_proof_refuses_a_foreign_reply`).
5. **`max_proof_bytes` unknown** (a node without `rand_getLimits`): the core must fall back to the vendored `MAX_PROOF_BYTES`, never to "unbounded" — Task 2.

---

### Task 0: Bring the spec onto the branch

- [ ] `git merge --ff-only docs/delegated-proving-spec` is not possible (the branch diverged from main); instead `git cherry-pick 928c11d` onto `feat/delegated-proving`. Confirm `docs/superpowers/specs/2026-09-28-delegated-proving-design.md` exists. No test. Commit is the cherry-pick itself.

### Task 1: Bump the vendored fullnode to `v0.6.2` and wire the prover crate into the core

**Files:**
- Modify: `core/vendor/fullnode` (submodule pointer → the `v0.6.2` tag), `core/Cargo.toml` (`randprotocol-prover = { path = "vendor/fullnode/crates/randprotocol-prover", default-features = false }`), `core/crates/wallet-core/Cargo.toml` (add the dependency), `core/crates/wallet-core/src/lib.rs:54` (`CHAIN_BUILD` → the v0.6.2 sha), `README.md` (the submodule line), the `core/Cargo.lock`
- Test: `core/crates/wallet-core/src/lib.rs` tests — `version_reports_prover_wire_1`

- [ ] **Step 1: The failing test**

```rust
#[test]
fn version_reports_prover_wire_1() {
    let v: Value = serde_json::from_str(&call("version", "{}")).unwrap();
    assert_eq!(v["value"]["prover_wire"], 1);
    assert_eq!(v["value"]["prover_wire"], randprotocol_prover::wire::WIRE_VERSION);
}
```

- [ ] **Step 2:** `cd core && cargo test --release -p wallet-core version_reports_prover_wire_1` → fails (no dependency / no field).
- [ ] **Step 3:** bump the submodule (`cd core/vendor/fullnode && git fetch --tags && git checkout v0.6.2`), add the dependency, add `"prover_wire": randprotocol_prover::wire::WIRE_VERSION` to `constants()` beside `"hc_bundle"` (`lib.rs:1957`). Rebuild wasm the way `core/scripts/` does (read `core/README.md`; the wasm target must still link — `randprotocol-prover` without `service` pulls only ml-kem/chacha/blake3/postcard/zeroize/serde, all already in the wasm build through zkvm; `getrandom` needs the same `wasm_js` cfg the crate already sets).
- [ ] **Step 4:** the test passes; `cargo test --release -p wallet-core` all green; the wasm build (`core/scripts/build-wasm.sh` or whatever the README names) succeeds and `web/wallet/test/core.integration.test.mjs` passes against the fresh `.wasm`.
- [ ] **Step 5:** commit `core: vendor fullnode v0.6.2 — randprotocol-prover's wire for the light client; version.prover_wire = 1`.

### Task 2: `prepare_transfer`, `prepare_burn`, `finish_proof`

**Files:**
- Modify: `core/crates/wallet-core/src/lib.rs` (`:1271-1300` `TransferBuild`/`build_transfer_unproven`, `:1522-1560` `BurnBuild`/`build_burn_unproven`, `:1378` `prove_transfer`, `:1635` `prove_burn`, `:2100-2206` `dispatch`, `:2054-2099` its doc comment)

**Interfaces:**
```rust
#[derive(Deserialize)] pub struct ProverTarget { pub kem_ek: String /* hex */, pub token: String /* hex 64 */, #[serde(default = "spend_key_kind")] pub witness_kind: String /* "spend_key" */ }
#[derive(Deserialize)] pub struct PrepareTransferRequest { #[serde(flatten)] pub req: ProveRequest, pub prover: ProverTarget, #[serde(default)] pub max_proof_bytes: Option<u32> }
#[derive(Deserialize)] pub struct PrepareBurnRequest { #[serde(flatten)] pub req: BurnRequest, pub prover: ProverTarget, #[serde(default)] pub max_proof_bytes: Option<u32> }
/// No spend key, no witness. Everything finish_proof needs to produce the same ProveResult/BurnResult prove_* would.
#[derive(Serialize, Deserialize)] pub struct Pending { pub kind: String /* "transfer" | "burn" */, pub tx_hex: String /* unproven */, pub expected: String /* digest hex */, pub reply_key: String /* hex */, pub max_proof_bytes: u32, pub profile: String, pub scalars: PendingScalars }
#[derive(Serialize, Deserialize)] pub struct PendingScalars { pub time: u32, pub asset: u32, pub amount: String, pub change: String, pub fee_change: String, pub fee: String, pub nullifiers: [String; 4], pub commitments: [String; 4], pub tx_keys: [String; 4], pub payment_slot: Option<usize>, pub payment_tx_key: Option<String>, pub payment_commitment: Option<String>, pub spent_indices: Vec<u64>, pub proofs: u8, /* burn only: */ pub relayer_fee: Option<String>, pub to_chain: Option<u16>, pub token: Option<String>, pub to: Option<String> }
#[derive(Serialize)] pub struct PrepareResult { pub sealed_hex: String, pub pending: Pending, pub expected: String }
pub fn prepare_transfer(r: &PrepareTransferRequest) -> Result<PrepareResult>;
pub fn prepare_burn(r: &PrepareBurnRequest) -> Result<PrepareResult>;
#[derive(Deserialize)] pub struct FinishRequest { pub pending: Pending, pub reply_hex: String }
pub fn finish_proof(r: &FinishRequest) -> Result<Value>;   // a ProveResult or BurnResult JSON, by pending.kind
```
- `prepare_*`: `build_*_unproven`, then `binding = tx.binding()`, `job = ProveJob { version: WIRE_VERSION, token, witness_kind: SpendKey, hc_bundle: ZkExecutor::hc_bundle(), profile: profile name, binding, inputs: prepared.words.clone(), reply_key: fresh_reply_key() }`, `sealed = seal_job(&kem_ek, &job)`; the job is dropped (zeroized) before returning. `witness_kind` other than `"spend_key"` is refused in this build ("this build's guests take a spend key"). `max_proof_bytes` absent → `randprotocol_core::gas::MAX_PROOF_BYTES`.
- `finish_proof`: `open_reply(reply_key, reply)` (bad → "the prover's reply does not open"), `reply.digest == expected` (else "the proof published a digest this wallet did not build"), `reply.proof.len() <= max_proof_bytes` (else names both numbers), verify: `ZkExecutor::new(profile)` + `ConfidentialExecutor::verify_bundle(&hc_bundle, &proof, &tx.binding())` (else "the proof does not verify"), insert into `tx.bundle.proof`, `debug_assert_eq!(tx.binding(), binding)`, encode; assemble the result from `scalars` exactly as `prove_transfer`/`prove_burn` do (`hash`, `tx_bytes`, `tx_hex`, `tier`, `proof_bytes` from the reply). Refactor `prove_transfer`/`prove_burn` to build their results through the same `PendingScalars` path so the two are one code path (a unit test asserts `prove_transfer(req)` == `finish_proof(prepare_transfer(req) + a locally made reply)` field for field, on the emulated/test profile).

- [ ] **Step 1: failing tests** (in `lib.rs` `mod tests`, using the existing `fixture_prove_request`/`fixture_burn_request` and the Test profile; a real proof is ~100 s so the round-trip test is `#[ignore]`d like the existing `prove_transfer_produces_an_admissible_bundle` and run once by the implementer):
  - `prepare_transfer_seals_a_job_the_prover_key_opens_and_pending_carries_no_secret`: generate `(dk, ek)` with `ml_kem::MlKem768::from_seed`; `prepare_transfer`; `open_job(&dk, sealed)` gives `inputs.len() == 1204`, `witness_kind == SpendKey`, `hc_bundle == ZkExecutor::hc_bundle()`; the serialized `pending` does not contain the request's spend key hex nor any of the first 8 witness words' decimal forms; `pending.tx_hex` decodes to a `Transaction` whose bundle proof is empty.
  - `prepare_refuses_a_viewing_key_witness_in_this_build`, `prepare_refuses_a_bad_kem_ek`, `prepare_defaults_max_proof_bytes_to_the_vendored_cap`.
  - `finish_proof_refuses_a_foreign_reply`: seal a `ProveReply { digest: expected ^ 1, .. }` under `pending.reply_key` → error contains "digest"; a reply under another key → "does not open"; a reply with `proof.len() == max_proof_bytes + 1` and the right digest → error contains "bytes" (verification is not reached — assert by the error text).
  - `#[ignore] finish_proof_matches_prove_transfer_field_for_field` (one real Test-profile proof made with `prove_bundle` on `prepared.words` inside the test, sealed as a reply).
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** `cargo test --release -p wallet-core` green; run the ignored one once: `cargo test --release -p wallet-core finish_proof_matches -- --ignored`. **Step 5:** commit `core: prepare_transfer / prepare_burn / finish_proof — the proof split for a light client; pending carries no spend key`.

### Task 3: The engine — `prover` group, token in the vault, remote proving, resume

**Files:**
- Modify: `ui/engine/backend-shared.js` (`K` `:96`, `getSettings`/`setSettings` `:421-460`, `startSession` `:824`, `send.send` `:1459`, `bridge.withdraw` `:1659`, the `backend` object `:1793`), `ui/engine/wallet.js` (`coreApi` `:235`, `send` `:874-921`, `burn` `:986-1028`), `ui/engine/backend-wasm.js` (`canProve` `:46`, `executeSend`/`executeWithdraw` — no longer unconditionally definite), `ui/engine/backend-native.js` (`makeCanProve` `:110` gains the prover fallback), `ui/backend.js` (the contract doc: `settings.prover`, `prover?` group, `onPhase(phase, detail)`)
- Create: `ui/engine/prover.js` (`parseLink(link)` → `{kemEk, url, token, own, fingerprint}` — port `PairingLink::parse` and `fingerprint_of` (blake3 over `"rand-prover-fingerprint-1" ‖ ek` → Crockford) to JS, or expose `parse_prover_link`/`prover_fingerprint` from the core via `call` — **rule: expose them from the core** (`"parse_prover_link"`, `"prover_fingerprint"` in `dispatch`, added in this task to `lib.rs`) so the JS never re-implements base58/blake3; `makeProverClient({fetch, url, token})` with `info()`, `submit(sealedHex)`, `status(job)`, `cancel(job)` over JSON-RPC; `remoteProve({client, core, prepared, storage, onPhase, signal, poll = 1000, maxWait = 20*60*1000})` which stores `{job, pending}` at `K.pendingProof` in `storage.session`, polls, calls `core.call('finish_proof', …)`, removes the record on success or definite failure)
- Test: `ui/test/prover.test.mjs` (new), `ui/test/backend-cases.mjs` (extend `assertKeyNeverLeaked` coverage to the prover's fetches — they already go through the injected `fetch`), `ui/test/backend-fixtures.mjs` (`stubFetch` learns the `prover_*` methods; `CORE_VERSION` gains `prover_wire: 1`; `stubCore` answers `prepare_transfer`/`finish_proof`/`parse_prover_link`/`prover_fingerprint`)

**Behaviour:**
- `prover.pair(link, password)` → `core.call('parse_prover_link')`, `checkRpcUrl`-style URL rule, `prover_info` with the injected `fetch`, fingerprint must equal the link's, store `settings.prover = {mode:'remote', name, url, kemEk, fingerprint, own}` and the token as `encryptSecret(password, token)` under `K.proverToken` (R2); also into the session record if unlocked. `prover.probe()` → `prover_info` → `{ok, queue, witnessKinds, fee}`; `{ok:false, reason}` on any failure. `prover.forget()` removes settings.prover, `K.proverToken` and the session copy.
- `canProve()` (both backends): device check first (native), then `settings.prover?.mode === 'remote'` and `probe().ok` and (`own` or the job kind is viewing — Phase 1: `own` required) → `{ok:true, via:'prover'}`; else the wasm/native sentence.
- `wallet.send`/`burn`: after `witness`, if `canProve` said `via:'prover'`: `prepare_transfer` (with `prover: {kem_ek, token, witness_kind:'spend_key'}`, `max_proof_bytes` from `client.limits()` when the node has `rand_getLimits`), then `remoteProve`, then continue with the `finish_proof` result exactly where `c.proveTransfer`'s result was used. `onPhase('prove', {position, prover: name})` while queued; `onPhase('prove', {prover: name})` while proving. `signal` abort → `prover_cancel` + remove the pending record.
- Resume: on backend construction (and on `send.resume()` — a new optional method), if `storage.session` has `K.pendingProof`, `send.send` is not needed: `send.resume(onPhase)` continues polling that job and submits; a screen calls it on mount when `send.pending()` reports one. `busy` (-32005) → definite error "the prover is full (N waiting)".

- [ ] **Step 1: failing tests** in `ui/test/prover.test.mjs` against `makeSharedBackend` with `stubCore` + `stubFetch` (the same rig `backend-cases.mjs` uses):
  - `pairing_stores_the_token_in_the_vault_not_in_settings` (settings.get() has `prover` without `token`; `storage.local[K.proverToken]` is an `encryptSecret` record; `assertKeyNeverLeaked` still holds with the token added as a second needle).
  - `a_spend_key_job_is_built_only_for_an_own_prover` (own:false → `canProve` false with the wasm sentence; no `prepare_transfer` call).
  - `a_send_through_the_prover_seals_submits_polls_and_submits_the_finished_tx` (fetch script: info → submit `{job}` → status queued position 2 → proving → done `{reply}`; `finish_proof` stub returns the ProveResult; `rand_sendTransaction` receives `tx_hex`; phases seen: select, witness, prove(position 2), prove, submit, wait).
  - `a_closed_popup_resumes_the_same_job_and_submits_once` (build backend A, start a send whose status stays `proving`, abandon it; build backend B over the same storage; `send.pending()` truthy; `send.resume()` continues with the same job id, submits once; the fetch log has exactly one `rand_sendTransaction`).
  - `busy_is_a_definite_error_with_the_depth`, `a_wrong_digest_never_reaches_send_transaction` (finish_proof stub throws → no `rand_sendTransaction`, error `definite`), `re_pairing_replaces_the_token_everywhere`, `forget_removes_settings_vault_and_session_copies`, `the_wasm_reason_names_the_prover_option`.
- [ ] **Step 2:** `node --test ui/test/prover.test.mjs` → fails. **Step 3:** implement. **Step 4:** `node --test ui/test web/wallet/test` all green. **Step 5:** commit `engine: the prover group — pair into the vault, probe, remote proving with resume from storage.session; canProve falls back to a paired prover`.

### Task 4: Settings and the send screen

**Files:**
- Modify: `ui/screens/settings.js` (a `proverMarkup(settings)` section after `networkMarkup`: **This device / My own prover**, a paste field + `platform.scanQr?` button, the Phase 1 warning (spec §4.4) shown before Save with a password field, Save = `platform.ensureHostPermission?(url)` inside the click → `prover.pair(link, password)`; a "Forget" button; a status line from `prover.probe()`), `ui/screens/send/state.js` (`onPhase(phase, detail)` keeps `detail`; `PHASE_LABELS.proving` becomes a function of `detail`: "Waiting at position N on <name>" / "Proving on <name>…" / the device sentence), `ui/screens/send/markup.js:251-274` (the banner text from the store, not hardcoded), `ui/screens/send.js` (on mount, if `ctx.backend.send.pending?.()` → call `resume`), `ui/screens/withdraw.js` (the same two hooks)
- Test: `ui/test/settings.test.mjs` (the section renders only when `ctx.backend.prover` exists; Save with a bad URL shows the rule; Save calls `ensureHostPermission` then `pair`; the warning text is present verbatim), `ui/test/send.test.mjs` (the queue position renders; resume is called on mount when pending)

- [ ] Steps: failing tests → implement → `node --test ui/test` green → commit `ui: Settings "Prover" — pair by link or QR with the spend-key warning; the send screen shows the queue position and resumes a pending job`.

### Task 5: The desktop app as a prover

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (`randprotocol-prover = { path = "../../core/vendor/fullnode/crates/randprotocol-prover" }` with `service`), `desktop/src-tauri/src/main.rs` (`.manage(ProverState::default())`, commands `prover_start`, `prover_stop`, `prover_status`, `prover_pairing_link`), `desktop/src-tauri/src/prover.rs` (new: `ProverState(Mutex<Option<Running>>)`; `start` = load-or-create `ProverKey` at `<data dir>/prover/prover.key.json` and `Pairings` at `<data dir>/prover/pairings.json`, mint one pairing `desktop` with `own: true` if none, `memory::check(1)`, `http::serve("127.0.0.1:8600")` with `accept_spend_key: true`, `max_parallel: 1`; `status` → `{running, addr, fingerprint}`; `pairing_link` → the `randprover:` link for the `desktop` pairing — the token is minted once and kept in the app's storage so the link can be shown again), `desktop/ui-shell/backend-tauri.js` (`platform.proverHost = {start, stop, status, link}`), `desktop/tauri.conf.json` (no CSP change needed: `connect-src` already allows `http://127.0.0.1:*`), `ui/screens/settings.js` ("Prove for my other devices" toggle, shown when `platform.proverHost` exists; shows the link and its QR via `ui/lib/qr.js`)
- Test: `desktop/src-tauri` unit test for `prover.rs` (start on port 0 → status running → link parses with the core's `parse_prover_link` → stop); `ui/test/settings.test.mjs` (the toggle renders only with `platform.proverHost`).

- [ ] Steps: failing tests → implement → `cd desktop/src-tauri && cargo test` and `node --test ui/test` green; `cargo tauri build` (or the repo's `desktop/scripts/build.sh`) succeeds → commit `desktop: "Prove for my other devices" — the fullnode prover service inside the app on 127.0.0.1, one job at a time, its pairing link and QR`.

### Task 6: Extension — host permission and the end-to-end test

**Files:**
- Modify: `extension/shared/lib/platform.js` (nothing new: `ensureHostPermission` already exists; verify `http://127.0.0.1/*` is in `optional_host_permissions` — it is, `chrome/manifest.json:48`, `firefox/manifest.json:92`), `extension/shared/popup.js`/`sidepanel.js` (on boot, if `send.pending()` → navigate to the send screen so it resumes)
- Create: `web/wallet/test/prover.e2e.test.mjs` — skipped unless `RAND_NODE_BIN`, `RAND_PROVER_BIN` and the built wasm exist: starts `rand-node run` on a tmp genesis (Test profile, like `../fullnode/crates/randprotocol-client/tests/wallet_flow.rs` does; the genesis JSON can be made with `rand-node genesis`), starts `rand-prover keygen|pair --own|run --accept-spend-key` in a tmp home, faucets a wallet, then drives `makeWasmBackend` with the real wasm core and real `fetch`: pair → send → the note lands (scan sees it). ~3–4 min with one real proof.
- Create: `scripts/e2e-prover.sh` that builds/locates the two binaries from `core/vendor/fullnode` (`cargo build --release -p randprotocol-node -p randprotocol-prover`) and runs the test.

- [ ] Steps: write the e2e → run it (`RAND_NODE_BIN=… RAND_PROVER_BIN=… node --test web/wallet/test/prover.e2e.test.mjs`) → pass → commit `extension, e2e: a wasm wallet pairs a rand-prover and sends — the transaction is admitted; boot resumes a pending job`.

### Task 7: Docs and release

- [ ] `README.md` (the known-limitation paragraph now says "pair your own prover"; the row for what each shell can do), `docs/` (a `docs/prover.md` for users: pair the desktop app from the extension, run `rand-prover` on a server, the warning), the extension/web build scripts rebuild `dist`. Commit. Then the whole-branch review, `node --test ui/test web/wallet/test`, `cd core && cargo test --release`, and merge/push per `superpowers:finishing-a-development-branch`. Deploy the web wallet and the site's `/clients` page the way `../website` deploys (memory `website-deploy-and-papers-sync`) only after the fullnode's v0.6.2 release is public.

### Task 8: iOS and Android Settings and remote proving

**Files:**
- iOS: `ios/RandWallet/UI/SettingsView.swift` (a "Prover" section: paste/scan a link via `QRScannerView`, the warning, Keychain-stored token via `Keychain.swift`, forget), `ios/RandWallet/Services/` (a `ProverClient.swift`: JSON-RPC `prover_*`, `prepare_transfer` → submit → poll → `finish_proof`), `ios/RandWallet/UI/SendView.swift` (use the prover when the device cannot prove and one is paired; show the queue position)
- Android: `ui/SettingsActivity.java` (the section), `security/KeyVault.java` (the token), `wallet/ProvingService.java` (the remote path with the same order), `wallet/SendState.java` (queue position)
- Tests: the existing unit-test targets of each app (an `XCTest` for the link parse through the core + the client against a local stub; a JUnit test for `ProvingService` with a fake `HttpURLConnection`).

- [ ] Steps: failing tests → implement → `xcodebuild test` (iOS simulator) and `./gradlew test` green → commit `ios, android: pair a prover in Settings; the send path proves through it when the device cannot`.

---

## Self-review

- **Spec coverage:** §3 core → Task 2 (+ `prover_wire` in Task 1); §4.1 contract → Task 3; §4.2 order → Task 3; §4.3 flow + resume → Tasks 3, 4, 6 (under R1/R3); §4.4 Settings → Task 4; §4.5 rules → Tasks 2, 3 tests; §5 desktop → Task 5; §7 C1-1..C1-6 → Tasks 2, 3, 4, 5, 6, 8; §8 Q1 → per wallet (the token is a vault record of the one wallet), Q2 → R4, Q3 → Phase 2.
- **Placeholders:** none; every step names the file, the function and the test.
- **Type consistency:** `Pending`/`PendingScalars` are the single shape both `prepare_*` and `finish_proof` use; `onPhase(phase, detail)` is the same in engine, state and markup; `K.proverToken`/`K.pendingProof` are the only new storage keys.
- **Review Focus:** all five pinned (Tasks 3, 3, 3, 2, 2).
