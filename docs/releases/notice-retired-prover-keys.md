# DRAFT — notice: update Rand Wallet if you run 0.8.0 or earlier

**Status: draft. Not published anywhere.** Audit row VK-9 asks for this notice to be published;
this file is the text, ready to paste. It is not a release's notes (`vX.Y.Z.md` in this folder are;
the release workflow reads only those). Background, the list of keys and what each version does:
[`../retired-prover-keys.md`](../retired-prover-keys.md).

## When to publish

With the wallet release after 0.8.8, the first in which **every** wallet — Android and iOS
included — refuses the retired keys. The notice's last sentence about "the current Rand Wallet"
is true of the extension, web and desktop wallets since 0.8.7, and of the Android and iOS apps only
from that release. If it has to go out earlier, use the "before the mobile release" wording below.

Where: the GitHub release page of that release (above "Download"), the download page of
randprotocol.org, and the "What's new" field of the Chrome Web Store, Firefox Add-ons, Google Play
and App Store listings (the short form).

## The notice

> **Update Rand Wallet if you run 0.8.0 or earlier.** Rand Wallet 0.6.9 to 0.8.0 pin four
> RandProtocol prover keys that were retired on 22 October 2026. Those versions can no longer use
> the RandProtocol provers — a send that needs them says the provers cannot be reached — and they
> still trust the retired keys. Update to the current Rand Wallet: it pins the current provers,
> tells you itself when its pins go out of date, and refuses the retired keys. Your funds are not
> at risk: a prover is only ever sent a viewing key, never the key that spends.

The version you run is shown in the wallet's Settings (and, for the extension, on the browser's
extensions page). Updating replaces the app, not the wallet in it; keep a backup of your spend key (the
wallet's key file) to hand, as before any update.

### Short form (store "What's new")

> Update if you run Rand Wallet 0.8.0 or earlier: those versions pin RandProtocol prover keys
> retired on 22 October 2026, can no longer use the RandProtocol provers, and still trust the old
> keys. This version pins the current provers and refuses the retired keys. Funds are not at risk:
> a prover never receives the key that spends.

### Before the mobile release (only if published before the release after 0.8.8)

Replace the notice's fourth sentence with:

> Update to the current Rand Wallet: it pins the current provers and tells you itself when its
> pins go out of date; the extension, web and desktop wallets also refuse the retired keys, and
> the Android and iOS apps will from their next release.

## What the notice does not say, and why

- It does not name the retired fingerprints: a user has nothing to do with them. They are listed
  in `../retired-prover-keys.md`.
- It makes no statement about whether a retired key was ever misused: this draft was written from
  the code and `../retired-prover-keys.md`, not from the operators' records. The risk it describes
  is the standing one — a wallet that cannot be told about a retirement keeps trusting the key.
  Whoever publishes should add a sentence if the operators know more.
- Wallet 0.6.8 (the one shared key) is covered by "0.8.0 or earlier"; it finds no prover at all.
