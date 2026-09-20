// The withdraw flow (`#withdraw/<index>`, `#withdrawn/<hash>`) and the Withdraw action on the
// asset screen — task 4.5.
//
// A withdrawal is a `BridgeBurn`: an RPL note leaves the shielded pool for its origin chain, at a
// cost of two bundle proofs and about three and a half minutes. So most of what is asserted here
// is about **not starting one**: no Withdraw action where the shell or the chain cannot carry one
// out, and every refusal that can be made locally made before `bridge.estimate` is even called.
//
// `app.idle()` waits for every tracked backend call, so a test that deliberately holds
// `bridge.withdraw` open (to look at the proving step) drives the queue with plain turns instead —
// the same convention send.test.mjs follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { burnIsPossible } from '../engine/backend-shared.js';
import { checkRecipient, EVM_CHAINS } from '../screens/withdraw.js';

// 20 bytes, 40 hex characters. Deliberately asymmetric — ascending bytes, so the padding
// assertion below fails if anything pads on the wrong end, reverses, or truncates.
const EVM = '0102030405060708090a0b0c0d0e0f1011121314';
const PADDED = '0'.repeat(24) + EVM; // left-padded to 32 bytes, as `check_burn` requires
const turns = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** Never let node's assert inspect a DOM node — building a diff over linkedom exhausts the heap. */
function assertGone(el, what) {
  assert.ok(el === null || el === undefined, `${what} should not be on the page`);
}

function text(root) {
  return root.textContent || '';
}

function calls(b, name) {
  return b.calls.filter((c) => c[0] === name);
}

/** A backend whose `bridge.withdraw()` never settles on its own; `ctl` drives it. */
function controlledWithdraw(overrides = {}) {
  const ctl = { calls: 0, req: null, phases: [], emit: null, settle: null, fail: null };
  const b = unlockedBackend({
    ...overrides,
    bridge: {
      ...(overrides.bridge || {}),
      withdraw: (req, onPhase, options) => {
        ctl.calls += 1;
        ctl.req = req;
        ctl.options = options;
        ctl.emit = (phase) => { ctl.phases.push(phase); onPhase(phase); };
        return new Promise((resolve, reject) => { ctl.settle = resolve; ctl.fail = reject; });
      },
    },
  });
  return { b, ctl };
}

/** Walks `#withdraw/1` as far as the review step. */
async function review(t, b, { to = `0x${EVM}`, amount = '0.05', relayerFee = '' } = {}) {
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  root.querySelector('[data-chain="2"]').click();
  await app.idle();
  root.querySelector('textarea[name=to]').value = to;
  root.querySelector('[data-role="address-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  root.querySelector('input[name=amount]').value = amount;
  const relayer = root.querySelector('input[name=relayerFee]');
  if (relayer) relayer.value = relayerFee;
  root.querySelector('[data-role="amount-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  return { app, root };
}

// ---------------------------------------------------- the two facts only the chain knows -----

test('burnIsPossible is the port of the fullnode client’s own pre-flight check', () => {
  // A disabled bridge. The whole point of asking: `Bridge(Disabled)` would otherwise be learned
  // after two proofs.
  assert.equal(burnIsPossible({ enabled: false, chains: [], assets: [] }, 1).ok, false);
  assert.equal(burnIsPossible(null, 1).ok, false);
  assert.equal(burnIsPossible(undefined, 1).ok, false);
  // `enabled` must be exactly true, never merely truthy.
  assert.equal(burnIsPossible({ enabled: 'yes', assets: [{ index: 1 }] }, 1).ok, false);

  const state = { enabled: true, chains: [2], assets: [{ index: 1, chain: 2 }, { index: 4, chain: 3 }] };
  assert.deepEqual(burnIsPossible(state, 1), { ok: true });
  assert.deepEqual(burnIsPossible(state, 4), { ok: true });

  const missing = burnIsPossible(state, 2);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not in this chain's registry/);
  assert.match(missing.reason, /registered: 1, 4/, 'and says what IS registered, as upstream does');

  const empty = burnIsPossible({ enabled: true, chains: [], assets: [] }, 1);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /registry is empty/);
});

test('checkRecipient screens the shape check_burn would refuse, per chain family', () => {
  for (const chain of EVM_CHAINS) {
    assert.deepEqual(checkRecipient(chain, `0x${EVM}`), { to: PADDED, display: `0x${EVM}` });
    // Case and the `0x` prefix are cosmetic; the bytes are not.
    assert.equal(checkRecipient(chain, ` 0X${EVM.toUpperCase()} `.replace('0X', '0x')).to, PADDED);
    assert.ok(checkRecipient(chain, `0x${'00'.repeat(20)}`).error, 'the zero address');
    assert.ok(checkRecipient(chain, `0x${'ab'.repeat(32)}`).error, '32 bytes on an EVM chain');
  }
  // A non-EVM chain takes 32 plain bytes and is not padded.
  const wide = 'ab'.repeat(32);
  assert.deepEqual(checkRecipient(9, wide), { to: wide, display: wide });
  assert.ok(checkRecipient(9, `0x${EVM}`).error, '20 bytes on a chain that wants 32');
  assert.ok(checkRecipient(2, '').error);
  assert.ok(checkRecipient(2, '0xzz').error);
});

// ------------------------------------------------- the Withdraw action on the asset screen ----

test('the asset screen offers Withdraw for an RPL asset when the bridge says it can', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#asset/1' });
  await app.idle();
  const btn = root.querySelector('[data-go="withdraw/1"]');
  assert.ok(btn, 'a Withdraw action');
  assert.match(text(root), /Withdraw/);
});

test('no Withdraw action, and the reason instead, when canWithdraw says no', async (t) => {
  const REASON = 'Proving needs about 5.5 GB of free memory; this computer reports 8 GB.';
  const b = unlockedBackend({ bridge: { canWithdraw: () => ({ ok: false, reason: REASON }) } });
  const { app, root } = await mountApp(t, b, { hash: '#asset/1' });
  await app.idle();
  assertGone(root.querySelector('[data-go="withdraw/1"]'), 'the Withdraw action');
  assert.match(text(root), /5\.5 GB/, 'the reason is shown in its place');
});

test('a shell with no bridge group at all offers no Withdraw and asks it nothing', async (t) => {
  const b = unlockedBackend();
  delete b.bridge;
  const { app, root } = await mountApp(t, b, { hash: '#asset/1' });
  await app.idle();
  assertGone(root.querySelector('[data-go="withdraw/1"]'), 'the Withdraw action');
  assert.equal(b.calls.filter((c) => c[0].startsWith('bridge.')).length, 0);
});

test('RAND is never withdrawable', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#asset/0' });
  await app.idle();
  assertGone(root.querySelector('[data-go="withdraw/0"]'), 'the Withdraw action on RAND');
});

// ------------------------------------------------------------------- the withdraw screen ------

test('the withdraw screen refuses outright where the shell cannot withdraw', async (t) => {
  const b = unlockedBackend({ bridge: { canWithdraw: () => ({ ok: false, reason: 'no bridge here' }) } });
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  assert.match(text(root), /no bridge here/);
  assertGone(root.querySelector('[data-chain="2"]'), 'the chain step');
});

test('the destination chain is preselected to the asset’s own origin chain', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  const chosen = root.querySelector('[data-chain="2"]');
  assert.ok(chosen, 'the asset’s own chain is offered');
  assert.equal(chosen.getAttribute('aria-pressed'), 'true', 'and preselected');
  // A burn's destination must be the asset's own chain (`BridgeState::check_burn`), so the others
  // are not offered as if they were a choice.
  assertGone(root.querySelector('[data-chain="3"]'), 'a chain this asset did not come from');
});

test('an EVM address must be 20 bytes, and is left-padded to 32 before it is sent', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  root.querySelector('[data-chain="2"]').click();
  await app.idle();

  const input = root.querySelector('textarea[name=to]');
  const submit = () => root.querySelector('[data-role="address-form"]')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  input.value = 'not an address';
  submit();
  await app.idle();
  assert.match(text(root), /hexadecimal/i, 'a non-hex recipient is refused by shape');
  assert.ok(root.querySelector('textarea[name=to]'), 'and the step does not advance');

  input.value = `0x${EVM}ee`; // 21 bytes
  submit();
  await app.idle();
  assert.match(text(root), /40 hex characters\. That is 42/i, 'the length is explained in the chain’s own units');
  assert.ok(root.querySelector('textarea[name=to]'), 'nor does a 21-byte one');

  input.value = `0x${'00'.repeat(20)}`;
  submit();
  await app.idle();
  assert.match(text(root), /cannot be the zero address|zero address/i);
  assert.ok(root.querySelector('textarea[name=to]'), 'a zero recipient does not advance either');

  input.value = `0x${EVM}`;
  submit();
  await app.idle();
  assert.ok(root.querySelector('input[name=amount]'), 'a 20-byte address advances to the amount');

  root.querySelector('input[name=amount]').value = '0.05';
  root.querySelector('[data-role="amount-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  const [, req] = calls(b, 'bridge.estimate')[0];
  assert.equal(req.to, PADDED, 'left-padded to 32 bytes, and `0x` stripped');
  assert.equal(req.to.length, 64);
  assert.equal(req.toChain, 2);
  assert.equal(req.asset, 1);
});

test('a relayer fee larger than the amount is refused before estimate is called', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  root.querySelector('[data-chain="2"]').click();
  await app.idle();
  root.querySelector('textarea[name=to]').value = `0x${EVM}`;
  root.querySelector('[data-role="address-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  root.querySelector('input[name=amount]').value = '0.05';
  root.querySelector('input[name=relayerFee]').value = '0.06';
  root.querySelector('[data-role="amount-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  assert.equal(calls(b, 'bridge.estimate').length, 0, 'the backend was never asked');
  assert.match(text(root), /relayer fee/i);
  assert.ok(root.querySelector('input[name=amount]'), 'and the flow stays on the amount step');
});

test('the review warns that this leaves the pool, and the typed confirmation gates the button', async (t) => {
  const { b, ctl } = controlledWithdraw();
  const { app, root } = await review(t, b);

  assert.match(text(root), /leaves the shielded pool/i);
  assert.match(text(root), /become public on the other chain/i);

  const prove = root.querySelector('[data-action="prove"]');
  assert.ok(prove, 'the button exists');
  assert.equal(prove.disabled, true, 'but is not live yet');

  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = 'zzzz';
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  assert.equal(root.querySelector('[data-action="prove"]').disabled, true, 'the wrong four characters');

  // Clicking anyway does nothing: the flag is the gate, the `disabled` attribute is how it looks.
  root.querySelector('[data-action="prove"]').click();
  await app.idle();
  assert.equal(ctl.calls, 0);

  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  assert.equal(root.querySelector('[data-action="prove"]').disabled, false, 'the right four characters');
});

test('proving shows both bundles, including the proving-asset phase, and lands on #withdrawn', async (t) => {
  const { b, ctl } = controlledWithdraw();
  const { app, root } = await review(t, b);
  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await turns();

  assert.equal(ctl.calls, 1);
  assert.equal(ctl.req.asset, 1);
  assert.equal(ctl.req.to, PADDED);
  assert.equal(ctl.req.toChain, 2);
  assert.ok(root.querySelector('[data-role="ring-asset"]'), 'the asset bundle’s ring');
  assert.ok(root.querySelector('[data-role="ring-fee"]'), 'the fee bundle’s ring');

  ctl.emit('proving-asset');
  await turns();
  assert.match(text(root), /asset bundle/i, 'the proving-asset phase is labelled, not ignored');
  assert.equal(root.querySelector('[data-role="ring-asset"]').getAttribute('data-state'), 'active');
  assert.equal(root.querySelector('[data-role="ring-fee"]').getAttribute('data-state'), 'pending');

  ctl.emit('proving');
  await turns();
  assert.equal(root.querySelector('[data-role="ring-asset"]').getAttribute('data-state'), 'done');
  assert.equal(root.querySelector('[data-role="ring-fee"]').getAttribute('data-state'), 'active');

  ctl.emit('submitting');
  await turns();
  ctl.settle({ hash: `0x${'be'.repeat(32)}` });
  await turns(6);

  assert.equal(location.hash, `#withdrawn/0x${'be'.repeat(32)}`);
});

test('a withdrawal that fails before the wire says so and offers the review again', async (t) => {
  const { b, ctl } = controlledWithdraw();
  const { app, root } = await review(t, b);
  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await turns();

  const err = new Error('the notes of asset 1 hold 0 units, but the burn is 400');
  err.definite = true;
  ctl.fail(err);
  await turns(6);

  assert.match(text(root), /hold 0 units/, 'the core’s own sentence, shown as written');
  assert.ok(root.querySelector('[data-role="retry"]'), 'back to review is offered');
  assert.notEqual(location.hash, `#withdrawn/0x${'be'.repeat(32)}`);
});

test('the receipt names the destination chain and the burn', async (t) => {
  const b = unlockedBackend();
  const hash = `0x${'be'.repeat(32)}`;
  const { app, root } = await mountApp(t, b, { hash: `#withdrawn/${hash}` });
  await app.idle();
  assert.match(text(root), /Withdrawal submitted/i);
  assert.match(text(root), /be be|bebe/i);
});
