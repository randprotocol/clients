// lib/invoke-flow.js — the approval window's logic without its DOM. What the site hears, and when:
// a refusal that needs no proof at once, the hash after Approve, exactly one answer, and the phases
// reported on the way so a closed window can be answered for honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInvokeFlow } from '../shared/lib/invoke-flow.js';
import { SITE_ERRORS } from '../shared/lib/site-errors.js';

const SAY = SITE_ERRORS.invoke;
/** The site's answer holds none of the digits of the wallet's own reason, nor the reason itself. */
function private_(siteError, reason) {
  assert.ok(!siteError.message.includes(reason), `the wallet's reason reached the site: ${siteError.message}`);
  for (const n of reason.match(/[0-9]+/g) || []) assert.ok(!siteError.message.includes(n), `"${n}" from the wallet's reason reached the site`);
  assert.equal(siteError.message, SAY[siteError.code], 'not the fixed sentence for its code');
}

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

test('a refusal before any proof is answered to the site at once, with its code and the fixed sentence', async () => {
  const stale = harness({ program: { quote: async () => { throw Object.assign(new Error('The pool changed'), { code: 'STALE_READ' }); } } });
  await stale.flow.start();
  assert.equal(stale.flow.state.step, 'failed');
  assert.deepEqual(stale.results()[0].error, { code: 'STALE_READ', message: SAY.STALE_READ });
  const noProver = harness({ program: { canInvoke: async () => ({ ok: false, code: 'PROVER_UNAVAILABLE', reason: 'Pair a prover.' }) } });
  await noProver.flow.start();
  assert.deepEqual(noProver.results()[0].error, { code: 'PROVER_UNAVAILABLE', message: SAY.PROVER_UNAVAILABLE });
  const old = harness({ program: null });
  await old.flow.start();
  assert.equal(old.results()[0].error.code, 'UNSUPPORTED');
});

test('the wallet\'s balance never reaches the site: INSUFFICIENT_FUNDS and a refused program read as CANNOT_INVOKE / PROGRAM_REFUSED with fixed sentences', async () => {
  const funds = 'Rand Wallet does not hold enough to cover this and its network fee: insufficient balance: have 4100, need 9000';
  const poor = harness({ program: { quote: async () => { throw Object.assign(new Error(funds), { code: 'INSUFFICIENT_FUNDS', definite: true }); } } });
  await poor.flow.start();
  assert.deepEqual(poor.results()[0].error, { code: 'CANNOT_INVOKE', message: SAY.CANNOT_INVOKE });
  private_(poor.results()[0].error, funds);
  assert.equal(poor.flow.state.error.message, funds, 'the window keeps the full reason');
  const refused = 'The program would not accept this request, so nothing was sent: note 77 holds 31 RAND';
  const no = harness({ program: { quote: async () => { throw Object.assign(new Error(refused), { code: 'PROGRAM_REFUSED' }); } } });
  await no.flow.start();
  assert.equal(no.results()[0].error.code, 'PROGRAM_REFUSED');
  private_(no.results()[0].error, refused);
  const late = harness({ program: { invoke: async () => { throw Object.assign(new Error(funds), { code: 'INSUFFICIENT_FUNDS' }); } } });
  await late.flow.start();
  await late.flow.approve();
  private_(late.results()[0].error, funds);
});

test('reject is USER_REJECTED; a failure mid-proof with no listed code is CANNOT_INVOKE', async () => {
  const no = harness();
  await no.flow.start();
  await no.flow.reject();
  assert.equal(no.results()[0].error.code, 'USER_REJECTED');
  const broken = harness({ program: { invoke: async () => { throw new Error('the prover went away'); } } });
  await broken.flow.start();
  await broken.flow.approve();
  assert.deepEqual(broken.results()[0].error, { code: 'CANNOT_INVOKE', message: SAY.CANNOT_INVOKE });
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
      assert.equal(h.results()[0].error.message, SAY.PROVER_UNAVAILABLE);
      assert.match(h.flow.state.error.message, /Firefox did not allow/, 'the window says why');
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
  assert.match(proverNotice(4), /one of the RandProtocol provers \(4 machines operated by RandProtocol; each one that proves a send sees that wallet's viewing key\)/);
  assert.match(proverNotice(4), /It cannot spend/);
});
