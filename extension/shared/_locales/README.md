# `_locales/` — the manifest's strings, per language

WebExtension i18n for the few strings the BROWSER shows before any page of the wallet runs: the
extension's name and description (the extension list, the store), the toolbar button's tooltip and,
on Firefox, the sidebar's title. `chrome/manifest.json` and `firefox/manifest.json` refer to them as
`__MSG_appName__` etc. and name `en` as `default_locale`, so a language without a file falls back to
English. Everything the wallet's own pages show goes through `t()` and `ui/locales/<code>.js` instead
(see `ui/i18n.js`); nothing here is read by the pages.

Each language is one directory holding one `messages.json` with exactly the keys of
`en/messages.json` (`appName`, `appShortName`, `appDescription`, `actionTitle`, `sidebarTitle`).
Only `message` is read by the browser; `description` is the note to the translator and may be
dropped from a translation. `appShortName` is at most 12 characters and `appDescription` at most
132, which the stores enforce.

## Language code → directory

The wallet's language codes (`LOCALES` in `ui/i18n.js`, and the file names under `ui/locales/`)
are not all names the browser accepts under `_locales/`: Chrome and Firefox take the locale codes
of the Chrome Web Store, with an underscore before a region. This is the mapping, and
`extension/test/locales.test.mjs` holds the directories to it.

| `ui/i18n.js` code | `_locales/` directory | language |
|---|---|---|
| `en` | `en` | English (the source; `default_locale`) |
| `ru` | `ru` | Русский |
| `zh` | `zh_CN` | 中文（简体） |
| `zh-hk` | `zh_HK` | 中文（繁體） — Hong Kong; `zh_TW` is deliberately not a separate file |
| `ko` | `ko` | 한국어 |
| `id` | `id` | Bahasa Indonesia |
| `ms` | `ms` | Bahasa Melayu |
| `ja` | `ja` | 日本語 |
| `ar` | `ar` | العربية |
| `fa` | `fa` | فارسی |
| `ur` | `ur` | اردو |
| `ps` | `ps` | پښتو |
| `hi` | `hi` | हिन्दी |
| `ta` | `ta` | தமிழ் |
| `es` | `es` | Español |
| `pt` | `pt_BR` | Português — the store has no plain `pt`; `pt_BR` is the one it lists first |
| `de` | `de` | Deutsch |
| `fr` | `fr` | Français |
| `it` | `it` | Italiano |
| `pl` | `pl` | Polski |

`chrome/pack.sh` and `firefox/pack.sh` copy `extension/shared/` whole, so a directory added here
ships with the next pack; this README is excluded from the packed tree. `extension/test/smoke.mjs`
checks the packed tree: `_locales/en/messages.json` is present and every `__MSG_…__` in the packed
manifest resolves against it.
