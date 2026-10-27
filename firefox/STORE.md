# addons.mozilla.org listing — Rand Wallet

The listing text, the permission justifications, the privacy answers and the notes for the
reviewer are all in [`docs/store/README.md`](../docs/store/README.md), §4, with the other
stores': one document, so that what the four listings say about the wallet cannot drift apart.

The file to upload is `rand-wallet-firefox-<version>.zip`, built by `firefox/pack.sh` and
attached to every [release](https://github.com/randprotocol/clients/releases/latest).

## Version 0.8.2

`window.rand` gains `withdraw`, a bridge burn that randbridge.org asks for and the wallet shows in its
own approval window; the wallet proves and sends it on the user's approval. The site learns the hash
of the transaction it asked for and the phase names while it works, and nothing else. The permissions,
the hosts and the content scripts are the same as in 0.8.1.
