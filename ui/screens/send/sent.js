// `#sent/<hash>` — the receipt for a submitted transfer.
//
// The per-transaction key reaches this screen through the session-keyed handoff in ./state.js and
// lives in this closure alone: it is written into one text node while it is revealed, blanked on
// cleanup, and never put in an attribute, in `ctx.state`, in the URL or in storage. Reached cold
// (a reload, or a second visit) there is simply no key, and the screen says what it can.
import { h, raw, on } from '../../lib/dom.js';
import { icons } from '../../lib/icons.js';
import { registerScreen } from '../../app.js';
import { formatUnits, shortAddress, shortHex } from '../../lib/format.js';
import { explorerLink } from '../../lib/explorer.js';
import { HOLD_MS, takeResult } from './state.js';

function sentSkeletonMarkup() {
  return h`
    <div class="narrow">
      <div class="topbar"><span class="topbar-title">Sent</span></div>
      <div class="skeleton block"></div>
    </div>`;
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
      ? raw(h`<div class="kv wrap"><span class="k">To</span><span class="v mono">${shortAddress(result.to)}</span></div>`)
      : '';
    const keyBlock = txKey
      ? raw(h`
        <div class="card stack">
          <span class="caption">The transaction key discloses this one payment — its amount and its recipient — to whoever you give it to. It cannot spend anything.</span>
          <div class="hold-reveal">
            <span class="key-mask masked" data-role="txkey">•••• •••• •••• •••• •••• ••••</span>
            <button class="btn block hold-btn" type="button" data-role="hold"><span class="fill"></span>${raw(icons.eye())}Hold to reveal</button>
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
        <div class="topbar"><span class="topbar-title">Sent</span></div>
        <div class="stage">
          <span class="avatar lg in">${raw(icons.check())}</span>
          <h2 class="title" data-role="step-title" tabindex="-1">Transfer submitted</h2>
          ${amountLine}
        </div>
        <div class="card">
          ${toRow}
          <div class="kv wrap"><span class="k">Transaction</span><span class="v mono">${shortHex(hash, 10)}</span></div>
        </div>
        ${keyBlock}
        ${explorerBtn}
        <button class="btn btn-primary block" type="button" data-go="home">Done</button>
      </div>`;

    const title = root.querySelector('[data-role="step-title"]');
    if (title && typeof title.focus === 'function') title.focus();

    // ---- hold to reveal: the key is written into one text node and nowhere else ----
    const mask = root.querySelector('[data-role="txkey"]');
    const holdBtn = root.querySelector('[data-role="hold"]');
    let holdTimer = null;

    function reveal() {
      if (!txKey || !mask) return;
      mask.textContent = txKey;
      mask.classList.remove('masked');
      if (holdBtn) holdBtn.classList.remove('holding');
    }
    function startHold(evt) {
      evt.preventDefault();
      if (!txKey) return;
      holdBtn.classList.add('holding');
      clearTimeout(holdTimer);
      holdTimer = setTimeout(reveal, HOLD_MS);
    }
    function cancelHold() {
      if (holdBtn) holdBtn.classList.remove('holding');
      clearTimeout(holdTimer);
    }
    if (holdBtn) {
      holdBtn.addEventListener('pointerdown', startHold);
      holdBtn.addEventListener('pointerup', cancelHold);
      holdBtn.addEventListener('pointerleave', cancelHold);
      holdBtn.addEventListener('pointercancel', cancelHold);
      holdBtn.addEventListener('keydown', (evt) => { if (evt.key === 'Enter' || evt.key === ' ') startHold(evt); });
      holdBtn.addEventListener('keyup', cancelHold);
    }

    const offCopy = on(root, '[data-role="copy-key"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!txKey) return;
      await ctx.backend.platform.copy(txKey);
      if (!live()) return;
      ctx.toast('Transaction key copied', { kind: 'positive' });
    });
    const offExplorer = on(root, '[data-role="explorer"]', 'click', (evt) => {
      evt.preventDefault();
      if (explorer) ctx.backend.platform.openExternal(explorer.url);
    });

    return () => {
      clearTimeout(holdTimer);
      if (mask) mask.textContent = '';
      txKey = null;
      offCopy(); offExplorer();
    };
  },
});

