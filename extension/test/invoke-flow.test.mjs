// lib/invoke-flow.js — the approval window's logic without its DOM. What the site hears, and when:
// a refusal that needs no proof at once, the hash after Approve, exactly one answer, and the phases
// reported on the way so a closed window can be answered for honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInvokeFlow } from '../shared/lib/invoke-flow.js';

const REQUEST = { program: 'ab'.repeat(32) };
const QUOTE = { title: 'Swap', program: 'ab'.repeat(32), spend: [{ asset: 0, amount: '1' }], receive: [{ asset: 1, amount: '2' }], fee: '3', cells: 0, tier: 12 };

function harness({ parked = { ok: true, result: { origin: 'https://durian.market', request: REQUEST } }, program } = {}) {
  const sent = [];
  const send = async (msg) => { sent.push(msg); return msg.type === 'rand:invokeRequest' ? parked : { ok: true }; };
  const backend = program === null ? {} : {
    program: {
      canInvoke: async () => ({ ok: true, via: 'prover' }),
      quote: async () => QUOTE,
      invoke: async (req, onPhase) => { onPhase('proving', { prover: 'p' }); onPhase('submitting'); return { hash: `0x${'CD'.repeat(32)}` }; },
      ...program,
    },
  };
  const flow = makeInvokeFlow({ id: 'i1', send, backend });
  const results = () => sent.filter((m) => m.type === 'rand:invokeResult');
  return { flow, sent, results, backendRef: backend };
}

test('review, approve, and the site hears the hash once, with every phase reported on the way', async () => {
  const h = harness();
  await h.flow.start();
  assert.equal(h.flow.state.step, 'review');
  assert.equal(h.flow.state.origin, 'https://durian.market');
  assert.deepEqual(h.flow.state.quote, QUOTE);
  assert.equal(h.results().length, 0, 'nothing is said to the site while the user decides');
  await h.flow.approve();
  assert.equal(h.flow.state.step, 'done');
  assert.deepEqual(h.results(), [{ type: 'rand:invokeResult', id: 'i1', ok: true, result: { tx: 'cd'.repeat(32) } }]);
  const phases = h.sent.filter((m) => m.type === 'rand:invokeProgress').map((m) => m.phase);
  assert.deepEqual(phases, ['selecting', 'proving', 'submitting']);
  await h.flow.approve();
  await h.flow.reject();
  assert.equal(h.results().length, 1, 'one answer, whatever is pressed afterwards');
});

test('a refusal before any proof is answered to the site at once, with its code', async () => {
  const stale = harness({ program: { quote: async () => { throw Object.assign(new Error('The pool changed'), { code: 'STALE_READ' }); } } });
  await stale.flow.start();
  assert.equal(stale.flow.state.step, 'failed');
  assert.deepEqual(stale.results()[0].error, { code: 'STALE_READ', message: 'The pool changed' });
  const noProver = harness({ program: { canInvoke: async () => ({ ok: false, code: 'PROVER_UNAVAILABLE', reason: 'Pair a prover.' }) } });
  await noProver.flow.start();
  assert.equal(noProver.results()[0].error.code, 'PROVER_UNAVAILABLE');
  const old = harness({ program: null });
  await old.flow.start();
  assert.equal(old.results()[0].error.code, 'UNSUPPORTED');
});

test('reject is USER_REJECTED; a failure mid-proof keeps its code, and an uncoded one is UNKNOWN', async () => {
  const no = harness();
  await no.flow.start();
  await no.flow.reject();
  assert.equal(no.results()[0].error.code, 'USER_REJECTED');
  const broken = harness({ program: { invoke: async () => { throw new Error('the prover went away'); } } });
  await broken.flow.start();
  await broken.flow.approve();
  assert.deepEqual(broken.results()[0].error, { code: 'UNKNOWN', message: 'the prover went away' });
});

test('a request that is no longer waiting tells nobody and shows why', async () => {
  const h = harness({ parked: { ok: false, error: { code: 'GONE', message: 'That request is no longer waiting.' } } });
  await h.flow.start();
  assert.equal(h.flow.state.step, 'failed');
  assert.equal(h.flow.state.error.code, 'GONE');
  assert.equal(h.results().length, 0);
});

test('the RandProtocol prover\'s notice stands in Approve\'s place; read (Firefox: consented inside the click), Approve goes', async () => {
  for (const granted of [true, false, null]) {
    const order = [];
    const h = harness({ program: { canInvoke: async () => ({ ok: true, via: 'prover', prover: 'default', notice: true }) } });
    await h.flow.start();
    assert.equal(h.flow.state.step, 'review');
    assert.equal(h.flow.state.notice, true);
    await h.flow.approve();
    assert.equal(h.flow.state.step, 'review', 'Approve went through before the notice was read');
    // The harness's backend gains the prover group and (Firefox, when granted is not null) the
    // platform's consent request.
    h.backendRef.prover = { acknowledgeDefault: async () => { order.push('acknowledge'); } };
    if (granted !== null) h.backendRef.platform = { requestDataCollectionConsent: () => { order.push('request'); return Promise.resolve(granted); } };
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
    assert.deepEqual(order, granted ? ['request', 'acknowledge'] : ['acknowledge']);
    assert.equal(h.flow.state.notice, false);
    await h.flow.approve();
    assert.equal(h.flow.state.step, 'done');
  }
});

test('the approval window names the RandProtocol provers by count, as every surface does', async () => {
  const { proverNotice } = await import('../shared/lib/invoke-flow.js');
  const h = harness({ program: { canInvoke: async () => ({ ok: true, via: 'prover', prover: 'default', provers: 4, notice: true }) } });
  await h.flow.start();
  assert.equal(h.flow.state.provers, 4);
  assert.match(proverNotice(4), /one of the RandProtocol provers \(4 machines run by the validators; each one that proves a send sees that wallet's viewing key\)/);
  assert.match(proverNotice(4), /It cannot spend/);
});
