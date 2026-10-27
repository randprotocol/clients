#!/usr/bin/env bash
# The pinned RandProtocol prover pool, held to its pins before anything is packaged. A wrong or
# dropped member still builds — the core just reports a smaller pool — so a release runs these
# first and stops on any mismatch:
#
#   1. wallet-core's pool tests: every member's link parses to its own pinned URL and key, no two
#      members share a key, none is dropped, and `version` reports the pool (core/crates/wallet-core).
#   2. the BUILT wasm core (extension/shared/core, from core/scripts/build-wasm.sh): the pool it
#      reports, each link parsed through it to the member's pinned key and URL
#      (web/wallet/test/core.integration.test.mjs, with RAND_REQUIRE_CORE=1 so a missing core fails
#      instead of skipping).
#
#   scripts/release/check-pool.sh            both (build the wasm core first)
#   scripts/release/check-pool.sh --core     only 1 (no wasm core needed)
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== wallet-core: the pinned pool =="
( cd core && cargo test --locked -p wallet-core --lib -- pool_member member_whose_link )

[ "${1:-}" = "--core" ] && exit 0

echo "== the built wasm core: the pool it ships =="
RAND_REQUIRE_CORE=1 node --test web/wallet/test/core.integration.test.mjs
