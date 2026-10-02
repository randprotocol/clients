# Localizing Rand Wallet for iOS

The app ships in English (the source language) and is prepared for nineteen more. English is
complete; the other languages are filled in by translators in the string catalogs below.

## Where the strings live

| File | What it holds |
| --- | --- |
| `RandWallet/Localizable.xcstrings` | Every sentence, label and button title the app shows (about 430 keys). The key is the English text; the `en` value is the same text with positional placeholders. |
| `RandWallet/InfoPlist.xcstrings` | The Info.plist strings iOS shows on the app's behalf: `CFBundleDisplayName` (the name under the icon), `NSCameraUsageDescription`, `NSFaceIDUsageDescription`. `Info.plist` keeps the English values as the fallback. |

How a string gets into the catalog:

- **SwiftUI literals.** `Text("Balance")`, `Button("Copy")`, `.navigationTitle("Settings")` and every
  component that takes a `LocalizedStringKey` (`PrimaryButton(title:)`, `SecondaryButton(title:)`,
  `CopyRow(label:)`, `SectionLabel(text:)`, `Field(placeholder:)`, `RoundAction(label:)`,
  `QRScannerView(prompt:)`) look their literal up in the catalog. Interpolations become
  placeholders: `Text("Synced \(age) ago")` is the key `Synced %@ ago`; an `Int` is `%lld`, a
  `UInt64` `%llu`.
- **Plain strings** a service, a store or a view model produces for the screen (`WalletService`,
  `ProverClient`, `ProverPairingService`, `InvokeFlow`, `SendLink`, `Contacts`, `Amm`, …) are written
  `String(localized: "…")`, interpolations kept.
- **Data is never a key.** Addresses, amounts, fingerprints, transaction hashes, memos and contact
  names are passed as `String` (or `Text(verbatim:)`) and shown as they are.
- Log lines, test messages, preconditions and protocol diagnostics (`rand_getBlocks: …`) stay
  English and stay out of the catalog.

`project.yml` sets `SWIFT_EMIT_LOC_STRINGS`, `LOCALIZED_STRING_SWIFTUI_SUPPORT` and
`LOCALIZATION_PREFERS_STRING_CATALOGS`, so the compiler records every key. After adding or changing
a user-visible string, refresh the catalog either by building in Xcode (it syncs the catalog) or:

```sh
cd ios
xcodebuild -exportLocalizations -project RandWallet.xcodeproj \
  -localizationPath /tmp/rw-loc -exportLanguage en -sdk iphonesimulator ARCHS=arm64
```

and merge the new keys from `/tmp/rw-loc/en.xcloc/Source Contents/RandWallet/Localizable.xcstrings`.
To hand work to a translator, export with `-exportLanguage <id>` and import the returned `.xcloc`
with `xcodebuild -importLocalizations -localizationPath <file>.xcloc`.

## Languages

The development region is `en` (`CFBundleDevelopmentRegion` in `Info.plist`,
`options.developmentLanguage` in `project.yml`). The project's `knownRegions` list is:

| Identifier | Language |
| --- | --- |
| `en` | English (source) |
| `ru` | Russian |
| `zh-Hans` | Chinese, Simplified |
| `zh-Hant-HK` | Chinese, Traditional (Hong Kong) |
| `ko` | Korean |
| `id` | Indonesian |
| `ms` | Malay |
| `ja` | Japanese |
| `ar` | Arabic (right to left) |
| `fa` | Persian (right to left) |
| `ur` | Urdu (right to left) |
| `ps` | Pashto (right to left) |
| `hi` | Hindi |
| `ta` | Tamil |
| `es` | Spanish |
| `pt-BR` | Portuguese (Brazil) |
| `de` | German |
| `fr` | French |
| `it` | Italian |
| `pl` | Polish |

xcodegen has no key for `knownRegions`, so `project.yml` runs `scripts/known-regions.sh` as its
`postGenCommand` with that list; `xcodegen generate` therefore leaves the full list in
`RandWallet.xcodeproj`. To add a language, add its identifier there and regenerate.

## Rules for translators

1. **Keep every placeholder, and keep their count.** `%@` is text, `%lld` / `%llu` a whole number,
   `%%` a literal percent sign. Where a key holds more than one, the `en` value numbers them
   (`%1$@`, `%2$@`, …): use the numbered form, and reorder freely — `%2$@ … %1$@` is fine.
2. **Keep these as they are:** `RAND`, `zUSD`, `RPL`, `Rand Wallet`, `RandProtocol`, `RandScan`,
   `randscan.org`, `durian.market`, `rand-prover`, the schemes `randpay:` and `randprover:`, the
   address prefix `rand1`, and technical names in backticks or parentheses (`hc_auth`,
   `max_proof_bytes`, `wallet.key.json`). Keys marked *Don't translate* in the catalog are brand
   names or placeholders.
3. **Amounts stay ASCII.** Digits and the decimal point inside amounts are inserted by the app
   (`%@ RAND`); do not add digit shaping, thousands separators or a different decimal mark. The
   amount placeholder `0.0` stays `0.0`.
4. **Fragments.** A few keys are pieces joined by the app; their catalog comment says so. Keys
   beginning with a space (` of %@ RAND`, ` of %lld`) keep the leading space; keys beginning with
   `%@` (`%@The %@ provers are all busy…`) receive a preceding sentence, already ending in a space,
   or nothing.
5. **Security wording.** Sentences about the spend key, the viewing key and what a prover can see
   are deliberate: translate them exactly, without softening ("cannot spend", "whole history").
6. Dates and times are formatted by the system (`.formatted()`), so they need no translation.
7. Right-to-left languages (`ar`, `fa`, `ur`, `ps`): SwiftUI mirrors the layout. Addresses, amounts and
   hashes remain left to right.

## Errors from the Rust core

The Rust core (`core/crates/wallet-core`, and the crates it vendors from the fullnode) refuses a
call with one English sentence, `{"ok":false,"error":"…"}`. `RandWallet/Core/CoreErrors.swift`
maps the sentences a user can meet to catalog keys:

- `CoreErrors.localized(_:)` first looks the sentence up in an exact table (key format, address
  parsing, payment links, amounts, coin selection, memo support, prover pairing links, the
  prover-history warning).
- Otherwise it tries regular-expression rules, in order, for sentences with a variable part
  (byte counts, amounts, digests, chain ids, a nested error's tail). The captures are
  interpolated into the localized sentence. Prefixes such as `bad address: …` and `address: …` map
  their tail recursively.
- A sentence it does not know passes through unchanged (English).

It is applied where core errors reach the screen: `RandCore.CoreError.errorDescription` (so every
`error.localizedDescription` from a core call), the `error` of a `parse_address` reply in
`WalletService`, and the prover-history warning in `ProverPairingService`. `CoreError.message`
keeps the English sentence for logs and tests.

When the core gains or rewords a user-facing error, add or update the entry in `CoreErrors.swift`
with the same English text (the key) and refresh the catalog.
