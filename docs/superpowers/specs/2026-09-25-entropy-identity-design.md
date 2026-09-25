# Rand Wallet: the entropy identity — design

Date: 2026-09-25. Status: direction chosen by the owner in session ("Entropy / shielded"), scope
"include mobile palettes". Supersedes the look of `2026-09-19-wallet-ui-redesign-design.md` §3.3
(the aurora gradient); layout, screens and behaviour there are unchanged.

## 1. Why

The 2026-09-19 UI works but reads as the stock wallet template: an indigo→violet gradient card,
a logo that is an empty rounded square, all-caps eyebrows over every section, and every block in
the same rounded card. Nothing on screen says *Rand*: a network named for randomness whose
amounts are hidden by proofs.

## 2. The idea

**The wallet's face is its own entropy.** The balance sits on a dither field — ordered-dither
pixels over value noise — seeded from the wallet's own address, so every wallet has a different
field (a fingerprint, the way an identicon is) and the same wallet always has the same one. It is
the one bold element; everything around it is quiet.

- The field is always ink with bone grain, in both themes: a sealed object on the page.
- A handful of grain pixels burn in the signal colour. Nothing else on the hero is coloured.
- The balance can be **veiled**: the figure is replaced by dither blocks of the same width until
  the user reveals it. Per-device preference, remembered in `localStorage` (a UI convenience, not
  a wallet setting, so no backend changes).
- One orchestrated moment: when the field first paints it resolves from noise into the pattern
  (~600 ms). Off under `prefers-reduced-motion`.

## 3. Tokens

| role | dark | light |
|---|---|---|
| bg (ink / paper) | `#0E1220` | `#F2F3F7` |
| surface | `#161C2C` | `#FFFFFF` |
| text (bone / ink) | `#ECE9E2` | `#121521` |
| accent — *signal* | `#FF5C9D` (ink text on it) | `#C8185F` (white text on it) |
| positive / negative / warning | `#3DDC97` `#FF7A59` `#F5C451` | `#0B7A51` `#C2410C` `#8F6200` |
| field (both themes) | ink `#0E1220`, grain `#ECE9E2`, hot = accent | same |

Every text colour is ≥ 4.5:1 on bg and surface (`ui/test/tokens.test.mjs`). The `gradient`
token is removed; the primary action is solid signal.

Type: **Departure Mono** (Helena Zhang, OFL) for the wordmark and the balance figure only — a
pixel face on an 11 px grid, set at multiples of 11 so it stays crisp, and the typographic twin of
the dither field. **Inter** stays for all UI text; **JetBrains Mono** stays for addresses, hashes
and keys (literal data, never labels).

## 4. Structure

- Brand: a 3×3 dither glyph + lowercase `rand` wordmark. Appears once per layout (sidebar on
  wide, topbar on compact) — never both.
- Section headings in sentence case, no tracking, no eyebrow labels.
- Lists sit flat on the page with hairlines; cards only where a group needs a boundary (review
  sheets, settings groups).
- Actions: Send is the single signal-filled pill; Receive / Faucet / Bridge are quiet buttons.
- Programmatically focused headings (`tabindex="-1"`, focused for screen-reader announcement) no
  longer draw the keyboard ring.

## 5. Mobile

iOS `Theme.swift` and Android `colors.xml` take the new palette; the aurora gradient becomes the
flat ink field colour with the signal accent. No mobile layout work and no dither renderer on
mobile in this pass.
