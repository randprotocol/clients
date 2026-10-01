# Rand Wallet — privacy policy

Effective 1 October 2026. This covers every Rand Wallet client: the iOS and Android apps, the
Chrome and Firefox extensions, the desktop app for Windows, macOS and Linux, and the local web
wallet. The same text is published at https://randprotocol.org/clients/privacy.

## The short version

Rand Wallet collects nothing. There is no account, no sign-up, no analytics, no advertising, no
crash reporting and no server of ours that the wallet reports to. Your keys are generated on
your device and stay there.

## What stays on your device

- **Your spend key** — generated on the device from the operating system's randomness and stored
  encrypted: in the Keychain on iOS, in Keystore-backed encrypted preferences on Android, and in
  a password-encrypted vault (AES-256-GCM under PBKDF2-SHA256) in the extensions, the desktop
  app and the web wallet. We never receive it and cannot recover it for you.
- **Unlock with Touch ID** (the Chrome extension, only if you turn it on) — a passkey made by your
  device's own authenticator for this extension alone. The extension keeps the passkey's id and
  your wallet password sealed under a key only that passkey can produce after your fingerprint
  (WebAuthn PRF). The fingerprint never reaches the extension, and nothing leaves your device.
- **Your notes and activity** — a local cache of the chain data your key can open, and the
  transaction keys of payments you made. A rescan rebuilds it.
- **Your settings and contacts** — the RPC URL, the auto-lock interval, the theme, any addresses
  you saved with a name.

Nothing is backed up to a cloud service: Android's backup is switched off for the app, and the
iOS Keychain item is marked for this device only. Removing the Android app or a browser
extension removes its data. iOS keeps Keychain items after an app is deleted, and the desktop
app's `wallet.json` stays in your user data folder after an uninstall; both remain encrypted on
your device until you delete them.

## What leaves your device, and where it goes

- **To the RPC node you use.** The wallet speaks JSON-RPC to one node: by default
  `https://rpc.randprotocol.org`, or the URL you enter in Settings. It asks for blocks and
  commitment-tree data to find your notes, and it submits the transactions you confirm. A
  transaction is what the chain publishes anyway — commitments, nullifiers, sealed envelopes and
  a proof — and carries no name, no account and no readable amount. Like any server, the node
  sees the IP address the request comes from, and the public endpoint may keep ordinary
  web-server logs (address, time, request size) to operate and protect the service. A node you
  run yourself sees only what you send it.
- **To the testnet faucet, if you ask it.** A faucet request asks the node to mint test RAND
  into a note that only your key can open.
- **To a prover, when your device cannot make the proof itself.** A browser wallet, or a phone
  without the memory for a proof, has the payment's proof made by a prover. From version 0.6.8
  the wallet uses **the RandProtocol prover** by default — https://prover.randprotocol.org
  (fingerprint RGTF-7HKJ-XZFV-GQ1J), a pool of machines run by the RandProtocol validators,
  sharing one prover key and charging no fee — and tells you so before your first send. Each
  proving job carries your wallet's **viewing key** and a one-time salt, encrypted to that one
  prover. With them the prover's operators can read your wallet's whole history — every
  payment received and sent, past and future — and they cannot spend: your **spend key never
  leaves your device**, which makes the small authorisation proof itself. For more privacy,
  choose your own prover in Settings → Prover (the desktop app on your own computer, or a server
  you run or trust), which the wallet then always prefers, or no prover at all (a browser
  wallet then cannot send). The app warns you before it saves a pairing to a prover that is not
  your own.
- **To sites you connect, in the extension.** On randbridge.org the extension offers itself as
  `window.rand`. A site learns nothing until you approve it for that site, and an approved site
  learns your address and its bridge recipient hash, nothing else.
- **When you open a link.** "View on RandScan" and similar buttons open randscan.org or
  randprotocol.org in your browser. Viewing keys and transaction keys are decrypted there in
  your browser; the wallet never sends them anywhere by itself.

## Permissions

- **Camera** (iOS, Android) — only while you scan an address or payment-link QR code. Frames are
  processed on the device and are not stored or sent.
- **Face ID, Touch ID, fingerprint** — handled by the operating system; the app learns only
  whether the unlock succeeded.
- **Notifications** (Android) — the progress notification shown while a proof is being made.
- **Browser storage, alarms, side panel** (extensions) — the encrypted vault and settings, the
  auto-lock timer, and showing the wallet in the browser's side panel.

## What we do not do

We do not sell, share or transfer data, because we do not have any. We do not track you across
apps or sites. The wallet loads no remote code: everything it runs is in the package you
installed, and the source is public at https://github.com/randprotocol/clients.

## Children

Rand Wallet is not directed at children and collects no information from anyone.

## Changes

If this policy changes, the new text is published here and at
https://randprotocol.org/clients/privacy with a new effective date, and the change is visible in
this repository's history.

## Contact

Questions about this policy: open an issue at https://github.com/randprotocol/clients/issues.
