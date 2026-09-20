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
import { detailTopbar, wireSelection } from '../lib/panes.js';

export const RPL_SEND_DISABLED_TEXT = 'RPL transfers are not available on this network.';

function skeletonMarkup(ctx) {
  return h`
    ${raw(detailTopbar(ctx, 'Asset', 'home'))}
    <div class="skeleton hero"></div>`;
}

const HINT_ID = 'asset-send-hint';
const WITHDRAW_HINT_ID = 'asset-withdraw-hint';

/**
 * A registry asset cannot be *transferred*, but it can be **withdrawn**: burned back to its origin
 * chain across the bridge. That is `#withdraw/<index>`, and it is offered only where the backend
 * says it can actually be carried out — the `bridge` group is optional in the contract, and its
 * `canWithdraw()` is false on every shell that cannot produce two bundle proofs. Where it says no,
 * the reason goes in the action's place, exactly as Send's does.
 */
function withdrawMarkup(withdraw, index) {
  if (!withdraw) return { button: '', hint: '' };
  if (withdraw.ok) {
    return {
      button: raw(h`<button class="btn-round" type="button" data-go="withdraw/${index}"><span class="ic">${raw(icons.bridge())}</span><span class="cap">Withdraw</span></button>`),
      hint: '',
    };
  }
  return {
    button: '',
    hint: raw(h`<p class="caption" id="${WITHDRAW_HINT_ID}" data-role="withdraw-hint">${withdraw.reason || 'Withdrawals are not available here.'}</p>`),
  };
}

function actionsMarkup(asset, withdraw = null) {
  const canSend = asset.index === 0;
  // `aria-disabled`, not `disabled`: a `disabled` button is skipped by the keyboard entirely, so
  // the reason it is off (the hint below, tied on with aria-describedby) would never be announced
  // to the one user who most needs it. It carries no `data-go`, so a click does nothing.
  const sendBtn = raw(canSend
    ? h`<button class="btn-round" type="button" data-go="send/0"><span class="ic">${raw(icons.arrowUpRight())}</span><span class="cap">Send</span></button>`
    : h`<button class="btn-round" type="button" aria-disabled="true" aria-describedby="${HINT_ID}"><span class="ic">${raw(icons.arrowUpRight())}</span><span class="cap">Send</span></button>`);
  const hint = raw(canSend ? '' : h`<p class="caption" id="${HINT_ID}" data-role="rpl-hint">${RPL_SEND_DISABLED_TEXT}</p>`);
  const w = withdrawMarkup(withdraw, asset.index);
  return raw(h`
    <div class="actions">
      <button class="btn-round" type="button" data-go="receive"><span class="ic">${raw(icons.arrowDownLeft())}</span><span class="cap">Receive</span></button>
      ${sendBtn}
      ${w.button}
    </div>
    ${hint}
    ${w.hint}`);
}

function bodyMarkup(ctx, { asset, activity, assetsByIndex, withdraw }) {
  const rplChip = raw(asset.index >= 1 ? h`<span class="chip xs">RPL</span>` : '');
  const pending = raw(asset.pending && asset.pending !== '0'
    ? h`<span class="sub">+${formatUnits(asset.pending, 6, asset.decimals)} ${asset.symbol} pending</span>`
    : '');
  const activitySection = raw(activity.length === 0
    ? h`<div class="card"><div class="empty"><span class="empty-title">No activity yet</span><span>Transfers in this asset will appear here.</span></div></div>`
    : h`<div class="card flush">${listMarkup(activity.map((item) => activityRowMarkup(item, assetsByIndex)))}</div>`);
  return h`
    ${raw(detailTopbar(ctx, asset.symbol, 'home'))}
    <div class="card stack">
      <div class="cluster">${avatarMarkup(asset)}<h1 class="title">${asset.name || asset.symbol}</h1>${rplChip}</div>
      <span class="amount">${formatUnits(asset.balance ?? '0', 6, asset.decimals)}<span class="unit">${asset.symbol}</span></span>
      ${pending}
    </div>
    ${actionsMarkup(asset, withdraw)}
    <h2 class="section-title">Activity</h2>
    ${activitySection}`;
}

registerScreen('asset', {
  // An asset is a detail of the home asset list, so on a wide screen it opens beside home (task
  // 1.7). Its parent is always home — unlike a transaction it is never reached from somewhere
  // else — and it is itself a list, so a transaction opened from *it* keeps it in the content
  // pane (see `PARENT_ROUTES` in lib/panes.js).
  pane: 'detail',
  parent: () => '#home',
  render: (ctx) => skeletonMarkup(ctx),
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

    // Only a registry asset has anywhere to be withdrawn *to*, and only a shell with the optional
    // `bridge` group can take it there — so RAND and a bridge-less shell ask nothing at all. A
    // failure to answer is "no", never "yes": it must never show an action that cannot work.
    let withdraw = null;
    if (index >= 1 && ctx.backend.bridge && typeof ctx.backend.bridge.canWithdraw === 'function') {
      try { withdraw = (await ctx.backend.bridge.canWithdraw()) || null; } catch (err) {
        withdraw = { ok: false, reason: (err && err.message) || 'The bridge could not be asked.' };
      }
      if (!ctx.isCurrent()) return;
    }

    root.innerHTML = bodyMarkup(ctx, { asset, activity, assetsByIndex, withdraw });
    for (const el of root.querySelectorAll('.avatar[data-hue]')) el.style.setProperty('--hue', el.dataset.hue);
    // When this screen is the content pane's list (a transaction opened from it on a wide
    // screen), its rows carry the selection marker like any other list's.
    const selection = wireSelection(ctx, root);
    return () => { selection.destroy(); };
  },
});
