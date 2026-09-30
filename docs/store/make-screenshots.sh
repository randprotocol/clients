#!/usr/bin/env bash
# The extension and desktop store screenshots: the real interface (ui/), mounted by the dev
# harness (ui/dev.html) over its fixture wallet, photographed by a headless Chrome at 1280x800.
#
#   docs/store/make-screenshots.sh            → docs/store/screenshots/extension/*.png
#
# The balances, addresses and activity in them are the harness's fixture, not a real wallet; the
# screens are the ones every JavaScript shell ships. Phone screenshots are not made here: the iOS
# and Android apps have their own native screens and are photographed on a device or simulator.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
[ -x "$CHROME" ] || CHROME=$(command -v google-chrome || command -v chromium || true)
[ -n "$CHROME" ] || { echo "set CHROME to a Chrome or Chromium binary"; exit 1; }
[ -d ui/node_modules ] || npm ci --prefix ui     # the fixture backend imports fake-indexeddb
OUT=docs/store/screenshots/extension
PORT=${PORT:-4398}
mkdir -p "$OUT"
( cd ui && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
WALLET="state=unlocked&theme=dark&chainId=18&assets=one&activity=rich&address=long"
shot() {  # name, query, hash
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 \
    --virtual-time-budget=6000 --screenshot="$OUT/$1.png" \
    "http://127.0.0.1:$PORT/dev.html?$2$3" >/dev/null 2>&1
  echo "$OUT/$1.png"
}
shot 1-welcome  "state=new&theme=dark" ""
shot 2-home     "$WALLET&canProve=1"   "#home"
shot 3-receive  "$WALLET"              "#receive"
shot 4-send     "$WALLET&canProve=1"   "#send"
shot 5-activity "$WALLET"              "#activity"
