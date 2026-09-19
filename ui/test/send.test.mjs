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
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { explainProvingError } from '../screens/send.js';
import { RPL_SEND_DISABLED_TEXT } from '../screens/asset.js';

const TO = `rand1${'p'.repeat(40)}`;
const OWN = `rand1${'q'.repeat(40)}`; // unlockedBackend()'s own address
const turns = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

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
  const b = unlockedBackend({ send: { canProve: async () => ({ ok: false, reason: 'Proving needs about 5.5 GB; browsers allow 4 GB.' }) } });
  const { root } = await review(t, b);
  assert.equal(root.querySelector('[data-action="prove"]'), null);
  assert.match(root.textContent, /5\.5 GB/);
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

// --------------------------------------------------------------- amendment 2: RAND only -------

test('the asset picker lists RPL assets, disabled, with the shared explanation', async (t) => {
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#send' });
  await app.idle();
  const rand = root.querySelector('[data-asset="0"]');
  const rpl = root.querySelector('[data-asset="1"]');
  assert.ok(rand, 'RAND is offered');
  assert.equal(rand.hasAttribute('aria-disabled'), false);
  assert.ok(rpl, 'the RPL asset is listed, not hidden');
  assert.equal(rpl.getAttribute('aria-disabled'), 'true');
  assert.ok(root.textContent.includes(RPL_SEND_DISABLED_TEXT));
  const describedBy = rpl.getAttribute('aria-describedby');
  assert.ok(describedBy, 'the reason is tied to the control');
  assert.equal(root.querySelector(`#${describedBy}`).textContent, RPL_SEND_DISABLED_TEXT);
});

test('#send/1 explains instead of ever rendering the form', async (t) => {
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#send/1' });
  await app.idle();
  assert.equal(root.querySelector('form'), null, 'no send form for an RPL asset');
  assert.equal(root.querySelector('textarea[name=to]'), null);
  assert.ok(root.textContent.includes(RPL_SEND_DISABLED_TEXT));
  assert.ok(root.querySelector('[data-go="send/0"]'), 'a way back to sending RAND');
});

test('#send skips the picker when there is only one asset to list', async (t) => {
  const b = unlockedBackend({ assets: { list: async () => [{ index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' }] } });
  const { app, root } = await mountApp(t, b, { hash: '#send' });
  await app.idle();
  assert.equal(root.querySelector('[data-asset="0"]'), null, 'no picker to step through');
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
  assert.equal(root.querySelector('[data-action="prove"]'), null, 'and it has not reached review yet');

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
    assert.equal(root.querySelector('[data-action="prove"]'), null);
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
  assert.equal(root.querySelector('[data-action="prove"]'), null);
});

test('Max fills the balance minus the fee', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#send/0' });
  await app.idle();
  root.querySelector('textarea[name=to]').value = TO;
  root.querySelector('[data-role="max"]').click();
  await app.idle();
  // balance 3.5 RAND − fee 0.00001 RAND
  assert.equal(root.querySelector('input[name=amount]').value, '3.49999');
  assert.equal(b.calls.filter((c) => c[0] === 'send.estimate').length, 1);
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
  assert.equal(root.querySelector('[data-action="prove"]'), null);
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
  assert.equal(root.querySelector('[data-role="cancel"]'), null);
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
  assert.equal(root.querySelector('form'), null);
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
  assert.equal(root.querySelector('[data-role="hold"]'), null, 'no key to reveal');
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
