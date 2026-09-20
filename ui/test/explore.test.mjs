// The Explore screen (`#explore`, `#explore/bridge`) — task 5.2.
//
// Explore is the primary real consumer of `ctx.backend.rpc.call` (the raw JSON-RPC escape hatch,
// ui/backend.js) in this UI so far. Its four cards (Network, Assets, Bridge, Lookup) are driven
// off `ui/lib/rpc-methods.js`'s `explore:` metadata rather than a hand-written list of method
// names — `groupMethods()` is exported from the screen precisely so this file can assert that
// fact without duplicating it.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { METHODS } from '../lib/rpc-methods.js';
import { groupMethods } from '../screens/explore.js';

function text(root) {
  return root.textContent || '';
}

function rpcCalls(b) {
  return b.calls.filter((c) => c[0] === 'rpc.call').map((c) => [c[1], c[2]]);
}

const TX_HASH = 'a1'.repeat(32);
const BLOCK_HASH = 'b2'.repeat(32);

/** A fixture map keyed by wire method name; `hooks[method]` can override a single method's
 *  behaviour (throw, stall, etc.) for one test without rebuilding the whole map. */
function explorerBackend(hooks = {}) {
  const answers = {
    rand_status: () => ({ height: 500, peer_count: 8, syncing: false }),
    rand_getHead: () => ({ height: 12345, hash: `0x${'aa'.repeat(32)}`, view: 999 }),
    rand_getEpoch: () => ({ epoch: 41, epoch_blocks: 1000, next_set: [] }),
    rand_getValidators: () => [{ address: 'v1' }, { address: 'v2' }],
    rand_getPeers: () => [{ peer_id: 'p1' }],
    rand_getSupply: () => ({ height: 12345, total_supply: '5000000000' }), // 5 RAND
    rand_getAssets: () => [{ index: 1, chain: 2, token: 'ee'.repeat(32), asset_id: 'aa'.repeat(32) }],
    rand_getBridgeState: () => ({ enabled: true, emitters: { 2: '02'.repeat(32) }, guardian_set_index: 3, burn_sequence: 7 }),
    rand_getTransaction: () => null,
    rand_getBlockByHash: (params) => ({ hash: params[0], height: 99, transactions: [] }),
    rand_getBlockByHeight: (params) => ({ hash: `0x${'bb'.repeat(32)}`, height: params[0], transactions: [] }),
  };
  return unlockedBackend({
    rpc: {
      call: async (method, params) => {
        if (hooks[method]) return hooks[method](params);
        const fn = answers[method];
        if (!fn) throw new Error(`explorerBackend: no fixture for ${method}`);
        return fn(params);
      },
    },
  });
}

async function at(t, hash, b = explorerBackend()) {
  const { app, root } = await mountApp(t, b, { hash });
  await app.idle();
  return { root, b, app };
}

// -------------------------------------------------------------------------------- metadata ----

test('groupMethods reads the card contents from rpc-methods.js, not a second list', () => {
  assert.deepEqual(groupMethods('network'), ['status', 'getHead', 'getEpoch', 'getValidators', 'getPeers', 'getSupply']);
  assert.deepEqual(groupMethods('assets'), ['getAssets']);
  // getBridgeBurn/bridgeAssetId are tagged 'bridge' too but take arguments no mount-time fetch
  // has, so only the zero-argument getBridgeState is in the auto-fetched set.
  assert.deepEqual(groupMethods('bridge'), ['getBridgeState']);
  for (const name of groupMethods('network').concat(groupMethods('assets'), groupMethods('bridge'))) {
    assert.equal(METHODS[name].params.length, 0);
  }
});

// ----------------------------------------------------------------------------------- cards -----

test('#explore renders all four cards from one set of independent RPC calls', async (t) => {
  const { root, b } = await at(t, '#explore');
  const body = text(root);

  // Network: height, epoch, validator count, peer count, supply in RAND.
  assert.match(body, /12,345/); // getHead().height
  assert.match(body, /41/); // getEpoch().epoch
  assert.match(body, /2 validators/);
  assert.ok(body.includes('1 peer'), 'peer count reads singular');
  assert.match(body, /5 RAND/); // getSupply().total_supply formatted

  // Assets: registry rows with an RPL chip.
  assert.match(body, /RPL#1/);
  assert.match(body, /RPL/);
  assert.match(body, /Chain 2/);

  // Bridge: state summary.
  assert.match(body, /Guardian set/);
  assert.match(body, /3/);
  assert.match(body, /Burn sequence/);
  assert.match(body, /7/);

  // Lookup field is present.
  assert.ok(root.querySelector('#explore-lookup'));

  // Every call this screen made was a zero-argument, metadata-tagged method — nothing hand-listed
  // beyond what groupMethods() itself names.
  const methods = rpcCalls(b).map(([m]) => m);
  assert.deepEqual(new Set(methods), new Set(['rand_status', 'rand_getHead', 'rand_getEpoch', 'rand_getValidators', 'rand_getPeers', 'rand_getSupply', 'rand_getAssets', 'rand_getBridgeState']));
});

test('a rejected call renders inside its own card without breaking the others', async (t) => {
  const b = explorerBackend({
    rand_getBridgeState: () => { throw new Error('bridge unreachable'); },
  });
  const { root } = await at(t, '#explore', b);
  const body = text(root);

  // The bridge card reports the failure...
  const bridgeCard = root.querySelector('[data-role="bridge"]');
  assert.match(bridgeCard.textContent, /bridge unreachable/);

  // ...but Network and Assets, whose own calls all succeeded, still render their data.
  assert.match(body, /12,345/);
  assert.match(body, /RPL#1/);
});

// ---------------------------------------------------------------------------------- lookup -----

async function submitLookup(root, value) {
  const input = root.querySelector('#explore-lookup');
  input.value = value;
  const form = root.querySelector('[data-role="lookup-form"]');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  // Let the async submit handler's awaits resolve.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

test('a 64-hex lookup tries rand_getTransaction, and stops there when it is found', async (t) => {
  const b = explorerBackend({ rand_getTransaction: () => ({ height: 192, tx: { hash: TX_HASH } }) });
  const { root } = await at(t, '#explore', b);
  await submitLookup(root, TX_HASH);

  const calls = rpcCalls(b);
  assert.deepEqual(calls.filter(([m]) => m === 'rand_getTransaction'), [['rand_getTransaction', [TX_HASH]]]);
  assert.equal(calls.filter(([m]) => m === 'rand_getBlockByHash').length, 0);

  const result = root.querySelector('[data-role="lookup-result"]');
  assert.match(result.textContent, /Transaction/);
  assert.match(result.textContent, /192/);
  assert.ok(result.querySelector('details'), 'result renders as a collapsible tree');
  assert.ok(result.querySelector('[data-role="copy-result"]'), 'result offers a copy affordance');
});

test('a 64-hex lookup falls back to rand_getBlockByHash when the transaction is not found', async (t) => {
  const { root, b } = await at(t, '#explore'); // default fixture: rand_getTransaction -> null
  await submitLookup(root, BLOCK_HASH);

  const calls = rpcCalls(b).filter(([m]) => m === 'rand_getTransaction' || m === 'rand_getBlockByHash');
  assert.deepEqual(calls, [
    ['rand_getTransaction', [BLOCK_HASH]],
    ['rand_getBlockByHash', [BLOCK_HASH]],
  ]);

  const result = root.querySelector('[data-role="lookup-result"]');
  assert.match(result.textContent, /Block/);
});

test('an all-digits lookup calls rand_getBlockByHeight, not a hash method', async (t) => {
  const { root, b } = await at(t, '#explore');
  await submitLookup(root, '12345');

  const calls = rpcCalls(b);
  assert.deepEqual(calls.filter(([m]) => m.startsWith('rand_getBlock') || m === 'rand_getTransaction'), [
    ['rand_getBlockByHeight', [12345]],
  ]);
  const result = root.querySelector('[data-role="lookup-result"]');
  assert.match(result.textContent, /Block/);
});

test('a lookup that matches neither shape makes no RPC call and shows an inline error', async (t) => {
  const { root, b } = await at(t, '#explore');
  const before = rpcCalls(b).length;
  await submitLookup(root, 'not a hash or a height');
  assert.equal(rpcCalls(b).length, before);
  assert.match(text(root.querySelector('#explore-lookup-error')), /hash|height/i);
});

test('copying a lookup result hands the backend the JSON text', async (t) => {
  const b = explorerBackend({ rand_getTransaction: () => ({ height: 1, tx: { hash: TX_HASH } }) });
  const { root, app } = await at(t, '#explore', b);
  await submitLookup(root, TX_HASH);
  root.querySelector('[data-role="copy-result"]').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  await app.idle();
  const copy = b.calls.find((c) => c[0] === 'platform.copy');
  assert.ok(copy, 'platform.copy was called');
  const copied = JSON.parse(copy[1]);
  assert.deepEqual(copied, { height: 1, tx: { hash: TX_HASH } });
});

// ------------------------------------------------------------------------------ #explore/bridge -

test('#explore/bridge renders every card and scrolls the bridge card into view', async (t) => {
  const seen = [];
  const original = globalThis.HTMLElement.prototype.scrollIntoView;
  globalThis.HTMLElement.prototype.scrollIntoView = function scrollIntoView(...args) { seen.push({ el: this, args }); };
  t.after(() => { globalThis.HTMLElement.prototype.scrollIntoView = original; });

  const { root } = await at(t, '#explore/bridge');
  const bridgeCard = root.querySelector('[data-role="bridge"]');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].el, bridgeCard);

  // Every other card is still there.
  assert.ok(root.querySelector('[data-role="network"]'));
  assert.ok(root.querySelector('[data-role="assets"]'));
});

test('#explore (no sub-route) never scrolls anything', async (t) => {
  const seen = [];
  const original = globalThis.HTMLElement.prototype.scrollIntoView;
  globalThis.HTMLElement.prototype.scrollIntoView = function scrollIntoView(...args) { seen.push(args); };
  t.after(() => { globalThis.HTMLElement.prototype.scrollIntoView = original; });

  await at(t, '#explore');
  assert.equal(seen.length, 0);
});
