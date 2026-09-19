// `#sent/<hash>` — the receipt for a submitted transfer.
//
// The per-transaction key reaches this screen through the session-keyed handoff in ./state.js
// (which the send itself filled at the moment the backend answered, whatever screen was mounted)
// and lives in this closure alone. The reveal, the masking and the copy are the shared helper in
// lib/reveal.js, so the one rule — the secret is only ever in one text node, never an attribute,
// never `ctx.state`, never the URL — is implemented once. Reached cold (a reload, or a second
// visit) there is simply no key, and the screen says what it can.
import { h, raw, on } from '../../lib/dom.js';
import { icons } from '../../lib/icons.js';
import { registerScreen } from '../../app.js';
import { formatUnits, shortAddress, shortHex } from '../../lib/format.js';
import { explorerLink } from '../../lib/explorer.js';
import { wireSecretReveal } from '../../lib/reveal.js';
import { takeResult, clearFinishedSend } from './state.js';

function sentSkeletonMarkup() {
  return h`<div class="narrow"><div class="skeleton block"></div></div>`;
}

registerScreen('sent', {
  tab: 'home',
  render: () => sentSkeletonMarkup(),
  async after(ctx, root, hash) {
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;

    // Consumed here and nowhere else: the key crosses from the send flow exactly once, and a
    // reload (or a second visit) simply finds nothing, which is the correct answer.
    const result = takeResult(ctx.session, hash);
    let txKey = (result && result.txKey) || null;

    // The receipt has been reached, so the finished send is done with — and so is the chip that
    // led here.
    clearFinishedSend(ctx, hash);
    ctx.setPinnedChip(null);

    let assets = [];
    let settings = {};
    try {
      [assets, settings] = await Promise.all([ctx.backend.assets.list(), ctx.backend.settings.get()]);
    } catch { /* the receipt still stands without them */ }
    if (!live()) { txKey = null; return; }

    const asset = assets.find((a) => a.index === (result ? result.assetIndex : 0)) || { symbol: 'RAND', decimals: 9 };
    const explorer = explorerLink(settings.explorerUrl, hash);

    const amountLine = result
      ? raw(h`<span class="amount">${formatUnits(result.amount, 9, asset.decimals)}<span class="unit">${asset.symbol}</span></span>`)
      : '';
    const toRow = result
      ? raw(h`<div class="kv"><span class="k">To</span><span class="v mono truncate">${shortAddress(result.to)}</span></div>`)
      : '';
    const keyBlock = txKey
      ? raw(h`
        <div class="card stack">
          <span class="caption">The transaction key discloses this one payment — its amount and its recipient — to whoever you give it to. It cannot spend anything.</span>
          <div class="hold-reveal">
            <span class="key-mask masked" data-role="txkey">•••• •••• •••• •••• •••• ••••</span>
            <button class="btn block hold-btn" type="button" data-role="hold"><span class="fill"></span>${raw(icons.eye())}Hold to reveal</button>
            <button class="btn block" type="button" data-role="timed"></button>
            <button class="btn block" type="button" data-role="copy-key">${raw(icons.copy())}Copy transaction key</button>
          </div>
        </div>`)
      : raw(h`<button class="btn block" type="button" data-go="tx/${hash}">View this transaction</button>`);
    const explorerBtn = explorer
      ? raw(h`<button class="btn block" type="button" data-role="explorer">${explorer.label}</button>`)
      : '';

    root.innerHTML = h`
      <h1 class="sr-only">Sent</h1>
      <div class="narrow">
        <div class="stage">
          <span class="avatar lg in">${raw(icons.check())}</span>
          <h2 class="title" data-role="step-title" tabindex="-1">Transfer submitted</h2>
          ${amountLine}
        </div>
        <div class="card">
          ${toRow}
          <div class="kv"><span class="k">Transaction</span><span class="v mono truncate">${shortHex(hash, 10)}</span></div>
        </div>
        ${keyBlock}
        ${explorerBtn}
        <button class="btn btn-primary block" type="button" data-go="home">Done</button>
      </div>`;

    const title = root.querySelector('[data-role="step-title"]');
    if (title && typeof title.focus === 'function') title.focus();

    // The key never leaves this closure: the helper reads it through `getSecret` at the moment it
    // paints, and blanks the node again on teardown. Deliberately NOT `dropOnHide` — someone
    // switching windows to paste a transaction key somewhere must not come back to nothing.
    const reveal = wireSecretReveal(root, {
      getSecret: () => txKey,
      selectors: { mask: '[data-role="txkey"]', hold: '[data-role="hold"]', timed: '[data-role="timed"]', copy: '[data-role="copy-key"]' },
      copy: (secret) => ctx.backend.platform.copy(secret),
      onCopied: () => { if (live()) ctx.toast('Transaction key copied', { kind: 'positive' }); },
      labels: { reveal: 'Show for 10 seconds', hide: 'Hide the transaction key' },
    });

    const offExplorer = on(root, '[data-role="explorer"]', 'click', (evt) => {
      evt.preventDefault();
      if (explorer) ctx.backend.platform.openExternal(explorer.url);
    });

    return () => {
      reveal.destroy();
      txKey = null;
      offExplorer();
    };
  },
});
