# randprotocol.org/clients

The wallets pages on randprotocol.org live in the site's own repository, `../randprotocol.org`
(Astro + Tailwind v4), not here:

| page | source in randprotocol.org |
|---|---|
| https://randprotocol.org/clients | `src/pages/clients.astro` |
| https://randprotocol.org/clients/ios, `/android`, `/chrome`, `/firefox`, `/windows`, `/macos`, `/linux`, `/web` | `src/pages/clients/[slug].astro` |
| every fact both of them show: requirements, store links, how each client sends, where it keeps the key, build steps, testnet notes | `src/data/clients.ts` |

So when a client changes in this repository — a new minimum OS or browser, a new vendored
fullnode, a store listing going live — change `src/data/clients.ts` there to match, then build
and deploy the site per its `DEPLOY.md` (`npm run build`, then an rsync of `dist/` to the
droplet). A copy of the page used to be kept here as `web/clients.astro`; the site's version had
moved ahead of it, so it was removed on 2026-09-29 and the site is the only copy.

Store links: each client's `link` in `src/data/clients.ts` is `null` until its listing is live;
set the URL and the card and the client's page switch from "listing pending" to a button.

The icon is the one thing still made here: `design/make-icons.py` writes
`web/public/clients/icon-256.png` (and `design/out/icon-256.png`); copy it to the site's
`public/clients/icon-256.png` and bump the `?v=` on its `<img>` tags.

`web/wallet/` is unrelated to the site: it is the local web wallet, served from a checkout
(see `web/wallet/README.md`).
