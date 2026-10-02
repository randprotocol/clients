// Send flow — every string that reaches the DOM, in one place.
//
// Everything here goes through `h`, so every value is escaped; the only `raw()` calls are around
// icons and around markup this module built itself. Backend- and node-controlled strings (a
// `canProve` reason, an estimate's failure message, an address, a hash) are interpolated, never
// raw, and a hash is validated before it is allowed near a URL.
//
// Layout note: a step's blocks are children of `[data-role="step"]`, which is a `.stack.loose`,
// so nothing in the flow ever sits flush against the thing above it. The screen has exactly one
// title — the step's own heading; the top bar carries the back button and no second title.
import { expectedMs, progressAt, remainingText } from '../../lib/progress.js';
import { h, raw } from '../../lib/dom.js';
import { icons } from '../../lib/icons.js';
import { formatUnits, shortAddress, elapsed } from '../../lib/format.js';
import { avatarMarkup, listMarkup } from '../../lib/rows.js';
import { unlistedText, canSendAsset, feeDecimals, feeSymbol } from '../../lib/assets.js';
import { phaseLabel, provingBanner, CANCELLABLE, unknownNotice, unknownConfirm, MEMO_MAX_BYTES, noMemoNotice, proveCost } from './state.js';
import { t } from '../../i18n.js';

export function shellMarkup() {
  return h`
    <h1 class="sr-only">${t('Send')}</h1>
    <div class="narrow">
      <div class="topbar">
        <button class="btn-icon icon-flip" type="button" data-role="back" aria-label="${t('Back')}">${raw(icons.chevron())}</button>
        <span class="grow"></span>
      </div>
      <p class="caption" data-role="step-indicator" aria-live="polite"></p>
      <div class="stack loose" data-role="step"><div class="skeleton block"></div></div>
    </div>`;
}

/** The standing warning a transfer of unknown outcome leaves on the flow for the rest of the
 *  session. Shown above the form and above the review, never alone. */
function unknownNoticeMarkup(record) {
  if (!record) return '';
  return raw(h`
    <div class="banner warn" data-role="unknown-notice">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${t('Check Activity first')}</span>${unknownNotice()} ${t('Sending twice would pay twice.')}</span>
    </div>`);
}

function assetRowMarkup(asset) {
  // Chain 14 transfers any asset the registry lists, so the only row that is off is an asset this
  // wallet holds but the node does not list: its decimals are a guess, and the row says so rather
  // than letting an amount be typed against them.
  const sendable = canSendAsset(asset);
  const hintId = `send-unlisted-hint-${asset.index}`;
  const off = sendable ? '' : raw(h` aria-disabled="true" aria-describedby="${hintId}"`);
  const rplChip = asset.index >= 1 ? raw(h`<span class="chip xs">RPL</span>`) : '';
  const hint = sendable ? '' : raw(h`<p class="caption" id="${hintId}">${unlistedText()}</p>`);
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

export function assetStepMarkup(assets, unknown = null) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('Which asset?')}</h2>
    ${unknownNoticeMarkup(unknown)}
    <div class="card flush">${listMarkup(assets.map((a) => assetRowMarkup(a)))}</div>`;
}

/** The end of the road for an asset that cannot be sent at all — one the node's registry does
 *  not list (see UNLISTED_TEXT), or one this wallet simply does not hold. Never a form: a form
 *  would let an amount be typed against decimals nobody vouched for. */
export function unsendableMarkup(asset, { hasRand = true } = {}) {
  const alternative = hasRand
    ? raw(h`<button class="btn btn-primary block" type="button" data-go="send/0">${t('Send RAND instead')}</button>`)
    : raw(h`<button class="btn btn-primary block" type="button" data-go="receive">${t('Receive RAND')}</button>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${asset ? t('{symbol} cannot be sent', { symbol: asset.symbol }) : t('This asset cannot be sent')}</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${asset ? t('Not in the token registry') : t('Not in this wallet')}</span>${asset ? unlistedText() : t('This wallet holds no such asset.')}</span>
    </div>
    ${alternative}
    <button class="btn btn-ghost block" type="button" data-go="home">${t('Back to home')}</button>`;
}

/** No asset 0 in `assets.list()` at all. The screen says so rather than rendering a form against
 *  an asset this wallet does not have — a fabricated zero-balance RAND would let someone fill in
 *  an amount and only find out at the last step. */
export function noRandMarkup() {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('No RAND to send yet')}</h2>
    <div class="card" data-role="no-rand">
      <div class="empty">
        <span class="avatar lg">${raw(icons.arrowUpRight())}</span>
        <span>${t('Transfers on this network are paid for in RAND. Receive some, or take some from the faucet, and this screen will be ready.')}</span>
      </div>
    </div>
    <button class="btn btn-primary block" type="button" data-go="receive">${raw(icons.arrowDownLeft())}${t('Receive RAND')}</button>
    <button class="btn block" type="button" data-go="faucet">${raw(icons.droplet())}${t('Get test RAND from the faucet')}</button>`;
}

export function detailsStepMarkup(asset, draft, {
  canPaste = false, canScan = false, canPickContact = false, memoSupported = false, unknown = null,
} = {}) {
  // No Paste button where the shell cannot read the clipboard (it is optional in the Backend
  // contract), and no camera button where nothing can scan: a button that does nothing is worse
  // than no button.
  const paste = canPaste ? raw(h`<button class="btn sm" type="button" data-role="paste">${t('Paste')}</button>`) : '';
  const scan = canScan ? raw(h`<button class="btn sm" type="button" data-role="scan" aria-label="${t('Scan a QR code')}">${t('Scan')}</button>`) : '';
  const pick = canPickContact ? raw(h`<button class="btn sm" type="button" data-role="pick-contact">${t('Contacts')}</button>`) : '';
  // The memo field only where the chain carries a memo (its limits report an envelope size). Its
  // value is written by the screen as a property, never into this markup: it is user text.
  const memo = memoSupported
    ? raw(h`
      <div class="field">
        <div class="field-top">
          <label class="label" for="send-memo">${t('Memo')}</label>
          <span class="caption" data-role="memo-count" aria-live="polite">${t('{used}/{max} bytes', { used: 0, max: MEMO_MAX_BYTES })}</span>
        </div>
        <textarea id="send-memo" name="memo" rows="2" autocomplete="off" aria-describedby="send-memo-hint"></textarea>
        <span class="hint" id="send-memo-hint">${t('Optional. Encrypted with the payment: only the recipient, you, and anyone shown the transaction key can read it.')}</span>
        <span class="error" id="send-memo-error"></span>
      </div>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('Where to?')}</h2>
    ${unknownNoticeMarkup(unknown)}
    <form class="stack loose" data-role="send-form" novalidate>
      <div class="field">
        <div class="field-top">
          <label class="label" for="send-to">${t('Recipient')}</label>
          <span class="cluster">${pick}${scan}${paste}</span>
        </div>
        <textarea id="send-to" name="to" rows="2" spellcheck="false" autocomplete="off" placeholder="${t('rand1…, randpay:… or a contact')}" aria-describedby="send-to-hint">${draft.to}</textarea>
        <span class="hint" id="send-to-hint">${t('An address (rand1…), a payment link (randpay:…), or a saved contact’s name.')}</span>
        <span class="error" id="send-to-error"></span>
        <span class="caption mono" data-role="to-link"></span>
      </div>
      <div class="field amount-field">
        <div class="field-top">
          <label class="label" for="send-amount">${t('Amount')}</label>
          <button class="btn sm" type="button" data-role="max">${t('Max')}</button>
        </div>
        <input id="send-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${draft.amount}" aria-describedby="send-amount-hint">
        <span class="hint" id="send-amount-hint">${t('Available {amount} {symbol}', { amount: formatUnits(asset.balance ?? '0', 6, asset.decimals), symbol: asset.symbol })}</span>
        <span class="error" id="send-amount-error"></span>
      </div>
      ${memo}
      <div data-role="memo-notice"></div>
      <div data-role="form-banner"></div>
      <button class="btn btn-primary block" type="submit">${t('Review')}</button>
    </form>`;
}

/** The standing notice for a memo this chain cannot carry (a link brought one). It blocks
 *  Continue until the user drops it; the memo itself is not shown here, only that there is one. */
export function noMemoNoticeMarkup() {
  return h`
    <div class="banner warn" data-role="no-memo">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${noMemoNotice()}</span>${t('Clear it to continue without it, or ask for a link without a memo.')}</span>
    </div>
    <button class="btn block" type="button" data-role="clear-memo">${t('Clear the memo')}</button>`;
}

/** The contact picker's sheet. Names are written by the screen as text; this is the frame. */
export function contactPickerMarkup(count) {
  const list = count === 0
    ? raw(h`<p class="sheet-sub">${t('No contacts yet. Save one from Settings, or paste an address.')}</p>`)
    : raw(h`<ul class="list" role="list">${raw(Array.from({ length: count }, () => '<li><button class="row" type="button" data-pick-contact=""><span class="row-main"><span class="row-title"><span class="truncate" data-role="pick-name"></span></span><span class="row-sub mono" data-role="pick-address"></span></span></button></li>').join(''))}</ul>`);
  return h`
    <h3 class="sheet-title">${t('Send to a contact')}</h3>
    ${list}
    <div class="sheet-foot">
      <button class="btn" type="button" data-role="manage-contacts">${t('Manage contacts')}</button>
      <button class="btn btn-primary" type="button" data-role="close-picker">${t('Close')}</button>
    </div>`;
}

/** The browser camera's sheet (./lib/scan-qr.js). */
export function scanSheetMarkup() {
  return h`
    <h3 class="sheet-title">${t('Scan a payment link')}</h3>
    <video class="scan-video" data-role="scan-video" playsinline muted></video>
    <p class="sheet-sub" data-role="scan-status">${t('Point the camera at a Rand QR code.')}</p>
    <div class="sheet-foot"><button class="btn" type="button" data-role="cancel-scan">${t('Cancel')}</button></div>`;
}

/**
 * The one-time notice before the first proof made by the RandProtocol provers, the default where
 * this device cannot prove (wallet 0.6.8; a pool of keyed members since 0.6.9): what it learns, that it cannot spend, and the way to
 * use a prover of your own instead — right there, before anything is sent. `canProve.notice`
 * (the engine's) decides when it is shown; acknowledging it is remembered for this wallet.
 */
/** The RandProtocol provers, named the one way every surface names them (wallet 0.6.9). */
export function poolPhrase(n) {
  return Number.isSafeInteger(n) && n > 0
    ? t('the RandProtocol provers ({n} machines run by the validators; each one that proves a send sees that wallet\'s viewing key)', { n })
    : t('the RandProtocol provers (machines run by the validators; each one that proves a send sees that wallet\'s viewing key)');
}

/** The whole notice is one sentence per case (a known count of machines, or none), never
 *  `poolPhrase` glued into a frame: a language declines "one of the provers" its own way. */
export function defaultProverNotice(n) {
  return Number.isSafeInteger(n) && n > 0
    ? t('This device cannot make the proof, so one of the RandProtocol provers ({n} machines run by the validators; '
      + 'each one that proves a send sees that wallet\'s viewing key) makes it. '
      + 'The one that does receives this wallet\'s viewing key, so it can read your whole history — every payment received and sent, past and future. '
      + 'It cannot spend. You are asked once; to keep your history to yourself, use your own prover instead.', { n })
    : t('This device cannot make the proof, so one of the RandProtocol provers (machines run by the validators; '
      + 'each one that proves a send sees that wallet\'s viewing key) makes it. '
      + 'The one that does receives this wallet\'s viewing key, so it can read your whole history — every payment received and sent, past and future. '
      + 'It cannot spend. You are asked once; to keep your history to yourself, use your own prover instead.');
}

export function proverNoticeMarkup(n) {
  return h`
    <div class="banner warn" data-role="prover-notice">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${t('The RandProtocol provers can read your history')}</span>${defaultProverNotice(n)}</span>
    </div>
    <button class="btn btn-primary block" type="button" data-action="acknowledge-prover">${t('I understand — continue')}</button>
    <button class="btn block" type="button" data-go="settings" data-role="use-own-prover">${t('Use my own prover')}</button>`;
}

/**
 * Firefox did not let the wallet send its viewing key to the RandProtocol prover (its
 * `financialAndPaymentInfo` data-collection permission, asked from the notice's own click): this
 * browser then has no prover, and the way out is one of the user's own.
 */
export const proverConsentDeclined = () => t('Firefox did not allow this wallet to send your viewing key to the RandProtocol provers, '
  + 'so this browser has no prover to make the proof. Nothing was sent. Pair your own prover in Settings.');
/** The same sentence in English, the old export, kept unchanged for a screen still importing it (swap). */
export const PROVER_CONSENT_DECLINED = 'Firefox did not allow this wallet to send your viewing key to the RandProtocol provers, so this browser has no prover to make the proof. Nothing was sent. Pair your own prover in Settings.';

export function proverDeclinedMarkup() {
  return h`
    <div class="banner warn" data-role="prover-declined">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${t('No prover')}</span>${proverConsentDeclined()}</span>
    </div>
    <button class="btn block" type="button" data-go="settings" data-role="use-own-prover">${t('Pair your own prover in Settings')}</button>`;
}

/** The RandProtocol prover is the way to prove here, and it did not answer: plainly, and the way out. */
export function proverUnreachableMarkup(reason, busy) {
  // The engine flags a busy pool (`busy: true`); the reason itself is translated, so matching its
  // words only works in English and is the fallback for an answer that carries no flag.
  const isBusy = typeof busy === 'boolean' ? busy : /all busy/.test(String(reason || ''));
  return h`
    <div class="banner warn" data-role="prover-unreachable">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${isBusy ? t('The RandProtocol provers are busy') : t('The RandProtocol provers cannot be reached')}</span>${reason || t('They did not answer.')}</span>
    </div>
    <button class="btn block" type="button" data-go="settings" data-role="use-own-prover">${t('Pair your own prover in Settings')}</button>`;
}

export function reviewStepMarkup({ asset, to, units, estimate, canProve, unknown = null, assets = [] }) {
  const fee = BigInt(estimate.fee || '0');
  const amountOf = (u) => t('{amount} {symbol}', { amount: formatUnits(u, 9, asset.decimals), symbol: asset.symbol });
  // The fee is RAND, whatever is being sent — chain 14's bundle pays it out of slots 2–3 — so it
  // is denominated in the native token and read at the native token's own decimals, never the
  // sent asset's and never a written 9.
  const feeOf = (u) => t('{amount} {symbol}', { amount: formatUnits(u, 9, feeDecimals(assets)), symbol: feeSymbol(assets) });
  const changeRow = estimate.change !== undefined && estimate.change !== null
    ? raw(h`<div class="kv"><span class="k">${t('Change back to you')}</span><span class="v amount">${amountOf(estimate.change)}</span></div>`)
    : '';
  // Amount + fee is only a number when both are the same asset. For a token transfer the fee is
  // RAND out of the other half of the bundle, and "0.5 zUSD + 0.00001 RAND" is not a Total.
  const totalRow = Number(asset.index) === 0
    ? raw(h`<div class="kv"><span class="k">${t('Total')}</span><span class="v amount">${amountOf(units + fee)}</span></div>`)
    : '';
  // A standing unknown outcome makes proving again a deliberate act: the box has to be ticked
  // before the button is live. `unknown` is already null once a later scan has settled the
  // question (see unknownOutcome), so there is nothing else to ask here.
  const gated = !!unknown;
  const gate = gated
    ? raw(h`
      <label class="check">
        <input type="checkbox" name="checked-activity">
        <span>${unknownConfirm()}</span>
      </label>`)
    : '';
  const footer = canProve.ok && canProve.notice
    ? raw(proverNoticeMarkup(canProve.provers))
    : !canProve.ok && canProve.unreachable
      ? raw(proverUnreachableMarkup(canProve.reason, canProve.busy))
      : canProve.ok
    ? raw(h`
      ${gate}
      <button class="btn btn-primary block" type="button" data-action="prove"${raw(gated ? ' disabled' : '')}>${raw(icons.arrowUpRight())}${t('Prove and send')}</button>
      <p class="caption">${proveCost(estimate.proofs)}</p>`)
    : raw(h`
      <div class="banner warn">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">${t('This device cannot prove the transfer')}</span>${canProve.reason || t('Proving is not available here.')} ${t('Your keys import into the desktop app, which proves natively; nothing else about this wallet changes.')}</span>
      </div>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('Review')}</h2>
    ${unknownNoticeMarkup(unknown)}
    <p class="confirm-line mono" data-role="confirm-line"></p>
    <p class="confirm-line confirm-memo memo-line mono" data-role="confirm-memo"></p>
    <div class="card">
      <div class="kv">
        <span class="k">${t('To')}</span>
        <span class="v cluster">
          <span class="mono truncate">${shortAddress(to)}</span>
          <button class="btn-icon" type="button" data-role="expand-to" aria-label="${t('Show the full address')}" aria-expanded="false">${raw(icons.eye())}</button>
        </span>
      </div>
      <div class="kv"><span class="k">${t('Amount')}</span><span class="v amount">${amountOf(units)}</span></div>
      <div class="kv"><span class="k">${t('Network fee')}</span><span class="v amount">${feeOf(fee)}</span></div>
      ${totalRow}
      ${changeRow}
    </div>
    <div class="address-box" data-role="to-full" hidden><span class="mono">${to}</span></div>
    ${footer}
    <button class="btn btn-ghost block" type="button" data-role="edit">${t('Edit')}</button>`;
}

/**
 * The proving ring: an estimate, not a measurement — the elapsed time against how long this kind
 * of send usually takes on this device (ui/lib/progress.js). It fills towards 90% at the usual
 * time, creeps after that, and says how long is left; 100% is only the "sent" screen.
 */
export function progressRing(store, label = '') {
  const spent = Date.now() - store.startedMs;
  const expected = expectedMs(store.kind || 'transfer');
  const pct = progressAt(spent, expected);
  const shown = Math.round(pct * 100);
  return h`
      <div class="ring" data-role="ring" role="progressbar" aria-label="${label}" aria-valuetext="${remainingText(spent, expected)}" style="--pct: ${pct.toFixed(3)}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-track" cx="60" cy="60" r="52"></circle>
          <circle class="ring-bar" cx="60" cy="60" r="52"></circle>
        </svg>
        <div class="ring-label">
          <span class="ring-pct" data-role="pct">${shown}%</span>
          <span class="ring-cap" data-role="left">${remainingText(spent, expected)}</span>
          <span class="ring-cap mono" data-role="elapsed">${elapsed(spent)}</span>
        </div>
      </div>`;
}

export function provingStepMarkup(store) {
  const label = phaseLabel(store.phase, store.detail);
  const banner = provingBanner(store);
  const cancel = store.controller && CANCELLABLE.includes(store.phase)
    ? raw(h`<button class="btn block" type="button" data-role="cancel">${t('Cancel')}</button>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('Sending')}</h2>
    <div class="stage">
      ${raw(progressRing(store, label))}
      <span class="subtitle" data-role="phase">${label}</span>
    </div>
    <div class="banner">
      <span class="ic">${raw(icons.shield())}</span>
      <span><span class="banner-title" data-role="proving-banner-title">${banner.title}</span><span data-role="proving-banner">${banner.text}</span></span>
    </div>
    <div data-role="prove-actions">${cancel}</div>`;
}

/**
 * A failure that happened before anything was broadcast: nothing moved, so a retry is safe.
 * `resumable` is a paired prover that ran out of time (`err.proverSilent`): its job is still
 * pending there, so the ways on are Resume (the same job) and Cancel (forget it), not a new send
 * — which the engine would refuse while the job is pending.
 */
export function failedStepMarkup(message, { resumable = false } = {}) {
  const actions = resumable
    ? raw(h`<button class="btn btn-primary block" type="button" data-role="resume-proof">${t('Resume')}</button>
    <button class="btn block" type="button" data-role="cancel-proof">${t('Cancel the proof')}</button>`)
    : raw(h`<button class="btn btn-primary block" type="button" data-role="retry">${t('Back to review')}</button>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('Not sent')}</h2>
    <div class="banner negative">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${resumable ? t('Not sent yet') : t('The transfer was not sent')}</span>${message}</span>
    </div>
    ${actions}
    <button class="btn btn-ghost block" type="button" data-go="home">${t('Back to home')}</button>`;
}

/**
 * A failure at or after `'submitting'`. The transaction left this device and may be on chain, so
 * this screen offers no way back to Review and no way to prove again — only a way to go and look.
 * `hash` has already been validated; `explorer` is `{url, label}` or null.
 */
export function unknownOutcomeStepMarkup({ message, hash, explorer }) {
  const detail = message
    ? raw(h`<p class="caption">${t('The wallet was told: {message}', { message })}</p>`)
    : '';
  const hashRow = hash
    ? raw(h`<div class="card"><div class="kv"><span class="k">${t('Transaction')}</span><span class="v mono truncate">${hash}</span></div></div>`)
    : '';
  const explorerBtn = explorer
    ? raw(h`<button class="btn block" type="button" data-role="explorer-unknown">${explorer.label}</button>`)
    : '';
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">${t('We couldn’t confirm this transfer')}</h2>
    <div class="banner warn">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">${t('Outcome unknown')}</span>${t('It may already have been sent. Check Activity before sending again — sending twice would pay twice.')}</span>
    </div>
    ${hashRow}
    ${detail}
    <button class="btn btn-primary block" type="button" data-role="check-activity">${t('Check Activity')}</button>
    ${explorerBtn}
    <button class="btn btn-ghost block" type="button" data-go="home">${t('Back to home')}</button>`;
}
