#!/usr/bin/env bash
# Write SHA256SUMS for a GitHub release over every file attached to it, and attach that too.
#
#   scripts/release/checksums.sh v0.6.7                     re-sum what the release has
#   scripts/release/checksums.sh v0.6.7 a.apk b.aab         attach these first, then sum everything
#
# The sums are taken over the files as GitHub serves them back (they are downloaded again, not
# read from the local disk), so SHA256SUMS describes exactly what a user's download will be. The
# release's files are left in dist/release/<tag>/ afterwards: that directory is then the whole
# release, including the zips that go to the extension stores.
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG=${1:?usage: checksums.sh <tag> [files to attach first…]}
shift
REPO=${RELEASE_REPO:-randprotocol/clients}
DIR="dist/release/$TAG"
[ $# -eq 0 ] || gh release upload "$TAG" "$@" --repo "$REPO" --clobber
mkdir -p "$DIR"
gh release download "$TAG" --repo "$REPO" --dir "$DIR" --clobber
# Only the release's own files: the directory may hold local builds that were never attached.
gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' \
  | grep -v '^SHA256SUMS$' | LC_ALL=C sort > "$DIR/.assets"
( cd "$DIR" && rm -f SHA256SUMS && tr '\n' '\0' < .assets | xargs -0 shasum -a 256 > SHA256SUMS && rm -f .assets )
gh release upload "$TAG" "$DIR/SHA256SUMS" --repo "$REPO" --clobber
cat "$DIR/SHA256SUMS"
