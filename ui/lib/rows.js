// Shared `.row` markup builders for asset and activity lists — used by the home, asset and
// activity screens so the three places that list assets/activity render identical markup. An
// addition beyond the task brief's file list, in the same spirit as lib/forms.js from the
// previous task: small, self-contained, importable under plain Node (no document/window access).
//
// Every row builder returns a whole `<li>`: a list of rows is a real `<ul class="list"
// role="list">` with one `<li>` per row (the explicit `role` is there because base.css's
// `list-style: none` otherwise costs a <ul> its list semantics in Safari/VoiceOver). Nothing in
// the app renders a bare `.row` directly under a `role="list"` container.
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

/** `<ul class="list" role="list">` around already-built `<li>` rows. */
export function listMarkup(rows) {
  return raw(h`<ul class="list" role="list">${raw(rows.join(''))}</ul>`);
}

/**
 * The second line of an asset row. The symbol is only worth repeating when it is not just the
 * title again in different casing ("Wrapped Ether" / "wETH" is useful; "RAND" / "RAND" is not) —
 * otherwise the line says what kind of asset this is instead.
 */
function assetSubtitle(asset) {
  const title = String(asset.name || asset.symbol || '');
  const symbol = String(asset.symbol || '');
  if (symbol && symbol.toLowerCase() !== title.toLowerCase()) return symbol;
  return asset.index === 0 ? 'Native token' : `Registry asset · #${asset.index}`;
}

/** One `<li>` + `.row` for an asset-list entry. */
export function assetRowMarkup(asset) {
  const balance = formatUnits(asset.balance ?? '0', 6, asset.decimals ?? 9);
  const pending = asset.pending && asset.pending !== '0'
    ? raw(h`<span class="row-meta">+${formatUnits(asset.pending, 6, asset.decimals ?? 9)} pending</span>`)
    : '';
  const rplChip = asset.index >= 1 ? raw(h`<span class="chip xs">RPL</span>`) : '';
  return h`
    <li>
      <button class="row" type="button" data-go="asset/${asset.index}">
        ${avatarMarkup(asset)}
        <span class="row-main">
          <span class="row-title"><span class="truncate">${asset.name || asset.symbol}</span>${rplChip}</span>
          <span class="row-sub">${assetSubtitle(asset)}</span>
        </span>
        <span class="row-end">
          <span class="amount">${balance}</span>
          ${pending}
        </span>
      </button>
    </li>`;
}

// The four kinds the Backend contract admits (see ui/backend.js). `faucet` is a receipt, so it
// reads like one — a droplet on the same positive tint as `in`, and a `+` amount. `pending` keeps
// the warning tint and no sign at all (nothing has moved yet). Anything else is a kind this build
// does not know: it renders neutrally, with the node's own word for it shown as text (escaped by
// `h`, like every other node-controlled string) rather than being silently relabelled "Pending".
const KIND_ICON = { in: 'arrowDownLeft', out: 'arrowUpRight', faucet: 'droplet', pending: 'activity' };
const KIND_TITLE = { in: 'Received', out: 'Sent', faucet: 'Faucet' };
const KIND_SIGN = { in: '+', out: '−', faucet: '+' };
// `status` is optional on a pending item; only these known values become a title of their own.
const PENDING_TITLE = { pending: 'Pending', proving: 'Proving', submitting: 'Submitting', confirming: 'Confirming' };

/** `{kind, icon, title, sign, tint}` for an activity item, for rows and the tx detail alike. */
export function kindOf(item) {
  const kind = String(item && item.kind);
  if (kind === 'in' || kind === 'out' || kind === 'faucet') {
    return { kind, icon: KIND_ICON[kind], title: KIND_TITLE[kind], sign: KIND_SIGN[kind], tint: kind };
  }
  if (kind === 'pending') {
    const title = PENDING_TITLE[String(item.status || '').toLowerCase()] || 'Pending';
    return { kind, icon: 'activity', title, sign: '', tint: 'pending' };
  }
  const known = kind && kind !== 'undefined' && kind !== 'null';
  return { kind, icon: 'activity', title: known ? kind : 'Transaction', sign: '', tint: '' };
}

/**
 * One `<li>` + `.row` for an activity-list entry, tinted by `item.kind`. Sign is carried in the
 * text itself, not colour alone (amendment 11). `assetsByIndex` maps asset index -> the asset
 * object (for symbol/decimals), from `assets.list()`.
 *
 * `item.hash` is OPTIONAL in the Backend contract, and a real one leaves it out more often than
 * the fake does: the chain serves commitment-tree *leaves*, so a received note only gains a
 * transaction hash if the wallet also happened to read the header of the block it landed in. A
 * row with no hash has no `#tx/…` page to open, so it is rendered as a plain `<div>` rather than
 * as a button pointing at `#tx/undefined` — a dead control in the tab order that would answer
 * "This transaction was not found." The payment itself is perfectly real and reads identically.
 */
export function activityRowMarkup(item, assetsByIndex) {
  const asset = assetsByIndex.get(item.asset) || { symbol: `RPL#${item.asset}`, decimals: 9 };
  const k = kindOf(item);
  const amountCls = k.sign === '+' ? 'amount in' : 'amount';
  const amount = `${k.sign}${formatUnits(item.amount, 6, asset.decimals ?? 9)} ${asset.symbol}`;
  const sub = raw(item.address
    ? h`<span class="row-sub mono">${shortAddress(item.address)}</span>`
    : h`<span class="row-sub">${asset.symbol}</span>`);
  const meta = k.kind === 'pending' ? k.title : timeAgo(item.time * 1000);
  const body = h`
        <span class="avatar ${k.tint}">${raw(icons[k.icon]())}</span>
        <span class="row-main">
          <span class="row-title"><span class="truncate">${k.title}</span></span>
          ${sub}
        </span>
        <span class="row-end">
          <span class="${amountCls}">${amount}</span>
          <span class="row-meta">${meta}</span>
        </span>`;
  const row = item.hash
    ? h`<button class="row" type="button" data-go="tx/${item.hash}">${raw(body)}</button>`
    : h`<div class="row">${raw(body)}</div>`;
  return h`
    <li>
      ${raw(row)}
    </li>`;
}
