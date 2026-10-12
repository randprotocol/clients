#!/usr/bin/env bash
# Move core/vendor/fullnode (the submodule) to a fullnode commit, and everything that names it.
#
#   core/scripts/vendor-fullnode.sh <rev> [<source>]
#
# <rev>     a fullnode commit (any form `git rev-parse` takes in the source).
# <source>  where to fetch it from: a local fullnode clone (read only — nothing is checked out
#           there) or a URL. Default: the submodule's own `origin` (.gitmodules). A local clone is
#           the way to vendor a commit not pushed yet.
#
# What it does, in order:
#   1. Populates the submodule if it is empty (a clone from <source>, absorbed into this
#      checkout's .git/modules, `origin` set back to .gitmodules' URL), otherwise fetches <rev>
#      from <source> into it; then checks <rev> out detached.
#   2. Checks the vendored tree still carries what the wallet's builds rely on: the zkvm crate
#      gates `dilithium-core` and `dilithium_host` off wasm32 (its `asm!` does not build there),
#      the [patch]ed Plonky3 forks core/Cargo.toml names exist, and `randprotocol-msig` comes
#      with its tests/fixtures/*.json (listed with their SHA-256s, to compare with the fullnode).
#   3. Rewrites CHAIN_BUILD (wallet-core) and the three tests that pin it (wallet-core's
#      `version_reports_chain_fourteen`, the web core integration test, the iOS smoke test) from
#      the old short hash to the new one.
#   4. Refreshes core/Cargo.lock and desktop/src-tauri/Cargo.lock (`cargo metadata`: new or
#      changed path crates only, nothing upgraded).
#
# What it leaves to you (it prints the list): the prose that describes the build (CHAIN_BUILD's doc
# comment in wallet-core, README.md's submodule sentence), the test runs, and the commit.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
REV=${1:?usage: core/scripts/vendor-fullnode.sh <rev> [<source>]}
SUB=core/vendor/fullnode
URL=$(git config -f .gitmodules submodule.$SUB.url)
SRC=${2:-$URL}

# ── 1. the submodule at <rev> ────────────────────────────────────────────────────────────────────
if [ ! -e "$SUB/.git" ]; then
  rmdir "$SUB" 2>/dev/null || { echo "$SUB is not empty and not a checkout" >&2; exit 1; }
  git clone -q --no-checkout "$SRC" "$SUB"
  git -C "$SUB" remote set-url origin "$URL"
  git submodule absorbgitdirs "$SUB"
fi
if ! git -C "$SUB" cat-file -e "$REV^{commit}" 2>/dev/null; then
  git -C "$SUB" fetch -q "$SRC" "$REV" || git -C "$SUB" fetch -q "$SRC"
fi
FULL=$(git -C "$SUB" rev-parse --verify "$REV^{commit}")
git -C "$SUB" checkout -q --detach "$FULL"
NEW=${FULL:0:7}
echo "vendor-fullnode: $SUB at $FULL ($(git -C "$SUB" log -1 --format=%s "$FULL" | cut -c1-100))"

# ── 2. what the wallet's builds rely on ─────────────────────────────────────────────────────────
fail() { echo "vendor-fullnode: $*" >&2; exit 1; }
ZK=$SUB/crates/randprotocol-zkvm
if grep -q dilithium-core "$ZK/Cargo.toml"; then
  python3 - "$ZK/Cargo.toml" <<'EOF' || fail "randprotocol-zkvm's dilithium-core is not under cfg(not(target_arch = \"wasm32\")): the wasm build breaks"
import re, sys
s = open(sys.argv[1]).read()
sect = None
for line in s.splitlines():
    m = re.match(r'\s*\[(.*)\]\s*$', line)
    if m: sect = m.group(1)
    elif re.match(r'\s*dilithium-core\s*=', line):
        sys.exit(0 if sect and 'not(target_arch = "wasm32")' in sect else 1)
sys.exit(1)
EOF
  grep -B1 -E '^pub mod dilithium_host;' "$ZK/src/lib.rs" | grep -q 'cfg(not(target_arch = "wasm32"))' \
    || fail "randprotocol-zkvm's lib.rs does not gate dilithium_host off wasm32"
  echo "vendor-fullnode: zkvm's dilithium-core / dilithium_host gated off wasm32 — ok"
fi
for p in $(sed -n 's/^p3-[a-z-]* = { path = "\(vendor\/fullnode\/vendor\/[^"]*\)".*/\1/p' core/Cargo.toml); do
  [ -f "core/$p/Cargo.toml" ] || fail "core/Cargo.toml patches core/$p, which this commit does not carry"
done
MSIG=$SUB/crates/randprotocol-msig
if [ -d "$MSIG" ]; then
  ls "$MSIG"/tests/fixtures/*.json >/dev/null 2>&1 || fail "randprotocol-msig has no tests/fixtures/*.json"
  echo "vendor-fullnode: randprotocol-msig fixtures ($(ls "$MSIG"/tests/fixtures/*.json | wc -l | tr -d ' ')):"
  ( cd "$MSIG/tests/fixtures" && shasum -a 256 *.json | sed 's/^/  /' )
else
  echo "vendor-fullnode: WARNING — this commit has no crates/randprotocol-msig, which wallet-core depends on" >&2
fi

# ── 3. CHAIN_BUILD and the tests that pin it ────────────────────────────────────────────────────
LIB=core/crates/wallet-core/src/lib.rs
OLD=$(sed -n 's/^pub const CHAIN_BUILD: &str = "\([0-9a-f]*\)";/\1/p' "$LIB")
[ -n "$OLD" ] || fail "no CHAIN_BUILD in $LIB"
if [ "$OLD" != "$NEW" ]; then
  python3 - "$OLD" "$NEW" "$LIB" web/wallet/test/core.integration.test.mjs ios/RandWalletTests/CoreSmokeTests.swift <<'EOF'
import sys
old, new, lib, web, ios = sys.argv[1:]
edits = {
    lib: [(f'pub const CHAIN_BUILD: &str = "{old}";', f'pub const CHAIN_BUILD: &str = "{new}";'),
          (f'assert_eq!(v["chain_build"], "{old}");', f'assert_eq!(v["chain_build"], "{new}");')],
    web: [(f"assert.equal(k.chain_build, '{old}');", f"assert.equal(k.chain_build, '{new}');")],
    ios: [(f'XCTAssertEqual(c.chainBuild, "{old}"', f'XCTAssertEqual(c.chainBuild, "{new}"')],
}
for path, pairs in edits.items():
    s = open(path).read()
    for a, b in pairs:
        if a not in s:
            sys.exit(f"vendor-fullnode: {path} does not contain {a!r}")
        s = s.replace(a, b)
    open(path, "w").write(s)
EOF
  echo "vendor-fullnode: CHAIN_BUILD $OLD → $NEW (wallet-core, its version test, the web and iOS tests)"
fi

# ── 4. lockfiles ────────────────────────────────────────────────────────────────────────────────
( cd core && cargo metadata --format-version 1 >/dev/null )
( cd desktop/src-tauri && cargo metadata --format-version 1 >/dev/null )

cat <<EOF

vendor-fullnode: done. Still yours:
  - CHAIN_BUILD's doc comment ($LIB) and README.md's submodule sentence: what $NEW adds.
  - cd core && cargo test --release                       (wallet-core, wallet-ffi, wallet-wasm)
  - cd core/vendor/fullnode && cargo test --release --locked -p randprotocol-msig --target-dir ../../target/vendored-msig
    (the vendored signer checks and their fixtures; not a member of the core workspace — a
    non-member with dev-dependencies cannot be tested from it — so it runs in its own workspace)
  - core/scripts/build-wasm.sh                            (the wasm32 build)
  - scripts/e2e-prover.sh                                 (real node + prover; see its header)
  - git add $SUB core/Cargo.lock desktop/src-tauri/Cargo.lock ... && git commit
EOF
