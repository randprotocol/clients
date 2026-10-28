# Chrome Web Store listing — Rand Wallet

The listing text, the permission justifications, the privacy answers and the notes for the
reviewer are all in [`docs/store/README.md`](../docs/store/README.md), §3, with the other
stores': one document, so that what the four listings say about the wallet cannot drift apart.

The file to upload is `rand-wallet-chrome-<version>.zip`, built by `chrome/pack.sh` and
attached to every [release](https://github.com/randprotocol/clients/releases/latest).

## Version 0.8.3

A bundle proof made in the wallet is about 40% faster (its core vendors fullnode `97bcf4b`, the
v0.8.3 batch), and a send that loses its connection after the node read it is no longer repeated on
another node. The permissions, the hosts and the content scripts are the same as in 0.8.2.

## Version 0.8.2

`window.rand` gains `withdraw`, a bridge burn that randbridge.org asks for and the wallet shows in its
own approval window; the wallet proves and sends it on the user's approval. The site learns the hash
of the transaction it asked for and the phase names while it works, and nothing else. The permissions,
the hosts and the content scripts are the same as in 0.8.1.
