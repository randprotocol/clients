// lib/withdraw-flow.js — the withdraw approval window's logic without its DOM. What the site hears,
// and when: every refusal that needs no proof at once (a request the wallet cannot read, another
// chain, the wallet's own estimate refusing), the hash after Approve, exactly one answer, and the
// phases reported on the way so a closed window can be answered for honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWithdrawFlow, normalizeWithdrawRequest } from '../shared/lib/withdraw-flow.js';

const ADDR = 'ab'.repeat(20);
const EVM = { asset: 1, amount: '1500000000', toChain: 2, token: `0x${'11'.repeat(32).toUpperCase()}`, to: `${'0'.repeat(24)}${ADDR}`, chainId: 21, title: '  Withdraw to Ethereum ' };
const NORMAL = { asset: 1, amount: '1500000000', toChain: 2, token: '11'.repeat(32), to: `${'0'.repeat(24)}${ADDR}`, relayerFee: '0', title: 'Withdraw to Ethereum' };
const ESTIMATE = { fee: '5', relayerFee: '0', bridgeFee: '0', receive: '1500000000', change: '0', feeChange: '0', proofs: 1 };

function harness({ raw = EVM, chainId = 21, bridge = {}, parked } = {}) {
  const sent = [];
  const calls = { estimate: 0, withdraw: 0, args: [] };
  const answer = parked || { ok: true, result: { origin: 'https://randbridge.org', request: raw } };
  const send = async (msg) => { sent.push(msg); return msg.type === 'rand:withdrawRequest' ? answer : { ok: true }; };
  const backend = {
    settings: { get: async () => ({ chainId }) },
    bridge: {
      canWithdraw: async () => ({ ok: true, via: 'prover' }),
      estimate: async (req) => { calls.estimate += 1; calls.args.push(req); return ESTIMATE; },
      withdraw: async (req, onPhase) => { calls.withdraw += 1; calls.args.push(req); onPhase('proving', { prover: 'p' }); onPhase('submitting'); return { hash: `0x${'CD'.repeat(32)}` }; },
      ...bridge,
    },
  };
  const flow = makeWithdrawFlow({ id: 'w1', send, backend });
  const results = () => sent.filter((m) => m.type === 'rand:withdrawResult');
  return { flow, sent, results, calls, backend };
}

test('review, approve, the hash once (lowercase, no 0x), every phase reported on the way', async () => {
  const h = harness();
  await h.flow.start();
  assert.equal(h.flow.state.step, 'review');
  assert.equal(h.flow.state.origin, 'https://randbridge.org');
  assert.deepEqual(h.flow.state.request, NORMAL);
  assert.deepEqual(h.flow.state.estimate, ESTIMATE);
  assert.equal(h.results().length, 0, 'nothing is said to the site while the user decides');
  await h.flow.approve();
  assert.equal(h.flow.state.step, 'done');
  assert.deepEqual(h.results(), [{ type: 'rand:withdrawResult', id: 'w1', ok: true, result: { tx: 'cd'.repeat(32) } }]);
  const phases = h.sent.filter((m) => m.type === 'rand:withdrawProgress').map((m) => m.phase);
  assert.deepEqual(phases, ['selecting', 'proving', 'submitting']);
  assert.deepEqual(h.calls.args, [
    { asset: 1, amount: '1500000000', relayerFee: '0', toChain: 2, token: '11'.repeat(32), to: NORMAL.to },
    { asset: 1, amount: '1500000000', relayerFee: '0', toChain: 2, token: '11'.repeat(32), to: NORMAL.to },
  ], 'bridge.* gets exactly the burn arguments, no title and no chainId');
  await h.flow.approve();
  await h.flow.reject();
  assert.equal(h.results().length, 1, 'one answer, whatever is pressed afterwards');
});

test('a request the wallet cannot read is refused at once, before any estimate', async () => {
  const dirty = harness({ raw: { ...EVM, to: `${'0'.repeat(22)}ff${ADDR}` } });
  await dirty.flow.start();
  assert.equal(dirty.flow.state.step, 'failed');
  assert.equal(dirty.results()[0].error.code, 'BAD_REQUEST');
  assert.equal(dirty.calls.estimate, 0);
  assert.equal(dirty.calls.withdraw, 0);
});

test('normalizeWithdrawRequest: lowercases, strips 0x, caps the title, and refuses everything else', () => {
  const ok = normalizeWithdrawRequest({ ...EVM, to: `0x${EVM.to.toUpperCase()}`, title: 'x'.repeat(200) }, 21);
  assert.equal(ok.to, NORMAL.to);
  assert.equal(ok.token, NORMAL.token);
  assert.equal(ok.title.length, 80);
  assert.equal(normalizeWithdrawRequest({ ...EVM, title: undefined }, 21).title, '');
  const sol = normalizeWithdrawRequest({ ...EVM, toChain: 5, to: 'ff'.repeat(32) }, 21);
  assert.equal(sol.to, 'ff'.repeat(32), 'a non-EVM chain takes all 32 bytes');
  const bad = (patch, code = 'BAD_REQUEST', chain = 21) => {
    assert.throws(() => normalizeWithdrawRequest({ ...EVM, ...patch }, chain), (e) => e.code === code, JSON.stringify(patch));
  };
  for (const patch of [
    { toChain: 0 }, { toChain: 256 }, { toChain: 2.5 }, { toChain: '2' },
    { asset: -1 }, { asset: '1' }, { asset: 1.5 },
    { amount: '0' }, { amount: '01' }, { amount: 5 }, { amount: '1'.repeat(31) }, { amount: '-1' }, { amount: '1.5' },
    { token: 'ab' }, { token: 'zz'.repeat(32) }, { token: 7 },
    { to: 'ab' }, { to: 1 }, { to: '0'.repeat(64) },
    { chainId: -1 }, { chainId: '21' }, { chainId: undefined },
    { title: 5 },
  ]) bad(patch);
  assert.throws(() => normalizeWithdrawRequest(null, 21), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => normalizeWithdrawRequest([], 21), (e) => e.code === 'BAD_REQUEST');
  bad({ chainId: 20 }, 'WRONG_CHAIN');
});

test('the wallet\'s own estimate refusing answers the site at once with the wallet\'s sentence', async () => {
  const h = harness({ bridge: { estimate: async () => { throw Object.assign(new Error('You hold 3 zUSD.'), { definite: true }); } } });
  await h.flow.start();
  assert.equal(h.flow.state.step, 'failed');
  assert.deepEqual(h.results()[0], { type: 'rand:withdrawResult', id: 'w1', ok: false, error: { code: 'UNKNOWN', message: 'You hold 3 zUSD.' } });
  assert.equal(h.calls.withdraw, 0);
  await h.flow.approve();
  assert.equal(h.calls.withdraw, 0);
});

test('no proof route: PROVER_UNAVAILABLE with the wallet\'s reason, and no estimate', async () => {
  const h = harness({ bridge: { canWithdraw: async () => ({ ok: false, reason: 'Your paired prover is not available: busy.' }) } });
  await h.flow.start();
  assert.deepEqual(h.results()[0].error, { code: 'PROVER_UNAVAILABLE', message: 'Your paired prover is not available: busy.' });
  assert.equal(h.calls.estimate, 0);
});

test('the one-time notice comes before Approve; Firefox consent declined is PROVER_UNAVAILABLE', async () => {
  for (const granted of [true, false, null]) {
    const order = [];
    const h = harness({ bridge: { canWithdraw: async () => ({ ok: true, via: 'prover', prover: 'default', provers: 4, notice: true }) } });
    await h.flow.start();
    assert.equal(h.flow.state.step, 'review');
    assert.equal(h.flow.state.notice, true);
    assert.equal(h.flow.state.provers, 4);
    assert.equal(h.flow.state.prover, 'default');
    assert.equal(h.flow.state.via, 'prover');
    await h.flow.approve();
    assert.equal(h.flow.state.step, 'review', 'Approve went through before the notice was read');
    assert.equal(h.calls.withdraw, 0);
    h.backend.prover = { acknowledgeDefault: async () => { order.push('acknowledge'); } };
    if (granted !== null) h.backend.platform = { requestDataCollectionConsent: () => { order.push('request'); return Promise.resolve(granted); } };
    const done = h.flow.acknowledge();
    if (granted !== null) assert.deepEqual(order, ['request'], 'the consent was not asked synchronously inside the click');
    await done;
    if (granted === false) {
      assert.deepEqual(order, ['request']);
      assert.equal(h.flow.state.step, 'failed');
      assert.equal(h.results()[0].error.code, 'PROVER_UNAVAILABLE');
      assert.match(h.results()[0].error.message, /Firefox did not allow/);
      continue;
    }
    assert.equal(h.flow.state.notice, false);
    await h.flow.approve();
    assert.equal(h.flow.state.step, 'done');
  }
});

test('reject answers USER_REJECTED once', async () => {
  const h = harness();
  await h.flow.start();
  await h.flow.reject();
  await h.flow.reject();
  assert.equal(h.flow.state.step, 'failed');
  assert.equal(h.results().length, 1);
  assert.equal(h.results()[0].error.code, 'USER_REJECTED');
  assert.equal(h.calls.withdraw, 0);
});

test('another chain is refused before any estimate', async () => {
  const h = harness({ raw: { ...EVM, chainId: 20 } });
  await h.flow.start();
  assert.equal(h.results()[0].error.code, 'WRONG_CHAIN');
  assert.equal(h.calls.estimate, 0);
});

test('an earlier proof still waiting is PROOF_PENDING, with the wallet\'s sentence', async () => {
  const pending = Object.assign(new Error('A proof is still pending — resume or cancel it.'), { definite: true, pending: true });
  const h = harness({ bridge: { withdraw: async () => { throw pending; } } });
  await h.flow.start();
  await h.flow.approve();
  assert.equal(h.flow.state.step, 'failed');
  assert.deepEqual(h.results()[0].error, { code: 'PROOF_PENDING', message: 'A proof is still pending — resume or cancel it.' });
  // …and the same refusal at estimate time (the backend may refuse there too).
  const early = harness({ bridge: { estimate: async () => { throw pending; } } });
  await early.flow.start();
  assert.equal(early.results()[0].error.code, 'PROOF_PENDING');
});

test('a request that is no longer waiting tells nobody and shows why', async () => {
  const h = harness({ parked: { ok: false, error: { code: 'GONE', message: 'That request is no longer waiting.' } } });
  await h.flow.start();
  assert.equal(h.flow.state.step, 'failed');
  assert.equal(h.flow.state.error.code, 'GONE');
  assert.equal(h.results().length, 0);
});

test('a wallet without the bridge group refuses with UNSUPPORTED', async () => {
  const h = harness();
  delete h.backend.bridge;
  await h.flow.start();
  assert.equal(h.results()[0].error.code, 'UNSUPPORTED');
});
