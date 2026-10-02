# Native translator brief: Android and iOS, one or more languages per agent

Work ONLY in /Users/dendisuhubdy/Github/randprotocol/clients/.claude/worktrees/i18n. Never git
commit/stash/checkout/reset/add. Write only the files named for your languages.

Terminology: the wallet's shared UI is already translated into your language in
ui/locales/<code>.js. Use THE SAME terms (wallet, note, viewing key, spend key, prover, bridge,
withdraw, swap, pool, faucet…) and register — read that file's header and grep it for a phrase before
translating the same idea. Many native strings are close or identical to a key there. Rules of
docs/i18n-translator-brief.md apply (glossary kept: RAND, zUSD, RPL, Rand, Rand Wallet, RandProtocol,
USDT, USDC, randscan, durian.market, rand1…, randpay:/randprover:, URLs, code tokens).

## Android: android/app/src/main/res/<folder>/strings.xml (+ arrays.xml)
Source: res/values/strings.xml and res/values/arrays.xml. Read android/LOCALIZATION.md.
- Every <string>, <plurals> and <string-array> that is not translatable="false", same names. Do NOT
  copy translatable="false" entries.
- Keep %1$s / %2$d placeholders exactly (order may move). Escape apostrophes as \' ; no HTML.
  Keep \n.
- <plurals>: give the quantities your language uses (Android: zero one two few many other as CLDR
  says; Russian/Polish one few many other; Arabic all six; CJK/Malay/Indonesian/Persian other only,
  plus one if a number is shown).
- Put string-arrays in <folder>/arrays.xml; integer-arrays are not copied.
- Check: `python3 scripts/i18n/native_check.py android <folder>` → 0 problems.

## iOS: ios/l10n/<ios-code>.json
Source keys: ios/RandWallet/Localizable.xcstrings and ios/RandWallet/InfoPlist.xcstrings (the key is
the English text; read "comment" fields; skip entries with "shouldTranslate" : false). Read
ios/LOCALIZATION.md. Write:
  {"Localizable": {"<key>": "<translation>", …}, "InfoPlist": {"CFBundleDisplayName": "…", …}}
- Every key. Keep %@ / %lld / %d placeholders in the same order (use positional %1$@ only if your
  language must reorder, and then number all of them). Leading/trailing spaces in a key are part of
  it: keep them.
- A key with %lld counting something may be a plural object {"one": "…", "other": "…"} instead of a
  string when your language needs it.
- CFBundleDisplayName stays "Rand Wallet" unless your script needs it; the two usage descriptions
  (camera, Face ID) are translated.
- Check: `python3 scripts/i18n/native_check.py ios <ios-code>` → 0 problems. Do NOT run ios-merge.

Folder / code table:
| ui code | Android folder | iOS code |
|---|---|---|
| ru | values-ru | ru |
| zh | values-zh-rCN | zh-Hans |
| zh-hk | values-zh-rHK | zh-Hant-HK |
| ko | values-ko | ko |
| id | values-in | id |
| ms | values-ms | ms |
| ja | values-ja | ja |
| ar | values-ar | ar |
| fa | values-fa | fa |
| ur | values-ur | ur |
| ps | values-ps | ps |
| hi | values-hi | hi |
| ta | values-ta | ta |
| es | values-es | es |
| pt | values-pt-rBR | pt-BR |
| de | values-de | de |
| fr | values-fr | fr |
| it | values-it | it |
| pl | values-pl | pl |

Report per language: Android problems 0, iOS problems 0, terms you were unsure of (≤5).
