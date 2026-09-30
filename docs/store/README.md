# Store uploads — what to upload, what to type, what each reviewer will ask

One page for the four stores. Each section has the file to upload, every text field filled in
ready to paste (character counts are against that store's limit), the answers to the privacy and
compliance forms, and the notes for the reviewer. Every statement here is true of the code at
the release tag; when the code changes, change it here in the same commit.

The files are in `dist/release/v<version>/` after `scripts/release/build-local.sh` and
`scripts/release/checksums.sh v<version>` have run, and on the
[GitHub release](https://github.com/randprotocol/clients/releases/latest).

| store | upload this | built by |
|---|---|---|
| TestFlight / App Store | an archive signed by your team, uploaded by `ios/scripts/archive.sh` | you, once a team id exists (§1) |
| Google Play | `rand-wallet-<v>-android.aab` | `scripts/release/build-local.sh android` |
| Chrome Web Store | `rand-wallet-chrome-<v>.zip` | the release workflow |
| addons.mozilla.org | `rand-wallet-firefox-<v>.zip`, and `rand-wallet-<v>-source.tar.gz` as the source | the release workflow |

## 0. Before any upload

**Used by every listing**

| field | value |
|---|---|
| Name | `Rand Wallet` |
| Privacy policy URL | `https://randprotocol.org/clients/privacy` (the text of [`PRIVACY.md`](../../PRIVACY.md)) |
| Website / marketing URL | `https://randprotocol.org/clients` |
| Support URL | `https://github.com/randprotocol/clients/issues` |
| Source / licence | `https://github.com/randprotocol/clients`, GPL-3.0-only |
| Category | Finance |
| Icon | `design/out/icon-1024-opaque.png` (App Store), `design/out/play-store-512.png` (Play), `extension/shared/icons/icon-128.png` (Chrome, Firefox) |

**Only the owner can supply**

- A **support email address** on a domain you control. Apple, Google and Chrome each require one
  and show it publicly; none is recorded in this repository.
- The **developer accounts**: Apple Developer Program, Google Play Console, Chrome Web Store
  developer ($5 once), addons.mozilla.org (free). For a wallet, enrol Apple and Google **as an
  organisation**, not as an individual — see the first item under each store's "What can get it
  rejected".
- **A funded review wallet.** The public endpoint refuses `rand_mint` ("method not allowed
  here", checked 2026-09-30), so the in-app Faucet button does not fund a reviewer's wallet, and
  a reviewer with no funds cannot reach the Send flow. Create a wallet, fund it from a node you
  operate, and paste its spend key where the review notes below say
  `<PASTE THE REVIEW WALLET'S SPEND KEY HERE>` — in the stores' private reviewer notes only,
  never in a public listing. Alternatively open the faucet on the endpoint for the review
  period (`docs/rpc-endpoints.md` has the tight `@mint` bucket for it) and say so in the notes.
- **Phone screenshots.** The browser and desktop set is in `docs/store/screenshots/extension/`
  (five at 1280 × 800, made by `docs/store/make-screenshots.sh` from the real interface over the
  dev harness's fixture wallet). The iOS and Android apps have their own native screens and no
  screenshots in the repository: take them on a device or simulator, from a wallet holding
  faucet RAND so that no screen is empty. The list is in each store's section.

**The one sentence every listing keeps**

> Testnet software: not audited, not for real value.

It is in every description below on purpose. A reviewer who thinks real money is at stake asks
for licences; a reviewer who is told plainly that it is a testnet wallet whose coins cost nothing
does not.

---

## 1. Apple — TestFlight, then the App Store

### Upload

Xcode on this machine has only a free Personal Team, which cannot sign for TestFlight. Once the
paid team exists:

```bash
DEVELOPMENT_TEAM=<team id> ios/scripts/archive.sh      # archives, signs, uploads to App Store Connect
```

Before that, in App Store Connect: **Apps → + → New App**, platform iOS, name `Rand Wallet`,
bundle id `org.randprotocol.wallet`, SKU `rand-wallet-ios`, primary language English (U.S.).
`scripts/release/build-local.sh ios` builds the same Release archive unsigned, which proves the
build is good but cannot be uploaded.

### App information

| field (limit) | text |
|---|---|
| Name (30) | `Rand Wallet` |
| Subtitle (30) | `Shielded wallet for RAND` |
| Primary category | Finance |
| Secondary category | Utilities |
| Content rights | Does not contain third-party content |
| Age rating | answer **None / No** to every question → 4+. (No gambling, no contests, no unrestricted web access: links open Safari.) |
| Copyright | `2026 RandProtocol Contributors` |

**Promotional text (170)**

```
A private wallet for the Rand Protocol testnet. Your balance and your payments are visible only to you, and to whoever you hand a viewing key.
```

**Keywords (100)**

```
rand,shielded,private,wallet,zero knowledge,testnet,viewing key,post-quantum,self custody,qr
```

**Description (4000)**

```
Rand Wallet is a self-custody wallet for the Rand Protocol testnet.

Rand is a fully shielded chain: there are no public accounts and no public balances. Your wallet is one spend key, generated on your iPhone and kept in its Keychain. Your balance is the set of notes that key can open. A payment is authorised by a zero-knowledge proof rather than a signature, so the chain learns that a valid payment happened and nothing about who paid whom or how much.

WHAT IT DOES
• Create a wallet, or import a spend key or a wallet.key.json from another Rand Wallet
• Receive: your rand1… address as text and as a QR code
• Send RAND and listed RPL tokens: review the payment, then the proof is made on your iPhone
• Scan an address or a randpay: payment link with the camera
• Activity: every note you received and every payment you sent
• Disclose only what you choose: copy your viewing key to open your own history on randscan.org, or one payment's transaction key to show exactly that payment

YOUR KEYS STAY WITH YOU
• The spend key never leaves the device Keychain and is never synced
• Face ID or Touch ID unlocks the wallet, with your passcode as the fallback
• No account, no sign-up, no analytics, no advertising, no tracking
• The app talks only to the RPC node you choose in Settings

GOOD TO KNOW
• Making a proof takes a minute or two and needs an iPhone with about 8 GB of memory. On other iPhones everything else works, and you can send by pairing a prover that you run yourself (Settings → Prover).
• There is no recovery service. Save your spend key when the wallet shows it to you; nobody can restore it for you.
• Rand Wallet does not buy, sell or exchange anything and holds no funds on your behalf.

Testnet software: not audited, not for real value. Test RAND has no monetary value.

Open source under GPL-3.0: github.com/randprotocol/clients
```

**What's New in This Version**

```
First TestFlight build. Built for Rand testnet chain 19.
```

### App Privacy ("nutrition label")

- **Data collection: "No, we do not collect data from this app."** That is the whole form.
- Privacy policy URL: `https://randprotocol.org/clients/privacy`.
- The bundled privacy manifest (`PrivacyInfo.xcprivacy`) agrees: no tracking, no collected data,
  two required-reason APIs (UserDefaults `CA92.1`, file timestamps `C617.1`).

### Export compliance

The app encrypts with standard, published algorithms (ML-KEM-768, ChaCha20-Poly1305, AES-GCM,
SHA-2, Poseidon2) and carries its own implementations of them instead of calling Apple's.
`Info.plist` currently sets `ITSAppUsesNonExemptEncryption = false`, which skips the question on
every upload. **Check that answer with whoever signs your export declarations before the first
external build.** If App Store Connect's questionnaire is answered by hand instead, the
accurate choice is "standard encryption algorithms instead of, or in addition to, using or
accessing the encryption within Apple's operating system"; that path asks for a French
encryption declaration if the app is distributed in France, and the simple way through is to
leave France out of the first release's territories.

### TestFlight

| field | text |
|---|---|
| Beta App Description | the first two paragraphs of the description above |
| Feedback email | your support address |
| Marketing URL | `https://randprotocol.org/clients/ios` |
| Privacy policy URL | `https://randprotocol.org/clients/privacy` |
| Sign-in required | No |

**What to Test**

```
1. Create a new wallet and save the spend key it shows you.
2. Import the funded test wallet from the invitation email (Welcome → I already have a wallet), or ask us for test RAND to your own address.
3. Receive: show your address as a QR code. Scan it from a second device's Send screen.
4. Send 1 RAND to another Rand Wallet address. On an iPhone with 8 GB of memory the proof takes a minute or two; keep the app open. On other iPhones the review screen explains why this device cannot make the proof.
5. Activity → a payment → Disclose this payment: copy the transaction key and open it on randscan.org.
6. Lock the phone, reopen the app: Face ID should be required.
```

### App Review notes (paste into "Notes")

```
Rand Wallet is a non-custodial ("self-custody") wallet for the Rand Protocol TESTNET. Test RAND costs nothing and has no monetary value.

NO LOGIN: there is no account. Tap "Create a new wallet" to begin.

TO GET FUNDS FOR TESTING: a funded test wallet is provided for review. On the Welcome screen choose "I already have a wallet" and paste this key: <PASTE THE REVIEW WALLET'S SPEND KEY HERE>. (The Faucet button asks the node for test RAND; the public node does not hand it out to anonymous callers, so that button reports a refusal there. It is for nodes that run an open faucet.)

WHAT THE APP DOES NOT DO: it does not buy, sell, exchange or swap anything; it has no in-app purchases; it holds no user funds (keys are generated and stored only on the device, in the Keychain); it does not run an ICO or sell tokens; it offers no reward for any task.

THE ON-DEVICE COMPUTATION IS NOT MINING. When the user confirms a payment, the app computes one zero-knowledge proof that authorises that single payment. It runs once per payment, only after the user taps Confirm, takes one to two minutes, and earns nothing. There is no background computation.

DEVICE MEMORY: the proof needs about 8 GB of device memory. On devices with less, the review screen says so and the payment is not started; creating a wallet, receiving, activity and key disclosure all work on every device. To test a send, use a device with 8 GB of memory (for example iPhone 15 Pro or later).

NETWORK: the app connects only to the JSON-RPC node shown in Settings (default https://rpc.randprotocol.org). It collects no data and contains no analytics or advertising SDKs.

CAMERA is used only to scan an address or payment-link QR code. FACE ID is used only to unlock the wallet.

Source code: https://github.com/randprotocol/clients (GPL-3.0).
```

### Screenshots

6.9-inch iPhone (1320 × 2868 portrait) is the one required set; the app is iPhone-only and
portrait-only, so no iPad set. Take, in this order: Home with a balance · Receive (QR) · Send
review · Proving · Sent, with "Copy transaction key" · Activity · Settings → viewing key.
Suggested captions, if you add text to the frames:

1. `Your balance. Only you can see it.`
2. `Receive with an address or a QR code.`
3. `Review every payment before it is proved.`
4. `The proof is made on your iPhone.`
5. `Disclose one payment, or none.`
6. `Every note you received and sent.`
7. `Your keys stay on this device.`

### What can get it rejected

- **Guideline 3.1.5(i) — wallets must come from an organisation.** "Apps may facilitate virtual
  currency storage, provided they are offered by developers enrolled as an organization." An
  individual developer account is refused for this app however good the listing is. Enrol the
  organisation (it needs a D-U-N-S number) before anything else.
- **Guideline 2.2 — betas belong in TestFlight.** A testnet-only wallet is, to App Review, a
  beta. Stay on TestFlight (external testing has its own, lighter, Beta App Review) until there
  is a mainnet; submitting this build to the App Store itself invites a 2.2 rejection.
- **Guideline 3.1.5(ii) — mining.** The proof is heavy on-device computation in a cryptocurrency
  app, which is what a mining rejection looks like from the outside. The review notes say what
  it is; keep that paragraph.
- **Guideline 2.1 — a button that reports a refusal.** On the public endpoint the Faucet button
  answers with the node's refusal. A reviewer reads a feature that errors as an incomplete app.
  Either open the faucet for the review period, or point the app at an endpoint that serves it;
  the notes explain it, but an explanation is weaker than a button that works.
- **Guideline 2.1 — the reviewer cannot finish a send.** On a review device with less than 8 GB
  the send stops at the review screen by design. The notes say which devices can; if a reviewer
  still insists, stand up your own `rand-prover` and give them its pairing link in the notes.
- **Guideline 5.1.1 — privacy policy.** The URL must load, and must be the wallet's own policy.
- **Territories.** A wallet must be lawful wherever it is offered (3.1.5). Leave out China
  mainland, and any territory where you have not checked, in Pricing and Availability.

---

## 2. Google Play

### Upload

`rand-wallet-<v>-android.aab`, to **Testing → Internal testing** first. It targets API 36 (Play
has required that of new apps since 31 August 2026), supports 16 KB pages, and carries arm64-v8a
and x86_64.

The bundle is signed with the upload key in `android/release.jks` (gitignored; passwords in
`android/keystore.properties`). Its certificate's SHA-256 is
`75:22:2E:BF:22:D3:95:80:A5:11:2A:AC:B7:EC:2E:03:93:91:07:77:96:E0:45:1D:7B:CF:E3:7E:FA:06:53:52`.
**Back both files up somewhere that is not this laptop.** Accept Play App Signing when the
console offers it: Google then holds the app signing key, and a lost upload key can be reset.

### Store listing

| field (limit) | text |
|---|---|
| App name (30) | `Rand Wallet` |
| Short description (80) | `A private, self-custody wallet for the Rand Protocol testnet.` |
| App category | Finance |
| Tags | Finance, Crypto wallet (if offered) |
| Contact email | your support address |
| Website | `https://randprotocol.org/clients` |
| Privacy policy | `https://randprotocol.org/clients/privacy` |

**Full description (4000)**

```
Rand Wallet is a self-custody wallet for the Rand Protocol testnet.

Rand is a fully shielded chain: there are no public accounts and no public balances. Your wallet is one spend key, generated on your phone and encrypted under a key held by the Android Keystore. Your balance is the set of notes that key can open. A payment is authorised by a zero-knowledge proof rather than a signature, so the chain learns that a valid payment happened and nothing about who paid whom or how much.

WHAT IT DOES
• Create a wallet, or import a spend key or a wallet.key.json from another Rand Wallet
• Receive: your rand1… address as text and as a QR code
• Send RAND and listed RPL tokens: review the payment, then the proof is made on your phone
• Scan an address or a randpay: payment link with the camera
• Activity: every note you received and every payment you sent
• Disclose only what you choose: copy your viewing key to open your own history on randscan.org, or one payment's transaction key to show exactly that payment

YOUR KEYS STAY WITH YOU
• The spend key is stored encrypted on the device and is never backed up or synced
• Fingerprint or face unlock, with your screen lock as the fallback
• No account, no sign-up, no analytics, no advertising, no tracking
• The app talks only to the RPC node you choose in Settings, and only over HTTPS

GOOD TO KNOW
• Making a proof takes a few minutes and needs a phone with about 8 GB of memory. A notification shows while it runs. On other phones everything else works, and you can send by pairing a prover that you run yourself (Settings → Prover).
• There is no recovery service. Save your spend key when the wallet shows it to you; nobody can restore it for you.
• Rand Wallet does not buy, sell or exchange anything and holds no funds on your behalf.

Testnet software: not audited, not for real value. Test RAND has no monetary value.

Open source under GPL-3.0: github.com/randprotocol/clients
```

**Release notes (500)**

```
First testing release. Built for Rand testnet chain 19.
```

### App content declarations

| form | answer |
|---|---|
| Privacy policy | `https://randprotocol.org/clients/privacy` |
| App access | All functionality is available without special access (no login) |
| Ads | No, the app does not contain ads |
| Content rating (IARC) | Category: Utility / Productivity. Answer No to every content question. The app does not let users exchange real money or purchase digital goods. |
| Target audience | 18 and over only |
| News app | No |
| Data safety | see below |
| Government app | No |
| Financial features | **Cryptocurrency software wallet (non-custodial).** Nothing else: no exchange, no custodial wallet, no loans, no trading, no banking. |
| Health | None |

**Data safety**

- Does your app collect or share any of the required user data types? **No.**
- Is all of the user data collected by your app encrypted in transit? Not asked once the answer
  above is No. (For the record: release builds refuse cleartext HTTP.)
- Do you provide a way for users to request that their data is deleted? Not asked; there is no
  account and no server-side data.

The answer is No because the form's own definition of "collect" is transmitting data off the
device to the developer or a third party: the wallet's keys, notes and settings never leave the
device, and a transaction submitted to the chain carries no personal data.

**Permissions the console may ask about**

| permission | why |
|---|---|
| `CAMERA` | scanning an address or payment-link QR code; optional hardware (`required="false"`) |
| `USE_BIOMETRIC` | unlocking the wallet |
| `POST_NOTIFICATIONS` | the notification shown while a proof is being made |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | see the next block |
| `INTERNET` | JSON-RPC to the node in Settings |

**Foreground service declaration** (Play asks for a description and a short video for each type)

- Type: **Data sync**. Task: *Other* →

  ```
  When the user confirms a payment, the app builds the transaction, computes the proof that authorises it and uploads it to the network. This takes a few minutes and must not be interrupted: if the app is suspended the payment is lost and the user must start again. The service starts only when the user taps Confirm, shows an ongoing notification with progress, and stops as soon as the transaction is submitted.
  ```
- Video: record Send → Review → Confirm → the notification appearing → switching to another app
  → returning to "Sent". Thirty seconds is enough; upload it unlisted and paste the link.

### Graphics

| asset | spec | where |
|---|---|---|
| App icon | 512 × 512 PNG | `design/out/play-store-512.png` |
| Feature graphic | 1024 × 500 | `design/out/play-feature-1024x500.png` (`design/make-store-art.py`) |
| Phone screenshots | 2 to 8, 9:16, at least 1080 px wide | Home with a balance · Receive (QR) · Send review · Proving notification · Sent · Activity · Settings |

Captions as in §1. Do not put "No. 1", prices, or store badges in any graphic.

### What can get it rejected

- **Personal developer accounts.** A personal Play account created after November 2023 must run
  a closed test with at least 12 testers for 14 days before it can publish to production, and
  Play expects a wallet to come from a verified **organisation** account (D-U-N-S number).
- **Financial features declaration missing or wrong.** Every app must complete it. Declare the
  non-custodial software wallet and nothing else. Do not describe the app anywhere as an
  exchange, as "earning", or as an investment.
- **Foreground service type.** `dataSync` is the closest declared type for "compute, then
  upload", and reviewers do refuse declarations they find unconvincing. If this one is refused,
  the fix is in code, not in the form: change `ProvingService` to the `specialUse` type with a
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` that says "user-initiated zero-knowledge proof for a
  payment", and resubmit.
- **Mining.** Play forbids on-device cryptocurrency mining. The proof is not mining (one
  computation per payment, user-initiated, no reward); the description says "proof", never
  "mine" or "earn", and should stay that way.
- **Deceptive claims.** "Private" and "shielded" are claims about the protocol; keep "testnet",
  "not audited" and "no monetary value" in the description so they cannot be read as promises
  about real funds.
- **Stay in testing tracks while this is a testnet wallet.** Internal, closed and open testing
  all install from Play without a production review of a product that has no mainnet.

---

## 3. Chrome Web Store

### Upload

`rand-wallet-chrome-<v>.zip` at **Developer Dashboard → Add new item**. Manifest V3,
`minimum_chrome_version` 116. The name and the short description shown in the store come from
the manifest and are already within their limits.

### Store listing

| field (limit) | text |
|---|---|
| Name (75, from the manifest) | `Rand Wallet` |
| Summary (132, from the manifest) | `A shielded wallet for RAND on the Rand Protocol chain: private balances, private transfers, and viewing keys for randscan.org.` |
| Category | Tools (there is no Finance category for extensions) |
| Language | English |
| Homepage URL | `https://randprotocol.org/clients/chrome` |
| Support URL | `https://github.com/randprotocol/clients/issues` |

**Description**

```
Rand Wallet is a self-custody wallet for the Rand Protocol testnet, in your browser's toolbar or side panel.

Rand is a fully shielded chain: there are no public accounts and no public balances. Your wallet is one spend key, generated in the extension and stored encrypted under your password. Your balance is the set of notes that key can open. A payment is authorised by a zero-knowledge proof, so the chain learns that a valid payment happened and nothing about who paid whom or how much.

WHAT IT DOES
• Create a wallet, or import a spend key or a wallet.key.json
• Receive: your rand1… address as text and as a QR code
• Send RAND and listed RPL tokens: the extension builds the payment, a prover you pair makes the proof, the extension checks the proof and submits it
• Connect to randbridge.org: the bridge sees your address only after you approve it
• Activity: every note you received and every payment you sent
• Disclose only what you choose: copy your viewing key to open your own history on randscan.org, or one payment's transaction key to show exactly that payment
• Password-encrypted key storage, auto-lock, dark and light themes

ABOUT SENDING
A proof needs more memory than a browser gives an extension, so the extension does not make it. Pair a prover that you run yourself: the Rand Wallet desktop app on the same computer, or your own server (Settings → Prover). Without one, everything except sending works.

YOUR KEYS STAY WITH YOU
No account, no sign-up, no analytics, no advertising, no remote code. The extension talks only to the RPC node in Settings and, if you pair one, to your own prover.

Testnet software: not audited, not for real value. Test RAND has no monetary value.

Open source under GPL-3.0: github.com/randprotocol/clients
```

### Privacy practices tab

**Single purpose**

```
Rand Wallet manages a wallet for the Rand Protocol chain: it holds the user's key, shows the balance and activity, and builds and submits transfers.
```

**Permission justifications** — one box each, paste as written

| permission | justification |
|---|---|
| `storage` | `Stores the user's password-encrypted wallet key, their settings, and a local cache of the chain data belonging to their wallet.` |
| `alarms` | `Runs the auto-lock timer, so the wallet locks after the chosen interval even when the popup is closed and the service worker is asleep.` |
| `sidePanel` | `Lets the user open the wallet in Chrome's side panel instead of the popup.` |
| `scripting` | `When the extension is installed or updated, re-injects its own bundled content script into randbridge.org tabs that are already open, so the bridge page can find the wallet without a reload. It injects only files packaged in the extension, and only into the hosts listed in the manifest.` |
| Host permissions: `rpc.randprotocol.org`, `rpc1`–`rpc3.randprotocol.org` | `The default JSON-RPC endpoints of the Rand chain. The wallet reads chain data from one of them and submits the user's transactions to it; the others are failover.` |
| Host permissions: `randbridge.org` | `The Rand bridge web app. The extension exposes a provider object there (window.rand) so the user can connect their wallet to the bridge. The site learns the wallet address only after the user approves the connection.` |
| Content scripts on `localhost` / `127.0.0.1` | `The same provider on a locally served copy of the bridge app, for people who run it themselves. No data is read from these pages.` |
| Optional host permissions (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) | `Requested at run time, for one origin, only when the user types their own RPC node URL in Settings or pairs their own prover. Nothing is requested until the user does that.` |
| Remote code | **No, I am not using remote code.** `All JavaScript and the WebAssembly module are packaged in the extension. 'wasm-unsafe-eval' is needed only to instantiate that bundled module.` |

**Data usage** — leave every "collects" checkbox **unticked** (personally identifiable
information, health, financial and payment information, authentication information, personal
communications, location, web history, user activity, website content), and tick all three
certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

Privacy policy URL: `https://randprotocol.org/clients/privacy`.

One thing to know before ticking: when the user pairs a prover, each proving job carries the
wallet's viewing key and a one-time salt, encrypted to that prover — enough to read the wallet's
history, not to spend (the spend key never leaves the device). It goes only to a prover the user
chose and pasted the link of, never to the developer, which is why "financial and payment
information" stays unticked; the app warns before saving a pairing that is not the user's own,
and the description and the privacy policy both say all of this. They must keep saying so.

### Graphics

| asset | spec |
|---|---|
| Store icon | 128 × 128: `extension/shared/icons/icon-128.png` |
| Screenshots | 1 to 5, 1280 × 800: `docs/store/screenshots/extension/1-welcome.png` … `5-activity.png` (welcome · home · receive · send · activity) |
| Small promo tile | 440 × 280: `design/out/chrome-promo-440x280.png` (`design/make-store-art.py`) |

### Test instructions (the dashboard's "Test instructions" tab)

```
No login is needed. Click the toolbar icon → "Create a new wallet" → choose a password → save the spend key shown. To test with funds, choose "I already have a wallet" instead and paste the review wallet's key: <PASTE THE REVIEW WALLET'S SPEND KEY HERE> (the Faucet button is refused by the public node; it is for nodes that run an open faucet). Receive shows the address and QR code. Sending needs a prover the user runs themselves (the Rand Wallet desktop app, Settings → "Prove for my other devices"); without one the Send screen explains this and stops before any proof. To see the bridge connection, open https://randbridge.org and choose Connect → Rand Wallet.
```

### What can get it rejected

- **A permission without a justification, or a justification that does not match the code.**
  The table above covers every permission in `chrome/manifest.json` at this release. If the
  manifest gains or loses one, this table changes in the same commit.
- **Broad optional host permissions** (`https://*/*`) draw an in-depth review, which is slower,
  not a refusal. The justification has to say they are optional and user-triggered; it does.
- **Minified or obfuscated code.** There is none: no bundler, no minifier. The one binary is
  `core/rand_wallet_bg.wasm`, built by `core/scripts/build-wasm.sh` from the public source.
- **Mining.** The Web Store bans extensions that mine. This one cannot even prove; say "proof",
  never "mine".
- **Keyword stuffing or misleading metadata.** The description names no other wallet and no
  other chain. Keep it that way.

---

## 4. Firefox — addons.mozilla.org

### Upload

`rand-wallet-firefox-<v>.zip` at **Developer Hub → Submit a New Add-on → On this site**. Add-on
id `wallet@randprotocol.org`, Firefox 140 or later, Manifest V3.

When the form asks **"Do you need to submit source code?" answer Yes** and upload
`rand-wallet-<v>-source.tar.gz`: the add-on contains a WebAssembly module, which is compiled
code, and Mozilla's reviewers rebuild it.

### Listing

| field (limit) | text |
|---|---|
| Name | `Rand Wallet` |
| Summary (250) | `A self-custody wallet for the Rand Protocol testnet: private balances and private transfers, proved by a prover you run yourself, and viewing keys to open your own history on randscan.org.` |
| Categories | Privacy & Security; Other |
| Licence | GNU General Public License v3.0 only |
| Homepage | `https://randprotocol.org/clients/firefox` |
| Support site | `https://github.com/randprotocol/clients/issues` |
| Support email | your support address |
| Privacy policy | paste the text of [`PRIVACY.md`](../../PRIVACY.md) (AMO hosts the text, not a link) |
| This add-on is experimental | **tick it** while the chain is a testnet |

**Description**: the Chrome description above, as written.

### Notes to reviewer

```
BUILD. The source archive is the whole repository at the release tag with its one submodule included. On Linux or macOS with rustup and Node 22+:

    core/scripts/build-wasm.sh     # builds core/crates/wallet-wasm with the pinned Rust 1.98.1 and runs wasm-bindgen (it installs the matching wasm-bindgen-cli); output: extension/shared/core/rand_wallet.js and rand_wallet_bg.wasm
    firefox/pack.sh                # copies extension/shared/ and ui/ into dist/firefox/ and zips it

No bundler, minifier or transpiler is used. Every .js file in the add-on is a source file from extension/shared/ or ui/, byte for byte. The only generated files are core/rand_wallet.js and core/rand_wallet_bg.wasm (wasm-bindgen output).

TESTING. No account is needed. Click the toolbar button → "Create a new wallet" → set a password → save the spend key. To test with funds, choose "I already have a wallet" and paste the review wallet's key: <PASTE THE REVIEW WALLET'S SPEND KEY HERE> (the Faucet button is refused by the public node; it is for nodes that run an open faucet). Sending needs a prover the user runs themselves (the Rand Wallet desktop app); without one the Send screen explains this and stops.

NETWORK. JSON-RPC POSTs to the node URL in Settings (default https://rpc.randprotocol.org; rpc1–rpc3.randprotocol.org are failover hosts). If, and only if, the user pairs a prover in Settings → Prover, requests go to that URL as well; a proving job contains the wallet's viewing key and a one-time salt, encrypted to that prover (enough to read the wallet's history, not to spend; the spend key never leaves the device, which makes the authorisation proof itself). No analytics, no telemetry, no remote code.

CONTENT SCRIPTS run only on randbridge.org (and localhost, for a locally served bridge) and expose a provider object, window.rand. A page learns the wallet address only after the user approves that site.

'wasm-unsafe-eval' in the CSP is required to instantiate the bundled WebAssembly module.

LINT. web-ext lint reports UNSAFE_VAR_ASSIGNMENT warnings in ui/screens/*.js: a screen renders itself as a template string into innerHTML. Every interpolated value passes through the `h` tagged template in ui/lib/dom.js, which escapes it; the only unescaped values are raw(…) literals written in this repository. Nothing from the network or from storage is inserted unescaped.

DATA. data_collection_permissions.required is ["none"] in the manifest.
```

### Screenshots

The same five files as Chrome's.

### What can get it rejected

- **No source, or source that does not rebuild.** The reviewer runs the two commands above on
  the archive. `scripts/release/source-tarball.sh` is what makes it complete; do not upload
  GitHub's automatic "Source code" archive, which leaves the submodule out.
- **`innerHTML`.** Expect a question; the lint paragraph in the notes is the answer.
- **Data collection.** The manifest declares none. If a build ever adds a network peer, the
  manifest, the notes and `PRIVACY.md` change together.

---

## 5. After a listing is live

Set that client's `link` in the site's `src/data/clients.ts` (in the randprotocol.org
repository) to the store URL, rebuild and deploy the site. The client's page and card switch
from "listing pending" to a store button by themselves.
