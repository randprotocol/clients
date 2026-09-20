// The node-reply validators. Each test is a shape a hostile or broken node can send, and the
// assertion is that it is refused *before* it can reach arithmetic, a cursor or the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeReplyError, checkHead, checkTreeInfo, checkCommitments, checkNullifiers, checkAnchor,
  checkWitness, checkFee, checkAssets, checkBlockHeader, checkSubmitted, checkBridgeState,
  intField, hexField, unitsField, checkGenesisHash, checkBlockActions, checkTransaction,
  checkTokens, ENVELOPE_LIMITS, MAX_TOKEN_PAGE,
} from '../engine/validate.js';

const HEX64 = 'ab'.repeat(32);
const envelope = { kem_ct: 'aa', to_receiver: 'bb', to_sender: 'cc', body: 'dd' };

function rejects(fn, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof NodeReplyError, `expected a NodeReplyError, got ${err && err.name}`);
    assert.match(err.message, pattern);
    assert.ok(err.message.length < 200, `the message quotes too much of the payload: ${err.message}`);
    return true;
  });
}

test('an error names the method and what was wrong, and quotes at most 80 characters', () => {
  const huge = 'z'.repeat(5000);
  assert.throws(() => checkHead({ height: huge }), (err) => {
    assert.match(err.message, /^rand_getHead: height is not a non-negative integer/);
    // The excerpt is capped at 80 characters, so the whole message stays short enough to put in
    // a banner — and 5 000 characters of a node's choosing never reach a log.
    assert.ok(err.message.length <= 160, `${err.message.length} characters: ${err.message.slice(0, 120)}`);
    assert.ok(!err.message.includes('z'.repeat(100)));
    return true;
  });
});

test('head: a height must be a safe non-negative integer', () => {
  assert.equal(checkHead({ height: 10, hash: HEX64 }).height, 10);
  rejects(() => checkHead(null), /the reply is not an object/);
  rejects(() => checkHead({}), /height is not a non-negative integer/);
  rejects(() => checkHead({ height: '10' }), /height/);
  rejects(() => checkHead({ height: -1 }), /height/);
  rejects(() => checkHead({ height: 1.5 }), /height/);
  rejects(() => checkHead({ height: Number.NaN }), /height/);
  rejects(() => checkHead({ height: 2 ** 53 }), /height/);
});

test('tree info: next_index is an integer', () => {
  assert.equal(checkTreeInfo({ next_index: 0 }).next_index, 0);
  rejects(() => checkTreeInfo({ next_index: null }), /next_index/);
});

const from0 = { from: 0, limit: 500 };

test('commitments: every row is checked, and a page cannot exceed what was asked for', () => {
  const good = [{ index: 0, cm: HEX64, height: 3, envelope }];
  assert.equal(checkCommitments(good, from0).length, 1);
  rejects(() => checkCommitments(good, { from: 0, limit: 0 }), /more than the 0 asked for/);
  rejects(() => checkCommitments({}, from0), /not an array/);
  // A non-integer index is now caught by the "does this page answer the request" check, which
  // runs first and says something more useful than "row 0 index".
  rejects(() => checkCommitments([{ index: '0', cm: HEX64, height: 3, envelope }], from0), /starts at leaf/);
  rejects(() => checkCommitments([{ index: 0, cm: HEX64, height: 3, envelope }, { index: '1', cm: HEX64, height: 3, envelope }], from0), /row 1 index/);
  rejects(() => checkCommitments([{ index: 0, cm: 'nope', height: 3, envelope }], from0), /row 0 cm is not 64 hex/);
  rejects(() => checkCommitments([{ index: 0, cm: HEX64, height: null, envelope }], from0), /row 0 height/);
  rejects(() => checkCommitments([{ index: 0, cm: HEX64, height: 3 }], from0), /row 0 envelope/);
  rejects(() => checkCommitments([{ index: 0, cm: HEX64, height: 3, envelope: { ...envelope, body: 'zz' } }], from0), /envelope\.body/);
  rejects(() => checkCommitments([{ index: 0, cm: HEX64, height: 3, envelope: { ...envelope, body: 'a'.repeat(70000) } }], from0), /envelope\.body/);
});

test('commitments: a page must answer the request it was made for', () => {
  const leaf = (index) => ({ index, cm: HEX64, height: 3, envelope });
  // The probe that found this: a node serving leaf 900 for a request from 0 moved the cursor to
  // 901 and left leaves 0–899 never trial-decrypted — received notes silently gone.
  rejects(() => checkCommitments([leaf(900)], from0), /starts at leaf 900, not the 0/);
  rejects(() => checkCommitments([leaf(0), leaf(2)], from0), /not 1 — the page has a gap/);
  assert.equal(checkCommitments([leaf(0), leaf(1), leaf(2)], from0).length, 3);
  assert.equal(checkCommitments([], from0).length, 0, 'an empty page is a legitimate answer');
  assert.equal(checkCommitments([leaf(7), leaf(8)], { from: 7, limit: 500 }).length, 2);

  // …and never a leaf the tree says it has not grown.
  rejects(() => checkCommitments([leaf(0), leaf(1)], { from: 0, limit: 500, leafCount: 1 }), /past the 1 leaves/);
  assert.equal(checkCommitments([leaf(0), leaf(1)], { from: 0, limit: 500, leafCount: 2 }).length, 2);
  assert.throws(() => checkCommitments([], { limit: 500 }), /without the index it was asked from/);
});

const nfFrom = (from, tip) => ({ from, limit: 500, tip });

test('nullifiers: the row that used to poison the cursor', () => {
  assert.equal(checkNullifiers([{ height: 7, nullifier: HEX64 }], nfFrom(0, 100)).length, 1);
  // Exactly the shape that made `Math.max(...rows.map(r => r.height))` NaN.
  rejects(() => checkNullifiers([{ height: 7, nullifier: HEX64 }, { height: 'nine', nullifier: HEX64 }], nfFrom(0, 100)), /row 1 height/);
  rejects(() => checkNullifiers([{ height: null, nullifier: HEX64 }], nfFrom(0, 100)), /row 0 height/);
  rejects(() => checkNullifiers([{ height: 7 }], nfFrom(0, 100)), /row 0 nullifier/);
  rejects(() => checkNullifiers('rows', nfFrom(0, 100)), /not an array/);
});

test('nullifiers: a page must be the prefix the RPC promises', () => {
  const row = (height) => ({ height, nullifier: HEX64 });
  // `nullifiers_from` collects height >= from, sorts, truncates — so a reply is sorted, starts no
  // lower than `from`, and never reaches past the chain's tip.
  assert.equal(checkNullifiers([row(3), row(3), row(9)], nfFrom(3, 100)).length, 3);
  rejects(() => checkNullifiers([row(2)], nfFrom(3, 100)), /below the 3 it was asked from/);
  rejects(() => checkNullifiers([row(9), row(4)], nfFrom(3, 100)), /the page is not sorted/);
  rejects(() => checkNullifiers([row(400)], nfFrom(3, 100)), /above the tip 100/);
  assert.throws(() => checkNullifiers([], { limit: 500 }), /without the height it was asked from/);
});

test('anchor and witness', () => {
  assert.deepEqual(checkAnchor({ height: 4, root: HEX64 }), { height: 4, root: HEX64 });
  rejects(() => checkAnchor({ height: 4, root: 'short' }), /root is not 64 hex/);
  assert.equal(checkWitness(null), null);
  const path = Array.from({ length: 32 }, () => HEX64);
  assert.equal(checkWitness({ index: 1, root: HEX64, path }).path.length, 32);
  rejects(() => checkWitness({ index: 1, root: HEX64, path: path.slice(0, 31) }), /path is not 32 levels/);
  rejects(() => checkWitness({ index: 1, root: HEX64, path: [...path.slice(0, 31), 'x'] }), /path\[31\]/);
});

test('fee: a decimal units string, never a float', () => {
  assert.equal(checkFee('1000000'), '1000000');
  assert.equal(checkFee(1000000), '1000000', 'an integer reply is accepted and normalised to a string');
  rejects(() => checkFee('1.5'), /the fee is not a decimal amount/);
  rejects(() => checkFee(-1), /the fee/);
  rejects(() => checkFee('9'.repeat(31)), /the fee/);
  rejects(() => checkFee(null), /the fee/);
});

test('assets: rows with an index, and a chain, token and asset_id when present', () => {
  assert.equal(checkAssets([]).length, 0);
  assert.equal(checkAssets([{ index: 1, chain: 2, token: HEX64, asset_id: HEX64 }]).length, 1);
  rejects(() => checkAssets([{ index: 'one' }]), /row 0 index/);
  rejects(() => checkAssets([{ index: 1, asset_id: 'nope' }]), /row 0 asset_id/);
  // A row may legitimately carry neither, and an older node's reply is not refused for it.
  assert.equal(checkAssets([{ index: 1 }]).length, 1);
});

/**
 * `chain` is a **bridge chain id** — the same concept `checkBridgeState` derives its `chains` from
 * — and it is a `u16` on the chain's side (`AssetInfo.chain`, `Action::BridgeBurn.to_chain`). It
 * used to be the one field here with no bound at all, which mattered once `assets.list()` began
 * threading it through: `ui/screens/withdraw.js` offers a known origin chain as the ONLY
 * destination, so an unbounded `chain` off a node reply reached `prove_burn`'s `to_chain` without
 * ever passing the bounded `chains` list. `token` is the token's address on that chain, 32 bytes,
 * and got the same treatment `asset_id` already had.
 */
test('assets: a chain id is a u16 and a token is 32 bytes, both from the node', () => {
  rejects(() => checkAssets([{ index: 1, chain: 100000 }]), /row 0 chain/);
  rejects(() => checkAssets([{ index: 1, chain: 0x10000 }]), /row 0 chain/); // one past a u16
  rejects(() => checkAssets([{ index: 1, chain: -1 }]), /row 0 chain/);
  rejects(() => checkAssets([{ index: 1, chain: '2' }]), /row 0 chain/); // a chain id is a number
  rejects(() => checkAssets([{ index: 1, chain: 2.5 }]), /row 0 chain/);
  assert.equal(checkAssets([{ index: 1, chain: 0xffff }])[0].chain, 0xffff, 'the top of the range is fine');
  assert.equal(checkAssets([{ index: 1, chain: 0 }])[0].chain, 0);

  rejects(() => checkAssets([{ index: 1, token: 'aa' }]), /row 0 token/); // too short
  rejects(() => checkAssets([{ index: 1, token: `${HEX64}aa` }]), /row 0 token/); // too long
  rejects(() => checkAssets([{ index: 1, token: 'zz'.repeat(32) }]), /row 0 token/); // not hex
  rejects(() => checkAssets([{ index: 1, token: 2 }]), /row 0 token/);

  // And the same bound applies through `rand_getBridgeState`, which routes its registry through
  // this very function — the bounded `chains` list is not the only thing a burn's destination can
  // come from.
  rejects(
    () => checkBridgeState({ enabled: true, assets: [{ index: 1, chain: 100000 }] }),
    /row 0 chain/,
  );
});

/**
 * Chain 14's `rand_getAssets` is **one row per backing**, not one per asset: zUSD is seven rows
 * that all carry `index: 1`. Each row gained the backing coin's own `decimals` (the SOURCE chain's
 * — 18 on chain 3, not the token's 8 on Rand), and the three decimal-string amounts the mint cap
 * is counted in. All of them reach `wallet-core`'s `burn_is_possible`, which derives the release
 * unit from `decimals` and compares the burn against `locked`, so none may be believed unchecked.
 */
test('assets: chain 14 sends one row per backing, with the coin’s decimals and locked amount', () => {
  const row = {
    index: 1, chain: 2, token: HEX64, asset_id: HEX64, decimals: 6,
    locked: '900000000', mint_cap_per_day: '10000000000000', minted_today: '1000000000', mint_day: 20716,
  };
  const rows = checkAssets([row, { ...row, chain: 3, decimals: 18, token: 'cd'.repeat(32) }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decimals, 6);
  assert.equal(rows[1].decimals, 18, 'a backing’s decimals are the SOURCE coin’s, not the token’s 8');
  assert.equal(rows[0].locked, '900000000');

  rejects(() => checkAssets([{ ...row, decimals: 300 }]), /row 0 decimals/); // past a u8
  rejects(() => checkAssets([{ ...row, decimals: '6' }]), /row 0 decimals/);
  rejects(() => checkAssets([{ ...row, locked: 1.5 }]), /row 0 locked/);
  rejects(() => checkAssets([{ ...row, locked: '-1' }]), /row 0 locked/);
  rejects(() => checkAssets([{ ...row, minted_today: 'lots' }]), /row 0 minted_today/);
  rejects(() => checkAssets([{ ...row, mint_cap_per_day: 1e30 }]), /row 0 mint_cap_per_day/);
  rejects(() => checkAssets([{ ...row, mint_day: '20716' }]), /row 0 mint_day/);
  // An older node that sends none of them is still a node.
  assert.equal(checkAssets([{ index: 1, chain: 2, token: HEX64 }]).length, 1);
});

test('tokens: the RPL registry, paged, with every amount a decimal string', () => {
  const bridged = {
    index: 1, id: HEX64, id_text: `rpl1${'q'.repeat(58)}`, name: 'Shielded USD', symbol: 'zUSD',
    decimals: 8, mint_nonce: 0, total_supply: '3600000000', registered_at: 256,
    authority: {
      kind: 'bridge',
      backings: [
        { chain: 2, token: HEX64, decimals: 6, locked: '900000000', mint_cap_per_day: '1', minted_today: '0', mint_day: 20716 },
        { chain: 3, token: 'cd'.repeat(32), decimals: 18, locked: '0', mint_cap_per_day: '1', minted_today: '0', mint_day: 20716 },
      ],
    },
  };
  const reply = checkTokens({ enabled: true, registration_fee: '1000000000', next_index: 2, tokens: [bridged] });
  assert.equal(reply.enabled, true);
  assert.equal(reply.next_index, 2);
  assert.equal(reply.registration_fee, '1000000000');
  assert.equal(reply.tokens.length, 1);
  assert.equal(reply.tokens[0].symbol, 'zUSD');
  assert.equal(reply.tokens[0].decimals, 8);
  assert.equal(reply.tokens[0].backings.length, 2, 'a bridged token’s backings are lifted out of `authority`');
  assert.deepEqual(reply.tokens[0].backings[1], { chain: 3, token: 'cd'.repeat(32), locked: '0', decimals: 18 });

  // A chain with no `tokens` section answers this, and it is not an error.
  assert.deepEqual(checkTokens({ enabled: false, tokens: [] }), { enabled: false, next_index: 0, registration_fee: '0', tokens: [] });

  // A native token has an authority with no backings at all.
  const native = checkTokens({ enabled: true, tokens: [{ ...bridged, index: 2, authority: { kind: 'key', key: 'aa' } }] });
  assert.deepEqual(native.tokens[0].backings, []);

  // Index 0 is RAND and is never listed; a row claiming it is a node lying about the native token.
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, index: 0 }] }), /row 0 index/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, decimals: 10 }] }), /row 0 decimals/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, total_supply: 1.5 }] }), /row 0 total_supply/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, id: 'nope' }] }), /row 0 id/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, symbol: 42 }] }), /row 0 symbol/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, name: 'x'.repeat(500) }] }), /row 0 name/);
  rejects(() => checkTokens({ enabled: true, tokens: [{ ...bridged, id_text: 'x'.repeat(500) }] }), /row 0 id_text/);
  rejects(() => checkTokens(null), /not an object/);
  rejects(() => checkTokens({ enabled: true, tokens: 'lots' }), /not an array/);
  // A page longer than the node's own cap is not a page this wallet asked for.
  rejects(
    () => checkTokens({ enabled: true, tokens: new Array(MAX_TOKEN_PAGE + 1).fill(bridged) }),
    /more than the 1000 asked for/,
  );
});

test('block header: best-effort, never an error, never a bad timestamp', () => {
  assert.equal(checkBlockHeader(null), null);
  assert.equal(checkBlockHeader('not a block'), null);
  assert.deepEqual(checkBlockHeader({}), { transactions: [] });
  assert.equal(checkBlockHeader({ timestamp_ms: 'soon' }).timestamp_ms, undefined);
  assert.equal(checkBlockHeader({ timestamp_ms: -5 }).timestamp_ms, undefined);
  assert.equal(checkBlockHeader({ timestamp_ms: 1788000000000 }).timestamp_ms, 1788000000000);

  const header = checkBlockHeader({
    timestamp_ms: 1788000000000,
    transactions: [
      { hash: `0x${HEX64}`, bundle: { commitments: [HEX64, 'bad'] } },
      { hash: 'not-a-hash', bundle: { commitments: [HEX64] } },
      'rubbish',
    ],
  });
  assert.equal(header.transactions.length, 1, 'a transaction without a usable hash is dropped');
  assert.deepEqual(header.transactions[0].commitments, [HEX64], 'and so is a commitment that is not one');
});

test('submitted: a transaction hash, with or without 0x', () => {
  assert.equal(checkSubmitted('rand_mint', HEX64), HEX64);
  assert.equal(checkSubmitted('rand_mint', `0x${HEX64}`), `0x${HEX64}`);
  rejects(() => checkSubmitted('rand_mint', 'ok'), /rand_mint: the transaction hash/);
  rejects(() => checkSubmitted('rand_sendTransaction', null), /rand_sendTransaction/);
});

test('bridge state: `enabled` only when exactly true, and the chains are derived', () => {
  assert.deepEqual(checkBridgeState({ enabled: true, extra: 1 }), { enabled: true, chains: [], assets: [], mintPaused: false });
  assert.deepEqual(checkBridgeState({ enabled: 'yes' }), { enabled: false, chains: [], assets: [], mintPaused: false });
  rejects(() => checkBridgeState(null), /not an object/);

  // There is NO `chains` field on the wire: the node sends an `emitters` map keyed by chain id,
  // and its keys are the answer. Sorted, numeric, and only the ids a u16 `to_chain` could hold.
  const state = checkBridgeState({
    enabled: true,
    emitters: { 4: 'aa'.repeat(20), 2: 'bb'.repeat(20), '99999': 'cc'.repeat(20), notanumber: 'dd' },
    assets: [{ index: 1, chain: 2, token: 'ee'.repeat(32), asset_id: 'ff'.repeat(32) }],
  });
  assert.deepEqual(state.chains, [2, 4], 'out-of-range and non-numeric keys are not chains');
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].chain, 2, 'the registry rows come through as `rand_getAssets` gives them');

  // A `chains: [...]` that a node volunteered is ignored — it is not a field this chain has.
  assert.deepEqual(checkBridgeState({ enabled: true, chains: [7, 8] }).chains, []);
  // And a malformed registry is still refused, by the registry call's own validator.
  rejects(() => checkBridgeState({ enabled: true, assets: [{ index: 'one' }] }), /rand_getAssets/);
});

/**
 * Bridge hardening B1: while `mint_paused` is true the chain refuses every transfer attest, so a
 * deposit made now will not arrive. Burns stay open, which is why it is reported rather than
 * folded into `enabled` — a wallet can still withdraw, and should say why nothing is coming in.
 */
test('bridge state: mint_paused is carried, and only when the node says exactly true', () => {
  assert.equal(checkBridgeState({ enabled: true }).mintPaused, false);
  assert.equal(checkBridgeState({ enabled: true, mint_paused: true }).mintPaused, true);
  assert.equal(checkBridgeState({ enabled: true, mint_paused: 'yes' }).mintPaused, false);
  assert.equal(checkBridgeState({ enabled: true, mint_paused: 1 }).mintPaused, false);
});

test('the primitives are usable on their own', () => {
  assert.equal(intField('m', 'x', 3), 3);
  assert.equal(hexField('m', 'x', HEX64, 64), HEX64);
  assert.equal(unitsField('m', 'x', '0'), '0');
  rejects(() => intField('m', 'x', 5, { max: 4 }), /m: x is not a non-negative integer/);
});

// ------------------------------------------------------------------------- fix round 2 --------
test('an envelope is bounded by what the chain actually produces', () => {
  // `randprotocol-core`'s MAX_ENVELOPE_BYTES is 2048 for all four parts, and its own fixture is
  // ML-KEM-768's 1088-byte ciphertext plus 60 + 60 + 140. The old bound (65 536 chars per field)
  // let one 500-row page claim ~128 MB, which a wallet would buffer before checking any of it.
  const real = { kem_ct: 'ab'.repeat(1088), to_receiver: 'cd'.repeat(60), to_sender: 'ef'.repeat(60), body: '01'.repeat(140) };
  const row = (env) => [{ index: 0, cm: HEX64, height: 1, envelope: env }];
  assert.equal(checkCommitments(row(real), from0).length, 1, 'a real envelope must still pass');

  assert.ok(ENVELOPE_LIMITS.kem_ct < 5000);
  assert.ok(ENVELOPE_LIMITS.total <= 2 * 2 * 2048);
  rejects(() => checkCommitments(row({ ...real, kem_ct: 'a'.repeat(ENVELOPE_LIMITS.kem_ct + 2) }), from0), /envelope\.kem_ct/);
  rejects(() => checkCommitments(row({ ...real, body: 'a'.repeat(ENVELOPE_LIMITS.body + 2) }), from0), /envelope\.body/);

  // …and a page of individually-legal rows that adds up to too much is refused as a page.
  const fat = Array.from({ length: 500 }, (_, i) => ({
    index: i, cm: HEX64, height: 1,
    envelope: { kem_ct: 'a'.repeat(ENVELOPE_LIMITS.kem_ct), to_receiver: 'b'.repeat(ENVELOPE_LIMITS.to_receiver), to_sender: 'c'.repeat(ENVELOPE_LIMITS.to_sender), body: 'd'.repeat(ENVELOPE_LIMITS.body) },
  }));
  const perRow = ENVELOPE_LIMITS.kem_ct + ENVELOPE_LIMITS.to_receiver + ENVELOPE_LIMITS.to_sender + ENVELOPE_LIMITS.body;
  if (perRow > ENVELOPE_LIMITS.total) {
    rejects(() => checkCommitments(fat, from0), /envelope is \d+ characters/);
  } else {
    assert.ok(perRow * 500 < 8_000_000, 'the whole-page bound should still be reachable in principle');
  }
});

test('genesis hash: hex of a plausible length, normalised', () => {
  assert.equal(checkGenesisHash('AB'.repeat(32)), 'ab'.repeat(32));
  assert.equal(checkGenesisHash(`0x${'ab'.repeat(32)}`), 'ab'.repeat(32));
  rejects(() => checkGenesisHash(null), /not a string/);
  rejects(() => checkGenesisHash('nope'), /not hex of a plausible length/);
  rejects(() => checkGenesisHash('ab'.repeat(200)), /plausible length/);
});

test('block actions: plain, bounded objects, and nothing else', () => {
  assert.deepEqual(checkBlockActions(null), []);
  assert.deepEqual(checkBlockActions({ transactions: [] }), []);
  assert.deepEqual(checkBlockActions({ transactions: ['x', {}, { action: 7 }, { action: {} }] }), [],
    'anything without a string `kind` is dropped');

  const out = checkBlockActions({ transactions: [{ action: { kind: 'bridge_attest', amount: 5 } }] });
  assert.deepEqual(out, [{ kind: 'bridge_attest', amount: 5 }]);
  assert.equal(Object.getPrototypeOf(out[0]), Object.prototype, 'the core must get a plain object');

  rejects(
    () => checkBlockActions({ transactions: [{ action: { kind: 'bridge_attest', blob: 'x'.repeat(20000) } }] }),
    /an action is \d+ characters/,
  );
  rejects(() => checkBlockActions({ transactions: new Array(5000).fill({ action: { kind: 'a' } }) }), /transactions/);
});

test('a transaction record yields only a validated height', () => {
  assert.equal(checkTransaction(null), null);
  assert.deepEqual(checkTransaction({ height: 7, tx: { anything: true } }), { height: 7 });
  rejects(() => checkTransaction({ height: '7' }), /height/);
  rejects(() => checkTransaction({}), /height/);
});
