#!/usr/bin/env bash
# Fails if our tree still says shrugg anywhere, in any case.
#
# The fullnode renamed itself (SHRUGG/SESH → RAND) at upstream `ed96c39`: the crates are
# `randprotocol-core`/`-zkvm`/`-client`/`-node`, the binaries are `rand-node` and `rand`, the RPC
# namespace is `rand_`, addresses are `rand1…`. Nothing on the wire is called shrugg any more, so
# this guard has no allow-list: every hit is an offender.
#
# Inline opt-out: a line containing the marker `rename-guard: allow` (e.g. in a trailing comment)
# is skipped, for the rare line that legitimately mentions the old name on purpose — doc prose
# contrasting it with the new one, or a test asserting the old name is now absent — rather than
# leaving it behind by mistake. The HARDFAIL set below always wins over the marker: our own former
# identifiers (`shrugg_wallet` as the library name, `ShruggCore`) may never come back under any
# excuse.
#
# Portability: the whole grep stream is filtered by one `perl` invocation rather than a
# `sed`/`grep` pipeline inside a per-line bash loop, because BSD (macOS) and GNU (Linux CI)
# sed/grep disagree on regex dialect — an earlier draft used a BSD-only bracket-expression word
# boundary that GNU rejects outright. Perl's regex engine is identical everywhere it ships, which
# is every mainstream macOS and Linux install.
#
# Two kinds of thing are deliberately out of scope for the scan:
#   * non-source trees — the vendored fullnode and circuits checkouts (upstream's own history
#     still names the old chain in its docs and retired genesis files), build output, package
#     caches, and `.superpowers/` task briefs;
#   * this script, which cannot grep for a word without containing it, and the four design
#     records that describe the rename itself and must keep quoting the old names to stay
#     readable: `docs/superpowers/{specs,plans}/2026-09-1[39]-*.md`.
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v perl >/dev/null 2>&1 || {
  echo "check-rename.sh needs perl (for portable BSD/GNU-identical regex matching); none found on PATH" >&2
  exit 2
}

RAW=$(grep -rIniE 'shrugg' . \
  --exclude-dir=.git --exclude-dir=vendor --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules \
  --exclude-dir=DerivedData --exclude-dir=Frameworks --exclude-dir=jniLibs \
  --exclude-dir=.superpowers \
  --exclude=check-rename.sh \
  2>/dev/null \
  | grep -v '^\./extension/shared/core/' \
  | grep -Ev '^\./docs/superpowers/(specs|plans)/2026-09-1[39]-[^:]*\.md:' || true)

# HARDFAIL (case-insensitive) always wins, even over the rename-guard marker. Otherwise the
# marker skips the line. Otherwise any shrugg at all, in any case, is an offender.
offenders=()
while IFS= read -r line; do
  offenders+=("$line")
done < <(printf '%s\n' "$RAW" | perl -ne '
  BEGIN {
    $HARDFAIL = qr{shrugg_wallet|ShruggCore}i;
    $MARKER   = qr{rename-guard: allow};
  }
  chomp;
  next if $_ eq "";
  if (/$HARDFAIL/) { print "$_\n"; next; }
  next if /$MARKER/;
  print "$_\n" if /shrugg/i;
')

if [ "${#offenders[@]}" -gt 0 ]; then
  printf '%s\n' "${offenders[@]}"
  echo "rename incomplete (${#offenders[@]} hits)"
  exit 1
fi

echo "rename clean"
