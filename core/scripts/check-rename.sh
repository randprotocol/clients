#!/usr/bin/env bash
# Fails if our tree still says shrugg anywhere except the wire names the node owns.
#
# Case matters here by design: the node's wire vocabulary (RPC method names like
# `shrugg_getCommitments`, the `shrugg1` address prefix, the vendored crate/binary names
# `shrugg-core`/`shrugg-zkvm`/`shrugg-client`/`shrugg-node`, and the `shrugg` CLI itself) is always
# lowercase and is never renamed. The token symbol and our own identifiers (`ShruggCore`,
# `SHRUGG` as a currency ticker, `shrugg_wallet` as our library name) are not wire names and must
# become RAND/Rand/rand_wallet.
#
# Inline opt-out: a line containing the marker `rename-guard: allow` (e.g. in a trailing comment)
# is skipped, for the rare line that legitimately mentions the old name on purpose (doc prose
# contrasting it with the new one, or a test asserting the old name/key is now absent) rather than
# leaving it behind by mistake. The HARDFAIL set below always wins over the marker.
#
# Portability: the allow-list stripping runs through one `perl` invocation over the whole grep
# stream, not a `sed`/`grep` pipeline inside a per-line bash loop. Word-boundary matching for the
# bare `shrugg` CLI name needs backslash-b-style lookaround, and BSD sed/grep (macOS) and GNU
# sed/grep (Linux CI) disagree on how to spell that: the old draft of this script used a
# BSD-only bracket-expression word-boundary extension that GNU's sed/grep reject outright, and
# GNU's own word-boundary escapes aren't recognised by BSD's. Perl's regex engine is the same
# everywhere it ships, which is every mainstream macOS and Linux install, so it is used instead
# of trying to keep two sed dialects in sync (see the `(?<!...)`/`(?!...)` lookaround below).
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v perl >/dev/null 2>&1 || {
  echo "check-rename.sh needs perl (for portable BSD/GNU-identical word-boundary matching); none found on PATH" >&2
  exit 2
}

RAW=$(grep -rIniE 'shrugg' . \
  --exclude-dir=.git --exclude-dir=vendor --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules \
  --exclude-dir=DerivedData --exclude-dir=Frameworks --exclude-dir=jniLibs \
  --exclude-dir=.superpowers \
  --exclude=check-rename.sh --exclude=Cargo.lock --exclude='2026-09-1[39]-*.md' \
  2>/dev/null | grep -v '^\./extension/shared/core/' || true)

# For each line: HARDFAIL (case-insensitive) always wins, even over the rename-guard marker.
# Otherwise the marker skips the line. Otherwise strip every allowed (wire-name) token
# case-sensitively; if "shrugg" in any case still remains, the line is a real offender (e.g. an
# un-renamed "SHRUGG" ticker, or a bare `shrugg` immediately glued to other identifier characters
# that isn't one of the recognised wire-name shapes).
offenders=()
while IFS= read -r line; do
  offenders+=("$line")
done < <(printf '%s\n' "$RAW" | perl -ne '
  BEGIN {
    $HARDFAIL = qr{shrugg_wallet|ShruggCore}i;
    $MARKER   = qr{rename-guard: allow};
    $ALLOW = qr{
        shrugg_[a-zA-Z]+                          # shrugg_getCommitments, shrugg_core, shrugg_client, etc
      | shrugg1                                    # the shrugg1 address prefix, incl. examples, test vectors
      | shrugg-(?:core|zkvm|client|node)            # vendored crate names and fullnode binaries
      | UNITS_PER_SHRUGG                            # the vendor crate own constant name
      | "shrugg"                                    # the bare wire literal, e.g. RPC_NAMESPACE == "shrugg"
      | (?<![A-Za-z0-9_-])shrugg(?![A-Za-z0-9_-])   # standalone shrugg CLI name in prose: a whole word,
                                                     # not glued to a letter, digit, underscore or hyphen
                                                     # on either side (so shrugg wallet, backtick shrugg
                                                     # backtick, shrugg send pass; shrugg-node and
                                                     # shrugg_wallet do not, those are handled above and
                                                     # by HARDFAIL respectively)
    }x;
  }
  chomp;
  next if $_ eq "";
  if (/$HARDFAIL/) { print "$_\n"; next; }
  next if /$MARKER/;
  (my $stripped = $_) =~ s/$ALLOW//g;
  print "$_\n" if $stripped =~ /shrugg/i;
')

if [ "${#offenders[@]}" -gt 0 ]; then
  printf '%s\n' "${offenders[@]}"
  echo "rename incomplete (${#offenders[@]} hits)"
  exit 1
fi

echo "rename clean"
