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
| the release after 0.8.6 | a, b, **and the retired list** | refuses a retired key wherever it comes from: a link, a stored pairing, or a pinned member |

The retired list (`RETIRED_PROVER_KEYS` in `ui/engine/backend-shared.js`) is how a retirement
reaches every wallet released after it. When a pool key is retired: add its fingerprint there and
to `rand`'s list (fullnode `crates/randprotocol-client/src/retired-provers.txt`) in the same
change that edits `trusted-prover-pool.json`; `ui/test/prover.test.mjs` fails if a pinned member
is on the list.

## The notice (for the release page, the site and the stores)

> **Update Rand Wallet if you run 0.8.0 or earlier.** Rand Wallet 0.6.9 to 0.8.0 pin four
> RandProtocol prover keys that were retired on 22 October 2026. Those versions can no longer use
> the RandProtocol provers — a send that needs them says the provers cannot be reached — and they
> still trust the retired keys. Update to the current Rand Wallet: it pins the current provers,
> tells you itself when its pins go out of date, and refuses the retired keys. Your funds are not
> at risk: a prover is only ever sent a viewing key, never the key that spends.

## The release-notes line (for the next wallet release)

- **Retired prover keys are refused.** The wallet carries the list of RandProtocol prover keys
  that were retired (the shared key of 0.6.8 and the four members of 0.6.9–0.8.0) and never pairs
  with one, never sends one a job, and skips a pinned member whose key is on it. A prover you
  paired yourself is unaffected unless its key is on that list. If you still run 0.8.0 or earlier,
  update: those versions cannot be told about a retired key.
