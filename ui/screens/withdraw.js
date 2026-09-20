// The withdraw flow: `#withdraw/<index>` and `#withdrawn/<hash>`.
//
// A withdrawal is a **bridge burn**: `amount` of a registry (RPL) asset is destroyed inside the
// shielded pool and the bridge releases it to an address on the asset's origin chain. It is the
// one thing this wallet does that is not private at the other end, and the one thing it does that
// cannot be undone — so the flow is built around three refusals rather than around the happy path:
//
//   * **Nothing starts without `bridge.canWithdraw()`.** The group itself is optional in the
//     Backend contract (most shells have no bridge at all) and the answer is false on every wasm
//     shell, so both are feature-detected before a single control is drawn.
//
//   * **Every check that can be made locally is made before `bridge.estimate`, and every check the
//     chain can make is made before the proof.** Two bundle proofs is about three and a half
//     minutes of this computer; a recipient of the wrong shape, a relayer fee bigger than the
//     amount, a disabled bridge or an unregistered asset would each spend all of it on a
//     transaction the chain was always going to refuse. The first two are here, the last two are
//     `bridge.withdraw`'s own gates (ui/engine/backend-shared.js, `burnIsPossible`).
//
//   * **The last step is typed, not tapped.** The destination's last four characters have to be
//     typed out before the button is live, because an address the user cannot undo is worth one
//     deliberate act.
//
// Steps: chain → address → amount → review → proving → `#withdrawn/<hash>`. Like the send flow,
// the proof lives on `ctx.state` (session-scoped) with a pinned chip, so leaving the screen does
// not cancel three and a half minutes of work.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { parseUnits, formatUnits, shortHex, elapsed } from '../lib/format.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { explorerLink, TX_HASH_RE } from '../lib/explorer.js';
import { plainUnits } from './send/state.js';

// ============================================================================ the vocabulary ===

/**
 * The chains whose recipient is a 20-byte address left-padded into 32 bytes, from the chain's own
 * rule: `BridgeState::check_burn` refuses a `to` whose upper twelve bytes are non-zero for chains
 * 2, 3 and 4 (`randprotocol-core/src/bridge/state.rs`, "an EVM/TVM chain (2, 3, 4)"). Everything
 * else takes 32 plain bytes and this wallet does not pretend to know their format.
 */
export const EVM_CHAINS = Object.freeze([2, 3, 4]);

export const PHASE_LABELS = Object.freeze({
  selecting: 'Selecting notes',
  witness: 'Building the witnesses',
  // Two bundles, proved one after the other. The native backend reports `proving-asset` for the
  // whole of `prove_burn` (it cannot see inside the call); a backend that can tell the two apart
  // reports `proving` for the second. Both are labelled, so neither looks like a stall.
  'proving-asset': 'Proving the asset bundle (1 of 2)',
  proving: 'Proving the fee bundle (2 of 2)',
  submitting: 'Submitting to the node',
  confirming: 'Waiting for the block',
});

/** Cancel is offered up to, but not including, the moment the transaction leaves this device. */
const CANCELLABLE = ['selecting', 'witness', 'proving-asset', 'proving'];
const AFTER_BROADCAST = ['submitting', 'confirming'];

export const LEAVES_POOL_WARNING = 'This leaves the shielded pool. The destination address and '
  + 'amount become public on the other chain.';

const STEPS = ['chain', 'address', 'amount', 'review'];

// ================================================================================ the address ==

/** `0x`-stripped, lower-cased, whitespace-trimmed. Nothing else is touched. */
function plainHex(text) {
  const s = String(text || '').trim().toLowerCase();
  return s.startsWith('0x') ? s.slice(2) : s;
}

/**
 * What goes in `to`: **32 plain bytes as 64 hex characters**, per chain family.
 *
 * Returns `{to, display}` or `{error}`. The three refusals mirror `check_burn`'s own, so the user
 * learns about them now rather than after two proofs — but this is a courtesy, not a second copy
 * of the rule: the bridge still owns it, and this wallet screens only the shape.
 */
export function checkRecipient(toChain, text) {
  const hex = plainHex(text);
  if (!hex) return { error: 'Enter the address this should be released to.' };
  if (!/^[0-9a-f]+$/.test(hex)) return { error: 'An address here is hexadecimal — 0-9 and a-f only.' };
  const evm = EVM_CHAINS.includes(Number(toChain));
  if (evm && hex.length !== 40) {
    return { error: `An address on this chain is 20 bytes — 40 hex characters. That is ${hex.length}.` };
  }
  if (!evm && hex.length !== 64) {
    return { error: `An address on this chain is 32 bytes — 64 hex characters. That is ${hex.length}.` };
  }
  // Left-padded to 32 bytes, which is what the action carries and what the bridge checks.
  const to = evm ? '0'.repeat(24) + hex : hex;
  if (/^0+$/.test(to)) return { error: 'That is the zero address; nothing sent there can ever be spent.' };
  return { to, display: evm ? `0x${hex}` : hex };
}

/** The four characters the review asks to be typed out. Of what the user sees, not of the padding. */
function lastFour(display) {
  return String(display || '').slice(-4).toLowerCase();
}

// =========================================================================== the in-flight job ==

/** The one in-flight (or just-finished) withdrawal for this wallet session, or `null`. */
export function currentWithdrawal(ctx) {
  const store = ctx.state.withdrawal;
  return store && store.sessionId === ctx.session.id ? store : null;
}

/** What a rejection means — the same three answers a transfer has, for the same reason. */
export function outcomeOf(store) {
  if (!store || !store.error) return 'ok';
  const err = store.error;
  if (store.cancelling || err.name === 'AbortError' || err.code === 'ABORT_ERR') return 'cancelled';
  if (err.definite === true) return 'not-sent';
  return AFTER_BROADCAST.includes(store.phase) ? 'unknown' : 'not-sent';
}

function safeHash(hash) {
  return TX_HASH_RE.test(String(hash || '')) ? String(hash) : null;
}

/**
 * Starts the withdrawal and records it on `ctx.state`, so it survives every navigation inside this
 * wallet session. Mirrors `startSend` (screens/send/state.js) — one job at a time, a pinned chip
 * that counts up, and a session abort that stops it — with one deliberate difference: a burn
 * produces **no transaction key**, because it addresses no note to anybody else. There is
 * therefore no secret handoff here at all.
 */
export function startWithdrawal(ctx, req, asset, display) {
  const session = ctx.session;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const store = {
    sessionId: session.id,
    phase: 'selecting',
    startedMs: Date.now(),
    listeners: new Set(),
    controller,
    cancelling: false,
    done: false,
    error: null,
    hash: null,
    ticker: null,
    req,
    display,
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
  ctx.state.withdrawal = store;

  const fan = () => {
    for (const fn of [...store.listeners]) {
      try { fn(store); } catch (err) { console.error('rand-wallet: withdrawal listener failed', err); }
    }
  };

  const paintChip = () => ctx.setPinnedChip({ text: `Withdrawing… ${elapsed(Date.now() - store.startedMs)}`, go: `withdraw/${req.asset}` });
  const stopTicker = () => {
    if (store.ticker !== null) { clearInterval(store.ticker); store.ticker = null; }
  };
  paintChip();
  store.ticker = setInterval(() => {
    if (store.done || ctx.session.id !== session.id) { stopTicker(); return; }
    paintChip();
  }, 1000);
  if (session.signal) {
    session.signal.addEventListener('abort', () => {
      stopTicker();
      if (controller) { try { controller.abort(); } catch { /* already aborted */ } }
    }, { once: true });
  }

  const onPhase = (phase) => {
    if (ctx.session.id !== session.id) return;
    if (!PHASE_LABELS[phase]) return; // a phase this build does not know: keep the last one
    store.phase = phase;
    fan();
  };

  const finish = () => { store.done = true; stopTicker(); };

  const p = Promise.resolve(ctx.backend.bridge.withdraw(req, onPhase, controller ? { signal: controller.signal } : undefined))
    .then(
      (result) => {
        store.hash = safeHash(result && result.hash);
        finish();
        if (ctx.session.id === session.id) {
          if (store.hash) {
            // Nothing secret, so the receipt's details live on `ctx.state` quite happily: an
            // amount and an address that are about to be public on another chain anyway.
            ctx.state.withdrawReceipt = {
              hash: store.hash, display, toChain: req.toChain, amount: req.amount,
              relayerFee: req.relayerFee, assetIndex: req.asset,
            };
            ctx.setPinnedChip({ text: 'Withdrawn — view', go: `withdrawn/${store.hash}`, kind: 'positive' });
          } else ctx.setPinnedChip(null);
        }
        fan();
        return { hash: store.hash };
      },
      (err) => {
        store.error = err;
        finish();
        if (ctx.session.id === session.id) ctx.setPinnedChip(null);
        fan();
        throw err;
      },
    );
  store.promise = p;
  p.catch(() => {});
  return store;
}

// ==================================================================================== markup ====

function shellMarkup() {
  return h`
    <h1 class="sr-only">Withdraw</h1>
    <div class="narrow">
      <div class="topbar">
        <button class="btn-icon icon-flip" type="button" data-role="back" aria-label="Back">${raw(icons.chevron())}</button>
        <span class="grow"></span>
      </div>
      <p class="caption" data-role="step-indicator" aria-live="polite"></p>
      <div class="stack loose" data-role="step"><div class="skeleton block"></div></div>
    </div>`;
}

function cannotMarkup(title, reason) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${title}</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">Not available here</span>${reason}</span>
    </div>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

function chainName(id) {
  return EVM_CHAINS.includes(Number(id)) ? `Chain ${id} (EVM)` : `Chain ${id}`;
}

/**
 * The destination chain. Usually there is exactly one: a burn's destination **must** be the
 * asset's own origin chain (`check_burn`'s `WrongTokenChain`), and `assets.list()` now carries
 * that chain through from the registry. It is still a step, and still preselected rather than
 * assumed away, because it is the fact the user most needs to see before the address field.
 */
function chainStepMarkup(asset, { chains, origin }) {
  const offered = origin === null ? chains : [origin];
  const note = origin === null
    ? raw(h`<p class="caption">This wallet does not know which chain ${asset.symbol} came from, so every chain this bridge knows is offered. Sending to the wrong one is refused by the chain.</p>`)
    : raw(h`<p class="caption">${asset.symbol} came from this chain, so it is the only place it can go back to.</p>`);
  const warning = origin !== null && chains.length > 0 && !chains.includes(origin)
    ? raw(h`
      <div class="banner warn">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">This bridge does not list that chain</span>The withdrawal may be refused. Nothing is spent until it is proved.</span>
      </div>`)
    : '';
  const rows = offered.map((id) => h`
    <li>
      <button class="row" type="button" data-chain="${id}" aria-pressed="${String(id === origin)}">
        <span class="avatar sm">${raw(icons.bridge())}</span>
        <span class="row-main"><span class="row-title">${chainName(id)}</span></span>
        <span class="row-end">${raw(icons.chevron())}</span>
      </button>
    </li>`).join('');
  const empty = offered.length === 0
    ? raw(h`<div class="card"><div class="empty"><span class="empty-title">No destination chain</span><span>This node's bridge lists no chains to withdraw to.</span></div></div>`)
    : raw(h`<div class="card flush"><ul class="list">${raw(rows)}</ul></div>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Withdraw ${asset.symbol} to</h2>
    ${warning}
    ${empty}
    ${note}`;
}

function addressStepMarkup(asset, toChain, draft) {
  const evm = EVM_CHAINS.includes(Number(toChain));
  const hint = evm
    ? `A 20-byte address on ${chainName(toChain)}, for example 0x… — it is padded to 32 bytes for the bridge.`
    : `A 32-byte recipient on ${chainName(toChain)}, written as 64 hex characters.`;
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Which address?</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">There is no way back</span>${LEAVES_POOL_WARNING}</span>
    </div>
    <form class="stack loose" data-role="address-form" novalidate>
      <div class="field">
        <label class="label" for="withdraw-to">Recipient on ${chainName(toChain)}</label>
        <textarea id="withdraw-to" name="to" rows="2" spellcheck="false" autocomplete="off" placeholder="${evm ? '0x…' : '64 hex characters'}" aria-describedby="withdraw-to-hint">${draft.to}</textarea>
        <span class="hint" id="withdraw-to-hint">${hint}</span>
        <span class="error" id="withdraw-to-error"></span>
      </div>
      <button class="btn btn-primary block" type="submit">Continue</button>
    </form>`;
}

function amountStepMarkup(asset, draft) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">How much ${asset.symbol}?</h2>
    <form class="stack loose" data-role="amount-form" novalidate>
      <div class="field amount-field">
        <div class="field-top">
          <label class="label" for="withdraw-amount">Amount</label>
          <button class="btn sm" type="button" data-role="max">Max</button>
        </div>
        <input id="withdraw-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${draft.amount}" aria-describedby="withdraw-amount-hint">
        <span class="hint" id="withdraw-amount-hint">Available ${formatUnits(asset.balance ?? '0', 6, asset.decimals)} ${asset.symbol}</span>
        <span class="error" id="withdraw-amount-error"></span>
      </div>
      <div class="field">
        <label class="label" for="withdraw-relayer">Relayer fee (optional)</label>
        <input id="withdraw-relayer" name="relayerFee" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${draft.relayerFee}" aria-describedby="withdraw-relayer-hint">
        <span class="hint" id="withdraw-relayer-hint">Deducted on the destination chain, out of the amount above — it pays whoever delivers the release there. Leave it at zero to deliver it yourself.</span>
        <span class="error" id="withdraw-relayer-error"></span>
      </div>
      <div data-role="form-banner"></div>
      <button class="btn btn-primary block" type="submit">Review</button>
    </form>`;
}

function reviewStepMarkup({ asset, display, toChain, units, estimate }) {
  const amountOf = (u) => `${formatUnits(u, 9, asset.decimals)} ${asset.symbol}`;
  const relayer = BigInt(estimate.relayerFee || '0');
  const relayerRow = relayer > 0n
    ? raw(h`<div class="kv"><span class="k">Relayer fee</span><span class="v amount">${amountOf(relayer)}</span></div>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Review</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">There is no way back</span>${LEAVES_POOL_WARNING}</span>
    </div>
    <div class="card">
      <div class="kv"><span class="k">To</span><span class="v mono truncate">${display}</span></div>
      <div class="kv"><span class="k">On</span><span class="v">${chainName(toChain)}</span></div>
      <div class="kv"><span class="k">Burned</span><span class="v amount">${amountOf(units)}</span></div>
      ${relayerRow}
      <div class="kv"><span class="k">Arrives</span><span class="v amount">${amountOf(BigInt(estimate.receive || '0'))}</span></div>
      <div class="kv"><span class="k">Network fee</span><span class="v amount">${formatUnits(estimate.fee || '0', 9, 9)} RAND</span></div>
    </div>
    <div class="address-box"><span class="mono">${display}</span></div>
    <form class="stack" data-role="confirm-form" novalidate>
      <div class="field">
        <label class="label" for="withdraw-confirm">Type the last four characters of that address</label>
        <input id="withdraw-confirm" name="confirm" type="text" autocomplete="off" spellcheck="false" maxlength="4" aria-describedby="withdraw-confirm-hint">
        <span class="hint" id="withdraw-confirm-hint">So the address above is one you have actually read.</span>
      </div>
    </form>
    <button class="btn btn-primary block" type="button" data-action="prove" disabled>${raw(icons.bridge())}Withdraw</button>
    <p class="caption">${Number(estimate.proofs) || 2} proofs · about ${(Number(estimate.proofs) || 2) * 2} minutes on this computer</p>
    <button class="btn btn-ghost block" type="button" data-role="edit">Edit</button>`;
}

/** One of the two proof rings. `state` is 'pending' | 'active' | 'done'. */
function ringMarkup(role, label, state) {
  const spin = state === 'active' ? ' spin' : '';
  return h`
    <div class="ring sm${raw(spin)}" data-role="${role}" data-state="${state}" role="progressbar" aria-label="${label}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring-track" cx="60" cy="60" r="52"></circle>
        <circle class="ring-bar" cx="60" cy="60" r="52"></circle>
      </svg>
      <div class="ring-label">${raw(state === 'done' ? icons.check() : '')}</div>
    </div>`;
}

/**
 * Both bundles, always both shown. A burn is two proofs and takes twice as long as anything else
 * this wallet does; one ring that sits still for three and a half minutes is indistinguishable
 * from a wallet that has hung.
 */
function ringStates(phase) {
  if (phase === 'proving-asset') return ['active', 'pending'];
  if (phase === 'proving') return ['done', 'active'];
  if (AFTER_BROADCAST.includes(phase)) return ['done', 'done'];
  return ['pending', 'pending'];
}

function provingStepMarkup(store) {
  const label = PHASE_LABELS[store.phase] || 'Working';
  const [a, f] = ringStates(store.phase);
  const cancel = store.controller && CANCELLABLE.includes(store.phase)
    ? raw(h`<button class="btn block" type="button" data-role="cancel">Cancel</button>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Withdrawing</h2>
    <div class="stage">
      <div class="cluster rings">
        ${raw(ringMarkup('ring-asset', 'Asset bundle', a))}
        ${raw(ringMarkup('ring-fee', 'Fee bundle', f))}
      </div>
      <span class="amount mono" data-role="elapsed">${elapsed(Date.now() - store.startedMs)}</span>
      <span class="subtitle" data-role="phase">${label}</span>
    </div>
    <div class="banner">
      <span class="ic">${raw(icons.shield())}</span>
      <span><span class="banner-title">Keep this window open</span>Two proofs run on this device, one after the other — about three and a half minutes. You can look at other screens; closing the wallet stops it.</span>
    </div>
    <div data-role="prove-actions">${cancel}</div>`;
}

function failedStepMarkup(message) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Not withdrawn</h2>
    <div class="banner negative">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">Nothing left the pool</span>${message}</span>
    </div>
    <button class="btn btn-primary block" type="button" data-role="retry">Back to review</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

function unknownStepMarkup(message) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">We couldn’t confirm this withdrawal</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">Outcome unknown</span>The transaction may already be on chain. Check Activity before withdrawing again — withdrawing twice would burn twice.</span>
    </div>
    ${raw(message ? h`<p class="caption">The wallet was told: ${message}</p>` : '')}
    <button class="btn btn-primary block" type="button" data-go="activity">Check Activity</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

// ==================================================================================== the screen =

registerScreen('withdraw', {
  tab: 'home',
  render: () => shellMarkup(),
  async after(ctx, root, arg) {
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;
    const stepEl = root.querySelector('[data-role="step"]');
    const indicatorEl = root.querySelector('[data-role="step-indicator"]');
    const backBtn = root.querySelector('[data-role="back"]');

    const endOfTheRoad = (markup) => { indicatorEl.textContent = ''; stepEl.innerHTML = markup; };

    // The group is optional in the contract; a shell without it has no withdrawal to offer and is
    // asked nothing at all.
    const bridge = ctx.backend.bridge;
    if (!bridge || typeof bridge.canWithdraw !== 'function') {
      endOfTheRoad(cannotMarkup('Withdrawals are not available', 'This version of the wallet cannot withdraw to another chain.'));
      return;
    }

    const index = Number(arg);
    let assets = [];
    let can = { ok: false, reason: 'Withdrawals are not available here.' };
    let state = { enabled: false, chains: [] };
    try {
      const [list, answer] = await Promise.all([ctx.backend.assets.list(), bridge.canWithdraw()]);
      assets = list || [];
      if (answer) can = answer;
      // Only once the device and the chain have both said yes is the node asked anything else.
      if (can.ok) state = (await bridge.state()) || state;
    } catch (err) {
      if (!live()) return;
      endOfTheRoad(cannotMarkup('Could not start a withdrawal', (err && err.message) || 'Something went wrong.'));
      return;
    }
    if (!live()) return;

    if (!can.ok) {
      endOfTheRoad(cannotMarkup('This device cannot withdraw', can.reason || 'Withdrawals are not available here.'));
      return;
    }

    const asset = assets.find((a) => a.index === index) || null;
    if (!asset || index < 1) {
      endOfTheRoad(cannotMarkup(
        'That asset cannot be withdrawn',
        asset ? 'RAND is this chain’s own token, not a bridged asset, so there is nothing to withdraw it to.' : 'This wallet holds no such asset.',
      ));
      return;
    }

    const origin = Number.isInteger(Number(asset.chain)) ? Number(asset.chain) : null;
    const chains = Array.isArray(state.chains) ? state.chains : [];

    // ---- the draft ----
    let draft = ctx.state.withdrawDraft;
    if (!draft || draft.assetIndex !== index) {
      draft = { assetIndex: index, toChain: origin, to: '', amount: '', relayerFee: '', estimate: null, display: '', padded: '' };
      ctx.state.withdrawDraft = draft;
    }

    let step = 'chain';
    let reviewUnits = 0n;
    let confirmed = false;
    let attached = null;
    let screenTicker = null;

    function focusStepTitle() {
      const title = stepEl.querySelector('[data-role="step-title"]');
      if (title && typeof title.focus === 'function') title.focus();
    }

    function paintIndicator() {
      const i = STEPS.indexOf(step);
      indicatorEl.textContent = i === -1 ? '' : `Step ${i + 1} of ${STEPS.length}`;
    }

    function stopScreenTicker() {
      if (screenTicker !== null) { clearInterval(screenTicker); screenTicker = null; }
    }

    function setFieldError(input, message) {
      const wrap = input.closest('.field');
      const errorEl = wrap.querySelector('.error');
      if (!errorEl) return;
      if (message) {
        errorEl.textContent = message;
        errorEl.classList.add('field-error');
        markInvalid(wrap, input, errorEl.id);
      } else {
        errorEl.textContent = '';
        errorEl.classList.remove('field-error');
        markValid(wrap, input, `${input.id}-hint`);
      }
    }

    function showFormBanner(message) {
      const slot = stepEl.querySelector('[data-role="form-banner"]');
      if (!slot) return;
      slot.innerHTML = message
        ? h`<div class="banner warn"><span class="ic">${raw(icons.warning())}</span><span>${message}</span></div>`
        : '';
    }

    function goStep(next, { focus = true } = {}) {
      stopScreenTicker();
      if (next === 'review' && (!draft.estimate || reviewUnits <= 0n)) next = 'amount';
      if (next === 'amount' && !draft.padded) next = 'address';
      if (next === 'address' && draft.toChain === null) next = 'chain';
      step = next;
      confirmed = false;
      if (next === 'chain') stepEl.innerHTML = chainStepMarkup(asset, { chains, origin });
      else if (next === 'address') stepEl.innerHTML = addressStepMarkup(asset, draft.toChain, draft);
      else if (next === 'amount') stepEl.innerHTML = amountStepMarkup(asset, draft);
      else if (next === 'review') {
        stepEl.innerHTML = reviewStepMarkup({
          asset, display: draft.display, toChain: draft.toChain, units: reviewUnits, estimate: draft.estimate,
        });
      } else if (next === 'proving') paintProving();
      else if (next === 'failed') stepEl.innerHTML = failedStepMarkup((attached && attached.error && attached.error.message) || 'The withdrawal could not be proved.');
      else if (next === 'unknown') stepEl.innerHTML = unknownStepMarkup((attached && attached.error && attached.error.message) || '');
      paintIndicator();
      if (focus) focusStepTitle();
    }

    function paintProving() {
      const store = attached;
      if (!store) return;
      stepEl.innerHTML = provingStepMarkup(store);
      const elapsedEl = stepEl.querySelector('[data-role="elapsed"]');
      stopScreenTicker();
      screenTicker = setInterval(() => {
        if (!live() || store.done) { stopScreenTicker(); return; }
        elapsedEl.textContent = elapsed(Date.now() - store.startedMs);
      }, 1000);
    }

    // The rings change state with the phase, so the block is repainted whole rather than patched:
    // it is two small SVGs and a label, and a half-updated pair is exactly the confusion they
    // exist to prevent.
    const paintPhase = () => paintProving();

    function onStoreChange(store) {
      if (!live()) return;
      if (!store.done) { if (step === 'proving') paintPhase(); return; }
      stopScreenTicker();
      if (store.error) {
        const outcome = outcomeOf(store);
        if (outcome === 'cancelled') {
          if (ctx.session.id === mySession) goStep('review');
          return;
        }
        goStep(outcome === 'unknown' ? 'unknown' : 'failed');
        return;
      }
      if (!store.hash) {
        ctx.state.withdrawal = null;
        ctx.state.withdrawDraft = null;
        ctx.toast('The withdrawal was submitted, but the node did not return a usable hash.', { kind: 'negative' });
        ctx.go('#activity');
        return;
      }
      ctx.state.withdrawal = null;
      ctx.state.withdrawDraft = null; // this draft has been spent
      ctx.go(`#withdrawn/${store.hash}`);
    }

    function attach(store) {
      attached = store;
      store.listeners.add(onStoreChange);
      if (store.done) { onStoreChange(store); return; }
      goStep('proving');
    }

    const running = currentWithdrawal(ctx);
    if (running) attach(running);
    else goStep(draft.estimate ? 'review' : (draft.padded ? 'amount' : (draft.toChain === null ? 'chain' : 'chain')), { focus: false });

    // ---- handlers ----
    const offChain = on(root, '[data-chain]', 'click', (evt, btn) => {
      evt.preventDefault();
      draft.toChain = Number(btn.dataset.chain);
      goStep('address');
    });

    const offAddress = on(root, '[data-role="address-form"]', 'submit', (evt) => {
      evt.preventDefault();
      const input = stepEl.querySelector('textarea[name=to]');
      const checked = checkRecipient(draft.toChain, input.value);
      if (checked.error) { setFieldError(input, checked.error); return; }
      setFieldError(input, null);
      draft.to = input.value.trim();
      draft.padded = checked.to;
      draft.display = checked.display;
      // A changed recipient invalidates whatever was reviewed against the old one.
      draft.estimate = null;
      goStep('amount');
    });

    const offMax = on(root, '[data-role="max"]', 'click', (evt) => {
      evt.preventDefault();
      const amountInput = stepEl.querySelector('input[name=amount]');
      // A burn's own fee is RAND, from a second bundle, so the whole asset balance is withdrawable
      // — unlike a transfer, where the fee comes out of what is being sent.
      const balance = BigInt(asset.balance || '0');
      if (balance <= 0n) { setFieldError(amountInput, `You hold no ${asset.symbol}.`); return; }
      amountInput.value = plainUnits(balance, asset.decimals);
      draft.amount = amountInput.value;
      setFieldError(amountInput, null);
    });

    const offAmountInput = on(root, 'input[name=amount]', 'input', (evt, input) => { draft.amount = input.value; });
    const offRelayerInput = on(root, 'input[name=relayerFee]', 'input', (evt, input) => { draft.relayerFee = input.value; });

    function readUnits(text, what) {
      const raw0 = String(text || '').trim();
      if (!raw0) return { units: 0n };
      try { return { units: parseUnits(raw0, asset.decimals) }; } catch (err) {
        const message = (err && err.message) || '';
        if (/decimal places/.test(message)) return { error: `${asset.symbol} has ${asset.decimals} decimal places — that is more.` };
        return { error: `Enter the ${what} as a number, for example 1.25.` };
      }
    }

    const offAmount = on(root, '[data-role="amount-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      const amountInput = stepEl.querySelector('input[name=amount]');
      const relayerInput = stepEl.querySelector('input[name=relayerFee]');
      showFormBanner('');

      // Everything decidable here is decided here — the backend is not a validator, and asking it
      // costs an RPC round trip on the way to costing two proofs.
      const amount = readUnits(amountInput.value, 'amount');
      if (amount.error) { setFieldError(amountInput, amount.error); return; }
      if (amount.units <= 0n) { setFieldError(amountInput, 'Enter an amount greater than zero.'); return; }
      const balance = BigInt(asset.balance || '0');
      if (amount.units > balance) {
        setFieldError(amountInput, `That is more than your balance of ${formatUnits(balance, 6, asset.decimals)} ${asset.symbol}.`);
        return;
      }
      setFieldError(amountInput, null);

      const relayer = readUnits(relayerInput.value, 'relayer fee');
      if (relayer.error) { setFieldError(relayerInput, relayer.error); return; }
      if (relayer.units > amount.units) {
        // The chain's own rule (`relayer_fee <= amount`), refused before the backend is asked.
        setFieldError(relayerInput, 'The relayer fee cannot be more than the amount being withdrawn.');
        return;
      }
      setFieldError(relayerInput, null);

      draft.amount = amountInput.value;
      draft.relayerFee = relayerInput.value;

      let estimate;
      try {
        estimate = await bridge.estimate({
          asset: index,
          amount: amount.units.toString(),
          relayerFee: relayer.units.toString(),
          toChain: draft.toChain,
          to: draft.padded,
        });
      } catch (err) {
        if (!live()) return;
        showFormBanner((err && err.message) || 'This withdrawal could not be prepared.');
        return;
      }
      if (!live()) return;
      draft.estimate = estimate;
      reviewUnits = amount.units;
      goStep('review');
    });

    const offConfirm = on(root, 'input[name=confirm]', 'input', (evt, input) => {
      confirmed = String(input.value || '').trim().toLowerCase() === lastFour(draft.display);
      const prove = stepEl.querySelector('[data-action="prove"]');
      if (prove) prove.disabled = !confirmed;
    });

    const offEdit = on(root, '[data-role="edit"]', 'click', (evt) => { evt.preventDefault(); goStep('amount'); });

    const offRetry = on(root, '[data-role="retry"]', 'click', (evt) => {
      evt.preventDefault();
      ctx.state.withdrawal = null;
      attached = null;
      goStep('review');
    });

    const offProve = on(root, '[data-action="prove"]', 'click', (evt) => {
      evt.preventDefault();
      // Re-checked from this flow's own state at the moment of the click, never from the DOM: a
      // `disabled` attribute is a rendering, not a rule.
      if (currentWithdrawal(ctx)) return; // one withdrawal at a time
      if (!confirmed) return;
      if (!draft.estimate || reviewUnits <= 0n || !draft.padded || draft.toChain === null) return;
      const store = startWithdrawal(ctx, {
        asset: index,
        amount: reviewUnits.toString(),
        relayerFee: String(draft.estimate.relayerFee || '0'),
        toChain: draft.toChain,
        to: draft.padded,
        fee: String(draft.estimate.fee || ''),
      }, asset, draft.display);
      attach(store);
    });

    const offCancel = on(root, '[data-role="cancel"]', 'click', (evt) => {
      evt.preventDefault();
      const store = currentWithdrawal(ctx);
      if (!store || !store.controller || !CANCELLABLE.includes(store.phase)) return;
      store.cancelling = true;
      try { store.controller.abort(); } catch { /* already aborted */ }
      paintPhase();
    });

    const onBack = (evt) => {
      evt.preventDefault();
      const i = STEPS.indexOf(step);
      if (i > 0) goStep(STEPS[i - 1]);
      else ctx.go(`#asset/${index}`);
    };
    backBtn.addEventListener('click', onBack);

    return () => {
      stopScreenTicker();
      if (attached) attached.listeners.delete(onStoreChange);
      backBtn.removeEventListener('click', onBack);
      offChain(); offAddress(); offMax(); offAmountInput(); offRelayerInput(); offAmount();
      offConfirm(); offEdit(); offRetry(); offProve(); offCancel();
    };
  },
});

// ================================================================== `#withdrawn/<hash>` ========

registerScreen('withdrawn', {
  tab: 'home',
  render: () => h`<div class="narrow"><div class="skeleton block"></div></div>`,
  async after(ctx, root, hash) {
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;

    // Nothing secret crosses here — a burn's destination and amount are about to be public on the
    // other chain — so this is a plain session value, consumed once for tidiness rather than for
    // safety.
    const receipt = ctx.state.withdrawReceipt && ctx.state.withdrawReceipt.hash === hash
      ? ctx.state.withdrawReceipt
      : null;
    ctx.state.withdrawReceipt = null;
    ctx.setPinnedChip(null);

    let assets = [];
    let settings = {};
    try {
      [assets, settings] = await Promise.all([ctx.backend.assets.list(), ctx.backend.settings.get()]);
    } catch { /* the receipt still stands without them */ }
    if (!live()) return;

    const asset = assets.find((a) => a.index === (receipt ? receipt.assetIndex : -1)) || null;
    const explorer = explorerLink(settings.explorerUrl, hash);
    const amountLine = receipt && asset
      ? raw(h`<span class="amount">${formatUnits(receipt.amount, 9, asset.decimals)}<span class="unit">${asset.symbol}</span></span>`)
      : '';
    const toRow = receipt
      ? raw(h`
        <div class="kv"><span class="k">To</span><span class="v mono truncate">${receipt.display}</span></div>
        <div class="kv"><span class="k">On</span><span class="v">${chainName(receipt.toChain)}</span></div>`)
      : '';
    const explorerBtn = explorer
      ? raw(h`<button class="btn block" type="button" data-role="explorer">${explorer.label}</button>`)
      : '';

    root.innerHTML = h`
      <h1 class="sr-only">Withdrawn</h1>
      <div class="narrow">
        <div class="stage">
          <span class="avatar lg out">${raw(icons.bridge())}</span>
          <h2 class="title" data-role="step-title" tabindex="-1">Withdrawal submitted</h2>
          ${amountLine}
        </div>
        <div class="banner">
          <span class="ic">${raw(icons.info())}</span>
          <span><span class="banner-title">The bridge takes it from here</span>The burn is on this chain now. Guardians sign it and a relayer releases it on the destination chain, which is not something this wallet can watch.</span>
        </div>
        <div class="card">
          ${toRow}
          <div class="kv"><span class="k">Transaction</span><span class="v mono truncate">${shortHex(hash, 10)}</span></div>
        </div>
        ${explorerBtn}
        <button class="btn btn-primary block" type="button" data-go="home">Done</button>
      </div>`;

    const title = root.querySelector('[data-role="step-title"]');
    if (title && typeof title.focus === 'function') title.focus();

    const offExplorer = on(root, '[data-role="explorer"]', 'click', (evt) => {
      evt.preventDefault();
      if (explorer) ctx.backend.platform.openExternal(explorer.url);
    });
    return () => { offExplorer(); };
  },
});
