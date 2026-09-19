// Shared `.row` markup builders for asset and activity lists — used by the home, asset and
// activity screens so the three places that list assets/activity render identical markup. An
// addition beyond the task brief's file list, in the same spirit as lib/forms.js from the
// previous task: small, self-contained, importable under plain Node (no document/window access).
import { h, raw } from './dom.js';
import { icons } from './icons.js';
import { formatUnits, shortAddress, timeAgo } from './format.js';
import { avatarFor } from './assets.js';

/** `<span class="avatar accent|rpl">` for an asset, per avatarFor()'s {text, hue}. The `data-hue`
 *  attribute is inert in CSS (see gallery.js) — a screen's `after()` must read it and write the
 *  real `--hue` custom property through the CSSOM (`el.style.setProperty('--hue', hue)`). */
export function avatarMarkup(asset) {
  const av = avatarFor(asset);
  return raw(av.hue === null
    ? h`<span class="avatar accent">${av.text}</span>`
    : h`<span class="avatar rpl" data-hue="${av.hue}">${av.text}</span>`);
}

/** One `.row` for an asset-list entry (home, and reused nowhere else today). */
export function assetRowMarkup(asset) {
  const balance = formatUnits(asset.balance ?? '0', 6, asset.decimals ?? 9);
  const pending = asset.pending && asset.pending !== '0'
    ? raw(h`<span class="row-meta">+${formatUnits(asset.pending, 6, asset.decimals ?? 9)} pending</span>`)
    : '';
  const rplChip = asset.index >= 1 ? raw(h`<span class="chip xs">RPL</span>`) : '';
  return h`
    <button class="row" type="button" data-go="asset/${asset.index}">
      ${avatarMarkup(asset)}
      <span class="row-main">
        <span class="row-title"><span class="truncate">${asset.name || asset.symbol}</span>${rplChip}</span>
        <span class="row-sub">${asset.symbol}</span>
      </span>
      <span class="row-end">
        <span class="amount">${balance}</span>
        ${pending}
      </span>
    </button>`;
}

const KIND_ICON = { in: 'arrowDownLeft', out: 'arrowUpRight', pending: 'activity' };
const KIND_TITLE = { in: 'Received', out: 'Sent', pending: 'Pending' };

/** One `.row` for an activity-list entry, tinted by `item.kind` ('in' | 'out' | 'pending'). Sign
 *  is carried in the text itself, not colour alone (amendment 11). `assetsByIndex` maps asset
 *  index -> the asset object (for symbol/decimals), from `assets.list()`. */
export function activityRowMarkup(item, assetsByIndex) {
  const asset = assetsByIndex.get(item.asset) || { symbol: `RPL#${item.asset}`, decimals: 9 };
  const kind = item.kind === 'in' || item.kind === 'out' ? item.kind : 'pending';
  const icon = KIND_ICON[kind];
  const title = KIND_TITLE[kind];
  const sign = kind === 'in' ? '+' : kind === 'out' ? '−' : '';
  const amountCls = kind === 'in' ? 'amount in' : 'amount';
  const amount = `${sign}${formatUnits(item.amount, 6, asset.decimals ?? 9)} ${asset.symbol}`;
  const sub = raw(item.address
    ? h`<span class="row-sub mono">${shortAddress(item.address)}</span>`
    : h`<span class="row-sub">${asset.symbol}</span>`);
  const meta = kind === 'pending' ? 'Pending' : timeAgo(item.time * 1000);
  return h`
    <button class="row" type="button" data-go="tx/${item.hash}">
      <span class="avatar ${kind}">${raw(icons[icon]())}</span>
      <span class="row-main">
        <span class="row-title"><span class="truncate">${title}</span></span>
        ${sub}
      </span>
      <span class="row-end">
        <span class="${amountCls}">${amount}</span>
        <span class="row-meta">${meta}</span>
      </span>
    </button>`;
}
