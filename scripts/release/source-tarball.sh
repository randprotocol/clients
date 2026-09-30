#!/usr/bin/env bash
# The whole source of a release as one archive: this repository at HEAD and the fullnode submodule
# at the commit it is pinned to. GitHub's own "Source code" archives leave the submodule out, and
# nothing builds without it.
#
#   scripts/release/source-tarball.sh out.tar.gz
#
# Everything unpacks under rand-wallet-<version>-source/. Only committed files go in (git archive),
# so an uncommitted change is not in the tarball — build it from a clean checkout of the tag.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?usage: source-tarball.sh out.tar.gz}
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
VER=$(node -p "require('./chrome/manifest.json').version")
PREFIX="rand-wallet-$VER-source"
SUB=core/vendor/fullnode
[ -e "$SUB/.git" ] || { echo "run: git submodule update --init"; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar --prefix="$PREFIX/" HEAD | tar -x -C "$TMP"
git -C "$SUB" archive --format=tar --prefix="$PREFIX/$SUB/" HEAD | tar -x -C "$TMP"
# A tarball is not a checkout: record what it was cut from.
{
  echo "clients  $(git rev-parse HEAD)  $(git describe --tags --always)"
  echo "fullnode $(git -C "$SUB" rev-parse HEAD)  $(git -C "$SUB" describe --tags --always)"
} > "$TMP/$PREFIX/SOURCE_COMMITS"
# COPYFILE_DISABLE: no ._ AppleDouble entries when this runs on a Mac.
COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$TMP" "$PREFIX"
ls -la "$OUT"
