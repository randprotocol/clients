// Home: balance hero, the four round actions, the asset list and a recent-activity preview.
//
// Renders immediately from `sync.cached()` (a skeleton while that resolves), then runs
// `sync.scan()` in the background without blocking the render (amendment 6): `render()` never
// awaits either call — only `after()` does, and only for the cached/asset fetch that produces the
// *first* paint. The scan itself is kicked off and left to run; its `.then`/`.catch` reactions
// update the DOM in place when it settles.
//
// A scan started by a visit to home that the user has since left (navigated away from) must not
// reach into the next screen's DOM — `mainEl` is reused across every screen, so writing into it
// from a stale reaction would corrupt whatever screen is on screen by then. `after()` returns a
// `cleanup` function (per the app.js contract: called right before the next render, or on
// destroy()); this closes over a per-visit `alive` flag that every DOM-touching reaction checks
// first, and that flag — not a boolean on the promise — is what "kept from touching a screen that
// was left" actually means here: the scan promise itself is never cancelled (fetch/sync work
// already in flight keeps running either way), only its *effect on the DOM* is suppressed once
// the screen has been torn down.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, shortAddress, timeAgo } from '../lib/format.js';
import { totalInRand } from '../lib/assets.js';
import { assetRowMarkup, activityRowMarkup } from '../lib/rows.js';

const ACTIONS = [
  { go: 'receive', icon: 'arrowDownLeft', label: 'Receive' },
  { go: 'send', icon: 'arrowUpRight', label: 'Send' },
  { go: 'faucet', icon: 'droplet', label: 'Faucet' },
  { go: 'explore/bridge', icon: 'bridge', label: 'Bridge' },
];

function actionsMarkup() {
  return raw(h`<div class="actions">${raw(ACTIONS.map((a) => h`
    <button class="btn-round" type="button" data-go="${a.go}">
      <span class="ic">${raw(icons[a.icon]())}</span>
      <span class="cap">${a.label}</span>
    </button>`).join(''))}</div>`);
}

function skeletonRows(n) {
  // Already returns raw() (an h`` template's own result is plain text otherwise): every place
  // this is interpolated into another h`` template relies on that, per the house rule below.
  return raw(Array.from({ length: n }, () => h`
    <div class="row">
      <span class="skeleton circle"></span>
      <span class="row-main">
        <span class="skeleton line lg"></span>
        <span class="skeleton line sm"></span>
      </span>
    </div>`).join(''));
}

function skeletonMarkup() {
  return h`
    <h1 class="sr-only">Home</h1>
    <div class="topbar"><div class="brand"><span class="mark"></span><span class="name">Rand Wallet</span></div></div>
    <div class="skeleton hero"></div>
    ${actionsMarkup()}
    <h2 class="section-title">Assets</h2>
    <div class="card flush"><div class="list" role="list">${skeletonRows(2)}</div></div>
    <h2 class="section-title">Activity</h2>
    <div class="card flush"><div class="list" role="list">${skeletonRows(2)}</div></div>`;
}

function emptyActivityMarkup() {
  return raw(h`
    <div class="card">
      <div class="empty">
        <span class="avatar lg">${raw(icons.activity())}</span>
        <span class="empty-title">No activity yet</span>
        <span>Transactions you send or receive will appear here.</span>
        <button class="btn sm" type="button" data-go="faucet">Get test RAND from the faucet</button>
      </div>
    </div>`);
}

/** A thin sync progress bar. Determinate once `head` is known (`--pct` written through the CSSOM
 *  by `paintProgress` below, never an inline style attribute); an indeterminate sliding bar until
 *  then, the same distinction `.ring`/`.ring.spin` already draws for the proving indicator. */
function progressMarkup(progress) {
  if (!progress) return '';
  const determinate = progress.head > 0;
  return raw(h`<div class="progress"${determinate ? '' : raw(' data-indeterminate="true"')} data-role="progress" role="progressbar" aria-label="Syncing" ${determinate ? raw(`aria-valuenow="${Math.round(Math.min(1, progress.scanned / progress.head) * 100)}" aria-valuemin="0" aria-valuemax="100"`) : ''}><span class="progress-bar" data-role="progress-bar"></span></div>`);
}

function paintProgress(root, progress) {
  const bar = root.querySelector('[data-role="progress"]');
  if (!bar || !progress || !(progress.head > 0)) return;
  bar.style.setProperty('--pct', String(Math.min(1, progress.scanned / progress.head)));
}

function heroMarkup({ address, assets, sync, error, progress, scanning }) {
  const totalUnits = totalInRand(assets);
  const rand = assets.find((a) => a.index === 0);
  const decimals = rand ? rand.decimals : 9;
  const pending = raw(rand && rand.pending && rand.pending !== '0'
    ? h`<span class="sub">+${formatUnits(rand.pending, 6, decimals)} RAND pending</span>`
    : '');
  const syncedText = sync.lastSyncMs ? `Synced ${timeAgo(sync.lastSyncMs)}` : 'Not synced yet';
  const banner = raw(error ? h`
    <div class="banner negative">
      <span class="ic">${raw(icons.warning())}</span>
      <span><span class="banner-title">Could not reach the node</span>${error} <a href="#settings" data-go="settings">Check settings</a></span>
      <span class="grow"></span>
      <button class="btn sm" type="button" data-action="sync">Retry</button>
    </div>` : '');
  return h`
    <section class="hero" aria-label="Balance">
      <span class="label">Balance</span>
      <span class="amount">${formatUnits(totalUnits, 6, decimals)}<span class="unit">RAND</span></span>
      ${pending}
      ${scanning ? progressMarkup(progress) : ''}
      <div class="hero-foot">
        <span class="dot ${scanning ? 'busy' : ''}"></span>
        <span>${syncedText}</span>
        <span class="grow"></span>
        <button class="btn-icon" type="button" data-action="sync" aria-label="Sync now">${raw(icons.activity())}</button>
      </div>
    </section>
    ${banner}`;
}

function bodyMarkup({ address, assets, sync, assetsByIndex, error, progress, scanning }) {
  const recent = [...(sync.activity || [])].sort((a, b) => b.time - a.time).slice(0, 5);
  const activitySection = raw(recent.length === 0
    ? emptyActivityMarkup()
    : h`<div class="card flush"><div class="list" role="list">${raw(recent.map((item) => activityRowMarkup(item, assetsByIndex)).join(''))}</div></div>`);
  return h`
    <h1 class="sr-only">Home</h1>
    <div class="topbar">
      <div class="brand"><span class="mark"></span><span class="name">Rand Wallet</span></div>
      <span class="grow"></span>
      <button class="chip" type="button" data-role="copy-address" aria-label="Copy address"><span class="mono">${shortAddress(address)}</span>${raw(icons.copy())}</button>
    </div>
    ${raw(heroMarkup({ address, assets, sync, error, progress, scanning }))}
    ${actionsMarkup()}
    <h2 class="section-title">Assets</h2>
    <div class="card flush"><div class="list" role="list">${raw(assets.map(assetRowMarkup).join(''))}</div></div>
    <h2 class="section-title">Activity</h2>
    ${activitySection}`;
}

registerScreen('home', {
  render: () => skeletonMarkup(),
  async after(ctx, root) {
    let alive = true;
    const stop = () => { alive = false; };

    let info;
    try { info = await ctx.backend.wallet.info(); } catch { info = { address: '' }; }
    if (!alive) return stop;

    let assets, sync;
    try {
      [assets, sync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
    } catch (err) {
      if (!alive) return stop;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load your wallet</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return stop;
    }
    if (!alive) return stop;

    function paint(nextAssets, nextSync, error, progress, scanning) {
      if (!alive) return;
      assets = nextAssets;
      sync = nextSync;
      const assetsByIndex = new Map(assets.map((a) => [a.index, a]));
      root.innerHTML = bodyMarkup({ address: info.address, assets, sync, assetsByIndex, error, progress, scanning });
      wireAvatarHues(root);
      paintProgress(root, progress);
    }

    paint(assets, sync, null, null, false);

    function runScan() {
      paint(assets, sync, null, null, true);
      const onProgress = (p) => { if (alive) paint(assets, sync, null, p, true); };
      ctx.backend.sync.scan(onProgress).then(
        async (fresh) => {
          if (!alive) return;
          let freshAssets = assets;
          try { freshAssets = await ctx.backend.assets.list(); } catch { /* keep the assets we had */ }
          if (!alive) return;
          paint(freshAssets, fresh, null, null, false);
        },
        (err) => {
          if (!alive) return;
          paint(assets, sync, (err && err.message) || 'The node could not be reached.', null, false);
        },
      );
    }
    runScan();

    const offSync = on(root, '[data-action="sync"]', 'click', (evt) => { evt.preventDefault(); runScan(); });
    const offCopy = on(root, '[data-role="copy-address"]', 'click', async (evt) => {
      evt.preventDefault();
      await ctx.backend.platform.copy(info.address);
      ctx.toast('Address copied', { kind: 'positive' });
    });

    return () => { stop(); offSync(); offCopy(); };
  },
});

function wireAvatarHues(root) {
  for (const el of root.querySelectorAll('.avatar[data-hue]')) el.style.setProperty('--hue', el.dataset.hue);
}
