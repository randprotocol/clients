# Rand Wallet for iOS

SwiftUI, iOS 16+, bundle id `org.randprotocol.wallet`. The chain cryptography (keys, envelopes,
the bundle proof) is the Rust core in `../core`, linked as `Frameworks/RandWalletCore.xcframework`;
everything else in this directory is Swift.

```
RandWallet/
  Core/        RandCore (the one FFI call), Models (the core's JSON shapes), Amount
  Network/     RpcClient — JSON-RPC 2.0 over URLSession
  Storage/     NoteStore (Application Support, complete file protection), Keychain, Settings,
               Contacts (Keychain-backed JSON, the CLI's rules)
  Services/    WalletService (scan / send / faucet), AuthService (lock, Face ID), ProverClient and
               ProverPairingService (a paired prover: JSON-RPC, the poll loop, pairing, the route
               and the checks made before a job is built)
  UI/          Welcome · Lock · Home · Receive · Send → Review → Proving → Sent · Activity · Settings
               · Contacts; `randpay:` links open Send pre-filled (never sent without Confirm)
RandWalletTests/   NoteStore logic, an FFI smoke test, the link / contact rules, and ProverTests (a
                   pairing link through the core; the prover client, route, the split-authorisation
                   job checks and the remote send path against a URLProtocol stub)
```

## Build and run

```bash
../core/scripts/build-ios.sh          # device + simulator slices → Frameworks/RandWalletCore.xcframework
open RandWallet.xcodeproj             # or:
xcodebuild -project RandWallet.xcodeproj -scheme RandWallet \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
xcodebuild -project RandWallet.xcodeproj -scheme RandWallet \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

`RandWallet.xcodeproj` is generated from `project.yml` by [xcodegen](https://github.com/yonaskolb/XcodeGen)
and committed; after editing `project.yml`, run `xcodegen generate`.

The app talks to a `rand-node` JSON-RPC endpoint (Settings → Network). The default,
`https://rpc.randprotocol.org`, has to be stood up by the operators (see the repository README);
on the simulator a local node at `http://127.0.0.1:8545` works directly, and an SSH tunnel to a
testnet droplet works the same way.

Proving a transfer runs on the phone's CPU and takes a minute or two (single-threaded tier-14
STARK) and about 6.2 GB of memory. The Send flow keeps the screen awake and asks the user to keep
the app open. A phone without that memory can hand the bundle proof to a paired `rand-prover`
(Settings → Prover, `../docs/prover.md`): on a split-authorisation chain (bundle guest v3, every
chain since 17) the job the core seals carries the **viewing key and a salt, never the spend
key** — the prover can read this wallet's whole history and cannot spend, so a prover somebody
else runs will do — and the spend authorisation (the auth proof, tier 10, about seven seconds)
is made on the phone inside the core's `prepare_transfer` before the job goes out. The phone
verifies the proof that comes back before anything is submitted. A pairing link made with
`rand-prover pair --own` is shown as "My own prover"; any other as "Paired prover" with a note
saying what it can read. This build pays no prover fee: a prover quoting one is refused before
the auth proof is made.

**The RandProtocol provers are the default** (wallet 0.6.8; per-member keys since 0.6.9, audit v7
VK-9; `../docs/prover.md` §8): the build pins a descriptor of members — the core's
`version.trusted_prover_pool` (`TrustedProverPool`), data in
`core/crates/wallet-core/src/trusted-prover-pool.json` — each with its own URL
(`https://prover.randprotocol.org/m/<member>`), key fingerprint and pairing link. With nothing
paired, a phone that cannot fit the proof sends through them at once:
`ProverPairingService.builtInPool` holds every member's link to THAT member's pinned fingerprint and
URL and `own=0` (a member that fails is left out, the others keep working); `WalletService`
shuffles them per send; `route(…, defaultProver:)` takes the first that answers with its pinned key,
no fee, viewing-key jobs and room in its queue; `provePool` seals the job to THAT member's key and
polls only it — a member busy, refusing or unreachable at submit is skipped for the next. Every
member out: "The RandProtocol provers are all busy right now …" / "… cannot be reached right now
(…)", pointing to Settings. Nothing is paired or put in the Keychain. The first such send shows the
one-time notice (one of the RandProtocol provers — N machines run by the validators; each one that
proves a send sees that wallet's viewing key; it cannot spend) with "I understand — continue" and
"Use my own prover"; it is remembered per wallet and `WalletService.send` refuses until it is read.
Settings → Prover lists each member with its fingerprint and offers "Use no prover"; with none,
"Use the RandProtocol provers". A paired prover is preferred; "Forget this prover" falls back to the
pool. A `prover_submit` that never reached a member is offered again, three tries, 1 s then 3 s.

## TestFlight

The listing text, the App Privacy answers, the review notes and what gets a wallet refused are
in [`docs/store/README.md`](../docs/store/README.md) §1. Signing for TestFlight needs a paid
Apple Developer team (for a wallet, an organisation's); `scripts/release/build-local.sh ios`
builds the same Release archive unsigned, which checks the build without one.

1. In App Store Connect create an app for `org.randprotocol.wallet` (name "Rand Wallet").
2. Put your team id in `project.yml` (`DEVELOPMENT_TEAM`) and run `xcodegen generate`, or pass it
   on the command line as below. Automatic signing needs your Apple ID in Xcode → Settings →
   Accounts.
3. Archive and upload in one step:

   ```bash
   DEVELOPMENT_TEAM=ABCDE12345 scripts/archive.sh
   ```

   `ExportOptions.plist` uses `method: app-store-connect` with `destination: upload`, so
   `xcodebuild -exportArchive` uploads straight to App Store Connect (it needs an API key or
   an Apple ID session in Xcode; `-allowProvisioningUpdates` creates the profile). To upload a
   build exported elsewhere: `xcrun altool --upload-app -f build/export/RandWallet.ipa -t ios
   --apiKey <id> --apiIssuer <issuer>` or drag the `.ipa` into Transporter.
4. In App Store Connect → TestFlight, add testers to the build. Export compliance is answered by
   `ITSAppUsesNonExemptEncryption = false` in `Info.plist` (standard crypto only).

The privacy manifest (`PrivacyInfo.xcprivacy`) declares no tracking and no collected data; the
only network host is the RPC URL the user configures, plus randscan.org when a link is tapped.

## Security notes

- The spend key is the only wallet secret, kept in the Keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; the viewing key and address are derived on unlock.
  It never leaves the process: a paired prover is sent the viewing key and a salt (a
  split-authorisation chain), or — on an older chain only, and only to a prover paired as your own
  — the spend key, inside a job sealed to the prover's key. A paired prover's record (the token,
  the key and URL a job is sealed and sent to, and whether the link marked it your own; Settings →
  Prover, `../docs/prover.md` §6) sits beside the spend key under its own account, with the same
  accessibility; the pairing's public fields are in `UserDefaults`, for display only.
- A remote proof's pending record (the transaction with its auth proof, about 2.8 MB of hex) is
  held in memory for the length of the send and never written anywhere; an app the system kills
  mid-proof loses it, and nothing is sent.
- Unlock is Face ID / Touch ID with the device passcode as fallback; auto-lock after the interval
  in Settings when backgrounded (never during a proof).
- The note store is a cache of chain data and is written with complete file protection.
