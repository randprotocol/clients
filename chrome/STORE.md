# Chrome Web Store listing — Rand Wallet

**Name**: Rand Wallet
**Summary** (132 chars max): A shielded wallet for RAND on Rand Protocol: private balances, private transfers, viewing keys for randscan.org.
**Category**: Productivity → Tools (or Finance if offered)
**Language**: English

**Description**

Rand Wallet is a lightweight wallet for the Rand Protocol testnet (RAND). The chain is fully
shielded: there are no accounts and no public balances. Your wallet is a single spend key; your
balance is the set of notes that key can open; a transfer is a zero-knowledge proof built in
your browser.

- Create a wallet or import a spend key / wallet.key.json
- Receive: your rand1… address as text and QR
- Send: choose the notes, prove the 2-in-2-out bundle locally (a few minutes), submit
- Testnet faucet: 100 RAND into a note only you can open
- Activity: every note received and every payment sent
- Disclosure on your terms: copy the viewing key to open your history on randscan.org, or a
  per-transaction key to show one payment
- Password-encrypted key storage, auto-lock, dark and light themes

Testnet software: not audited, not for real value.

**Single purpose**: manage a RAND wallet (keys, balance, transfers) for the Rand Protocol chain.

**Permission justifications**
- `storage`: the encrypted spend key, settings and the local note cache.
- `alarms`: the auto-lock timer.
- Host permissions `https://rpc.randprotocol.org/*`, `https://rpc1.randprotocol.org/*`,
  `https://rpc2.randprotocol.org/*` and `https://rpc3.randprotocol.org/*`: the default JSON-RPC
  endpoints the wallet talks to. The first is the live one today; the other three are the
  planned failover set, so one endpoint being down is not the wallet being down. It never
  contacts more than one at a time.
- Optional host permissions (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): only
  requested when the user enters a different RPC URL in Settings (their own node).
- No content scripts, no tabs permission, no remote code. WebAssembly is bundled
  (`'wasm-unsafe-eval'`) and built from the open-source core.

**Privacy disclosures**: collects no user data; does not use remote code; the only requests go
to the RPC node the user configures. Keys never leave the device. Privacy policy:
https://randprotocol.org/clients#privacy

**Screenshots to take** (1280×800 or 640×400): welcome, home with balance, receive (QR), send
review, proving, sent with "Copy transaction key", settings/viewing key.

**Promo tile** 440×280: the icon on the aurora gradient with "Rand Wallet".
