# Private multisig signing in every wallet app

Status: design, 2026-10-11. Implementation waits on fullnode's private multisig (the `msauth` guest,
constraint set 9) reaching fullnode `main`. The user's decision: **every app signs** — web wallet,
extension, desktop, iOS, Android.

## 1. What a signer does

A private multisig account is spent by a proposal that T of its N signers sign (fullnode
`docs/superpowers/specs/2026-10-11-private-multisig-phase4-design.md` §6). One person — anyone holding
the policy — runs `rand multisig-private prepare` and passes `prop.json` to the signers. Each signer
checks it, signs it, and sends back one share, `i:<sig hex>`. The preparer collects ≥ T shares and
runs `prove` (tier 18, ~31 GB) and `submit` on a big machine with the CLI.

The apps do the middle step only: **check, show, sign, share.** They never prepare, prove or submit.

## 2. The core API (one source of truth)

Every check is fullnode's, through the new crate `randprotocol-msig` (re-exported as
`randprotocol_client::multisig_private`; agreed with the private-multisig session; deps core, zkvm,
serde, hex, thiserror; pure: no RPC, no filesystem, no OS entropy; fullnode CI checks it for
`wasm32-unknown-unknown`). wallet-core depends on `randprotocol-msig` directly:

| fullnode | wallet-core `call` method | params → value |
|---|---|---|
| `check_proposal(proposal, policy) -> ProposalSummary` | `msauth_check` | `{proposal, policy}` → summary JSON |
| `sign(proposal, policy, seed) -> (u8, Vec<u8>)` | `msauth_sign` | `{proposal, policy, seed}` → `"i:hex"` |
| `verify_share(proposal, policy, share)` | `msauth_verify_share` | `{proposal, policy, share}` → `true` |
| — | `msauth_signer_import` | `{input}` (a `rand-node keygen` JSON or 64 hex) → `{seed, public_key, address}` |
| — | `msauth_policy_info` | `{policy}` → `{fingerprint, threshold, signers, address}` |

`ProposalSummary`: outputs (recipient, amount, asset, memo), fee, burns, `expires_at`,
`signing_message`, `policy_fingerprint`. `msauth_signer_import` checks the file's `public_key`
against the one derived from `seed` and refuses a mismatch. `msauth_sign` refuses a key that is not
in the policy (fullnode's rule); the app also checks this at import, so a wrong key fails early.

New arms go in `wallet_core::call` (`core/crates/wallet-core/src/lib.rs`); wasm, FFI and Tauri pick
them up through the existing generic `call` with no binding change. Typed wrappers:
`ui/engine/wallet.js` `coreApi()`, `ios/RandWallet/Core/RandCore.swift`,
`android/.../core/Core.java`. Error codes map in `ui/engine/core-errors.js` and the native error
tables.

## 3. What the app stores: a signer profile

A **signer profile** = `{label, policy (JSON), seed}`. Both halves are secret: the seed signs, and
the policy's `msk` is viewing power over the account. A profile is stored exactly where and how the
app stores its spend key today, never in plain storage:

- **web, extension, desktop** (shared engine): inside the existing vault, encrypted with the same
  AES-256-GCM / PBKDF2 key (`ui/engine/crypto.js`, `backend-shared.js`), readable only while
  unlocked. The vault gains a `signers` list beside the spend key.

**Every signature re-authenticates** (user's decision 2026-10-12). Unlocking the app does not
unlock signer seeds: each `msauth_sign` first asks for the password (web, extension, desktop:
the seed is decrypted from the vault for that one call and the buffer is zeroed after) or device
auth (iOS: Keychain item with `.userPresence` access control, read per signature; Android:
a Keystore key with `setUserAuthenticationRequired(true)` and a per-use BiometricPrompt /
device credential). The seed is never cached between signatures. Viewing a profile's policy
(fingerprint, T of N) needs only the normal unlock.
- **iOS**: Keychain items `msauth.<id>.seed` and `msauth.<id>.policy`, `WhenUnlockedThisDeviceOnly`,
  as `spend_key` is (`Storage/Keychain.swift`).
- **Android**: `KeyVault` entries of the same names (EncryptedSharedPreferences, Keystore master key).

Several profiles are allowed (one person may sign for several accounts). Removing a profile deletes
both halves. A profile does not need a spend key: an app with no wallet can still hold signer
profiles, but the existing unlock (password / device auth) gates them all the same.

**Proposals are never stored.** A proposal holds the account's witness (note openings, `nk`): it is
read into memory for one signing and dropped.

## 4. The flow (every app)

1. **Signers → Add**: import the policy file and the signer key (paste or file). The app shows the
   account address, its fingerprint (to compare out of band with the other signers — the design's
   own instruction), `T of N`, and this key's position. The profile is saved only after that screen.
2. **Signers → <profile> → Sign a proposal**: paste or open `prop.json`. `msauth_check` runs; any
   failure is shown by name and nothing can be signed.
3. **Review**: every output (recipient, amount and asset, memo), the fee, any burn, the expiry,
   the fingerprint. A recipient is shown as `check_proposal` gives it: a fingerprint of the owner
   key only, with the caveat "owner key verified; delivery key NOT verifiable from this proposal"
   rendered as-is (a proposal cannot prove the recipient's KEM key, so the app must not show a full
   address fingerprint as if it had checked one).
   **The signer must enter each payee's address** (2026-10-12, from the private-multisig review: a
   proposal alone cannot tell the signer that an output pays the payee they meant, so a dishonest
   coordinator could pay its own key with every check passing). Before review, the signer enters
   the **intended payments**: one row per payee, address and amount, both required (a payee paid
   twice is one row with the total). The app passes them as `address:amount` to
   `check_proposal`'s expected-recipients input. The crate (2026-10-12 ruling) matches by set,
   refuses a paying output whose owner is in no row, a row no output pays, and a row whose amount
   differs from the sum paid to that address. Each output then shows "matches <address
   fingerprint>"; an output with no match, or a recipient left empty, refuses signing (the app
   never signs on "no expected recipient given: the payee was NOT checked"). The chain-id and
   genesis line is shown and compared with the node's `rand_getHead`/status. Each output carries `to_account` (verified: the
   note's owner is the multisig account itself), so the review labels change apart from payments. `check_proposal` has no RPC, so it only checks `expires_at` against the
   bundle's own time; **the app compares it with the chain head** (`rand_getHead`, which every
   app already reads) and refuses to sign at or past `expires_at - 16`, the CLI `prove`'s margin.
   **With no node reachable it refuses to sign** (user's decision 2026-10-12): the expiry cannot be
   checked, so the share is not made; the screen says which node it tried and offers retry.
   Confirmation types the last four characters of the
   fingerprint, the withdraw flow's pattern (`ui/screens/withdraw.js`).
4. **Share**: `msauth_sign` → the share string. Copy, share sheet (iOS `ShareLink`, Android
   `ACTION_SEND`), or save as a file. The share is not secret (a signature over a public message).
5. Optional: **check a share** someone else sent (`msauth_verify_share`) — shows which positions are
   in hand against T.

New input for all apps: a **file picker** (web/desktop `<input type=file>`, iOS `.fileImporter`,
Android `ACTION_OPEN_DOCUMENT`), since proposals are tens of KB — awkward to paste on a phone. Paste
stays available.

## 5. Out of scope

Preparing, proving and submitting (CLI; proving needs ~31 GB); delegated msauth proving (a fullnode
follow-up, phase-4 spec §6.6); showing the multisig account's balance in the app (needs the
`Wallet::from_viewing_key` scan path; a later step); the CLI's validator-key warning (the apps
cannot tell a consensus key file apart).

## 6. Order of work

1. Re-pin `core/vendor/fullnode` to the private multisig merge (constraint set 9; the wallet's
   bundle proofs change with it) and re-run the real-node prover e2e on a chain-21 shape —
   **this makes clients main chain-21-only; chain 20 fixes go to `release/chain20`.**
2. Core arms + tests, using the fixtures committed with fullnode's `randprotocol-msig`
   (`crates/randprotocol-msig/tests/fixtures/`: `policy`, `proposal-valid`,
   `proposal-tampered-output`, `proposal-value-mismatch`, `proposal-fee-raised` (refused only by
   the per-asset balance check), `proposal-unbound` (refused on the binding),
   `proposal-wrong-expected`, `proposal-expired`,
   `signer-seeds` (three
   members + one outsider), `expected` (summary, signing message, shares for members 0 and 2)). They
   are deterministic, so the app tests match exact values, not only pass/fail. The tampered output is
   re-bound: it fails as "output does not open as sender", not on the binding. The zkvm re-pin
   brings `dilithium-core` gated off wasm32 (its `asm!` does not build there); the msig crate uses
   crystals-dilithium directly. Vendor from fullnode `e34117be` (Task 6 complete; 10 fixtures,
   SHA-256s checked 2026-10-12) or the merge that carries it.
3. Shared UI (web, extension, desktop) + unit tests + strings in all 20 locales.
4. iOS + XCTest; Android + JVM tests; native string parity.
5. One end-to-end: a 2-of-3 account on a devnet, the CLI prepares, two apps sign (web and one
   native through its core), the CLI proves and submits, the payout lands.

## 7. Release

Ships with the chain-21 wallet release (set 9), never to chain-20 users.
