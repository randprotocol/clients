# Retired RandProtocol prover keys

| key | what it was | pinned by | retired |
|---|---|---|---|
| `RGTF-7HKJ-XZFV-GQ1J` | the key every pool machine shared | Rand Wallet 0.6.8 | 2026-10-01 |
| `ZEXQ-1JHV-ZT60-KFB5` | member a | Rand Wallet 0.6.9–0.8.0 | 2026-10-22 |
| `D2XV-WXVT-PZRC-D7G8` | member archive2 | Rand Wallet 0.6.9–0.8.0 | 2026-10-22 |
| `SR28-MYT0-GR6A-03DE` | member nyc3 | Rand Wallet 0.6.9–0.8.0 | 2026-10-22 |
| `GMNX-Q1QD-FEXG-JHJM` | member sfo3 | Rand Wallet 0.6.9–0.8.0 | 2026-10-22 |

## What a released wallet can and cannot do

A wallet's pinned provers are compiled into it. **A wallet released before a key was retired
keeps pinning that key, and nothing a server sends or a later release does can change it.** Rand
Wallet 0.6.9–0.8.0 therefore still trusts the four member keys above at
`https://prover.randprotocol.org/m/<name>`: if someone held one of those keys *and* could answer
at that address, such a wallet would seal its viewing key to them (never its spend key — a prover
is not sent it). In practice those versions find no prover today: the pool's members answer with
other keys, the wallet reports that the provers "cannot be reached", and it does not show the
pool's own "retired, update" answer. The remedy is to update.

What each version does:

| version | pins | when its pins are stale |
|---|---|---|
| 0.6.8 | the shared key | finds no prover |
| 0.6.9–0.8.0 | the four retired members | "cannot be reached right now … try again later" |
| 0.8.1 | a, b | — |
| 0.8.2 and later | a, b | "Update Rand Wallet to the latest version" when a pinned member answers with another key |
| 0.8.7, 0.8.8 | a, b, **and the retired list — except on Android and iOS** (below) | refuses a retired key wherever it comes from: a link, a stored pairing, or a pinned member |
| the release after 0.8.8 | a, b, **and the retired list, in every wallet** | the same, on Android and iOS too |

## Which wallet carries the list

| wallet | carries the list from | where it lives |
|---|---|---|
| `rand` (command line) | see the fullnode repository | fullnode `crates/randprotocol-client/src/retired-provers.txt` |
| browser extension (Chrome, Firefox), web wallet, desktop app | 0.8.7 | `RETIRED_PROVER_KEYS` in `ui/engine/backend-shared.js` (the one engine all four run) |
| Android | the release after 0.8.8 | `RetiredProverKeys.java` (`android/app/src/main/java/org/randprotocol/wallet/wallet/`) |
| iOS | the release after 0.8.8 | `RetiredProverKeys` in `ios/RandWallet/Services/ProverPairingService.swift` |

The Android and iOS apps do not run the shared engine: each has its own twin of the prover code,
and until the release after 0.8.8 that twin had no list. **Android and iOS 0.8.1–0.8.8 therefore
pin the current provers (a, b) but still accept a retired key from a `randprover:` link or from a
pairing stored earlier**: if someone held a retired key and could answer at the address the link
names, those apps would pair with it and seal the wallet's viewing key to it (never the spend
key). The pinned pool was never affected on those versions: a and b are not retired keys. From the
release after 0.8.8 the two apps refuse at the engine's points and in its words:

| point | what happens with a retired key | Android | iOS |
|---|---|---|---|
| pairing a link | refused before the prover is asked; nothing is stored | `ProverPairing.pair` | `ProverPairingService.pair` |
| a pairing stored before the key was retired | the status line in Settings reads "Not answering: This prover's key was retired…", and the prover is not asked | `ProverPairing.probe` | `ProverPairingService.probe` |
| a send, swap or other proof through that stored pairing | refused with the sentence, before the prover is asked or anything is built; the fingerprint read is the vault / Keychain record's, never the display copy's | `RemoteSend.route`, `RemoteSend.prove` | `ProverPairingService.route`, `checkJob` |
| a pinned pool member | left out of the pool and never asked; the other members keep working | `ProverPairing.builtInPool`, `RemoteSend.provePool` | `ProverPairingService.builtInPool`, `provePool` |

As in the other wallets, a refused stored pairing is **not deleted**: it stays in Settings, shown
as not answering, until the user forgets it or pairs another prover, and a device that can make
the proof itself keeps doing so (it never used the pairing).

The retired list is how a retirement reaches every wallet released after it. It is kept in three
places in this repository — the engine, `RetiredProverKeys.java` and the Swift `RetiredProverKeys`
— because neither app loads the engine. When a pool key is retired: add its fingerprint to all
three (one line each, in the shape the file already uses) and to `rand`'s list (fullnode
`crates/randprotocol-client/src/retired-provers.txt`) in the same change that edits
`trusted-prover-pool.json`. `ui/test/prover.test.mjs` fails if a pinned member is on the list;
`ui/test/native-retired-keys.test.mjs` fails if the Android or the iOS list is not the engine's,
entry for entry, if the refusal's sentence differs in any language, or if one of the points above
stops checking the list. The apps' own suites (`RetiredProverKeysTest` on the JVM, `ProverTests`
under XCTest) exercise the points themselves.

## The notice (for the release page, the site and the stores)

The text to publish, its short forms for the stores, and when it may go out are drafted in
[`releases/notice-retired-prover-keys.md`](releases/notice-retired-prover-keys.md). It is a draft:
nothing has been published.

## The release-notes lines (for the next wallet release)

- **Retired prover keys are refused.** The wallet carries the list of RandProtocol prover keys
  that were retired (the shared key of 0.6.8 and the four members of 0.6.9–0.8.0) and never pairs
  with one, never sends one a job, and skips a pinned member whose key is on it. A prover you
  paired yourself is unaffected unless its key is on that list. If you still run 0.8.0 or earlier,
  update: those versions cannot be told about a retired key.
- **Android and iOS refuse retired prover keys too** (VK-9). The two apps now carry the same list
  as the extension, web and desktop wallets and refuse a retired key at the same points, in the
  same words: a `randprover:` link that names one is not paired, a pairing stored before its key
  was retired is sent nothing (Settings shows it as not answering; forget it or pair another), and
  a pinned member whose key is listed is skipped. Android and iOS 0.8.1–0.8.8 pin the current
  provers but would still have accepted a retired key from a link or a stored pairing: update.
  No new permission; nothing else changes.
