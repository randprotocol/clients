import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_PHASE, classify, makeReporter, runPhased, executeTransfer, executeBurn } from '../engine/execute.js';
import { RpcError } from '../engine/rpc.js';

const refused = () => new RpcError('refused', -32000);
const transport = () => new RpcError('down', -1, 'timeout');

test('the engine\'s phases map to the contract\'s', () => {
  assert.deepEqual({ ...UI_PHASE }, { select: 'selecting', witness: 'witness', prove: 'proving', submit: 'submitting', wait: 'confirming' });
  assert.ok(Object.isFrozen(UI_PHASE));
});

test('classify: a failure before the wire is definite', () => {
  for (const phase of [null, 'select', 'witness', 'prove']) {
    assert.equal(classify(new Error('x'), phase).definite, true, String(phase));
  }
});

test('classify: at submit only a node\'s own refusal is definite, never a transport failure', () => {
  assert.equal(classify(refused(), 'submit').definite, true);
  assert.equal(classify(transport(), 'submit').definite, undefined);
  // code -1 is a legal application code: an answered refusal with it is still definite
  assert.equal(classify(new RpcError('nope', -1), 'submit').definite, true);
  assert.equal(classify(new Error('plain'), 'submit').definite, undefined);
});

test('classify: while confirming, nothing is known', () => {
  assert.equal(classify(refused(), 'wait').definite, undefined);
  assert.equal(classify(new Error('x'), 'wait').definite, undefined);
});

test('classify passes through aborts, decided errors and non-errors', () => {
  const abort = Object.assign(new Error('a'), { name: 'AbortError' });
  assert.equal(classify(abort, 'select').definite, undefined);
  const decided = Object.assign(new Error('d'), { definite: false });
  assert.equal(classify(decided, 'select').definite, false);
  assert.equal(classify(null, 'select'), null);
  assert.equal(classify('text', 'select'), 'text');
});

test('makeReporter remembers the engine phase and reports the contract\'s name, with detail only when given', () => {
  const seen = []; const calls = [];
  const report = makeReporter((...a) => calls.push(a), (p) => seen.push(p));
  report('prove');
  report('wait', { position: 2 });
  report('custom');
  assert.deepEqual(seen, ['prove', 'wait', 'custom']);
  assert.deepEqual(calls, [['proving'], ['confirming', { position: 2 }], ['custom']]);
  // no callback: still remembers, does not throw
  const quiet = []; makeReporter(undefined, (p) => quiet.push(p))('select');
  assert.deepEqual(quiet, ['select']);
});

test('runPhased classifies by the last phase work reported', async () => {
  await assert.rejects(runPhased(null, async (report) => { report('prove'); throw new Error('boom'); }), (e) => e.definite === true);
  await assert.rejects(runPhased(null, async (report) => { report('submit'); throw transport(); }), (e) => e.definite === undefined);
  assert.equal(await runPhased(null, async () => 7), 7);
});

test('executeTransfer hands the engine the request in strings and returns only hash and txKey', async () => {
  let got;
  const phases = [];
  const out = await executeTransfer({
    req: { to: 'rand1x', amount: 5, asset: '2', memo: 'hi' },
    onPhase: (p) => phases.push(p),
    options: { signal: 'sig' },
    client: 'C', identity: 'I',
    requireUnlocked: async () => ({ spend_key: 'sk' }),
    bundleFee: async (c) => { assert.equal(c, 'C'); return 123n; },
    sendTransfer: async (sk, args) => { got = { sk, args }; args.onPhase('submit'); return { hash: '0xh', tx_key: 'k', secret: 'no' }; },
  });
  assert.deepEqual(out, { hash: '0xh', txKey: 'k' });
  assert.equal(got.sk, 'sk');
  assert.deepEqual({ ...got.args, onPhase: undefined }, {
    to: 'rand1x', asset: 2, amountUnits: '5', feeUnits: '123', memo: 'hi', wait: true, onPhase: undefined,
    signal: 'sig', client: 'C', identity: 'I',
  });
  assert.deepEqual(phases, ['submitting']);
});

test('executeTransfer defaults a missing request to an empty, RAND, memo-less one', async () => {
  let args;
  await executeTransfer({
    req: undefined, client: 'C', identity: 'I',
    requireUnlocked: async () => ({ spend_key: 'sk' }), bundleFee: async () => 1n,
    sendTransfer: async (_sk, a) => { args = a; return { hash: 'h' }; },
  });
  assert.equal(args.to, ''); assert.equal(args.asset, 0); assert.equal(args.amountUnits, '0'); assert.equal(args.memo, '');
});

test('a wallet locked before the first phase is a definite failure (nothing was begun)', async () => {
  await assert.rejects(
    executeTransfer({ req: {}, requireUnlocked: async () => { throw new Error('locked'); }, bundleFee: async () => 1n, sendTransfer: async () => ({}) }),
    (e) => e.message === 'locked' && e.definite === true,
  );
  await assert.rejects(
    executeBurn({ req: {}, requireUnlocked: async () => { throw new Error('locked'); }, sendBurn: async () => ({}) }),
    (e) => e.definite === true,
  );
});

test('a transfer that fails after submit by transport is left unknown', async () => {
  await assert.rejects(
    executeTransfer({
      req: {}, requireUnlocked: async () => ({ spend_key: 's' }), bundleFee: async () => 1n,
      sendTransfer: async (_s, a) => { a.onPhase('submit'); throw transport(); },
    }),
    (e) => e.definite === undefined,
  );
});

test('executeBurn passes the burn in strings and returns the hash alone', async () => {
  let args;
  const out = await executeBurn({
    req: { asset: '3', amount: 400, relayerFee: 100, toChain: '2', token: 'tk', to: 'dest', fee: 7 },
    options: {}, client: 'C', identity: 'I',
    requireUnlocked: async () => ({ spend_key: 'sk' }),
    sendBurn: async (sk, a) => { args = a; return { hash: '0xburn', tx_key: 'must-not-leak' }; },
  });
  assert.deepEqual(out, { hash: '0xburn' });
  assert.deepEqual({ ...args, onPhase: undefined }, {
    asset: 3, amountUnits: '400', relayerFeeUnits: '100', toChain: 2, token: 'tk', to: 'dest', feeUnits: '7', wait: true,
    onPhase: undefined, signal: undefined, client: 'C', identity: 'I',
  });
});
