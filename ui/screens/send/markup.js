// Send flow — every string that reaches the DOM, in one place.
//
// Everything here goes through `h`, so every value is escaped; the only `raw()` calls are around
// icons and around markup this module built itself. Backend- and node-controlled strings (a
// `canProve` reason, an estimate's failure message, an address) are interpolated, never raw.
import { h, raw } from '../../lib/dom.js';
import { icons } from '../../lib/icons.js';
import { formatUnits, shortAddress, elapsed } from '../../lib/format.js';
import { avatarMarkup, listMarkup } from '../../lib/rows.js';
import { RPL_SEND_DISABLED_TEXT } from '../asset.js';
import { PHASE_LABELS, CANCELLABLE, PROVE_COST } from './state.js';

export function shellMarkup() {
  return h`
    <h1 class="sr-only">Send</h1>
    <div class="narrow">
      <div class="topbar">
        <button class="btn-icon icon-flip" type="button" data-role="back" aria-label="Back">${raw(icons.chevron())}</button>
        <span class="topbar-title">Send</span>
        <span class="spacer"></span>
      </div>
      <p class="caption" data-role="step-indicator" aria-live="polite"></p>
      <div data-role="step"><div class="skeleton block"></div></div>
    </div>`;
}

function assetRowMarkup(asset) {
  const sendable = asset.index === 0;
  const hintId = `send-rpl-hint-${asset.index}`;
  const off = sendable ? '' : raw(h` aria-disabled="true" aria-describedby="${hintId}"`);
  const rplChip = sendable ? '' : raw(h`<span class="chip xs">RPL</span>`);
  const hint = sendable ? '' : raw(h`<p class="caption" id="${hintId}">${RPL_SEND_DISABLED_TEXT}</p>`);
  return h`
    <li>
      <button class="row" type="button" data-asset="${asset.index}"${off}>
        ${avatarMarkup(asset)}
        <span class="row-main">
          <span class="row-title"><span class="truncate">${asset.name || asset.symbol}</span>${rplChip}</span>
          <span class="row-sub">${asset.symbol}</span>
        </span>
        <span class="row-end"><span class="amount">${formatUnits(asset.balance ?? '0', 6, asset.decimals ?? 9)}</span></span>
      </button>
      ${hint}
    </li>`;
}

export function assetStepMarkup(assets) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Which asset?</h2>
    <div class="card flush">${listMarkup(assets.map((a) => assetRowMarkup(a)))}</div>`;
}

export function rplOnlyMarkup(asset) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${asset ? asset.symbol : 'This asset'} cannot be sent</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">Not on this network</span>${RPL_SEND_DISABLED_TEXT}</span>
    </div>
    <button class="btn btn-primary block" type="button" data-go="send/0">Send RAND instead</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

export function detailsStepMarkup(asset, draft, canPaste) {
  // No Paste button where the shell cannot read the clipboard (it is optional in the Backend
  // contract): a button that does nothing is worse than no button.
  const paste = canPaste ? raw(h`<button class="btn sm" type="button" data-role="paste">Paste</button>`) : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Where to?</h2>
    <form class="stack loose" data-role="send-form" novalidate>
      <div class="field">
        <div class="field-top">
          <label class="label" for="send-to">Recipient</label>
          ${paste}
        </div>
        <textarea id="send-to" name="to" rows="2" spellcheck="false" autocomplete="off" placeholder="rand1…" aria-describedby="send-to-hint">${draft.to}</textarea>
        <span class="hint" id="send-to-hint">Addresses on this network start with rand1.</span>
        <span class="error" id="send-to-error"></span>
      </div>
      <div class="field amount-field">
        <div class="field-top">
          <label class="label" for="send-amount">Amount</label>
          <button class="btn sm" type="button" data-role="max">Max</button>
        </div>
        <input id="send-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${draft.amount}" aria-describedby="send-amount-hint">
        <span class="hint" id="send-amount-hint">Available ${formatUnits(asset.balance ?? '0', 6, asset.decimals)} ${asset.symbol}</span>
        <span class="error" id="send-amount-error"></span>
      </div>
      <div data-role="form-banner"></div>
      <button class="btn btn-primary block" type="submit">Review</button>
    </form>`;
}

export function reviewStepMarkup({ asset, to, units, estimate, canProve }) {
  const fee = BigInt(estimate.fee || '0');
  const changeRow = estimate.change !== undefined && estimate.change !== null
    ? raw(h`<div class="kv"><span class="k">Change back to you</span><span class="v amount">${formatUnits(estimate.change, 9, asset.decimals)} ${asset.symbol}</span></div>`)
    : '';
  // The cost of proving belongs in the summary, with the fee and the total, rather than as a stray
  // line wedged between the card and the button.
  const costRow = canProve.ok
    ? raw(h`<div class="kv wrap"><span class="k">Proving</span><span class="v">${PROVE_COST}</span></div>`)
    : '';
  const footer = canProve.ok
    ? raw(h`<button class="btn btn-primary block" type="button" data-action="prove">${raw(icons.arrowUpRight())}Prove and send</button>`)
    : raw(h`
      <div class="banner warn">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">This device cannot prove the transfer</span>${canProve.reason || 'Proving is not available here.'} Your keys import into the desktop app, which proves natively; nothing else about this wallet changes.</span>
      </div>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Review</h2>
    <div class="card">
      <div class="kv wrap">
        <span class="k">To</span>
        <span class="v cluster">
          <span class="mono truncate">${shortAddress(to)}</span>
          <button class="btn-icon" type="button" data-role="expand-to" aria-label="Show the full address" aria-expanded="false">${raw(icons.eye())}</button>
        </span>
      </div>
      <div class="kv"><span class="k">Amount</span><span class="v amount">${formatUnits(units, 9, asset.decimals)} ${asset.symbol}</span></div>
      <div class="kv"><span class="k">Network fee</span><span class="v amount">${formatUnits(fee, 9, asset.decimals)} ${asset.symbol}</span></div>
      <div class="kv"><span class="k">Total</span><span class="v amount">${formatUnits(units + fee, 9, asset.decimals)} ${asset.symbol}</span></div>
      ${changeRow}
      ${costRow}
    </div>
    <div class="address-box" data-role="to-full" hidden><span class="mono">${to}</span></div>
    ${footer}
    <button class="btn btn-ghost block" type="button" data-role="edit">Edit</button>`;
}

export function provingStepMarkup(store) {
  const label = PHASE_LABELS[store.phase] || 'Working';
  const cancel = store.controller && CANCELLABLE.includes(store.phase)
    ? raw(h`<button class="btn block" type="button" data-role="cancel">Cancel</button>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Sending</h2>
    <div class="stage">
      <div class="ring spin" data-role="ring" role="progressbar" aria-label="${label}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-track" cx="60" cy="60" r="52"></circle>
          <circle class="ring-bar" cx="60" cy="60" r="52"></circle>
        </svg>
        <div class="ring-label"><span class="amount mono" data-role="elapsed">${elapsed(Date.now() - store.startedMs)}</span></div>
      </div>
      <span class="subtitle" data-role="phase">${label}</span>
    </div>
    <div class="banner">
      <span class="ic">${raw(icons.shield())}</span>
      <span><span class="banner-title">Keep this window open</span>The proof runs on this device. You can look at other screens — it keeps going — but closing the wallet stops it.</span>
    </div>
    <div data-role="prove-actions">${cancel}</div>`;
}

export function failedStepMarkup(message) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Not sent</h2>
    <div class="banner negative">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">The transfer was not sent</span>${message}</span>
    </div>
    <button class="btn btn-primary block" type="button" data-role="retry">Back to review</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}
