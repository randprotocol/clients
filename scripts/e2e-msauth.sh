#!/usr/bin/env bash
# Private-multisig signing end to end (spec 2026-10-11-msauth-signing-design.md §6.5): a 2-of-3
# account on a one-validator Test-profile devnet (chain 21's shape: split authorisation + the
# multisig auth guest), the CLI prepares, signer 0 signs in the web wallet's engine
# (ui/engine/signers.js over the real wasm core), signer 2 in iOS through MsauthSigning and RandCore
# on the simulator (FakeSignerSecrets: a simulator has no passcode), the CLI proves (msauth tier 18
# + bundle, on this machine) and submits, and the payee's scan finds the payout.
#
#   RAND_NODE_BIN=core/target/e2e/release/rand-node RAND_BIN=core/target/e2e/release/rand scripts/e2e-msauth.sh
#
# Both binaries from the fullnode this repo vendors (core/vendor/fullnode):
#   (cd core/vendor/fullnode && CARGO_TARGET_DIR=$PWD/../../target/e2e cargo build --release \
#      -p randprotocol-node -p randprotocol-client)   # then restore its Cargo.lock (see e2e-prover.sh)
# and the cores: core/scripts/build-wasm.sh, core/scripts/build-ios.sh.
#
# The prove is guarded: it does not start beside another prove or a process over 4 GB, and it is
# killed if its memory passes MSAUTH_E2E_MAX_MEM_GB (default 40) — the tier-18 msauth prove is "at
# least 48 GB" at Production; this chain runs the Test FRI profile. On macOS the gauge is the
# physical footprint (`footprint`), not RSS: the compressor keeps RSS low while the footprint grows
# (2026-10-12 on a 48 GB Mac: RSS 22.5 GB, footprint 76 GB, killed by the OS). Every process
# started here is killed on exit. MSAUTH_E2E_SKIP_IOS=1 has signer 2 sign with the CLI instead of
# the simulator.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
: "${RAND_NODE_BIN:?set RAND_NODE_BIN}" "${RAND_BIN:?set RAND_BIN}"
DIR=${MSAUTH_E2E_DIR:-$(mktemp -d)}
mkdir -p "$DIR"
PORT=${MSAUTH_E2E_PORT:-18545}
RPC="http://127.0.0.1:$PORT"
AMOUNT=10
MAX_KB=$(( ${MSAUTH_E2E_MAX_MEM_GB:-40} * 1024 * 1024 ))
SIM=${MSAUTH_E2E_SIMULATOR:-iPhone 18 Pro}   # a simulator on the newest installed iOS runtime
export RAND_MSAUTH_VK="$ROOT/core/vendor/fullnode/crates/randprotocol-zkvm/keys/msauth-vk-test.bin"
export RAND_ALLOW_TEST_FRI_PROFILE=1
R() { "$RAND_BIN" --rpc "$RPC" "$@"; }
rpc() { curl -sf -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC"; }
step() { printf '\n== %s (%s)\n' "$*" "$(date +%H:%M:%S)"; }
echo "workdir $DIR"
echo "rand-node $("$RAND_NODE_BIN" --version) at $RAND_NODE_BIN"
echo "rand      $("$RAND_BIN" --version) at $RAND_BIN"

free_gib=$(df -g "$DIR" | awk 'NR==2 {print $4}')
[ "$free_gib" -ge 25 ] || { echo "only $free_gib GiB free (need 25)"; exit 1; }

NODE_PID='' PROVE_PID=''
cleanup() {
  [ -n "$PROVE_PID" ] && { pkill -P "$PROVE_PID" 2>/dev/null || true; kill "$PROVE_PID" 2>/dev/null || true; }
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  [ -n "$NODE_PID" ] && wait "$NODE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step "devnet: chain 21 shape, Test FRI profile"
"$RAND_NODE_BIN" keygen --out "$DIR/node.key.json" >/dev/null
for i in 0 1 2; do "$RAND_NODE_BIN" keygen --out "$DIR/signer$i.key.json" >/dev/null; done
# The validator's payout wallet and the payee are two wallets: rewards never reach the payee.
R --key "$DIR/v.key.json" keygen >/dev/null
R --key "$DIR/p.key.json" keygen >/dev/null
addr() { R --key "$1" address 2>/dev/null | grep -Eo '^rand1[1-9A-HJ-NP-Za-km-z]+' | head -1; }
V=$(addr "$DIR/v.key.json")
P=$(addr "$DIR/p.key.json")
"$RAND_NODE_BIN" genesis --chain-id 21 --fri-profile test --faucet --validator "$DIR/node.key.json,1000,$V" \
  --gas-price 100 --byte-price 800 --bundle-gas-limit 20479 --bundle-guest v3 --auth-guest --auth-multisig-guest \
  --max-proof-bytes 4194304 --max-block-bytes 20971520 --binding-domain 1 --proof-window-blocks 1024 --out "$DIR/genesis.json"
"$RAND_NODE_BIN" init --datadir "$DIR/data" --genesis "$DIR/genesis.json"
"$RAND_NODE_BIN" run --datadir "$DIR/data" --key "$DIR/node.key.json" --validator --rpc "127.0.0.1:$PORT" \
  --listen /ip4/127.0.0.1/tcp/0 --no-mdns --block-interval-ms 3000 --view-timeout-ms 6000 --min-free-disk-mb 0 > "$DIR/node.log" 2>&1 &
NODE_PID=$!
for _ in $(seq 120); do rpc rand_status | grep -q '"msauth_key":"loaded"' && break; sleep 1; done
rpc rand_status | grep -q '"msauth_key":"loaded"' || { echo "the node did not load the msauth key"; tail -40 "$DIR/node.log"; exit 1; }

step "policy: 2 of 3; fund the account"
pk() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$1"; }
R multisig-private new-policy --signer "$(pk "$DIR/signer0.key.json")" --signer "$(pk "$DIR/signer1.key.json")" \
  --signer "$(pk "$DIR/signer2.key.json")" --threshold 2 --out "$DIR/policy.json"
ACCT=$(R multisig-private address --policy "$DIR/policy.json" | sed -n 's/^address: //p')
R faucet "$ACCT" --amount 100
R multisig-private balance --policy "$DIR/policy.json"

step "prepare: pay the payee $AMOUNT RAND"
R multisig-private prepare --policy "$DIR/policy.json" --to "$P" --amount "$AMOUNT" --out "$DIR/proposal.json"
# What the payee told each signer out of band, and what each signer enters: the address and amount.
echo "$P:$AMOUNT" > "$DIR/payee.txt"
R multisig-private check --proposal "$DIR/proposal.json" --policy "$DIR/policy.json" --expect-to "$P:$AMOUNT"

step "signer 0: the web wallet's engine"
MSAUTH_E2E_DIR="$DIR" MSAUTH_E2E_RPC="$RPC" MSAUTH_E2E_SIGNER=0 node --test web/wallet/test/msauth.devnet.e2e.test.mjs 2>&1 | tee "$DIR/web.log"
grep -q '^0:' "$DIR/share0.txt" || { echo "the web wallet wrote no share"; exit 1; }

if [ "${MSAUTH_E2E_SKIP_IOS:-0}" = 1 ]; then
  step "signer 2: the CLI (MSAUTH_E2E_SKIP_IOS=1)"
  R multisig-private sign --proposal "$DIR/proposal.json" --policy "$DIR/policy.json" --key "$DIR/signer2.key.json" \
    --expect-to "$P:$AMOUNT" > "$DIR/share2.txt"
else
  step "signer 2: iOS on the simulator ($SIM)"
  ( cd ios && TEST_RUNNER_RAND_MSAUTH_PROPOSAL="$(cat "$DIR/proposal.json")" TEST_RUNNER_RAND_MSAUTH_POLICY="$(cat "$DIR/policy.json")" \
    TEST_RUNNER_RAND_MSAUTH_KEY="$(cat "$DIR/signer2.key.json")" TEST_RUNNER_RAND_MSAUTH_RPC="$RPC" \
    TEST_RUNNER_RAND_MSAUTH_PAYEE="$P:$AMOUNT" TEST_RUNNER_RAND_MSAUTH_CHAIN_ID=21 \
    xcodebuild -project RandWallet.xcodeproj -scheme RandWallet -destination "platform=iOS Simulator,name=$SIM" \
    -derivedDataPath "$DIR/ios-dd" test -only-testing:RandWalletTests/LiveMsauthTests ) > "$DIR/ios.log" 2>&1 || { tail -40 "$DIR/ios.log"; exit 1; }
  grep -E 'Test (Case|Suite).*(passed|failed|skipped)|Executed' "$DIR/ios.log" | tail -4
  if grep -q 'LiveMsauthTests.*skipped' "$DIR/ios.log"; then echo "the iOS test was skipped"; exit 1; fi
  sed -n 's/.*MSAUTH-SHARE //p' "$DIR/ios.log" | head -1 > "$DIR/share2.txt"
  # The simulator's memory back before the prove.
  xcrun simctl shutdown all 2>/dev/null || true
fi
grep -q '^2:' "$DIR/share2.txt" || { echo "signer 2 produced no share"; exit 1; }

step "prove: msauth tier 18 + bundle, on this machine"
busy=$(ps -Ao rss=,pid=,command= | awk '$1 > 4194304 || ($3 ~ /(^|\/)(rand|rand-node|rand-prover)$/ && $0 ~ / prove/)' || true)
[ -z "$busy" ] || { echo "not proving beside:"; echo "$busy"; exit 1; }
/usr/bin/time -l "$RAND_BIN" --rpc "$RPC" --cpu multisig-private prove --proposal "$DIR/proposal.json" --policy "$DIR/policy.json" \
  --signature "$(tr -d '\n' < "$DIR/share0.txt")" --signature "$(tr -d '\n' < "$DIR/share2.txt")" --out "$DIR/proposal.tx" \
  > "$DIR/prove.out" 2> "$DIR/prove.err" &
PROVE_PID=$!
# KiB: the physical footprint (compressed pages included) where `footprint` exists, else RSS.
mem_kb() {
  local fp
  if command -v footprint >/dev/null; then
    fp=$(footprint -p "$1" 2>/dev/null | sed -n 's/.*Footprint: \([0-9.]*\) \([KMG]\)B.*/\1 \2/p' | head -1)
    [ -n "$fp" ] && { echo "$fp" | awk '{ m = ($2 == "G") ? 1048576 : ($2 == "M") ? 1024 : 1; printf "%d\n", $1 * m }'; return; }
  fi
  ps -o rss= -p "$1" 2>/dev/null | tr -d ' '
}
started=$(date +%s); peak=0; killed=0
while kill -0 "$PROVE_PID" 2>/dev/null; do
  child=$(pgrep -P "$PROVE_PID" | head -1 || true)
  if [ -n "$child" ]; then
    mem=$(mem_kb "$child")
    if [ -n "$mem" ]; then
      [ "$mem" -gt "$peak" ] && peak=$mem
      if [ "$mem" -gt "$MAX_KB" ]; then kill -9 "$child" 2>/dev/null || true; killed=1; fi
    fi
  fi
  sleep 2
done
set +e; wait "$PROVE_PID"; prove_rc=$?; set -e
PROVE_PID=''
echo "prove: $(( $(date +%s) - started )) s wall, sampled peak footprint $(( peak / 1024 )) MiB, exit $prove_rc"
grep -E 'real|maximum resident set size|peak memory footprint' "$DIR/prove.err" || true
cat "$DIR/prove.out"
[ "$killed" = 0 ] || { echo "the prove passed $(( MAX_KB / 1024 / 1024 )) GB and was killed"; exit 1; }
[ "$prove_rc" = 0 ] || { tail -20 "$DIR/prove.err"; exit 1; }

step "submit; the payee scans"
R multisig-private submit --tx "$DIR/proposal.tx"
R --key "$DIR/p.key.json" balance | tee "$DIR/p.balance"
grep -Eq "^balance: $AMOUNT(\.0+)? RAND" "$DIR/p.balance" || { echo "the payee does not hold $AMOUNT RAND"; exit 1; }
R multisig-private balance --policy "$DIR/policy.json"
echo "msauth e2e: OK"
