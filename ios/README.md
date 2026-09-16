# Rand Wallet for iOS

SwiftUI, iOS 16+, bundle id `org.randprotocol.wallet`. The chain cryptography (keys, envelopes,
the bundle proof) is the Rust core in `../core`, linked as `Frameworks/RandWalletCore.xcframework`;
everything else in this directory is Swift.

```
RandWallet/
  Core/        RandCore (the one FFI call), Models (the core's JSON shapes), Amount
  Network/     RpcClient — JSON-RPC 2.0 over URLSession
  Storage/     NoteStore (Application Support, complete file protection), Keychain, Settings
  Services/    WalletService (scan / send / faucet), AuthService (lock, Face ID)
  UI/          Welcome · Lock · Home · Receive · Send → Review → Proving → Sent · Activity · Settings
RandWalletTests/   NoteStore logic and an FFI smoke test
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
STARK). The Send flow keeps the screen awake and asks the user to keep the app open.

## TestFlight

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

- The spend key is the only secret, kept in the Keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; the viewing key and address are derived on unlock.
- Unlock is Face ID / Touch ID with the device passcode as fallback; auto-lock after the interval
  in Settings when backgrounded (never during a proof).
- The note store is a cache of chain data and is written with complete file protection.
