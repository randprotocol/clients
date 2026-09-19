// Transaction detail (#tx/<hash>) and note detail (#note/<index>). Both pull their record out of
// `sync.cached()` by the route arg — the backend contract has no per-hash/per-note getter, so
// this is the same source home/activity/asset already read.
//
// Two rules this screen exists to keep:
//   * the transaction key never leaves this closure. It is not in a DOM attribute (not even a
//     `data-full` one — an attribute is readable by anything with a handle on the document, and
//     survives in the serialised DOM), not in `ctx.state`, not in the hash, not in the console.
//     It is written to one text node while it is revealed, cleared on hide, and dropped on
//     cleanup; `platform.copy()` is handed the closure variable directly.
//   * the explorer URL is built from the transaction hash alone, and only after the hash has been
//     checked against a strict hex pattern — `item.hash` is node-controlled text. If the user has
//     no explorer configured, no button is offered at all rather than a guessed default.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, shortAddress, shortHex } from '../lib/format.js';
import { kindOf } from '../lib/rows.js';
// The explorer rules live in lib/ since task 1.5 (the `#sent` screen needs them too); re-exported
// here because that is where they were, and where the tests import them from.
import { explorerLink } from '../lib/explorer.js';
import { wireSecretReveal } from '../lib/reveal.js';

export { explorerLink };

function skeletonMarkup(title, backGo) {
  return h`
    <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="${backGo}" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">${title}</span><span class="spacer"></span></div>
    <div class="skeleton block"></div>`;
}

function notFoundMarkup(title, backGo, message) {
  return h`
    <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="${backGo}" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">${title}</span><span class="spacer"></span></div>
    <div class="card"><div class="empty"><span class="empty-title">${message}</span></div></div>`;
}

// ------------------------------------------------------------------------------------ tx ------
registerScreen('tx', {
  render: () => skeletonMarkup('Transaction', 'activity'),
  async after(ctx, root, hash) {
    let assets, sync, settings;
    try {
      [assets, sync, settings] = await Promise.all([
        ctx.backend.assets.list(), ctx.backend.sync.cached(), ctx.backend.settings.get(),
      ]);
    } catch (err) {
      if (!ctx.isCurrent()) return;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load this transaction</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!ctx.isCurrent()) return;

    const item = (sync.activity || []).find((a) => a.hash === hash);
    if (!item) {
      root.innerHTML = notFoundMarkup('Transaction', 'activity', 'This transaction was not found.');
      return;
    }

    // The key lives in this closure and is never written to an attribute, ctx.state or the hash.
    // `item` itself is left exactly as the backend returned it — a backend is free to hand back a
    // cached object, and clearing a field on it would destroy the key for everyone (see the
    // read-only rule in ui/backend.js).
    let txKey = item.txKey || null;

    const asset = assets.find((a) => a.index === item.asset) || { symbol: `RPL#${item.asset}`, decimals: 9 };
    const native = assets.find((a) => a.index === 0);
    const k = kindOf(item);
    const statusChip = raw(k.kind === 'pending'
      ? h`<span class="chip warn">${k.title}</span>`
      : h`<span class="chip positive">${raw(icons.check())}Confirmed</span>`);
    // Every row below is optional in the Backend contract — an item may carry none of them.
    const addressRow = raw(item.address ? h`<div class="kv"><span class="k">${k.kind === 'out' ? 'To' : 'From'}</span><span class="v mono">${shortAddress(item.address)}</span></div>` : '');
    const blockRow = raw(item.block ? h`<div class="kv"><span class="k">Block</span><span class="v amount">${item.block.toLocaleString('en-US')}</span></div>` : '');
    // Fees are always paid in the native asset, so they use its decimals — not this row's asset,
    // and not a hard-coded 9.
    const feeRow = raw(item.fee ? h`<div class="kv"><span class="k">Fee</span><span class="v amount">${formatUnits(item.fee, 6, native ? native.decimals : 9)} ${native ? native.symbol : 'RAND'}</span></div>` : '');
    const keyRow = raw(txKey ? h`
        <div class="kv wrap">
          <span class="k">Transaction key</span>
          <span class="v cluster">
            <span class="mono truncate" data-role="txkey">${shortHex(txKey)}</span>
            <button class="btn-icon" type="button" data-role="reveal-key" data-keep-label="true" aria-label="Reveal the full transaction key">${raw(icons.eye())}</button>
            <button class="btn-icon" type="button" data-role="copy-key" aria-label="Copy the transaction key">${raw(icons.copy())}</button>
          </span>
        </div>` : '');
    const noteLink = raw(k.kind === 'in' && item.index !== undefined ? h`<button class="btn btn-ghost sm" type="button" data-go="note/${item.index}">View the received note</button>` : '');
    const explorer = explorerLink(settings.explorerUrl, item.hash);
    const explorerBtn = raw(explorer ? h`<button class="btn block" type="button" data-role="explorer">${explorer.label}</button>` : '');

    root.innerHTML = h`
      <h1 class="sr-only">Transaction</h1>
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="activity" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Transaction</span><span class="spacer"></span></div>
      <div class="card stack">
        <div class="card-head"><h3>${k.title}</h3>${statusChip}</div>
        <span class="amount ${k.sign === '+' ? 'in' : ''}">${k.sign}${formatUnits(item.amount, 6, asset.decimals)}<span class="unit">${asset.symbol}</span></span>
        ${addressRow}
        ${blockRow}
        ${feeRow}
        ${keyRow}
        ${noteLink}
        ${explorerBtn}
      </div>`;

    // The reveal, the masking and the copy are lib/reveal.js — the same implementation the send
    // receipt and the settings key panels use, so the "only ever in one text node" rule is written
    // once. This screen's mask is the shortened key rather than dots, and its reveal control is
    // the icon button it has always been (a plain click, not a hold: the most accessible of the
    // three, and it keeps its own aria-label rather than taking the helper's text).
    const reveal = wireSecretReveal(root, {
      getSecret: () => txKey,
      masked: shortHex(txKey),
      selectors: { mask: '[data-role="txkey"]', hold: null, timed: '[data-role="reveal-key"]', copy: '[data-role="copy-key"]' },
      copy: (secret) => ctx.backend.platform.copy(secret),
      onCopied: () => { if (ctx.isCurrent()) ctx.toast('Transaction key copied', { kind: 'positive' }); },
      labels: { reveal: 'Reveal the full transaction key', hide: 'Hide the transaction key' },
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

// ---------------------------------------------------------------------------------- note ------
registerScreen('note', {
  render: () => skeletonMarkup('Note', 'home'),
  async after(ctx, root, indexArg) {
    let assets, sync;
    try {
      [assets, sync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
    } catch (err) {
      if (!ctx.isCurrent()) return;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load this note</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!ctx.isCurrent()) return;

    const note = (sync.notes || []).find((n) => String(n.index) === String(indexArg));
    if (!note) {
      root.innerHTML = notFoundMarkup('Note', 'home', 'This note was not found.');
      return;
    }
    const asset = assets.find((a) => a.index === note.asset) || { symbol: `RPL#${note.asset}`, decimals: 9 };
    const statusChip = raw(note.spent ? h`<span class="chip">Spent</span>` : h`<span class="chip positive">${raw(icons.check())}Unspent</span>`);
    const blockRow = raw(note.blockHeight ? h`<div class="kv"><span class="k">Block</span><span class="v amount">${note.blockHeight.toLocaleString('en-US')}</span></div>` : '');
    const commitmentRow = raw(note.commitment ? h`
        <div class="kv">
          <span class="k">Commitment</span>
          <span class="v cluster">
            <span class="mono truncate">${shortHex(note.commitment)}</span>
            <button class="btn-icon" type="button" data-role="copy-commitment" aria-label="Copy the commitment">${raw(icons.copy())}</button>
          </span>
        </div>` : '');

    root.innerHTML = h`
      <h1 class="sr-only">Note</h1>
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Note</span><span class="spacer"></span></div>
      <div class="card stack">
        <div class="card-head"><h3>Shielded note</h3>${statusChip}</div>
        <span class="amount">${formatUnits(note.amount, 6, asset.decimals)}<span class="unit">${asset.symbol}</span></span>
        <div class="kv"><span class="k">Note index</span><span class="v amount">${note.index}</span></div>
        ${blockRow}
        ${commitmentRow}
      </div>`;

    const offCopy = on(root, '[data-role="copy-commitment"]', 'click', async (evt) => {
      evt.preventDefault();
      await ctx.backend.platform.copy(note.commitment);
      if (!ctx.isCurrent()) return;
      ctx.toast('Commitment copied', { kind: 'positive' });
    });

    return () => { offCopy(); };
  },
});
