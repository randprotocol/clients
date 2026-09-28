# Vendored circuits crates

`guests-compiled/evm-core` and `guests-compiled/sbpf-core` are copied verbatim from the
RandProtocol `circuits` repository at commit `b9ffc39` (constraint set 7, the set the vendored
fullnode `109f47d` carries; earlier `7ef3220`); `rand-zkvm-cuda` is a hand-written stub.
They are here because the vendored node's `randprotocol-zkvm` crate depends on them by path
(`../../../circuits/guests-compiled/…`) and the workspace cannot resolve without them. They are
compiled into every binary this repository ships.

## Licence

GNU General Public License, version 3 (`GPL-3.0-only`) — see `LICENSE` in this directory. The
copyright holder of the `circuits` repository stated this licence for these crates on
2026-09-20. The stub's `Cargo.toml` records it in its `license` field; the two copied crates'
manifests are verbatim upstream, which at `b9ffc39` carries no `license` field, so this
directory's `LICENSE` is the record for them. The upstream
`circuits` repository should carry the same licence text and fields; when this directory is
replaced by a submodule, the licence will come from there and this note can go.

This is a copy, not a submodule: it does not track upstream. To refresh it, copy the two crates
again from a known `circuits` commit and update the commit named above.
