#!/bin/sh
# Rewrites knownRegions in RandWallet.xcodeproj to the languages the wallet ships (ios/LOCALIZATION.md).
# xcodegen derives knownRegions only from .lproj folders and catalog entries already translated,
# so project.yml runs this as its postGenCommand with the full list:
#   scripts/known-regions.sh en ru zh-Hans ...
set -eu
cd "$(dirname "$0")/.."
pbx=RandWallet.xcodeproj/project.pbxproj
python3 - "$pbx" "$@" <<'PY'
import re, sys
path, regions = sys.argv[1], ["Base"] + sys.argv[2:]
def q(r):
    return r if re.fullmatch(r"[A-Za-z0-9_]+", r) else '"%s"' % r
body = "knownRegions = (\n" + "".join("\t\t\t\t%s,\n" % q(r) for r in regions) + "\t\t\t);"
src = open(path).read()
out, n = re.subn(r"knownRegions = \([^)]*\);", lambda _: body, src)
if n != 1:
    sys.exit("known-regions: expected one knownRegions list in %s, found %d" % (path, n))
open(path, "w").write(out)
PY
