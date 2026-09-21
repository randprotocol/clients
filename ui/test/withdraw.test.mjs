// The withdraw flow (`#withdraw/<index>`, `#withdrawn/<hash>`) and the Withdraw action on the
// asset screen — task 4.5.
//
// A withdrawal is a `BridgeBurn`: an RPL note leaves the shielded pool for one of the coins that
// back it, at a cost of ONE bundle proof and about a minute and a half. So most of what is asserted here
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
import { coreApi } from '../engine/wallet.js';
import { checkRecipient, EVM_CHAINS } from '../screens/withdraw.js';
import { UNLISTED_TEXT } from '../lib/assets.js';

const COIN = 'ee'.repeat(32);

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

/**
 * `burnIsPossible` is no longer a JavaScript port of the fullnode client's check — it is a thin
 * adapter over `wallet-core`'s own pure `burn_is_possible`, which chain 14 added precisely so the
 * rule lives once (with the chain's own `release_unit` and the per-backing `locked` amount the
 * zUSD amendment introduced). So what is asserted here is the ADAPTER: the validated state and the
 * burn's own five parameters go to the core, `true` becomes `{ok: true}`, and the core's sentence
 * comes back as a reason written for the user. The refusal TABLE is asserted against the real core
 * in `web/wallet/test/core.integration.test.mjs`.
 */
test('burnIsPossible hands the whole question to the core, and dresses its answer for the user', async () => {
  const asked = [];
  const core = coreApi({
    async call(method, params) {
      asked.push([method, params]);
      if (params.asset === 7) throw new Error("asset 7 is not in this chain's registry, so no note of it was ever deposited (registered: 1)");
      return true;
    },
  });
  const state = { enabled: true, chains: [2], assets: [{ index: 1, chain: 2, token: COIN, decimals: 6, locked: '900' }] };

  assert.deepEqual(await burnIsPossible(core, state, 1, 2, COIN, '400', '100'), { ok: true });
  assert.deepEqual(asked[0], ['burn_is_possible', {
    bridge_state: { enabled: true, assets: state.assets },
    asset: 1, to_chain: 2, token: COIN, amount: '400', relayer_fee: '100',
  }], 'the core was asked a different question from the one the user asked');

  const missing = await burnIsPossible(core, state, 7, 2, COIN, '400', '100');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not in this chain's registry/);
  assert.match(missing.reason, /registered: 1/, 'and says what IS registered, as upstream does');
  // Shown verbatim in a banner, so it reads as a sentence rather than as a log line.
  assert.match(missing.reason, /^Asset 7 /);
  assert.match(missing.reason, /\.$/);
});

test('burnIsPossible never answers `ok` for a state it could not read', async () => {
  // There is no second copy of the rule here: even "there is no bridge state at all" is put to
  // the core, as a state with nothing enabled and nothing registered, so the sentence the user
  // sees is the chain's own in every case.
  const seen = [];
  const core = coreApi({
    async call(method, params) {
      seen.push(params.bridge_state);
      if (params.bridge_state.enabled !== true) throw new Error('this chain has no bridge, so there is nothing to burn to');
      return true;
    },
  });
  for (const state of [null, undefined, { enabled: false, chains: [], assets: [] }]) {
    const answer = await burnIsPossible(core, state, 1, 2, COIN, '400', '0');
    assert.equal(answer.ok, false, `state: ${JSON.stringify(state)}`);
    assert.match(answer.reason, /no bridge/i);
  }
  assert.deepEqual(seen, [
    { enabled: false, assets: [] },
    { enabled: false, assets: [] },
    { enabled: false, assets: [] },
  ]);
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
  const REASON = 'Proving needs about 5.7 GB of free memory; this computer reports 8 GB.';
  const b = unlockedBackend({ bridge: { canWithdraw: () => ({ ok: false, reason: REASON }) } });
  const { app, root } = await mountApp(t, b, { hash: '#asset/1' });
  await app.idle();
  assertGone(root.querySelector('[data-go="withdraw/1"]'), 'the Withdraw action');
  assert.match(text(root), /5\.7 GB/, 'the reason is shown in its place');
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

test('the destination is one of the asset’s own backings, never a bare chain', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  const chosen = root.querySelector('[data-chain="2"]');
  assert.ok(chosen, 'the asset’s own backing is offered');
  assert.equal(chosen.dataset.token, 'ee'.repeat(32), 'a backing is a COIN on a chain, not a chain');
  // A burn's destination must be a coin that actually backs this asset (`check_burn`'s
  // `NotABacking`), so a chain the bridge merely knows about is not offered as if it were one.
  assertGone(root.querySelector('[data-chain="3"]'), 'a chain this asset is not backed on');
});

test('every backing of a multi-coin token is offered, not just the last one read', async (t) => {
  // The zUSD shape: one token, several coins. A flow that kept one would send six of seven
  // withdrawals to a coin the chain refuses — after a proof.
  const b = unlockedBackend();
  const backings = [
    { chain: 2, token: 'ee'.repeat(32), locked: '900000000', decimals: 6 },
    { chain: 2, token: 'dd'.repeat(32), locked: '0', decimals: 6 },
    { chain: 3, token: 'cc'.repeat(32), locked: '5', decimals: 18 },
  ];
  b.assets.list = async () => {
    b.calls.push(['assets.list']);
    return [
      { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '1', pending: '0' },
      { index: 1, id: 'z', name: 'Shielded USD', symbol: 'zUSD', decimals: 8, balance: '120000000', pending: '0', backings },
    ];
  };
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  const offered = [...root.querySelectorAll('[data-token]')].map((el) => [Number(el.dataset.chain), el.dataset.token]);
  assert.deepEqual(offered, backings.map((x) => [x.chain, x.token]));
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
  assert.equal(req.token, 'ee'.repeat(32), 'the estimate never named the coin being redeemed');
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

test('proving shows the ONE bundle a chain-14 burn is, and lands on #withdrawn', async (t) => {
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
  assert.equal(ctl.req.token, 'ee'.repeat(32), 'the burn never named the coin it redeems');
  // Chain 14 burns the token and pays the RAND fee in ONE bundle, so there is one ring and one
  // proving phase. Two rings said "1 of 2" for a proof that no longer has a second half.
  assert.ok(root.querySelector('[data-role="ring-bundle"]'), 'the bundle’s ring');
  assertGone(root.querySelector('[data-role="ring-asset"]'), 'the retired asset-bundle ring');
  assertGone(root.querySelector('[data-role="ring-fee"]'), 'the retired fee-bundle ring');

  ctl.emit('proving');
  await turns();
  assert.equal(root.querySelector('[data-role="ring-bundle"]').getAttribute('data-state'), 'active');
  assert.doesNotMatch(text(root), /1 of 2|2 of 2/, 'a one-proof burn still counted to two');

  ctl.emit('submitting');
  await turns();
  assert.equal(root.querySelector('[data-role="ring-bundle"]').getAttribute('data-state'), 'done');
  ctl.settle({ hash: `0x${'be'.repeat(32)}` });
  await turns(6);

  assert.equal(location.hash, `#withdrawn/0x${'be'.repeat(32)}`);
});

test('`proving-asset` is not a phase any part of the wallet knows any more', async (t) => {
  // It named the first of two proofs. A backend that reported it now would be reporting a phase
  // the contract has retired, and the screen must not quietly label it.
  const { b, ctl } = controlledWithdraw();
  const { app, root } = await review(t, b);
  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await turns();
  ctl.emit('proving');
  await turns();
  const before = text(root);
  ctl.emit('proving-asset');
  await turns();
  assert.equal(text(root), before, 'an unknown phase changed what the user is told');
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
  // Reached through the flow, not by mounting `#withdrawn/<hash>` cold: arriving cold leaves
  // `ctx.state.withdrawReceipt` null, and the chain row, the To row and the amount line all
  // render as empty strings — which is exactly what this test used to assert nothing about
  // (task 4.5, M1).
  const b = unlockedBackend();
  const hash = `0x${'be'.repeat(32)}`;
  const { app, root } = await review(t, b, { amount: '0.05' });
  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await app.idle();

  assert.equal(location.hash, `#withdrawn/${hash}`);
  const shown = text(root);
  assert.match(shown, /Withdrawal submitted/i);
  assert.match(shown, /Chain 2 \(EVM\)/, 'the destination chain is named');
  assert.match(shown, new RegExp(EVM.slice(-4)), 'and so is the address it was sent to');
  // 0.05 of an eight-decimal token. A receipt that printed it at RAND's nine would say 0.005.
  assert.match(shown, /0\.05/);
  assert.match(shown, /wETH/);
  assert.match(shown, /bebebebe/i, 'with the transaction hash');
});

test('the review’s network fee is RAND at the RAND row’s own decimals, not a written 9', async (t) => {
  // Task 4.5's M8: `formatUnits(estimate.fee, 9, 9)` was the one number about money this screen
  // wrote rather than read. On a chain whose native token has six decimals it is out by 1000.
  const b = unlockedBackend({
    assets: {
      list: async () => [
        { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 6, balance: '3500000', pending: '0' },
        {
          index: 1, id: 'wrapped-eth', name: 'Wrapped Ether', symbol: 'wETH', decimals: 8,
          balance: '120000000', pending: '0',
          backings: [{ chain: 2, token: COIN, locked: '900000000', decimals: 6 }],
        },
      ],
    },
  });
  const { root } = await review(t, b);
  // The fake's burn fee is 10000000 units: 10 RAND at six decimals, 0.01 at nine.
  assert.match(text(root), /10 RAND/);
  assert.doesNotMatch(text(root), /0\.01 RAND/);
});

test('an asset the node’s registry does not list is refused at the very first step', async (t) => {
  // 4.5's M6: the old flow walked the whole address/amount/review sequence and only found out at
  // `estimate`. An unlisted asset's decimals are the wallet's own guess, so nothing the user
  // types about it means anything — the flow says so before the first field.
  const b = unlockedBackend({
    assets: {
      list: async () => [
        { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' },
        { index: 3, id: 'rpl-3', symbol: 'RPL#3', decimals: 9, balance: '7', pending: '0', unlisted: true },
      ],
    },
  });
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/3' });
  await app.idle();
  assert.ok(text(root).includes(UNLISTED_TEXT));
  assertGone(root.querySelector('[data-token]'), 'a backing to pick');
  assertGone(root.querySelector('textarea[name=to]'), 'an address field');
  assert.equal(calls(b, 'bridge.estimate').length, 0, 'and the backend was never asked to plan it');
});

test('a native token has no coin to release, and the flow says so instead of offering one', async (t) => {
  const b = unlockedBackend({
    assets: {
      list: async () => [
        { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' },
        { index: 2, id: 'n'.repeat(64), name: 'Points', symbol: 'PTS', decimals: 4, balance: '5000', pending: '0' },
      ],
    },
  });
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/2' });
  await app.idle();
  assert.match(text(root), /nothing.*(withdraw|release)|no coin/i);
  assertGone(root.querySelector('[data-token]'), 'a backing to pick');
  assert.equal(calls(b, 'bridge.estimate').length, 0);
});

test('a second backing, chosen, is the pair that reaches BOTH estimate and withdraw', async (t) => {
  const backings = [
    { chain: 2, token: 'ee'.repeat(32), locked: '900000000', decimals: 6 },
    { chain: 3, token: 'cc'.repeat(32), locked: '5000000', decimals: 18 },
  ];
  const { b, ctl } = controlledWithdraw();
  b.assets.list = async () => {
    b.calls.push(['assets.list']);
    return [
      { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' },
      { index: 1, id: 'z', name: 'Shielded USD', symbol: 'zUSD', decimals: 8, balance: '120000000', pending: '0', backings },
    ];
  };
  const { app, root } = await mountApp(t, b, { hash: '#withdraw/1' });
  await app.idle();
  // The backing's own locked holding is on the row, so "which coin?" is an informed choice.
  assert.match(text(root), /900/);
  root.querySelector('[data-backing="1"]').click();
  await app.idle();
  root.querySelector('textarea[name=to]').value = 'ab'.repeat(32); // chain 3 is EVM: 20 bytes
  root.querySelector('textarea[name=to]').value = `0x${EVM}`;
  root.querySelector('[data-role="address-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  root.querySelector('input[name=amount]').value = '0.05';
  root.querySelector('[data-role="amount-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  const [, est] = calls(b, 'bridge.estimate')[0];
  assert.equal(est.toChain, 3);
  assert.equal(est.token, 'cc'.repeat(32), 'the coin the user picked, not the first one listed');

  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await turns();
  assert.equal(ctl.req.toChain, 3);
  assert.equal(ctl.req.token, 'cc'.repeat(32));
});

test('an empty estimate fee is never passed on as one', async (t) => {
  // 4.5's T4. `String(fee || '')` is neither undefined nor null, so it would slip past
  // `bridge.withdraw`'s own default and reach `plan_burn` as `fee: ''`.
  const { b, ctl } = controlledWithdraw({ bridge: { estimate: async () => ({ fee: '', relayerFee: '0', receive: '5000000', change: '0', proofs: 1 }) } });
  const { app, root } = await review(t, b);
  const confirm = root.querySelector('input[name=confirm]');
  confirm.value = EVM.slice(-4);
  confirm.dispatchEvent(new Event('input', { bubbles: true }));
  await app.idle();
  root.querySelector('[data-action="prove"]').click();
  await turns();
  assert.equal(ctl.req.fee, undefined, 'an absent fee lets the backend supply the chain’s own');
});
