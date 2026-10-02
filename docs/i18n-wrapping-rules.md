# Wrapping rules for t() (ui/i18n.js)

Read ui/i18n.js first, and the converted examples: ui/app.js (TABS, networkLabel, applyLocale) and
ui/screens/settings.js (THEMES, AUTO_LOCK, appearanceMarkup).

1. The English string IS the key, a string literal: `t('Send')`. Long sentences may be joined with
   `+` across lines. Never a template literal with `${}`, never a variable as the key
   (ui/scripts/extract-strings.mjs refuses them).
2. Values go in `{name}` holes: `t('{url} answered first', { url })`. One key per whole sentence;
   never glue translated fragments, never leave part of a sentence literal.
3. Plurals: two keys with the same hole named `n`: `n === 1 ? t('{n} proof', { n }) : t('{n} proofs', { n })`.
4. In `h\`…\`` templates use `${t('…')}` (h escapes it). Also aria-label, placeholder, title, alt.
   No HTML inside a key: split around inline elements.
5. Nothing is translated at module load (the language changes at runtime). Module-scope English
   constants become functions or are built at render time. Exported constants imported elsewhere:
   keep the old English export unchanged AND add a function (`export const fooText = () => t('…')`),
   use the function in your own files, and report the importers.
6. Wrap: visible text, aria-*, placeholders, titles, toasts, `detailEmpty` (may be `() => t('…')`),
   errors a user can see, textContent assignments, option/button labels, hints, captions.
7. Do not wrap: console text, data-* attributes, classes, routes, RPC method names, URLs, keys,
   symbols (RAND, zUSD, RPL), addresses, hashes, text parsed back, developer-only assertions.
8. English output must stay byte-identical. `node --test "ui/test/**/*.test.mjs"` must pass except
   the i18n.test.mjs dictionary-parity tests and the en.js-staleness test.
9. `I18N_SCREENS=<names> node --test ui/test/i18n.test.mjs` walks screens under a pseudo-language;
   fix every leak from YOUR files. A leak that is fake-backend data (not UI text) may be added to
   ALLOWED in ui/test/i18n.test.mjs with a comment; never a UI word.
10. `node ui/scripts/extract-strings.mjs --check` must not report "t() without a string literal"
    (it will say stale: fine). Do not rewrite ui/locales/en.js.
11. Keep style and comments; do not reformat untouched code. Never git commit/stash/checkout/reset/add.
12. Some of your files may already be partly converted by an earlier interrupted pass: finish them,
    do not redo or duplicate.
