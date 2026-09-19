// Transaction detail (#tx/<hash>) and note detail (#note/<index>). Both pull their record out of
// `sync.cached()` by the route arg — the backend contract has no per-hash/per-note getter, so
// this is the same source home/activity/asset already read. "Open in randscan" only ever puts the
// transaction hash in the URL (amendment 7) — never a viewing key, spend key or transaction key.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, shortAddress, shortHex } from '../lib/format.js';

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
    let alive = true;
    let assets, sync, settings;
    try {
      [assets, sync, settings] = await Promise.all([
        ctx.backend.assets.list(), ctx.backend.sync.cached(), ctx.backend.settings.get(),
      ]);
    } catch (err) {
      if (!alive) return () => { alive = false; };
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load this transaction</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return () => { alive = false; };
    }
    if (!alive) return () => { alive = false; };

    const item = (sync.activity || []).find((a) => a.hash === hash);
    if (!item) {
      root.innerHTML = notFoundMarkup('Transaction', 'activity', 'This transaction was not found.');
      return () => { alive = false; };
    }
    const asset = assets.find((a) => a.index === item.asset) || { symbol: `RPL#${item.asset}`, decimals: 9 };
    const kind = item.kind === 'in' || item.kind === 'out' ? item.kind : 'pending';
    const sign = kind === 'in' ? '+' : kind === 'out' ? '−' : '';
    const statusChip = raw(kind === 'pending'
      ? h`<span class="chip warn">Pending</span>`
      : h`<span class="chip positive">${raw(icons.check())}Confirmed</span>`);
    const addressRow = raw(item.address ? h`<div class="kv"><span class="k">${kind === 'in' ? 'From' : 'To'}</span><span class="v mono">${shortAddress(item.address)}</span></div>` : '');
    const blockRow = raw(item.block ? h`<div class="kv"><span class="k">Block</span><span class="v amount">${item.block.toLocaleString('en-US')}</span></div>` : '');
    const feeRow = raw(item.fee ? h`<div class="kv"><span class="k">Fee</span><span class="v amount">${formatUnits(item.fee, 6, 9)} RAND</span></div>` : '');
    const keyRow = raw(item.txKey ? h`
        <div class="kv wrap">
          <span class="k">Transaction key</span>
          <span class="v cluster">
            <span class="mono truncate" data-role="txkey" data-full="${item.txKey}" data-short="${shortHex(item.txKey)}">${shortHex(item.txKey)}</span>
            <button class="btn-icon" type="button" data-role="reveal-key" aria-label="Reveal the full transaction key">${raw(icons.eye())}</button>
            <button class="btn-icon" type="button" data-role="copy-key" aria-label="Copy the transaction key">${raw(icons.copy())}</button>
          </span>
        </div>` : '');
    const noteLink = raw(kind === 'in' && item.index !== undefined ? h`<button class="btn-ghost sm" type="button" data-go="note/${item.index}">View the received note</button>` : '');

    root.innerHTML = h`
      <h1 class="sr-only">Transaction</h1>
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="activity" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Transaction</span><span class="spacer"></span></div>
      <div class="card stack">
        <div class="card-head"><h3>Transaction</h3>${statusChip}</div>
        <span class="amount ${kind === 'in' ? 'in' : ''}">${sign}${formatUnits(item.amount, 6, asset.decimals)}<span class="unit">${asset.symbol}</span></span>
        ${addressRow}
        ${blockRow}
        ${feeRow}
        ${keyRow}
        ${noteLink}
        <button class="btn block" type="button" data-role="explorer">View in explorer</button>
      </div>`;

    const offReveal = on(root, '[data-role="reveal-key"]', 'click', (evt, btn) => {
      evt.preventDefault();
      const span = root.querySelector('[data-role="txkey"]');
      const revealed = span.textContent === span.dataset.full;
      span.textContent = revealed ? span.dataset.short : span.dataset.full;
      btn.setAttribute('aria-label', revealed ? 'Reveal the full transaction key' : 'Hide the transaction key');
    });
    const offCopyKey = on(root, '[data-role="copy-key"]', 'click', async (evt) => {
      evt.preventDefault();
      await ctx.backend.platform.copy(item.txKey);
      ctx.toast('Transaction key copied', { kind: 'positive' });
    });
    // Never build this URL from anything but the public hash — no viewing key, spend key or
    // transaction key ever reaches platform.openExternal (amendment 7).
    const offExplorer = on(root, '[data-role="explorer"]', 'click', (evt) => {
      evt.preventDefault();
      const base = (settings.explorerUrl || 'https://explorer.rand.example').replace(/\/$/, '');
      ctx.backend.platform.openExternal(`${base}/tx/${item.hash}`);
    });

    return () => { alive = false; offReveal(); offCopyKey(); offExplorer(); };
  },
});

// ---------------------------------------------------------------------------------- note ------
registerScreen('note', {
  render: () => skeletonMarkup('Note', 'home'),
  async after(ctx, root, indexArg) {
    let alive = true;
    let assets, sync;
    try {
      [assets, sync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
    } catch (err) {
      if (!alive) return () => { alive = false; };
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load this note</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return () => { alive = false; };
    }
    if (!alive) return () => { alive = false; };

    const note = (sync.notes || []).find((n) => String(n.index) === String(indexArg));
    if (!note) {
      root.innerHTML = notFoundMarkup('Note', 'home', 'This note was not found.');
      return () => { alive = false; };
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
      ctx.toast('Commitment copied', { kind: 'positive' });
    });

    return () => { alive = false; offCopy(); };
  },
});
