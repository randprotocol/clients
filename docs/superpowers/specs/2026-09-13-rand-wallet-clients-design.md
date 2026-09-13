# Rand Wallet: lightweight clients — design

Date: 2026-09-13. Status: approved for implementation under the assumptions in §2; the user runs
this session unattended, so the assumptions are stated rather than asked.

## 1. Goal

Four lightweight wallets for the Rand Protocol SHRUGG chain, one per platform, each store-ready:

| client | language | ships as |
|---|---|---|
| iOS | Swift (SwiftUI) | TestFlight / App Store via `xcodebuild archive` |
| Android | Java | Play Console via a signed `.aab` |
| Chrome | JavaScript (MV3) | a zip for the Chrome Web Store |
| Firefox | JavaScript (MV3) | a zip for addons.mozilla.org |

Every client: an interface close to Phantom (balance card, Receive / Send / Faucet, activity
list, lock screen), generates wallets (spend key, viewing key, `shrugg1…` address), signs —
which on this chain means *proves* — transfers, and hands the user the keys randscan.org needs
to open confidential transactions (the party viewing key, and a per-transaction key per
payment). The downloads are published at `https://randprotocol.org/clients`.

## 2. What the chain is, and what that forces

The live testnet is chain 8: the fully shielded pool (fullnode branch `shielded-s2s3`, build
`03c9fb9`, on `origin/main`). There are no accounts, no balances on chain and no signatures on a
transfer. A wallet is a 256-bit spend key; a balance is the set of notes that key can open; a
transfer is a 2-in-2-out bundle authorised by a STARK proof that takes on the order of a minute
of CPU. The keys are Poseidon2 over Goldilocks, the envelopes ML-KEM-768 + ChaCha20-Poly1305,
the proof Plonky3 — none of which exist as Swift, Java or JavaScript libraries, and a
re-implementation would have to be byte-identical to the node's or every transfer is refused.

**Ruling: one Rust core, wrapped per platform.** `core/` vendors the fullnode's own crates
(`shrugg-core`, `shrugg-zkvm`) at the chain 8 commit as a git submodule and exposes them through a
single JSON entry point, `call(method, params) -> reply`. iOS links it as an XCFramework (C ABI),
Android as a `.so` (JNI), the extensions as WebAssembly. The Swift, Java and JavaScript that the
user asked for is the whole client above that line: the JSON-RPC client, the note store, the
scan and send orchestration, key storage, and the UI. This is how every shielded-chain mobile
wallet is built (Zcash's SDKs do the same), and it is the only way the four clients agree with
the chain bit for bit.

**Assumptions stated because nobody could be asked:**

1. **RPC endpoint.** No node exposes JSON-RPC publicly today (every `--rpc` binds
   `127.0.0.1:8545`; randscan.org serves REST, not RPC). The clients default to
   `https://rpc.randprotocol.org` and let the user change it. Standing that endpoint up — a
   reverse proxy with CORS on one observer node — is operations work outside this repo and is
   listed in the README as the one prerequisite to a working end-to-end experience.
2. **Proving on the device.** A phone or a browser proves slower than a laptop and single-
   threaded in WebAssembly. The send flow is designed around a long "Proving…" state that the user
   can leave and come back to, and every client sets expectations in words before starting. A
   remote prover would be faster but would see the spend key; ruled out.
3. **randscan.org integration is by copy and link.** The explorer's viewing page takes a pasted
   64-hex viewing key or a per-transaction key; it has no URL parameter. The clients copy the key
   to the clipboard and open the right page (`/viewing` for a history, `/transactions/<hash>` for
   one payment).
4. **Scope of actions.** Transfers and the testnet faucet. Bridge deposits are recognised when
   scanning (the deposit-rebuild path) so bridged notes show up, but bridge burns, staking,
   deploys and confidential calls stay in the `shrugg` CLI. A client that tried to be the CLI would
   not be lightweight.
5. **Desktop.** `linux/`, `macosx/`, `windows/` exist in the repo but were not asked for here;
   they hold a README pointing at the CLI.

## 3. Architecture

```
clients/
  core/                      Rust workspace (toolchain 1.98.1, the fullnode's)
    vendor/fullnode          git submodule @ 03c9fb9 (chain 8)
    vendor/circuits/…        a stub manifest for the zkVM's optional GPU dependency
    crates/wallet-core       the library: keys, scanning, selection, proving, JSON dispatch
    crates/wallet-ffi        C ABI (iOS) + JNI (Android); lib name shrugg_wallet
    crates/wallet-wasm       wasm-bindgen `call()`
    scripts/build-{ios,android,wasm}.sh
  ios/                       xcodegen project → RandWallet.xcodeproj, SwiftUI, links the XCFramework
  android/                   Gradle, Java, loads libshrugg_wallet.so
  extension/shared/          the extension's code and assets (both browsers)
  chrome/  firefox/          manifest + packaging into dist/
  web/                       the /clients page for randprotocol.org (Astro), copied into that repo
  design/                    tokens.json, icon generator, generated icons
```

### 3.1 The core API (JSON in, JSON out)

Reply: `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`. Methods (`wallet_core::dispatch`):

| method | params | value |
|---|---|---|
| `version` | `{}` | constants: chain id 8, default RPC, explorer URL, fee floor, faucet cap, windows |
| `keygen` | `{}` | `{spend_key, viewing_key, pk, address, key_file}` |
| `wallet_info` | `{spend_key}` | same |
| `import_key` | `{input}` (64 hex or a `wallet.key.json`) | same |
| `parse_address` | `{address}` | `{valid, pk, error}` |
| `scan_page` | `{spend_key, rows}` (`shrugg_getCommitments` rows) | `{received: [OwnedNote], sent: [SentRow], next_index, rows}` |
| `rebuilt_deposit` | `{spend_key, action}` (a `bridge_attest` action) | OwnedNote (index unknown) or null |
| `pending_cleared` | `{note, read_through}` | bool |
| `select_inputs` | `{notes, asset?, need}` | `{chosen, need, change}` or an error naming why |
| `prove_transfer` | `{spend_key, chain_id, to, amount, fee, anchor_height, anchor_root, inputs:[{note, path}], profile}` | `{tx_hex, hash, time, amount, change, fee, tier, proof_bytes, tx_bytes, nullifiers, commitments, tx_keys, spent_indices}` |
| `open_with_tx_key` | `{cm, envelope, tx_key}` | the note or null |
| `format_amount` / `parse_amount` | `{units}` / `{text}` | decimal string / units string |

`OwnedNote`: `{index, note (112-byte hex), cm, nf, amount (units string), asset, time, from (pk hex),
height, spent, pending (u32|null)}`. Amounts are strings everywhere: units exceed 2^53.

### 3.2 What every client implements in its own language

- **RPC client**: one `POST` of `{"jsonrpc":"2.0","id":1,"method","params"}`; methods used:
  `shrugg_chainId`, `shrugg_status`, `shrugg_getHead`, `shrugg_getTreeInfo`,
  `shrugg_getCommitments(from, 500)`, `shrugg_getNullifiers(from_height, 500)`,
  `shrugg_getAnchor()`, `shrugg_getWitness(index)`, `shrugg_sendTransaction(hex)`,
  `shrugg_getTransaction(hash)`, `shrugg_mint(address)`, `shrugg_getBlockByHeight(h)` (deposit
  rebuild), `shrugg_getBridgeState`.
- **Note store** (persisted JSON): `scanned_index`, `scanned_height`, `scanned_attest_height`,
  `notes: [OwnedNote]`, `sent: [SentRow]`, `submissions: [{hash, time, amount, to, fee, tx_key,
  status}]`.
- **Scan** (mirrors `shrugg_client::wallet::scan`): page commitments from `scanned_index` →
  `scan_page` → merge by leaf index; read `getHead` *before* paging nullifiers; page nullifiers
  from `scanned_height`, mark `spent`; `scanned_height = max(paged_to, head_before + 1)`; clear
  pending via `pending_cleared(note, scanned_height - 1)`. Balance = Σ amount of notes with
  `is_spendable` and `asset == 0`.
- **Send**: `select_inputs(notes, need = amount + fee)` → `getAnchor()` → `getWitness(index)` for
  each chosen note, refetch all if any witness root ≠ anchor root (3 attempts) →
  `prove_transfer` on a background thread/worker → `sendTransaction` → mark inputs `pending =
  time` → poll `getTransaction` (until committed, ≤ 180 s) → rescan. Store the payment's
  `tx_keys[0]` with the submission so the user can disclose that one payment later.
- **Faucet**: `shrugg_mint(address)`; then poll and rescan.
- **Key storage**: the spend key only, in the platform's secure store (§4). Never the viewing key
  (derived on demand), never in logs, never in a request.

### 3.3 Proving runs where it can survive

- iOS: a `Task.detached` with the app kept foregrounded and idle-timer disabled; a background
  task assertion covers a short backgrounding.
- Android: a foreground service with a notification ("Proving your transfer…") so the OS does not
  kill it.
- Extensions: the popup closes when focus moves, so Send hands off to a full-page extension tab
  (`app.html`) where a Web Worker runs the wasm. The tab stays open until the proof is submitted.
  MV3 needs `content_security_policy.extension_pages` with `'wasm-unsafe-eval'`.

## 4. Security rules (all clients)

1. The spend key is generated from OS randomness inside the core (`keygen`) and stored
   encrypted at rest: iOS Keychain (`ThisDeviceOnly`), Android Keystore-backed
   `EncryptedSharedPreferences`, extensions AES-GCM under a PBKDF2-SHA256 (600 000 iterations)
   password key in `storage.local`.
2. Unlock: Face ID / Touch ID with passcode fallback; BiometricPrompt with device credential
   fallback; password with auto-lock after 15 minutes (extension session in memory only).
3. Export of the spend key or the key file is behind unlock and a written warning; the viewing
   key export explains that it reveals the whole history and cannot spend.
4. The note store holds plaintext notes: file protection complete (iOS), app-private storage
   (Android), `storage.local` (extension; it is only a cache, rescannable from leaf 0).
5. No analytics, no third-party requests: the only hosts contacted are the RPC URL and, when the
   user taps a link, randscan.org.
6. Recipient addresses are validated with `parse_address` before an amount can be entered; the
   confirm screen shows the amount, the fee and the destination's shortened address.

## 5. Interface (Phantom-like)

Design tokens in `design/tokens.json`: dark by default, ink `#0B0D14`, surfaces `#151A2B`, the
"aurora" gradient `#5B7CFF → #9B6BFF` reserved for the balance card and the primary button,
`#33D69F` positive, `#FF6B6B` negative; a full light theme. System sans with tabular numerals
for amounts; mono for keys, hashes and addresses.

Screens, in the order a user meets them:

1. **Welcome** — "Create a new wallet" (primary) / "I already have a wallet" (import 64-hex or a
   `wallet.key.json`). Creating shows the spend key once with a "I have saved it" checkbox.
2. **Lock** — biometric / password.
3. **Home** — gradient balance card (`12.5 SHRUGG`, sync status line), address chip (first 10 and
   last 6 characters, tap to copy, QR icon → Receive), three round actions **Receive · Send ·
   Faucet**, then **Activity** (received / sent / pending rows with amount, height, relative time).
   Pull to refresh = scan.
4. **Receive** — the QR of the full address (byte-mode QR, ~1.7 KB fits at version 33+), the
   address in a scrollable mono box, Copy and Share.
5. **Send** — recipient (paste, or scan a QR on mobile), amount with **Max** (balance − fee),
   fee line, **Review** → confirm sheet → **Proving** screen (spinner, "About a minute on this
   device; keep the app open", elapsed timer) → **Sent** (hash, "View on RandScan", "Copy
   transaction key", Done). Errors from `select_inputs` are shown verbatim: they already say
   what to do (consolidate).
6. **Activity detail** — a received note: amount, from (pk), leaf, height, spent state; a sent
   payment: amount, to, hash, and **Disclose this payment** (copies the tx key, opens the
   transaction on randscan).
7. **Settings** — network (RPC URL, chain id, "Test connection" showing height and peers),
   **Viewing key** (copy + "Open My history on RandScan"), export key file, export spend key,
   rescan from zero, auto-lock, theme, about (core version, chain build).

## 6. Store readiness

- iOS: bundle id `org.randprotocol.wallet`, `MARKETING_VERSION 0.1.0`, `CURRENT_PROJECT_VERSION 1`,
  minimum iOS 16, privacy manifest (`PrivacyInfo.xcprivacy`: no tracking, no required-reason APIs
  beyond UserDefaults), `NSCameraUsageDescription` (QR scanning), `NSFaceIDUsageDescription`,
  `ITSAppUsesNonExemptEncryption = false` (standard encryption only), an `ExportOptions.plist`
  for `app-store-connect`, and `scripts/archive.sh`. The team id is a placeholder in
  `project.yml`.
- Android: `applicationId org.randprotocol.wallet`, `minSdk 26`, `targetSdk 35`, 16 KiB page
  alignment for the `.so`, `abiFilters arm64-v8a, x86_64`, release signing from
  `keystore.properties` (gitignored; template committed), `./gradlew bundleRelease`.
- Chrome: MV3, permissions `storage`, `alarms`; host permission only for the RPC origin (declared
  as optional and requested when the user changes it); `chrome/pack.sh` produces
  `dist/rand-wallet-chrome-<version>.zip`; store listing text and screenshots checklist in
  `chrome/STORE.md`.
- Firefox: same code, `browser_specific_settings.gecko.id = wallet@randprotocol.org`, background
  `scripts` (event page) instead of a service worker, `firefox/pack.sh` + `web-ext lint`.

## 7. Testing

- Core: unit tests for keys/addresses, scanning (received / sent / stranger), selection, the JSON
  entry point, and a full `prove_transfer` verified by the chain's own `verify_bundle` under the
  test FRI profile.
- Each client: a unit test of its note-store merge and pending logic against fixtures produced by
  the core, and a smoke test of the FFI (`version` and `keygen` round trip).
- Manual: against a local `shrugg-node` with faucet on (`scripts/local-testnet.sh` in the
  fullnode), documented in each client's README.

## 8. Finding during implementation: prover memory (2026-09-13)

Measured after the core was built: a bundle proof peaks at ~5.5 GB RSS under both the test and
the production FRI profile, and takes 95 s on an Apple M-series core (`examples/prove_fixture.rs`). wasm32 has a 4 GiB address
space, so the extensions abort with an allocation failure inside `commit_ldes`; phones with less
than ~8 GB will be killed. Assumption 2 in §2 ("proving on the device") therefore holds in code
but not yet in practice. Decisions: keep the on-device design (no remote prover: the spend key is
a guest input), publish the requirement as `prover_peak_memory_bytes` in the core's constants,
warn before proving on mobile, explain the failure in the browser, and point at the CLI. The
extensions also build the zkVM crate at opt-level 1 (`[profile.wasm]`): LLVM's wasm backend
never finished it at opt-level 3.

## 9. Out of scope, recorded

A local commitment tree in the client (the witness-request leak, fullnode §6), bridge burns,
staking, deploy/call, hardware keys, multiple accounts per app, push notifications, a remote
prover, desktop apps.
