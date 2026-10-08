#!/usr/bin/env bash
# `core-stale.sh <built file>` — exit 0 (and name a reason) when the core built into that file
# must be built again: it is missing, or a core source is newer than it. Exit 1 when it is fresh.
# The build scripts used to build a core only when it was MISSING, so a checkout that had built
# one kept it for good: on 2026-10-08 the locally packed extension still ran a core from 2026-09-30,
# without the built-in prover pool (wallet 0.6.9), and every send said "This device cannot prove
# the transfer" with no prover to fall back on.
set -euo pipefail
BUILT=$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1") || { echo "$1 is missing"; exit 0; }
cd "$(dirname "$0")/.."
[ -e "$BUILT" ] || { echo "$1 is missing"; exit 0; }
newer=$(find crates vendor Cargo.toml Cargo.lock rust-toolchain.toml .cargo -type f -newer "$BUILT" \
  -not -path '*/target/*' -not -name '*.md' -print -quit 2>/dev/null || true)
[ -n "$newer" ] && { echo "$1 is older than core/$newer"; exit 0; }
exit 1
