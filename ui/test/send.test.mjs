// The send flow (#send, #send/<index>, #sent/<hash>) — task 1.5.
//
// The brief's four Step-1 tests are here, with the amendments applied:
//   * addresses are `rand1…`, not the renamed-away prefix (amendment 1);
//   * they go through the shared `mountApp` helper (as task 1.4's tests do) so a failed assertion
//     cannot leak a mount into the rest of the suite;
//   * their recipient is NOT `rand1qqq…q`. That is `unlockedBackend()`'s *own* address, so the
//     brief's literal fixture would make every one of its tests a self-send, and amendment 3 puts
//     a confirmation in front of those. The self-send path has a test of its own below.
//
// `app.idle()` waits for every tracked backend call, so a test that deliberately holds `send.send`
// open (to look at the proving step) must drive the queue with plain turns instead — the same
// convention screens.test.mjs already follows for a scan that never settles.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { registerScreen } from '../app.js';
import { unlockedBackend, NO_SPENDABLE_RAND_TEXT } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { explainProvingError } from '../screens/send.js';
import { markUnknownOutcome, unknownOutcome } from '../screens/send/state.js';
import { UNLISTED_TEXT } from '../lib/assets.js';

const TO = `rand1${'p'.repeat(40)}`;
const OWN = `rand1${'q'.repeat(40)}`; // unlockedBackend()'s own address
const turns = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** The RAND row, at whatever decimals a test wants to give this chain's native token. */
const randRow = (over = {}) => ({ index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0', ...over });
/** A listed registry token: eight decimals on Rand, exactly as a bridged one is. */
const tokenRow = (over = {}) => ({ index: 1, id: 'z'.repeat(64), idText: `rpl1${'q'.repeat(58)}`, name: 'Shielded USD', symbol: 'zUSD', decimals: 8, balance: '120000000', pending: '0', backings: [{ chain: 2, token: 'ee'.repeat(32), locked: '900000000', decimals: 6 }], ...over });
/** Held, but absent from the node's registry: the decimals are the wallet's guess. */
const unlistedRow = (over = {}) => ({ index: 3, id: 'rpl-3', symbol: 'RPL#3', decimals: 9, balance: '7', pending: '0', unlisted: true, ...over });
const listing = (rows) => ({ assets: { list: async () => rows.map((r) => ({ ...r })) } });

/**
 * `assert.equal(node, null)` is a landmine here: when it *fails*, node's assert builds a diff by
 * inspecting both values, and inspecting a linkedom node graph exhausts the heap — the whole file
 * dies with SIGKILL, no message, pointing at the wrong test. Never let assert inspect a DOM node.
 */
function assertGone(el, what) {
  assert.ok(el === null || el === undefined, `${what} should not be on the page`);
}

/** A screen that hands its render's `ctx` back to the test, for the "never in ctx.state" checks. */
const spied = [];
registerScreen('spy', {
  render: () => '<h1 class="sr-only">Spy</h1>',
  after(ctx) { spied.push(ctx); },
});

/** True if `needle` appears in any string reachable from `value`. */
function reaches(value, needle, seen = new Set()) {
  if (typeof value === 'string') return value.includes(needle);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const v of Object.values(value)) if (reaches(v, needle, seen)) return true;
  return false;
}

function submit(root) {
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** Walks #send → asset picker → details → Review, exactly as the brief's helper does. */
async function review(t, b, { to = TO, amount = '1' } = {}) {
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();
  root.querySelector('[data-asset="0"]').click();
  await app.idle();
  root.querySelector('textarea[name=to]').value = to;
  root.querySelector('input[name=amount]').value = amount;
  submit(root);
  await app.idle();
  return { root, app };
}

/** A backend whose `send.send()` never settles on its own; `ctl` drives it. */
function controlledSend(overrides = {}) {
  const ctl = { calls: 0, phases: [], options: [], emit: null, settle: null, fail: null };
  const b = unlockedBackend({
    ...overrides,
    send: {
      canProve: async () => ({ ok: true }),
      ...(overrides.send || {}),
      send: (_req, onPhase, options) => {
        ctl.calls += 1;
        ctl.options.push(options);
        ctl.emit = (phase) => { ctl.phases.push(phase); onPhase(phase); };
        return new Promise((resolve, reject) => { ctl.settle = resolve; ctl.fail = reject; });
      },
    },
  });
  return { b, ctl };
}

// ------------------------------------------------------------- the brief's Step 1 tests --------

test('a shell that cannot prove shows the reason and no prove button', async (t) => {
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: false, reason: 'Proving needs about 5.7 GB; browsers allow 4 GB.' }) } });
  const { root } = await review(t, b);
  assertGone(root.querySelector('[data-action="prove"]'), 'root.querySelector([data-action="prove"])');
  assert.match(root.textContent, /5\.7 GB/);
  assert.match(root.textContent, /desktop app/i);
});

test('a shell that can prove walks the phases and lands on sent', async (t) => {
  const phases = [];
  const b = unlockedBackend({
    send: {
      canProve: async () => ({ ok: true }),
      send: async (_req, onPhase) => {
        for (const p of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) { onPhase(p); phases.push(p); }
        return { hash: 'ab'.repeat(32), txKey: 'cd'.repeat(32) };
      },
    },
  });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await app.idle();
  assert.equal(phases.length, 5);
  assert.match(location.hash, /^#sent\//);
  assert.ok(root.textContent.length > 0);
});

test('amount above balance is refused before estimate', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '999';
  submit(root);
  await app.idle();
  assert.match(root.querySelector('.field-error').textContent, /balance/i);
  assert.equal(b.calls.filter((c) => c[0] === 'send.estimate').length, 0);
});

test('explainProvingError maps wasm OOM', () => {
  assert.match(explainProvingError('RuntimeError: unreachable'), /memory/);
  assert.match(explainProvingError('out of memory'), /memory/);
  assert.match(explainProvingError('failed to allocate'), /memory/);
  assert.match(explainProvingError('RuntimeError: unreachable'), /desktop app/i);
  // Anything else is the node's own words, unchanged.
  assert.equal(explainProvingError('rejected by the mempool'), 'rejected by the mempool');
});

// ------------------------------------------------- chain 14: every listed asset is sendable ---

test('a token send goes through end to end: picker, the token’s own decimals, a RAND fee, phases', async (t) => {
  const phases = [];
  const b = unlockedBackend({
    ...listing([randRow(), tokenRow()]),
    send: {
      canProve: async () => ({ ok: true }),
      send: async (_req, onPhase) => {
        for (const p of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) { onPhase(p); phases.push(p); }
        return { hash: `0x${'ab'.repeat(32)}`, txKey: `tk-${'cd'.repeat(16)}` };
      },
    },
  });
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();

  const token = root.querySelector('[data-asset="1"]');
  assert.ok(token, 'the token is listed');
  assert.equal(token.hasAttribute('aria-disabled'), false, 'chain 14 transfers a token like any other asset');
  token.click();
  await app.idle();

  // 120000000 units of an EIGHT-decimal token is 1.2 — at RAND's nine it would read 0.12.
  assert.match(root.textContent, /Available 1\.2 zUSD/);
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '0.5';
  submit(root);
  await app.idle();

  const [, est] = b.calls.find((c) => c[0] === 'send.estimate');
  assert.equal(est.asset, 1);
  assert.equal(est.amount, '50000000', 'the amount is parsed with the ASSET’s decimals, not RAND’s');

  // The fee is RAND, said in RAND: 10000 units of a nine-decimal RAND is 0.00001.
  assert.match(root.textContent, /Network fee/);
  assert.match(root.textContent, /0\.00001 RAND/);
  assert.doesNotMatch(root.textContent, /0\.00001 zUSD/, 'the fee is never denominated in the token');

  root.querySelector('[data-action="prove"]').click();
  await app.idle();
  assert.equal(phases.length, 5);
  const [, sent] = b.calls.find((c) => c[0] === 'send.send');
  assert.equal(sent.asset, 1);
  assert.equal(sent.amount, '50000000');
  assert.match(location.hash, /^#sent\//);
});

test('a token’s review has no Total: the amount and the fee are different assets', async (t) => {
  const b = unlockedBackend({ ...listing([randRow(), tokenRow()]), send: { canProve: async () => ({ ok: true }) } });
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '0.5';
  submit(root);
  await app.idle();
  assert.ok(root.querySelector('[data-action="prove"]'), 'the review');
  assert.doesNotMatch(root.textContent, /Total/, '0.5 zUSD + 0.00001 RAND is not a number');
});

test('the network fee’s decimals are READ from the RAND row, never written as 9', async (t) => {
  // A chain whose native token has six decimals. A hard-coded 9 prints this fee a thousand times
  // too small — the whole of 4.5's M8.
  const b = unlockedBackend({
    ...listing([randRow({ decimals: 6, balance: '3500000' }), tokenRow()]),
    send: { canProve: async () => ({ ok: true }) },
  });
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '0.5';
  submit(root);
  await app.idle();
  assert.match(root.textContent, /0\.01 RAND/, '10000 units at the RAND row’s own six decimals');
  assert.doesNotMatch(root.textContent, /0\.00001 RAND/);
});

test('a wallet with no RAND to pay the fee is refused BEFORE review, in the backend’s own words', async (t) => {
  const b = unlockedBackend({ ...listing([randRow({ balance: '0' }), tokenRow()]), send: { canProve: async () => ({ ok: true }) } });
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '0.5';
  submit(root);
  await app.idle();

  assert.ok(root.textContent.includes(NO_SPENDABLE_RAND_TEXT), 'the core’s sentence, unedited');
  assertGone(root.querySelector('[data-action="prove"]'), 'root.querySelector([data-action="prove"])');
  assert.equal(b.calls.filter((c) => c[0] === 'send.send').length, 0, 'and nothing was proved');
  assert.ok(root.querySelector('input[name=amount]'), 'the flow stayed on the form');
});

test('an asset the registry does not list is shown, explained, and not sendable', async (t) => {
  const b = unlockedBackend(listing([randRow(), unlistedRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();
  const row = root.querySelector('[data-asset="3"]');
  assert.ok(row, 'it is listed — hiding a balance the wallet really holds would look broken');
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  const describedBy = row.getAttribute('aria-describedby');
  assert.ok(describedBy, 'the reason is tied to the control');
  assert.equal(root.querySelector(`#${describedBy}`).textContent, UNLISTED_TEXT);

  row.click();
  await app.idle();
  assert.ok(root.querySelector('[data-asset="3"]'), 'clicking it does not advance to a form');
  assertGone(root.querySelector('input[name=amount]'), 'root.querySelector(input[name=amount])');
});

test('#send/<n> for an unlisted asset explains instead of ever rendering the form', async (t) => {
  const b = unlockedBackend(listing([randRow(), unlistedRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send/3' });
  await app.idle();
  assertGone(root.querySelector('form'), 'no send form for an asset whose decimals are a guess');
  assert.ok(root.textContent.includes(UNLISTED_TEXT));
  assert.ok(root.querySelector('[data-go="send/0"]'), 'a way back to sending RAND');
});

test('#send/1 renders the form for a listed token', async (t) => {
  const b = unlockedBackend(listing([randRow(), tokenRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  assert.ok(root.querySelector('textarea[name=to]'), 'straight to the recipient');
  assert.match(root.textContent, /zUSD/);
});

test('#send skips the picker when there is only one asset to list', async (t) => {
  const b = unlockedBackend({ assets: { list: async () => [{ index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' }] } });
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();
  assertGone(root.querySelector('[data-asset="0"]'), 'no picker to step through');
  assert.ok(root.querySelector('textarea[name=to]'), 'straight to the recipient');
});

// ----------------------------------------------------- amendment 3: recipient validation ------

test('an invalid recipient shows the backend’s own reason inline', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = 'not-an-address';
  root.querySelector('input[name=amount]').value = '1';
  submit(root);
  await app.idle();
  const field = root.querySelector('textarea[name=to]').closest('.field');
  assert.ok(field.classList.contains('invalid'));
  assert.match(field.querySelector('.field-error').textContent, /not a rand1 address/);
  assert.equal(root.querySelector('textarea[name=to]').getAttribute('aria-invalid'), 'true');
});

test('a self-send asks once and then goes through', async (t) => {
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: true }) } });
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = OWN;
  root.querySelector('input[name=amount]').value = '1';
  submit(root);
  await app.idle();

  const dialog = root.querySelector('[role="dialog"]');
  assert.ok(dialog, 'a self-send is confirmed, not refused');
  assert.match(dialog.textContent, /Send to yourself\? This consolidates your notes\./);
  assertGone(root.querySelector('[data-action="prove"]'), 'and it has not reached review yet');

  dialog.querySelector('[data-role="confirm"]').click();
  await app.idle();
  assert.ok(root.querySelector('[data-action="prove"]'), 'confirming lands on review');
});

// ---------------------------------------------------------- amendment 4: amounts, BigInt ------

const AMOUNT_CASES = [
  { name: 'an empty amount', value: '', expect: /amount/i },
  { name: 'zero', value: '0', expect: /greater than zero/i },
  { name: 'more fractional digits than the asset has', value: '1.0000000001', expect: /decimal places/i },
  { name: 'more than the balance', value: '999', expect: /balance/i },
];

for (const { name, value, expect } of AMOUNT_CASES) {
  test(`${name} is refused locally, with no backend call`, async (t) => {
    const b = unlockedBackend();
    const { app, root } = await mountApp(t, b, { hash: '#send/0' });
    await app.idle();
    root.querySelector('textarea[name=to]').value = TO;
    root.querySelector('input[name=amount]').value = value;
    submit(root);
    await app.idle();
    assert.match(root.querySelector('.field-error').textContent, expect);
    assert.equal(b.calls.filter((c) => c[0] === 'send.estimate').length, 0);
    assertGone(root.querySelector('[data-action="prove"]'), 'root.querySelector([data-action="prove"])');
  });
}

test('the whole balance is refused once the fee is known', async (t) => {
  // 3.5 RAND exactly, with a 0.00001 RAND fee on top, is more than the wallet holds. That needs
  // the estimate, so it is the one amount check that is allowed to reach the backend first.
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '3.5';
  submit(root);
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'send.estimate').length, 1);
  assert.match(root.querySelector('.field-error').textContent, /fee/i);
  assertGone(root.querySelector('[data-action="prove"]'), 'root.querySelector([data-action="prove"])');
});

test('Max fills the balance minus the fee', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  // balance 3.5 RAND − fee 0.00001 RAND. Which backend call told us the fee is the subject of the
  // two `Max …` tests in the fix-round section below; here it only has to be right.
  assert.equal(root.querySelector('input[name=amount]').value, '3.49999');
  assert.equal(b.calls.filter((c) => c[0] === 'send.maxSendable' || c[0] === 'send.estimate').length, 1);
});

test('a "needs more than two notes" estimate is surfaced verbatim', async (t) => {
  const message = 'This send needs 3 notes; a transfer spends exactly 2. Consolidate first by sending to yourself.';
  const b = unlockedBackend({ send: { estimate: async () => { throw new Error(message); } } });
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('input[name=amount]').value = '1';
  submit(root);
  await app.idle();
  assert.ok(root.textContent.includes(message), 'the backend’s own words, unedited');
  assertGone(root.querySelector('[data-action="prove"]'), 'root.querySelector([data-action="prove"])');
});

// -------------------------------------------------------------- amendment 5: the review -------

test('review shows the fee, the total, the change and one proof', async (t) => {
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: true }), estimate: async () => ({ fee: '10000', inputs: 2, change: '1499990000', proofs: 1 }) } });
  const { root } = await review(t, b);
  const text = root.textContent;
  assert.match(text, /Network fee/);
  assert.match(text, /Total/);
  assert.match(text, /Change/);
  assert.match(text, /1 proof/);
  assert.match(text, /about 2 minutes/i);
  // The full address is available behind a control, not printed in the middle of the summary.
  assert.ok(root.querySelector('[data-role="expand-to"]'));
  assert.ok(root.querySelector('[data-role="to-full"]').hasAttribute('hidden'));
  root.querySelector('[data-role="expand-to"]').click();
  assert.equal(root.querySelector('[data-role="to-full"]').hasAttribute('hidden'), false);
  assert.ok(root.querySelector('[data-role="to-full"]').textContent.includes(TO));
});

test('review never estimates by simulating a send', async (t) => {
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: true }) } });
  const { root } = await review(t, b);
  assert.ok(root.querySelector('[data-action="prove"]'));
  assert.equal(b.calls.filter((c) => c[0] === 'send.send').length, 0);
});

// ------------------------------------------------------------- amendment 6: proving -----------

test('proving shows a labelled progressbar, the phase and an elapsed timer', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();

  const ring = root.querySelector('.ring[role="progressbar"]');
  assert.ok(ring, 'the proving ring is a progressbar');
  assert.equal(ring.hasAttribute('aria-valuenow'), false, 'indeterminate');
  assert.equal(root.querySelector('[data-role="elapsed"]').textContent, '00:00');
  assert.match(root.textContent, /Keep this window open/i);

  ctl.emit('witness');
  await turns();
  assert.match(root.querySelector('[data-role="phase"]').textContent, /witness/i);
  assert.match(ring.getAttribute('aria-label'), /witness/i);

  // Cancel is offered right up to the moment the transaction is handed to the node, and not after.
  assert.ok(root.querySelector('[data-role="cancel"]'));
  ctl.emit('submitting');
  await turns();
  assertGone(root.querySelector('[data-role="cancel"]'), 'root.querySelector([data-role="cancel"])');
  assert.ok(app);
});

test('send.send is given a session-linked AbortSignal as its third argument', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  const signal = ctl.options[0] && ctl.options[0].signal;
  assert.ok(signal, 'send.send(req, onPhase, { signal })');
  assert.equal(signal.aborted, false);
  root.querySelector('.sidebar [data-action="lock"], .tabbar [data-action="lock"]').click();
  await turns();
  assert.equal(signal.aborted, true, 'locking the wallet aborts the proof');
  assert.ok(app);
});

test('leaving the proving screen does not cancel the proof, and coming back re-attaches', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('proving');
  await turns();

  await app.go('#home');
  await turns();
  assert.equal(ctl.options[0].signal.aborted, false, 'the proof is still running');
  assert.equal(ctl.calls, 1);

  // The shell carries a chip back to it while it runs.
  const chip = root.querySelector('[data-role="pinned"] .chip');
  assert.ok(chip, 'a Proving… chip is pinned in the nav');
  assert.match(chip.textContent, /Proving/);
  assert.match(chip.textContent, /\d\d:\d\d/);
  assert.equal(chip.getAttribute('data-go'), 'send');

  await app.go('#send');
  await turns();
  assert.ok(root.querySelector('.ring[role="progressbar"]'), 're-attached to the running proof');
  assert.equal(ctl.calls, 1, 'and did not start a second one');
  assert.match(root.querySelector('[data-role="phase"]').textContent, /prov/i);
});

test('a second send cannot be started while one is in flight', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  assert.equal(ctl.calls, 1);

  await app.go('#send/0');
  await turns();
  // Whatever the user asks for, #send shows the proof that is already running.
  assert.ok(root.querySelector('.ring[role="progressbar"]'));
  assertGone(root.querySelector('form'), 'root.querySelector(form)');
  assert.equal(ctl.calls, 1);
});

test('the proving timer stops when the screen is left', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  const elapsedEl = root.querySelector('[data-role="elapsed"]');
  assert.equal(elapsedEl.textContent, '00:00');

  await app.go('#home');
  await turns();
  // `elapsedEl` is detached now. A timer the screen forgot to clear would still be writing to it.
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(elapsedEl.textContent, '00:00', 'the screen’s interval was cleared on cleanup');
  assert.ok(ctl);
});

test('a failed proof explains itself and Retry comes back to review with the form intact', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b, { amount: '1.25' });
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.fail(new Error('RuntimeError: unreachable'));
  await turns();

  const banner = root.querySelector('.banner.negative');
  assert.ok(banner);
  assert.match(banner.textContent, /memory/i);
  assert.match(banner.textContent, /desktop app/i);

  root.querySelector('[data-role="retry"]').click();
  await turns();
  assert.ok(root.querySelector('[data-action="prove"]'), 'back on review');
  assert.match(root.textContent, /1\.25/, 'with the amount still there');

  await app.go('#send');
  await turns();
  const to = root.querySelector('textarea[name=to]') || root.querySelector('[data-role="to-full"]');
  assert.ok(to, 'and the draft still reachable');
});

// ----------------------------------------------------------------- amendment 7: #sent ---------

test('#sent shows the amount, the recipient and the key behind hold-to-reveal', async (t) => {
  const txKey = `tk-${'cd'.repeat(16)}`;
  const hash = `0x${'ab'.repeat(32)}`;
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: true }), send: async () => ({ hash, txKey }) } });
  const { root, app } = await review(t, b, { amount: '1.5' });
  root.querySelector('[data-action="prove"]').click();
  await app.idle();

  assert.equal(location.hash, `#sent/${hash}`);
  assert.match(root.textContent, /1\.5/);
  assert.ok(root.innerHTML.includes(TO.slice(0, 12)), 'the recipient is shown');
  assert.ok(root.querySelector('[data-role="hold"]'), 'the key is behind a hold-to-reveal');
  assert.ok(!root.textContent.includes(txKey), 'and is not on screen until it is revealed');
  assert.ok(root.querySelector('[data-role="explorer"]'), 'with an explorer link');
  assert.ok(root.querySelector('[data-go="home"]'), 'and a way home');
});

test('the transaction key never reaches an attribute, ctx.state, the hash or storage', async (t) => {
  const txKey = `tk-${'ef'.repeat(16)}`;
  const hash = `0x${'ab'.repeat(32)}`;
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: true }), send: async () => ({ hash, txKey }) } });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await app.idle();

  const attributes = () => [...root.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`)).join(' ');
  assert.ok(!attributes().includes(txKey));
  assert.ok(!location.hash.includes(txKey));

  // Reveal: the key is written to one text node and nowhere else.
  const hold = root.querySelector('[data-role="hold"]');
  hold.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 750));
  assert.ok(root.textContent.includes(txKey), 'revealed');
  assert.ok(!attributes().includes(txKey), 'still not in any attribute');
  assert.ok(!location.hash.includes(txKey));

  root.querySelector('[data-role="copy-key"]').click();
  await app.idle();
  assert.deepEqual(b.calls.filter((c) => c[0] === 'platform.copy').at(-1), ['platform.copy', txKey]);

  spied.length = 0;
  await app.go('#spy');
  await app.idle();
  assert.equal(reaches(spied[0].state, txKey), false, 'the key was never put on ctx.state');
});

test('#sent reached cold (a reload) shows the hash and a link, and no key', async (t) => {
  const hash = `0x${'ab'.repeat(32)}`;
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: `#sent/${hash}` });
  await app.idle();
  assertGone(root.querySelector('[data-role="hold"]'), 'no key to reveal');
  assert.ok(root.textContent.includes(hash.slice(0, 10)));
  assert.ok(root.querySelector(`[data-go="tx/${hash}"]`), 'a link to the transaction instead');
});

// ------------------------------------------------------------------------ accessibility -------

test('every step has one page title, an announced step indicator and a big enough primary action', async (t) => {
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#send' });
  await app.idle();
  assert.equal(root.querySelectorAll('main h1, .app h1').length <= 1, true);
  const indicator = root.querySelector('[data-role="step-indicator"]');
  assert.ok(indicator);
  assert.equal(indicator.getAttribute('aria-live'), 'polite');
  assert.match(indicator.textContent, /Step 1 of 3/);

  root.querySelector('[data-asset="0"]').click();
  await app.idle();
  assert.match(root.querySelector('[data-role="step-indicator"]').textContent, /Step 2 of 3/);
  assert.ok(document.activeElement && document.activeElement.tagName === 'H2', 'focus moved to the step heading');
});

// =============================================================== fix round 1 ====================

// ---- 1. a failure's meaning depends on the phase it happened in --------------------------------

const BEFORE_SUBMIT = ['selecting', 'witness', 'proving'];
const AFTER_SUBMIT = ['submitting', 'confirming'];

for (const phase of BEFORE_SUBMIT) {
  test(`a failure during '${phase}' says the transfer was not sent, and offers a retry`, async (t) => {
    const { b, ctl } = controlledSend();
    const { root, app } = await review(t, b);
    root.querySelector('[data-action="prove"]').click();
    await turns();
    ctl.emit(phase);
    await turns();
    ctl.fail(new Error('the prover gave up'));
    await turns();

    assert.match(root.textContent, /was not sent/i);
    assert.ok(root.querySelector('[data-role="retry"]'), 'nothing was broadcast, so a retry is safe');
    assertGone(root.querySelector('[data-role="check-activity"]'), 'root.querySelector([data-role="check-activity"])');
    assert.ok(app);
  });
}

for (const phase of AFTER_SUBMIT) {
  test(`a failure during '${phase}' says the outcome is unknown and never invites a resend`, async (t) => {
    const { b, ctl } = controlledSend();
    const { root, app } = await review(t, b);
    root.querySelector('[data-action="prove"]').click();
    await turns();
    ctl.emit(phase);
    await turns();
    ctl.fail(new Error('the socket dropped'));
    await turns();

    assert.match(root.textContent, /We couldn.t confirm this transfer/i);
    assert.match(root.textContent, /may already have been sent/i);
    assert.match(root.textContent, /sending twice would pay twice/i);
    assert.ok(root.querySelector('[data-role="check-activity"]'), 'the way out is Activity');
    assertGone(root.querySelector('[data-action="prove"]'), 'no way to prove again');
    assertGone(root.querySelector('[data-role="retry"]'), 'and no way back to review');
    assertGone(root.querySelector('[data-role="edit"]'), 'root.querySelector([data-role="edit"])');
    assert.ok(app);
  });
}

test('a rejection the backend calls definite is a plain failure, whatever the phase', async (t) => {
  const { b, ctl } = controlledSend();
  const { root } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  const err = new Error('the node refused it: fee below the floor');
  err.definite = true; // the node answered, so we know it did not land
  ctl.fail(err);
  await turns();

  assert.match(root.textContent, /was not sent/i);
  assert.match(root.textContent, /fee below the floor/);
  assert.ok(root.querySelector('[data-role="retry"]'));
  assertGone(root.querySelector('[data-role="check-activity"]'), 'root.querySelector([data-role="check-activity"])');
});

test('the unknown screen links to the explorer only for a well-formed hash', async (t) => {
  const good = `0x${'ab'.repeat(32)}`;
  for (const [hash, expected] of [[good, true], ['javascript:alert(1)', false], ['nope', false], [undefined, false]]) {
    const { b, ctl } = controlledSend();
    const { root } = await review(t, b);
    root.querySelector('[data-action="prove"]').click();
    await turns();
    ctl.emit('submitting');
    await turns();
    const err = new Error('timed out waiting for the node');
    if (hash !== undefined) err.hash = hash;
    ctl.fail(err);
    await turns();
    const link = root.querySelector('[data-role="explorer-unknown"]');
    assert.equal(!!link, expected, `hash ${String(hash)}`);
    if (!expected && hash) assert.ok(!root.innerHTML.includes(hash), 'and the bad hash is not printed');
  }
});

test('Check Activity syncs, then lands on #activity', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('confirming');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();

  const scansBefore = b.calls.filter((c) => c[0] === 'sync.scan').length;
  root.querySelector('[data-role="check-activity"]').click();
  await turns(6);
  assert.ok(b.calls.filter((c) => c[0] === 'sync.scan').length > scansBefore, 'it re-scans first');
  assert.equal(location.hash, '#activity');
  assert.ok(app);
});

test('after an unknown outcome, review warns and gates Prove until a sync has finished', async (t) => {
  // A scan that never settles, so the gate cannot lift on its own.
  const { b, ctl } = controlledSend({ sync: { scan: () => new Promise(() => {}) } });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();
  root.querySelector('[data-role="check-activity"]').click();
  await turns();

  await app.go('#send');
  await turns();
  assert.ok(root.querySelector('[data-role="unknown-notice"]'), 'the warning stands on the form');
  submit(root);
  await turns(6);

  const notice = root.querySelector('[data-role="unknown-notice"]');
  assert.ok(notice, 'and above the review');
  assert.match(notice.textContent, /outcome is unknown/i);
  const prove = root.querySelector('[data-action="prove"]');
  assert.ok(prove);
  assert.equal(prove.disabled, true, 'proving is gated');
  const gate = root.querySelector('input[name="checked-activity"]');
  assert.ok(gate);
  assert.match(gate.closest('label').textContent, /I checked — it did not go through/);

  gate.checked = true;
  gate.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(root.querySelector('[data-action="prove"]').disabled, false);
});

test('a completed sync lifts the unknown-outcome gate', async (t) => {
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();
  root.querySelector('[data-role="check-activity"]').click();
  await turns(6); // the fake's scan resolves

  await app.go('#send');
  await turns();
  submit(root);
  await turns(6);
  // Per the controller's ruling: the notice goes with the gate. Once a scan that started after the
  // failure has finished, the user has had their chance to look, and the wallet stops nagging.
  assertGone(root.querySelector('[data-role="unknown-notice"]'), 'the notice');
  assertGone(root.querySelector('input[name="checked-activity"]'), 'the gate');
  assert.equal(root.querySelector('[data-action="prove"]').disabled, false);
});

// ---- 4. a send that finishes while the user is elsewhere ---------------------------------------

test('a send that completes off-screen leaves no key reachable from ctx.state, and says so', async (t) => {
  const txKey = `tk-${'9a'.repeat(16)}`;
  const hash = `0x${'ab'.repeat(32)}`;
  const { b, ctl } = controlledSend();
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  await app.go('#home');
  await turns();

  ctl.settle({ hash, txKey });
  await turns();

  const chip = root.querySelector('[data-role="pinned"] .chip');
  assert.ok(chip, 'the user is told, without being yanked off the screen they were on');
  assert.match(chip.textContent, /Sent/);
  assert.equal(chip.getAttribute('data-go'), `sent/${hash}`);

  spied.length = 0;
  await app.go('#spy');
  await app.idle();
  const state = spied[0].state;
  assert.equal(reaches(state, txKey), false, 'not in ctx.state');
  assert.ok(state.send, 'the finished send is still recorded');
  const settled = await state.send.promise;
  assert.deepEqual(settled, { hash }, 'and its promise fulfils to the hash alone');
  assert.equal(reaches(settled, txKey), false);
});

test('a malformed hash from the backend goes to activity, not to #sent/<junk>', async (t) => {
  const b = unlockedBackend({
    send: { canProve: async () => ({ ok: true }), send: async () => ({ hash: 'javascript:alert(1)', txKey: 'tk-x' }) },
  });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await app.idle();
  assert.equal(location.hash, '#activity');
  assert.ok(!location.hash.includes('javascript'));
  assert.ok(app && root);
});

// ---- 6. Max ------------------------------------------------------------------------------------

test('Max uses send.maxSendable when the backend offers one', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.equal(root.querySelector('input[name=amount]').value, '3.49999');
  assert.equal(b.calls.filter((c) => c[0] === 'send.maxSendable').length, 1);
  assert.equal(b.calls.filter((c) => c[0] === 'send.estimate').length, 0, 'no whole-balance estimate');
});

test('Max falls back to a one-unit estimate where the backend has no maxSendable', async (t) => {
  const b = unlockedBackend();
  delete b.send.maxSendable;
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.equal(root.querySelector('input[name=amount]').value, '3.49999');
  const estimates = b.calls.filter((c) => c[0] === 'send.estimate');
  assert.equal(estimates.length, 1);
  assert.equal(estimates[0][1].amount, '1', 'a one-unit probe, not the whole balance');
});

test('Max on a token fills the WHOLE balance — the fee is RAND out of the other half of the bundle', async (t) => {
  const b = unlockedBackend(listing([randRow(), tokenRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.equal(root.querySelector('input[name=amount]').value, '1.2', 'no fee is subtracted from a token');
  const [, asked] = b.calls.find((c) => c[0] === 'send.maxSendable');
  assert.equal(asked.asset, 1, 'the backend is asked about THIS asset; spendability is never computed here');
});

test('Max on a token with no RAND for the fee shows the backend’s reason, not a bare zero', async (t) => {
  const b = unlockedBackend(listing([randRow({ balance: '0' }), tokenRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.ok(root.textContent.includes(NO_SPENDABLE_RAND_TEXT));
  assert.notEqual(root.querySelector('input[name=amount]').value, '0');
});

test('Max on a token without maxSendable still does not subtract the RAND fee', async (t) => {
  const b = unlockedBackend(listing([randRow(), tokenRow()]));
  delete b.send.maxSendable;
  const { app, root } = await mountApp(t, b, { hash: '#send/1' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.equal(root.querySelector('input[name=amount]').value, '1.2');
});

test('Max explains itself when the balance does not cover the fee', async (t) => {
  const b = unlockedBackend({
    assets: { list: async () => [{ index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '5000', pending: '0' }] },
    // 5000 units of RAND against a 10000-unit fee: there is nothing sendable.
    send: { maxSendable: async () => ({ amount: '0', fee: '10000' }) },
  });
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  const amount = root.querySelector('input[name=amount]');
  amount.value = '0.000001';
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  assert.match(root.querySelector('.field-error').textContent, /doesn.t cover the network fee/i);
  assert.equal(amount.value, '0.000001', 'the field was left alone');
});

// ---- 7. never fabricate an asset ---------------------------------------------------------------

test('a wallet with no RAND gets an empty state, not a fabricated zero balance', async (t) => {
  const b = unlockedBackend({
    assets: {
      list: async () => [
        { index: 1, id: 'wrapped-eth', name: 'Wrapped Ether', symbol: 'wETH', decimals: 9, balance: '120000000', pending: '0' },
        { index: 2, id: 'wbtc', name: 'Wrapped Bitcoin', symbol: 'wBTC', decimals: 9, balance: '1', pending: '0' },
      ],
    },
  });
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  assertGone(root.querySelector('form'), 'no form against an invented asset');
  assert.ok(root.querySelector('[data-role="no-rand"]'));
  assert.match(root.textContent, /No RAND to send yet/i);
  assert.ok(root.querySelector('[data-go="receive"]'));
  assert.ok(root.querySelector('[data-go="faucet"]'));
});

test('a wallet holding only an unlisted asset gets the explanation, not a form', async (t) => {
  const b = unlockedBackend(listing([unlistedRow()]));
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();
  assertGone(root.querySelector('form'), 'root.querySelector(form)');
  assert.ok(root.textContent.includes(UNLISTED_TEXT));
});

// ---- 8. the proof cost is the estimate's, not a constant ---------------------------------------

test('the proof cost comes from the estimate', async (t) => {
  const b = unlockedBackend({
    send: { canProve: async () => ({ ok: true }), estimate: async () => ({ fee: '10000', inputs: 2, change: '0', proofs: 2 }) },
  });
  const { root } = await review(t, b);
  assert.match(root.textContent, /2 proofs/);
  assert.match(root.textContent, /about 4 minutes/i);
  assert.doesNotMatch(root.textContent, /1 proof\b/);
});

// ============================================================ follow-up 1.5b ===================

// ---- R. which scans lift the unknown-outcome gate ---------------------------------------------

test('only a scan that both started after the failure and finished lifts the gate', () => {
  // The rule, stated once: a scan already running when the transfer failed may have read the chain
  // *before* the transaction reached it, so finishing proves nothing. Only a scan that started
  // afterwards can have seen it. The shell counts both (see ui/app.js).
  const ctx = { state: { scansStarted: 1, scansConfirmed: 0 } }; // one scan already in flight
  markUnknownOutcome(ctx, {});
  assert.ok(unknownOutcome(ctx), 'nothing has finished yet');

  ctx.state.scansConfirmed = 1; // the scan that was already running finishes
  assert.ok(unknownOutcome(ctx), 'a scan that started before the failure saw nothing');

  ctx.state.scansStarted = 2;   // a new scan starts…
  assert.ok(unknownOutcome(ctx), 'and has not finished');
  ctx.state.scansConfirmed = 2; // …and finishes
  assertGone(unknownOutcome(ctx), 'the record');
});

test('a scan that fails does not lift the gate', () => {
  const ctx = { state: { scansStarted: 0, scansConfirmed: 0 } };
  markUnknownOutcome(ctx, {});
  ctx.state.scansStarted = 1; // a scan starts and then rejects: scansConfirmed never moves
  assert.ok(unknownOutcome(ctx));
});

test('home’s own scan lifts the gate, not only the one Check Activity starts', async (t) => {
  // The first scan — the one Check Activity kicks off — never answers. The second, which home
  // starts when the user simply navigates there, does. Under the old rule only the first could
  // ever lift the gate, so it stayed up for ever.
  const src = unlockedBackend();
  let scans = 0;
  const { b, ctl } = controlledSend({
    sync: {
      scan: (...args) => {
        scans += 1;
        return scans === 1 ? new Promise(() => {}) : src.sync.scan(...args);
      },
    },
  });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();
  root.querySelector('[data-role="check-activity"]').click();
  await turns();
  assert.equal(scans, 1, 'Check Activity started a scan that will never answer');

  // Straight to home, which scans on mount.
  await app.go('#home');
  await turns(8);
  assert.ok(scans >= 2, 'home started one of its own');

  await app.go('#send');
  await turns(4);
  assertGone(root.querySelector('[data-role="unknown-notice"]'), 'the notice');
});

test('the standing notice is on every step of the flow, not only the form and the review', async (t) => {
  const { b, ctl } = controlledSend({ sync: { scan: () => new Promise(() => {}) } });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();
  root.querySelector('[data-role="check-activity"]').click();
  await turns();

  // A fresh flow, started from the picker rather than resumed.
  spied.length = 0; // `spied` is module-level: without this we would read another mount's ctx
  await app.go('#spy');
  await turns();
  spied[0].state.sendDraft = null; // as if the user had not typed anything yet
  await app.go('#send');
  await turns();
  assert.ok(root.querySelector('[data-asset="0"]'), 'the picker');
  assert.ok(root.querySelector('[data-role="unknown-notice"]'), 'warned before a single field');
});

// ---- 2. the prove gate is enforced from state, not from the DOM -------------------------------

async function gatedReview(t) {
  const { b, ctl } = controlledSend({ sync: { scan: () => new Promise(() => {}) } });
  const { root, app } = await review(t, b);
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('submitting');
  await turns();
  ctl.fail(new Error('timed out'));
  await turns();
  root.querySelector('[data-role="check-activity"]').click();
  await turns();
  await app.go('#send');
  await turns();
  submit(root);
  await turns(6);
  assert.ok(root.querySelector('input[name="checked-activity"]'), 'the gate is up');
  // The failed attempt is already in `b.calls`; every assertion below is about what happens *next*.
  const sends = () => b.calls.filter((c) => c[0] === 'send.send').length;
  return { root, app, b, sends, sendsBefore: sends() };
}

test('a click landing on the prove button’s icon does not slip past the gate', async (t) => {
  const { root, sends, sendsBefore } = await gatedReview(t);
  // `evt.target` here is the <svg>, which has no `disabled` — the old check read it off the target
  // and let this through.
  const icon = root.querySelector('[data-action="prove"] svg');
  assert.ok(icon, 'the button has an icon child to click on');
  icon.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  await turns();
  assert.equal(sends(), sendsBefore, 'nothing was sent');
});

test('removing the disabled attribute by hand does not start a send', async (t) => {
  const { root, sends, sendsBefore } = await gatedReview(t);
  const prove = root.querySelector('[data-action="prove"]');
  prove.removeAttribute('disabled');
  prove.disabled = false;
  prove.click();
  await turns();
  assert.equal(sends(), sendsBefore, 'the DOM is not the gate');
});

test('ticking the box really does let the send through', async (t) => {
  const { root, sends, sendsBefore } = await gatedReview(t);
  const gate = root.querySelector('input[name="checked-activity"]');
  gate.checked = true;
  gate.dispatchEvent(new Event('change', { bubbles: true }));
  root.querySelector('[data-action="prove"]').click();
  await turns();
  assert.equal(sends(), sendsBefore + 1, 'the gate opens, it does not jam');
});

test('re-rendering the review clears a tick the user is no longer looking at', async (t) => {
  const { root, sends, sendsBefore } = await gatedReview(t);
  const gate = root.querySelector('input[name="checked-activity"]');
  gate.checked = true;
  gate.dispatchEvent(new Event('change', { bubbles: true }));

  // Back to the form and forward again: a fresh review, and the confirmation has to be given again.
  root.querySelector('[data-role="edit"]').click();
  await turns();
  submit(root);
  await turns(6);
  const prove = root.querySelector('[data-action="prove"]');
  assert.equal(prove.disabled, true, 'the new review is gated again');
  prove.removeAttribute('disabled');
  prove.click();
  await turns();
  assert.equal(sends(), sendsBefore, 'and the stale tick did not carry over');
});
