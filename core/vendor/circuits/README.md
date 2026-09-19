# Vendored circuits crates

`guests-compiled/evm-core` and `guests-compiled/sbpf-core` are copied verbatim from the
RandProtocol `circuits` repository at commit `7ef3220`; `rand-zkvm-cuda` is a hand-written stub.
They are here because the vendored node's `randprotocol-zkvm` crate depends on them by path
(`../../../circuits/guests-compiled/…`) and the workspace cannot resolve without them. They are
compiled into every binary this repository ships.

## Licence

GNU General Public License, version 3 (`GPL-3.0-only`) — see `LICENSE` in this directory. The
copyright holder of the `circuits` repository stated this licence for these crates on
2026-09-20; the `license` fields in the three `Cargo.toml` files here record it. The upstream
`circuits` repository should carry the same licence text and fields; when this directory is
replaced by a submodule, the licence will come from there and this note can go.

This is a copy, not a submodule: it does not track upstream. To refresh it, copy the two crates
again from a known `circuits` commit and update the commit named above.
