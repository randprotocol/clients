// The one place that says "this node is not on your wallet's chain".
//
// Three screens need it — home, activity and the send entry — because `sync.cached()` carries the
// `wrongChain` marker for the whole wallet, not just for whoever happened to run the scan, and a
// user who goes straight to Activity or to Send must see the same blocking state as one who
// stayed on home. Written once here rather than three times, so the three cannot drift.
//
// Every field of `wrongChain` came from a node, so all of it goes through `h` and none of it is
// ever `raw()`ed. Importable under plain Node: no document/window access at module scope.
import { h, raw } from './dom.js';
import { icons } from './icons.js';

/**
 * `chain 13 · aa1b2c3d…` — the identity a user can actually compare between two nodes.
 *
 * The chain id alone is not enough: two chains can carry the same id (the node's own docs say so,
 * which is why `rand_getGenesisHash` exists), and "different chain (chain 13) … read from chain
 * 13" is a banner that reads like a bug. The genesis hash is what tells them apart.
 */
export function chainLabel(identity) {
  if (!identity || (identity.chainId === null && identity.genesis === null)) {
    return identity && identity.unknown ? 'a node that will not say which chain it is' : 'an unknown chain';
  }
  const id = identity.chainId === null || identity.chainId === undefined || identity.chainId === ''
    ? 'an unknown chain'
    : `chain ${identity.chainId}`;
  const genesis = typeof identity.genesis === 'string' && identity.genesis
    ? ` · ${identity.genesis.slice(0, 8)}…`
    : '';
  return `${id}${genesis}`;
}

/**
 * The blocking banner. `canRescan` is whether the backend offers `sync.rescan` — where it does
 * not, no Rescan button is rendered at all rather than a dead one.
 *
 * The Rescan action is `data-action="rescan-chain"`; every screen that renders this must wire it
 * (or not offer it). Actions live in `.banner-actions` so two buttons do not squeeze the title to
 * one word per line at 360 px.
 */
export function wrongChainBannerMarkup(info, { canRescan = false } = {}) {
  const got = info && info.got ? info.got : {};
  const expected = info && info.expected ? info.expected : {};
  const rescan = raw(canRescan
    ? h`<button class="btn sm" type="button" data-action="rescan-chain">Rescan</button>`
    : '');
  return h`
    <div class="banner negative" data-role="wrong-chain">
      <span class="ic">${raw(icons.warning())}</span>
      <span>
        <span class="banner-title">This node is on a different chain (${chainLabel(got)})</span>
        Your wallet's history was read from ${chainLabel(expected)} — nothing has been changed, and
        this wallet will not send or request funds until the two agree.
        Switch node in Settings, or rescan this wallet for the new chain.
      </span>
      <span class="banner-actions">
        <a class="btn sm" href="#settings" data-go="settings">Settings</a>
        ${rescan}
      </span>
    </div>`;
}

/**
 * The quiet one: this node's tip is below what the wallet has read.
 *
 * Two readings, and the copy has to pick the right one. Normally the node is the odd one out (a
 * lagging replica, a snapshot restore) and the cure is another node. But when the gap is bigger
 * than any honest scan could have produced, or when *different* nodes keep saying it, the wallet
 * is what is wrong — a node once misreported its tip, or the user moved between networks — and
 * telling them to try yet another node would send them round in circles. The backend decides
 * which (`behind.walletAhead`); this only renders it.
 */
export function behindBannerMarkup(info, { canRescan = false } = {}) {
  const tip = String((info && info.tip) ?? '?');
  const wallet = String((info && info.wallet) ?? '?');
  if (info && info.walletAhead) {
    const rescan = raw(canRescan
      ? h`<button class="btn sm" type="button" data-action="rescan-plain">Rescan</button>`
      : '');
    return h`
      <div class="banner warn" data-role="behind">
        <span class="ic">${raw(icons.warning())}</span>
        <span>
          <span class="banner-title">Your wallet's scan position is ahead of this network</span>
          Your wallet has read to block ${wallet}; this network is at ${tip}. If you switched
          networks, or a node misreported its height, rescan to read this one from the start.
        </span>
        <span class="banner-actions">
          <a class="btn sm" href="#settings" data-go="settings">Settings</a>
          ${rescan}
        </span>
      </div>`;
  }
  return h`
    <div class="banner warn" data-role="behind">
      <span class="ic">${raw(icons.info())}</span>
      <span><span class="banner-title">This node is behind your wallet</span>It is at block ${tip}; your wallet has read to ${wallet}. Try another node in Settings.</span>
      <span class="grow"></span>
      <a class="btn sm" href="#settings" data-go="settings">Settings</a>
    </div>`;
}

/** True when the backend offers the optional `sync.rescan`. */
export function canRescan(ctx) {
  return !!ctx && !!ctx.backend && !!ctx.backend.sync && typeof ctx.backend.sync.rescan === 'function';
}

/**
 * Asks before rescanning, then runs it. `forChain` drops the other chain's history; a plain
 * rescan keeps the notes and simply re-reads. Resolves with the scan result, or `null` if the
 * user cancelled or the screen went away.
 */
export function confirmRescan(ctx, { forChain = false } = {}) {
  return new Promise((resolve) => {
    if (!canRescan(ctx)) { resolve(null); return; }
    const dialog = ctx.sheet(forChain
      ? h`
        <h3 class="sheet-title">Rescan for this chain?</h3>
        <p class="sheet-sub">This forgets the notes and history read from the old chain and reads this node from the start. Your keys and your password are not touched.</p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="cancel">Cancel</button>
          <button class="btn btn-primary" type="button" data-role="confirm">Rescan</button>
        </div>`
      : h`
        <h3 class="sheet-title">Rescan this wallet?</h3>
        <p class="sheet-sub">The wallet forgets how far it has read and reads this node again from the start. Your keys, your password and your settings are not touched.</p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="cancel">Cancel</button>
          <button class="btn btn-primary" type="button" data-role="confirm">Rescan</button>
        </div>`);
    const cancel = dialog.querySelector('[data-role="cancel"]');
    const confirm = dialog.querySelector('[data-role="confirm"]');
    cancel.addEventListener('click', () => { ctx.closeSheet(); resolve(null); });
    confirm.addEventListener('click', async () => {
      ctx.closeSheet();
      if (!ctx.isCurrent()) { resolve(null); return; }
      try {
        resolve(await ctx.backend.sync.rescan({ forChain, signal: ctx.session.signal }));
      } catch (err) {
        if (ctx.isCurrent()) ctx.toast((err && err.message) || 'The rescan could not be started.', { kind: 'negative' });
        resolve(null);
      }
    });
  });
}
