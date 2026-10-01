// The Swap screen: priced from the durian.market pool cells the backend reads, the transition it
// hands `program.quote`/`program.invoke` is ui/lib/amm.js's to the unit, and a pool that moved
// (STALE_READ) brings the user back to a fresh quote rather than a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { DURIAN_PROGRAM, buildSwap, encodePool, findRoute, poolKey, poolsOf } from '../lib/amm.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (app) => { for (let i = 0; i < 5; i += 1) { await app.idle(); await tick(); } };

// RAND/wETH (asset 1, 8 decimals): 200 RAND against 3 wETH.
const POOL = { token: 1, rr: 200_000_000_000n, rt: 300_000_000n, supply: 7_000_000_000n, lpAsset: 3 };
const cellOf = (p) => ({ key: poolKey(p.token), value: encodePool(p) });
const HASH = 'ab'.repeat(32);

function withProgram({ cells = [cellOf(POOL)], can = { ok: true, via: 'prover', prover: 'default', provers: 4 }, invoke } = {}) {
  const b = unlockedBackend();
  const calls = { cells: [], quote: [], invoke: [] };
  let cellsNow = cells;
  b.program = {
    async cells(id) { calls.cells.push(id); return cellsNow; },
    async canInvoke() { return can; },
    async quote(req) { calls.quote.push(req); return { title: '', program: req.program, spend: [], receive: [], fee: '2000000', cells: 0, tier: 12 }; },
    async invoke(req, onPhase) {
      calls.invoke.push(req);
      if (invoke) return invoke(req, onPhase);
      onPhase('proving', { prover: 'RandProtocol (a)' });
      return { hash: HASH };
    },
  };
  return { b, calls, setCells: (c) => { cellsNow = c; } };
}

async function typeAmount(root, text) {
  const input = root.querySelector('#swap-amount');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

test('home: Swap replaces Faucet in the action row and opens the swap screen', async (t) => {
  const { b } = withProgram();
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  await settle(app);
  const btn = root.querySelector('.btn-round[data-go="swap"]');
  assert.ok(btn, 'a Swap action');
  assert.equal(btn.textContent.trim(), 'Swap');
  assert.equal(root.querySelector('.btn-round[data-go="faucet"]'), null, 'no Faucet action');
  btn.click();
  await settle(app);
  assert.equal(location.hash, '#swap');
  assert.ok(root.querySelector('#swap-amount'), 'the swap form');
});

test('the form quotes RAND → wETH from the pool cells, exactly as amm.buildSwap does', async (t) => {
  const { b, calls } = withProgram();
  const { app, root } = await mountApp(t, b, { hash: '#swap' });
  await settle(app);
  assert.deepEqual(calls.cells, [DURIAN_PROGRAM]);
  const sells = [...root.querySelectorAll('#swap-sell option')].map((o) => o.textContent);
  assert.deepEqual(sells, ['RAND', 'wETH']);
  assert.equal(root.querySelector('#swap-buy').value, '1', 'buying the pool token by default');
  assert.equal(root.querySelector('[data-role="review"]').disabled, true, 'nothing to review yet');
  await typeAmount(root, '2');
  const expected = buildSwap({ route: findRoute(poolsOf([cellOf(POOL)]), 0, 1), dx: 2_000_000_000n, rnd: [0, 0, 0] });
  assert.equal(root.querySelector('[data-role="out"]').textContent, (Number(expected.amountOut) / 1e8).toString());
  assert.match(root.querySelector('[data-role="details"]').textContent, /Pool fee/);
  assert.equal(root.querySelector('[data-role="review"]').disabled, false);
});

test('more than the balance cannot be reviewed', async (t) => {
  const { b } = withProgram();
  const { app, root } = await mountApp(t, b, { hash: '#swap' });
  await settle(app);
  await typeAmount(root, '4'); // the fixture holds 3.5 RAND
  assert.match(root.querySelector('#swap-amount-error').textContent, /You have 3\.5 RAND/);
  assert.ok(root.querySelector('[data-role="pay-field"]').classList.contains('invalid'), 'the error is shown, not only written');
  assert.equal(root.querySelector('[data-role="review"]').disabled, true);
});

test('review → Swap hands the exact transition to program.invoke and shows the hash', async (t) => {
  const { b, calls } = withProgram();
  const { app, root } = await mountApp(t, b, { hash: '#swap' });
  await settle(app);
  await typeAmount(root, '1');
  root.querySelector('[data-role="swap-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle(app);
  assert.equal(calls.quote.length, 1);
  const review = root.querySelector('[data-role="step"]').textContent;
  assert.match(review, /Review the swap/);
  assert.match(review, /Network fee\s*0\.002 RAND/);
  const req = calls.quote[0];
  assert.equal(req.program, DURIAN_PROGRAM);
  assert.equal(req.inputs[0], 3, 'the swap method');
  assert.deepEqual(req.inflow, { rand: '1000000000', asset: 0, amount: '0', kind: 'none' });
  assert.deepEqual(req.reads, [cellOf(POOL)]);
  root.querySelector('[data-role="swap"]').click();
  await settle(app);
  assert.equal(calls.invoke.length, 1);
  assert.deepEqual(calls.invoke[0], req, 'the request reviewed is the request sent');
  const done = root.querySelector('[data-role="step"]').textContent;
  assert.match(done, /Swap submitted/);
  assert.match(done, /abababab/);
});

test('a pool that moved before the swap landed re-reads the pool and offers a new quote', async (t) => {
  const err = Object.assign(new Error('stale'), { code: 'STALE_READ' });
  const { b, calls, setCells } = withProgram({ invoke: async () => { throw err; } });
  const { app, root } = await mountApp(t, b, { hash: '#swap' });
  await settle(app);
  await typeAmount(root, '1');
  root.querySelector('[data-role="swap-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle(app);
  setCells([cellOf({ ...POOL, rr: POOL.rr + 5_000_000_000n, rt: POOL.rt - 7_000_000n })]);
  root.querySelector('[data-role="swap"]').click();
  await settle(app);
  assert.equal(calls.cells.length, 2, 'the pool was read again');
  const text = root.querySelector('[data-role="step"]').textContent;
  assert.match(text, /The pool moved/);
  assert.ok(root.querySelector('#swap-amount'), 'back at the form');
});

test('the RandProtocol provers\' notice is read before the first swap through them', async (t) => {
  const { b, calls } = withProgram({ can: { ok: true, via: 'prover', prover: 'default', provers: 4, notice: true } });
  let acked = 0;
  b.prover.acknowledgeDefault = async () => { acked += 1; };
  const { app, root } = await mountApp(t, b, { hash: '#swap' });
  await settle(app);
  await typeAmount(root, '1');
  root.querySelector('[data-role="swap-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle(app);
  assert.equal(root.querySelector('[data-role="swap"]'), null, 'no Swap button until the notice is read');
  assert.ok(root.querySelector('[data-role="prover-notice"]'));
  root.querySelector('[data-action="acknowledge-prover"]').click();
  await settle(app);
  assert.equal(acked, 1);
  assert.ok(root.querySelector('[data-role="swap"]'), 'Swap offered once read');
  assert.equal(calls.invoke.length, 0);
});

test('no pools, or a chain without programs, says so instead of a form', async (t) => {
  for (const [cells, words] of [[[], /no pools on this chain/], [null, /does not run programs/]]) {
    const { b } = withProgram({ cells });
    const { app, root } = await mountApp(t, b, { hash: '#swap' });
    await settle(app);
    assert.match(root.querySelector('[data-role="step"]').textContent, words);
    assert.equal(root.querySelector('#swap-amount'), null);
    assert.ok(root.querySelector('[data-role="open-durian"]'));
  }
});
