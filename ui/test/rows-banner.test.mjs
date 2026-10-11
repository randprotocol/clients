import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, hasMemo, activityRowMarkup, assetRowMarkup, listMarkup } from '../lib/rows.js';
import { chainLabel, partlyIdentified, canRescan, wrongChainBannerMarkup, behindBannerMarkup, identityUnknownBannerMarkup } from '../lib/chain-banner.js';

test('kindOf: in, out and faucet carry a sign and their own tint', () => {
  assert.deepEqual(kindOf({ kind: 'in' }), { kind: 'in', icon: 'arrowDownLeft', title: 'Received', sign: '+', tint: 'in' });
  assert.deepEqual(kindOf({ kind: 'out' }), { kind: 'out', icon: 'arrowUpRight', title: 'Sent', sign: '−', tint: 'out' });
  assert.deepEqual(kindOf({ kind: 'faucet' }), { kind: 'faucet', icon: 'droplet', title: 'Faucet', sign: '+', tint: 'faucet' });
});

test('kindOf: a pending item is titled by its known status, else "Pending"; no sign', () => {
  assert.equal(kindOf({ kind: 'pending', status: 'Proving' }).title, 'Proving');
  assert.equal(kindOf({ kind: 'pending', status: 'confirming' }).title, 'Confirming');
  assert.equal(kindOf({ kind: 'pending', status: 'weird' }).title, 'Pending');
  assert.equal(kindOf({ kind: 'pending' }).title, 'Pending');
  assert.equal(kindOf({ kind: 'pending' }).sign, '');
  assert.equal(kindOf({ kind: 'pending' }).tint, 'pending');
});

test('kindOf: a kind this build does not know shows the node\'s word, neutrally', () => {
  assert.deepEqual(kindOf({ kind: 'bridge' }), { kind: 'bridge', icon: 'activity', title: 'bridge', sign: '', tint: '' });
  assert.equal(kindOf({}).title, 'Transaction');
  assert.equal(kindOf(null).title, 'Transaction');
});

test('hasMemo is true only for a non-empty string memo', () => {
  assert.equal(hasMemo({ memo: 'hi' }), true);
  assert.equal(hasMemo({ memo: '' }), false);
  assert.equal(hasMemo({ memo: 5 }), false);
  assert.equal(hasMemo({}), false);
  assert.equal(hasMemo(null), false);
});

const ASSETS = new Map([[0, { index: 0, symbol: 'RAND', name: 'RAND', decimals: 9 }]]);

test('activity row: a hash makes a button to #tx/…, no hash makes a plain div', () => {
  const withHash = activityRowMarkup({ kind: 'in', asset: 0, amount: '1500000000', time: 0, hash: '0xabc' }, ASSETS);
  assert.match(withHash, /<button class="row" type="button" data-go="tx\/0xabc">/);
  assert.match(withHash, /\+1\.5 RAND/);
  assert.match(withHash, /class="amount in"/);
  const without = activityRowMarkup({ kind: 'out', asset: 0, amount: '1000000000', time: 0 }, ASSETS);
  assert.doesNotMatch(without, /<button/);
  assert.match(without, /<div class="row">/);
  assert.match(without, /−1 RAND/);
  assert.doesNotMatch(without, /class="amount in"/);
});

test('activity row: node-controlled text is escaped; a memo only gets an empty slot', () => {
  const html = activityRowMarkup({ kind: 'in', asset: 7, amount: '1', time: 0, address: '<script>x</script>', memo: '<img onerror=1>' }, ASSETS);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /data-role="row-memo"><\/span>/);
  assert.match(html, /RPL#7/, 'an unknown asset falls back to RPL#index');
});

test('asset row: pending balance and RPL chip appear only where they apply', () => {
  const rand = assetRowMarkup({ index: 0, symbol: 'RAND', name: 'RAND', balance: '2500000000', decimals: 9 });
  assert.match(rand, /data-go="asset\/0"/);
  assert.match(rand, /2\.5/);
  assert.match(rand, /Native token/);
  assert.doesNotMatch(rand, /RPL<\/span>|pending/);
  const tok = assetRowMarkup({ index: 3, symbol: 'wETH', name: 'Wrapped Ether', balance: '5', pending: '1000000', decimals: 6 });
  assert.match(tok, /<span class="chip xs">RPL<\/span>/);
  assert.match(tok, /\+1 pending/);
  assert.match(tok, /<span class="row-sub">wETH<\/span>/);
});

test('listMarkup wraps rows in a role=list ul', () => {
  assert.equal(listMarkup(['<li>a</li>', '<li>b</li>']).toString(), '<ul class="list" role="list"><li>a</li><li>b</li></ul>');
});

test('chainLabel names both halves, and names a missing half rather than dropping it', () => {
  assert.equal(chainLabel({ chainId: 14, genesis: 'aa1b2c3d4e5f' }), 'chain 14 · aa1b2c3d…');
  assert.equal(chainLabel({ chainId: 14, genesis: null }), 'chain 14 · genesis unknown');
  assert.equal(chainLabel({ chainId: null, genesis: 'aa1b2c3d4e5f' }), 'chain unknown · aa1b2c3d…');
  assert.equal(chainLabel({ chainId: null, genesis: null }), 'an unknown chain');
  assert.equal(chainLabel({ chainId: null, genesis: null, unknown: true }), 'a node that would not say which chain it is');
  assert.equal(chainLabel(null), 'an unknown chain');
});

test('partlyIdentified and canRescan are strict about their inputs', () => {
  assert.equal(partlyIdentified({ got: { unknown: true } }), true);
  assert.equal(partlyIdentified({ got: {} }), false);
  assert.equal(partlyIdentified(null), false);
  assert.equal(canRescan({ backend: { sync: { rescan() {} } } }), true);
  assert.equal(canRescan({ backend: { sync: {} } }), false);
  assert.equal(canRescan({ backend: {} }), false);
  assert.equal(canRescan(null), false);
});

test('wrong-chain banner: Rescan button only when offered; headline does not over-claim', () => {
  const info = { got: { chainId: 15, genesis: 'ffeeddcc00' }, expected: { chainId: 20, genesis: '1122334455' } };
  const plain = wrongChainBannerMarkup(info);
  assert.doesNotMatch(plain, /rescan-chain/);
  assert.match(plain, /on a different chain \(chain 15 · ffeeddcc…\)/);
  assert.match(plain, /read from chain 20 · 11223344…/);
  assert.match(wrongChainBannerMarkup(info, { canRescan: true }), /data-action="rescan-chain"/);
  const partly = wrongChainBannerMarkup({ got: { chainId: 15, genesis: null, unknown: true }, expected: info.expected });
  assert.match(partly, /did not fully identify its chain/);
});

test('behind banner: Rescan is primary only when the wallet is known to be ahead', () => {
  const calm = behindBannerMarkup({ tip: 10, wallet: 99 }, { canRescan: true });
  assert.match(calm, /block 10; your wallet has read to 99/);
  assert.match(calm, /class="btn sm"[^>]*data-action="rescan-plain"/);
  const ahead = behindBannerMarkup({ tip: 10, wallet: 99, walletAhead: true }, { canRescan: true });
  assert.match(ahead, /btn sm btn-primary/);
  assert.doesNotMatch(behindBannerMarkup({}), /rescan-plain/);
  assert.match(behindBannerMarkup({}), /block \?; your wallet has read to \?/);
});

test('identity-unknown banner offers only the way to another node', () => {
  const html = identityUnknownBannerMarkup();
  assert.match(html, /data-role="identity-unknown"/);
  assert.doesNotMatch(html, /data-action/);
  assert.match(html, /Choose another node/);
});
