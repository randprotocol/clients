// Asset detail (#asset/<index>): balance, Receive/Send actions and this asset's recent activity.
//
// RPL assets (index >= 1) cannot be sent on this network — the ledger only admits asset-0
// transfers (amendment 3) — so Send renders disabled with a fixed helper string a later task
// reuses verbatim; RAND's Send links to #send/0. Receive is available for every asset.
import { h, raw } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits } from '../lib/format.js';
import { avatarMarkup, activityRowMarkup, listMarkup } from '../lib/rows.js';

export const RPL_SEND_DISABLED_TEXT = 'RPL transfers are not available on this network.';

function skeletonMarkup() {
  return h`
    <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Asset</span><span class="spacer"></span></div>
    <div class="skeleton hero"></div>`;
}

const HINT_ID = 'asset-send-hint';

function actionsMarkup(asset) {
  const canSend = asset.index === 0;
  // `aria-disabled`, not `disabled`: a `disabled` button is skipped by the keyboard entirely, so
  // the reason it is off (the hint below, tied on with aria-describedby) would never be announced
  // to the one user who most needs it. It carries no `data-go`, so a click does nothing.
  const sendBtn = raw(canSend
    ? h`<button class="btn-round" type="button" data-go="send/0"><span class="ic">${raw(icons.arrowUpRight())}</span><span class="cap">Send</span></button>`
    : h`<button class="btn-round" type="button" aria-disabled="true" aria-describedby="${HINT_ID}"><span class="ic">${raw(icons.arrowUpRight())}</span><span class="cap">Send</span></button>`);
  const hint = raw(canSend ? '' : h`<p class="caption" id="${HINT_ID}" data-role="rpl-hint">${RPL_SEND_DISABLED_TEXT}</p>`);
  return raw(h`
    <div class="actions">
      <button class="btn-round" type="button" data-go="receive"><span class="ic">${raw(icons.arrowDownLeft())}</span><span class="cap">Receive</span></button>
      ${sendBtn}
    </div>
    ${hint}`);
}

function bodyMarkup({ asset, activity, assetsByIndex }) {
  const rplChip = raw(asset.index >= 1 ? h`<span class="chip xs">RPL</span>` : '');
  const pending = raw(asset.pending && asset.pending !== '0'
    ? h`<span class="sub">+${formatUnits(asset.pending, 6, asset.decimals)} ${asset.symbol} pending</span>`
    : '');
  const activitySection = raw(activity.length === 0
    ? h`<div class="card"><div class="empty"><span class="empty-title">No activity yet</span><span>Transfers in this asset will appear here.</span></div></div>`
    : h`<div class="card flush">${listMarkup(activity.map((item) => activityRowMarkup(item, assetsByIndex)))}</div>`);
  return h`
    <div class="topbar">
      <button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button>
      <span class="topbar-title">${asset.symbol}</span>
      <span class="spacer"></span>
    </div>
    <div class="card stack">
      <div class="cluster">${avatarMarkup(asset)}<h1 class="title">${asset.name || asset.symbol}</h1>${rplChip}</div>
      <span class="amount">${formatUnits(asset.balance ?? '0', 6, asset.decimals)}<span class="unit">${asset.symbol}</span></span>
      ${pending}
    </div>
    ${actionsMarkup(asset)}
    <h2 class="section-title">Activity</h2>
    ${activitySection}`;
}

registerScreen('asset', {
  render: () => skeletonMarkup(),
  async after(ctx, root, arg) {
    const index = Number(arg);

    let assets, sync;
    try {
      [assets, sync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
    } catch (err) {
      if (!ctx.isCurrent()) return;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load this asset</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!ctx.isCurrent()) return;

    const asset = assets.find((a) => a.index === index);
    if (!asset) {
      root.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">Asset not found</span><button class="btn sm" type="button" data-go="home">Back to home</button></div></div>`;
      return;
    }
    const assetsByIndex = new Map(assets.map((a) => [a.index, a]));
    const activity = (sync.activity || []).filter((a) => a.asset === index).sort((a, b) => b.time - a.time);

    root.innerHTML = bodyMarkup({ asset, activity, assetsByIndex });
    for (const el of root.querySelectorAll('.avatar[data-hue]')) el.style.setProperty('--hue', el.dataset.hue);
  },
});
