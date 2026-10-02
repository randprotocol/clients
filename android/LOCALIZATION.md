# Localizing Rand Wallet for Android

Every sentence the app shows lives in `app/src/main/res/values/strings.xml` (English, the
default), with lists in `res/values/arrays.xml`. A translation is a copy of those files in a
language folder; nothing else changes. Only English ships today — the language folders below are
added when their translations arrive.

## Languages and folders

Order and native names follow the shared UI (`../ui/i18n.js`, `LOCALES`).

| Language            | Folder           | Tag (locales_config / Settings) |
|---------------------|------------------|---------------------------------|
| English             | `values`         | `en`    |
| Русский             | `values-ru`      | `ru`    |
| 中文（简体）          | `values-zh-rCN`  | `zh-CN` |
| 中文（繁體）          | `values-zh-rHK`  | `zh-HK` |
| 한국어               | `values-ko`      | `ko`    |
| Bahasa Indonesia    | `values-in`      | `in` (Android's code for `id`) |
| Bahasa Melayu       | `values-ms`      | `ms`    |
| 日本語               | `values-ja`      | `ja`    |
| العربية             | `values-ar`      | `ar` (right-to-left) |
| فارسی               | `values-fa`      | `fa` (right-to-left) |
| Español             | `values-es`      | `es`    |
| Português (Brasil)  | `values-pt-rBR`  | `pt-BR` |
| Deutsch             | `values-de`      | `de`    |
| Français            | `values-fr`      | `fr`    |
| Italiano            | `values-it`      | `it`    |
| Polski              | `values-pl`      | `pl`    |

The list is kept in four places, which must agree: `res/xml/locales_config.xml` (the system's
per-app language setting, API 33+), `resourceConfigurations` in `app/build.gradle`, and the
`language_tags` / `language_names` arrays in `res/values/arrays.xml` (the Language row in
Settings: "System default" first, then each language in its own name).

The Language row calls `AppCompatDelegate.setApplicationLocales`. From API 33 the platform keeps
the choice; below it AppCompat stores it (`AppLocalesMetadataHolderService` with
`autoStoreLocales` in the manifest). The app declares `android:supportsRtl="true"` and its
layouts use `start`/`end`, so Arabic and Persian mirror.

## Translator rules

- Translate `<string>` and `<plurals>` entries only. Skip anything marked
  `translatable="false"` (symbols, the dash placeholder, language names, setting values).
- Keep every placeholder exactly: `%1$s`, `%2$s`, `%1$d`… You may move them within the sentence;
  never drop, renumber or retype one. `%%` is a literal percent sign.
- Keep the names RAND, zUSD, RPL, Rand Wallet, RandProtocol, randpay:, randprover:, rand1 and
  command lines in backticks (`rand faucet`, `rand-prover pair --own`) as they are.
- Escape apostrophes as `\'` and double quotes as `\"`; `\n` is a line break. No HTML, no
  markup: the strings are shown as plain text.
- `<plurals>`: give every quantity your language uses (`zero`, `one`, `two`, `few`, `many`,
  `other` — see the CLDR plural rules); English has only `one` and `other`.
- Amounts arrive already formatted (ASCII digits, the app's own decimal rules) as `%s`; do not
  turn them into `%d`.

## Code without a Context: `L10n`

The send and swap rules, the prover client and the contact book are unit tested on the JVM and
have no `Context`. They call `util/L10n.t(R.string.x, "English", args…)` (and `L10n.plural`).
On a device `App.onCreate` installs the app's resources in the language in force, and the
resource is shown; on the JVM the English literal is formatted instead. The literal must equal
the resource's English — `StringsParityTest` checks every one, and that every `R.string` /
`R.plurals` / `@string/` the code names exists.

## The core's errors: `ui/CoreErrors.java`

The Rust core (`../core/crates/wallet-core`, `wallet-ffi`) refuses in English and knows nothing
of the app's languages. `CoreException.getLocalizedMessage()` runs each core message through
`CoreErrors.translate`, and screens show `getLocalizedMessage()` (or `CoreErrors.of(e)`):

- exact sentences map straight to a `core_err_*` resource;
- sentences with a variable part are matched by a regular expression over the core's
  `format!`, the holes passed as `%1$s`…; a prefix the core adds to another error ("the RAND
  fee: …", "recipient: …") translates the inner sentence too;
- anything not in the table is shown unchanged, and in English the output is always the input.

When the core gains or rewords a user-facing error, add or update its line in `CoreErrors`
and its `core_err_*` string together. The core's internal invariants and RPC/protocol
diagnostics stay English by design.
