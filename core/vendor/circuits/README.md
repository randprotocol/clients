# Vendored circuits crates

`guests-compiled/evm-core` and `guests-compiled/sbpf-core` are copied verbatim from the
RandProtocol `circuits` repository at commit `aeacf31` (`feat/v067-circuits`: constraint set 8 plus
the CUDA-kernel, rVM-allocator and ALU-test fixes, the commit the vendored fullnode `v0.6.7`
(`86941a1`) is built with; earlier `18c2627`, `b9ffc39` — constraint set 7 — and `7ef3220`);
`rand-zkvm-cuda` is a hand-written stub. Neither constraint set 8 nor `aeacf31`'s fixes touched
these two interpreter crates (the zkVM itself the fullnode vendors, `crates/randprotocol-zkvm`):
every one of the seventeen files here is byte-identical at `b9ffc39`, `18c2627` and `aeacf31`,
checked by comparing each against `git show aeacf31:guests-compiled/…` on 2026-09-30, and
`aeacf31` has no file under either crate's `src/` that this copy lacks.
The copy before `b9ffc39` was not byte-identical to the commit it named (rustfmt had reformatted
it and two `license` lines had been added by hand); the `b9ffc39` copy is verbatim.
They are here because the vendored node's `randprotocol-zkvm` crate depends on them by path
(`../../../circuits/guests-compiled/…`) and the workspace cannot resolve without them. They are
compiled into every binary this repository ships.

## Licence

GNU General Public License, version 3 (`GPL-3.0-only`) — see `LICENSE` in this directory. The
copyright holder of the `circuits` repository stated this licence for these crates on
2026-09-20. The stub's `Cargo.toml` records it in its `license` field; the two copied crates'
manifests are verbatim upstream, which at `aeacf31` carries no `license` field, so this
directory's `LICENSE` is the record for them. The upstream
`circuits` repository should carry the same licence text and fields; when this directory is
replaced by a submodule, the licence will come from there and this note can go.

This is a copy, not a submodule: it does not track upstream. To refresh it, copy the two crates
again from a known `circuits` commit and update the commit named above.
