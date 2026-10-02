# The wallet's languages

One file per language, `<code>.js`, each a dictionary from the English string to its
translation. `en.js` is generated from the `t()` call sites by `node ui/scripts/extract-strings.mjs`
and is the complete list; `ui/test/i18n.test.mjs` holds every other file to exactly its keys.

| code | language | `<html lang>` | direction |
|---|---|---|---|
| en | English | en | ltr |
| ru | Русский | ru | ltr |
| zh | 中文（简体）, Mandarin, Simplified | zh-Hans | ltr |
| zh-hk | 中文（繁體）, Cantonese as written in Hong Kong, Traditional | zh-Hant-HK | ltr |
| ko | 한국어 | ko | ltr |
| id | Bahasa Indonesia | id | ltr |
| ms | Bahasa Melayu | ms | ltr |
| ja | 日本語 | ja | ltr |
| ar | العربية | ar | rtl |
| fa | فارسی | fa | rtl |
| ur | اردو | ur | rtl |
| ps | پښتو | ps | rtl |
| hi | हिन्दी | hi | ltr |
| ta | தமிழ் | ta | ltr |
| es | Español (neutral, Latin American where it matters) | es | ltr |
| pt | Português (Brazilian where it matters) | pt | ltr |
| de | Deutsch | de | ltr |
| fr | Français | fr | ltr |
| it | Italiano | it | ltr |
| pl | Polski | pl | ltr |

The list, in this order, is `LOCALES` in `ui/i18n.js`; the picker in Settings shows each
language under its own name.

## Writing a dictionary

```js
export default {
  "Send": "Отправить",
  "{n} min ago": { one: "{n} минуту назад", few: "{n} минуты назад", many: "{n} минут назад", other: "{n} минуты назад" },
  …
};
```

- Every key of `en.js`, no more and no fewer, each translated. An empty string falls back to
  English and fails the test.
- `{name}` holes are filled at run time: keep each one, spelled exactly, and move it to where
  the language puts it. Never translate the word inside the braces.
- A key with an `{n}` (or `{count}`) hole may be an object of CLDR plural categories instead of
  a string, when the language inflects by number. Give every category the language has
  (`Intl.PluralRules` says which: Russian and Polish `one few many other`, Arabic six, Japanese
  and Chinese `other` only, English `one other`). The test checks them.
- Keep these words as they are, in Latin letters: RAND, zUSD, RPL, Rand, Rand Wallet, USDT,
  USDC, STARK, randscan, the chain names (Solana, Tron, Ethereum, Binance Smart Chain), `rand1…`
  addresses, URLs, and the command `rand send`.
- Amounts are not in the dictionary: the wallet writes them with ASCII digits in every language.
- No HTML in a value. The markup is outside the key; the value is plain text.
- Register: the wallet speaks plainly, in full sentences, without exclamation marks and without
  marketing. Buttons are short imperatives. Errors say what happened and what to do.
- Script: Simplified characters for `zh`, Traditional (Hong Kong usage and vocabulary) for
  `zh-hk`; Arabic and Persian in their own scripts; Urdu (Nastaliq-style Urdu alphabet) and
  Pashto in their own Arabic-derived scripts; Hindi in Devanagari; Tamil in Tamil script; Japanese with the usual katakana for loan
  words; Korean without honorific overreach.
