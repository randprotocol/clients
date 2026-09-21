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
//     chain can make is made before the proof.** A bundle proof is about two minutes of
//     this computer and ~5.7 GB; a recipient of the wrong shape, a relayer fee bigger than the
//     amount, a disabled bridge, an unregistered index, a coin that does not back this token or
//     one that is not holding enough would each spend all of it on a transaction the chain was
//     always going to refuse. The first two are here; the rest are `bridge.withdraw`'s own gates
//     (ui/engine/backend-shared.js, `screenBurn` → the core's `burn_is_possible`).
//
//   * **The last step is typed, not tapped.** The destination's last four characters have to be
//     typed out before the button is live, because an address the user cannot undo is worth one
//     deliberate act.
//
// Steps: backing → address → amount → review → proving → `#withdrawn/<hash>`. Like the send flow,
// the proof lives on `ctx.state` (session-scoped) with a pinned chip, so leaving the screen does
// not cancel two minutes of work.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { parseUnits, formatUnits, shortHex, elapsed } from '../lib/format.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { explorerLink, TX_HASH_RE } from '../lib/explorer.js';
import { UNLISTED_TEXT, isUnlisted, backingsOf, feeDecimals, feeSymbol } from '../lib/assets.js';
import { plainUnits, proveCost } from './send/state.js';

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
  // ONE bundle since chain 14: the token is burned from slots 0–1 and the RAND fee is paid from
  // slots 2–3 of the same proof. `'proving-asset'` named the first of two and is gone from the
  // contract; a backend that reported it now would be reporting a phase nothing knows, and this
  // screen keeps the last one it recognised rather than labelling it.
  proving: 'Proving the bundle',
  submitting: 'Submitting to the node',
  confirming: 'Waiting for the block',
});

/** Cancel is offered up to, but not including, the moment the transaction leaves this device. */
const CANCELLABLE = ['selecting', 'witness', 'proving'];
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
 * learns about them now rather than after a proof — but this is a courtesy, not a second copy
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
 * The destination: one of the asset's **backings**, not a bare chain.
 *
 * `Action::BridgeBurn` names a `(to_chain, token)` pair, and one RPL token can be backed by
 * several coins on several chains — zUSD is seven. A pair that does not back this token is
 * `NotABacking`, and a coin that is not holding enough of it is `InsufficientBacking`; both are
 * refused by the ledger, after a proof, unless the user is asked which coin they want. So every
 * backing `assets.list()` carries is offered, with what that coin is holding, and the first is
 * preselected. Chain 13's "there is exactly one origin chain" is not true of a bridged token and
 * never was — the old flow kept whichever registry row was read last.
 */
function backingStepMarkup(asset, { chains, backings }) {
  const note = backings.length === 0
    ? raw(h`<p class="caption">This wallet does not know which coins back ${asset.symbol}, so there is nothing it can safely burn to.</p>`)
    : raw(h`<p class="caption">${asset.symbol} is released as the coin you pick, on that coin's own chain.</p>`);
  const unknown = backings.filter((b) => chains.length > 0 && !chains.includes(b.chain));
  const warning = unknown.length > 0
    ? raw(h`
      <div class="banner warn">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">This bridge does not list every chain below</span>A withdrawal to one it does not list may be refused. Nothing is spent until it is proved.</span>
      </div>`)
    : '';
  const rows = backings.map((b, i) => h`
    <li>
      <button class="row" type="button" data-chain="${b.chain}" data-token="${b.token}" data-backing="${i}" aria-pressed="${String(i === 0)}">
        <span class="avatar sm">${raw(icons.bridge())}</span>
        <span class="row-main">
          <span class="row-title">${chainName(b.chain)}</span>
          <span class="row-sub mono truncate">${shortHex(b.token, 8)}</span>
        </span>
        <span class="row-end"><span class="amount">${formatUnits(b.locked ?? '0', Number(b.decimals) || 0, Number(b.decimals) || 0)}</span><span class="row-meta">held</span></span>
      </button>
    </li>`).join('');
  const empty = backings.length === 0
    ? raw(h`<div class="card"><div class="empty"><span class="empty-title">No coin to release</span><span>This node lists no backing for ${asset.symbol}.</span></div></div>`)
    : raw(h`<div class="card flush"><ul class="list">${raw(rows)}</ul></div>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Withdraw ${asset.symbol} as</h2>
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

function reviewStepMarkup({ asset, display, toChain, units, estimate, assets = [] }) {
  const amountOf = (u) => `${formatUnits(u, 9, asset.decimals)} ${asset.symbol}`;
  const relayer = BigInt(estimate.relayerFee || '0');
  const relayerRow = relayer > 0n
    ? raw(h`<div class="kv"><span class="k">Relayer fee</span><span class="v amount">${amountOf(relayer)}</span></div>`)
    : '';
  // The burn's fee is RAND, read at the RAND row's own decimals — writing `9` here was the one
  // number about money this screen produced without the chain (task 4.5's M8).
  const feeLine = `${formatUnits(estimate.fee || '0', 9, feeDecimals(assets))} ${feeSymbol(assets)}`;
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
      <div class="kv"><span class="k">Network fee</span><span class="v amount">${feeLine}</span></div>
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
    <p class="caption">${proveCost(estimate.proofs)}</p>
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
 * One bundle, one ring. A chain-14 burn burns the token from slots 0–1 and pays the RAND fee from
 * slots 2–3 of the SAME proof, so the second ring — and the "1 of 2" that went with it — would be
 * counting to a number the chain no longer has.
 */
function ringState(phase) {
  if (phase === 'proving') return 'active';
  if (AFTER_BROADCAST.includes(phase)) return 'done';
  return 'pending';
}

function provingStepMarkup(store) {
  const label = PHASE_LABELS[store.phase] || 'Working';
  const cancel = store.controller && CANCELLABLE.includes(store.phase)
    ? raw(h`<button class="btn block" type="button" data-role="cancel">Cancel</button>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Withdrawing</h2>
    <div class="stage">
      <div class="cluster rings">
        ${raw(ringMarkup('ring-bundle', 'Bundle', ringState(store.phase)))}
      </div>
      <span class="amount mono" data-role="elapsed">${elapsed(Date.now() - store.startedMs)}</span>
      <span class="subtitle" data-role="phase">${label}</span>
    </div>
    <div class="banner">
      <span class="ic">${raw(icons.shield())}</span>
      <span><span class="banner-title">Keep this window open</span>One proof runs on this device — about two minutes. You can look at other screens; closing the wallet stops it.</span>
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

    // An asset the node's registry does not list is refused at the very first step, not after the
    // whole address/amount/review walk: its decimals are this wallet's guess, so nothing the user
    // could type about it means what they meant (task 4.5's M6).
    if (isUnlisted(asset)) {
      endOfTheRoad(cannotMarkup(`${asset.symbol} cannot be withdrawn`, UNLISTED_TEXT));
      return;
    }

    // Only now — a shell that can carry a burn out, and an asset that was not already refused —
    // is the node asked for the bridge's state.
    try {
      state = (await bridge.state()) || state;
    } catch (err) {
      if (!live()) return;
      endOfTheRoad(cannotMarkup('Could not start a withdrawal', (err && err.message) || 'Something went wrong.'));
      return;
    }
    if (!live()) return;

    // Every coin that backs this token, straight from `assets.list()`. A burn names one of them
    // (`to_chain` + `token`), so this is the choice the flow opens on.
    const backings = backingsOf(asset);
    const chains = Array.isArray(state.chains) ? state.chains : [];
    const first = backings[0] || null;

    // ---- the draft ----
    let draft = ctx.state.withdrawDraft;
    if (!draft || draft.assetIndex !== index) {
      draft = {
        assetIndex: index,
        toChain: first ? Number(first.chain) : null,
        token: first ? first.token : '',
        to: '', amount: '', relayerFee: '', estimate: null, display: '', padded: '',
      };
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
      if (next === 'address' && (draft.toChain === null || !draft.token)) next = 'chain';
      step = next;
      confirmed = false;
      if (next === 'chain') stepEl.innerHTML = backingStepMarkup(asset, { chains, backings });
      else if (next === 'address') stepEl.innerHTML = addressStepMarkup(asset, draft.toChain, draft);
      else if (next === 'amount') stepEl.innerHTML = amountStepMarkup(asset, draft);
      else if (next === 'review') {
        stepEl.innerHTML = reviewStepMarkup({
          asset, display: draft.display, toChain: draft.toChain, units: reviewUnits, estimate: draft.estimate, assets,
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

    // The ring changes state with the phase, so the block is repainted whole rather than patched:
    // it is one small SVG and a label, and a half-updated pair of them is exactly the confusion
    // they exist to prevent.
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
    else goStep(draft.estimate ? 'review' : (draft.padded ? 'amount' : 'chain'), { focus: false });

    // ---- handlers ----
    const offChain = on(root, '[data-chain]', 'click', (evt, btn) => {
      evt.preventDefault();
      const chosen = backings[Number(btn.dataset.backing)] || null;
      if (!chosen) return;
      // A changed coin invalidates whatever was estimated against the old one: the release unit
      // and the amount that coin is holding are both its own.
      if (draft.token !== chosen.token || draft.toChain !== Number(chosen.chain)) draft.estimate = null;
      draft.toChain = Number(chosen.chain);
      draft.token = chosen.token;
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
      // A burn's fee is RAND out of slots 2–3 of the same bundle, so the whole asset balance is
      // withdrawable — it is never the fee's source, whatever is being burned.
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
      // costs an RPC round trip on the way to costing a proof.
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
          token: draft.token,
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
      if (!draft.estimate || reviewUnits <= 0n || !draft.padded || draft.toChain === null || !draft.token) return;
      const store = startWithdrawal(ctx, {
        asset: index,
        amount: reviewUnits.toString(),
        relayerFee: String(draft.estimate.relayerFee || '0'),
        toChain: draft.toChain,
        token: draft.token,
        to: draft.padded,
        // An absent fee is left ABSENT — `String(fee || '')` would slip `''` past the backend's
        // own default and reach `plan_burn` as a fee the chain never named (task 4.5's T4).
        fee: draft.estimate.fee ? String(draft.estimate.fee) : undefined,
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
