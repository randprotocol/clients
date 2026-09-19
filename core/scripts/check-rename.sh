#!/usr/bin/env bash
# Fails if our tree still says shrugg anywhere except the wire names the node owns.
#
# Case matters here by design: the node's wire vocabulary (RPC method names like
# `shrugg_getCommitments`, the `shrugg1` address prefix, the vendored crate/binary names
# `shrugg-core`/`shrugg-zkvm`/`shrugg-client`/`shrugg-node`, and the `shrugg` CLI itself) is always
# lowercase and is never renamed. The token symbol and our own identifiers (`ShruggCore`,
# `SHRUGG` as a currency ticker, `shrugg_wallet` as our library name) are not wire names and must
# become RAND/Rand/rand_wallet.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Wire names the node owns: never renamed. Matched case-sensitively (lowercase only) so an
# uppercase/mixed-case leftover like SHRUGG or ShruggCore is never mistaken for one of these.
ALLOW='shrugg_[a-zA-Z]+'                 # shrugg_getCommitments, shrugg_core, shrugg_client, ...
ALLOW="$ALLOW"'|shrugg1'                 # the shrugg1... address prefix, incl. examples/test vectors
ALLOW="$ALLOW"'|shrugg-(core|zkvm|client|node)'  # vendored crate names / fullnode binaries
ALLOW="$ALLOW"'|UNITS_PER_SHRUGG'        # the vendor crate's own constant name
ALLOW="$ALLOW"'|"shrugg"'                # the bare wire literal, e.g. RPC_NAMESPACE == "shrugg"
ALLOW="$ALLOW"'|[[:<:]]shrugg[[:>:]]'    # the standalone `shrugg` CLI/binary name in prose

# CONTROLLER RULING: matching shrugg_[a-zA-Z]+ against a whole line (as the brief's sketch did)
# would let a stale "shrugg_wallet" (or "ShruggCore") slip through a line that also contains other
# text, which is exactly the bug this guard exists to catch. So every candidate line is checked
# against this hard-fail set FIRST and unconditionally, before any ALLOW stripping.
HARDFAIL='shrugg_wallet|ShruggCore'

# core/crates/ is out of scope here: it is task 0.1's own directory (already renamed and
# reviewed there), and this task is explicitly told not to touch it. It legitimately retains
# `shrugg`/`SHRUGG` in a couple of spots that are not stale leftovers — e.g. a doc comment
# contrasting what "upstream" (the vendored fullnode crate) calls the token with what our code
# calls it, and test assertions that check the *absence* of the old name/JSON key by matching it
# as a literal string. A path-prefix filter (not a directory exclusion) is used so other `core/`
# content (scripts/, README.md, Cargo.toml) is still checked.
RAW=$(grep -rIniE 'shrugg' . \
  --exclude-dir=.git --exclude-dir=vendor --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules \
  --exclude-dir=DerivedData --exclude-dir=Frameworks --exclude-dir=jniLibs \
  --exclude-dir=.superpowers \
  --exclude=check-rename.sh --exclude=Cargo.lock --exclude='2026-09-1[39]-*.md' \
  2>/dev/null | grep -v '^\./extension/shared/core/' | grep -v '^\./core/crates/' || true)

offenders=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if echo "$line" | grep -qiE "$HARDFAIL"; then
    offenders+=("$line")
    continue
  fi
  # Strip every allowed (wire-name) token, case-sensitively; if "shrugg" in any case still
  # appears afterwards, this line is a real offender (e.g. an un-renamed "SHRUGG" ticker).
  stripped=$(echo "$line" | sed -E "s/($ALLOW)//g")
  if echo "$stripped" | grep -qiE 'shrugg'; then
    offenders+=("$line")
  fi
done <<< "$RAW"

if [ "${#offenders[@]}" -gt 0 ]; then
  printf '%s\n' "${offenders[@]}"
  echo "rename incomplete (${#offenders[@]} hits)"
  exit 1
fi

echo "rename clean"
