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
 * `chain 14 · aa1b2c3d…` — the identity a user can actually compare between two nodes.
 *
 * The chain id alone is not enough: two chains can carry the same id (the node's own docs say so,
 * which is why `rand_getGenesisHash` exists), and "different chain (chain 14) … read from chain
 * 14" is a banner that reads like a bug. The genesis hash is what tells them apart.
 */
export function chainLabel(identity) {
  if (!identity || (identity.chainId === null && identity.genesis === null)) {
    return identity && identity.unknown ? 'a node that would not say which chain it is' : 'an unknown chain';
  }
  const id = identity.chainId === null || identity.chainId === undefined || identity.chainId === ''
    ? 'chain unknown'
    : `chain ${identity.chainId}`;
  // A missing half is named as missing rather than silently dropped. Without this, a node that
  // gave its id but not its genesis rendered as "different chain (chain 14) … read from chain 14",
  // which reads as a bug in the wallet rather than a problem with the node.
  const genesis = typeof identity.genesis === 'string' && identity.genesis
    ? `${identity.genesis.slice(0, 8)}…`
    : 'genesis unknown';
  return `${id} · ${genesis}`;
}

/** True when the node could not name every part the wallet wanted to compare. */
export function partlyIdentified(info) {
  return !!(info && info.got && info.got.unknown);
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
  // "On a different chain" is a claim; when the node would not fully identify itself, the honest
  // headline is that it did not, not that it is somewhere else.
  const title = partlyIdentified(info)
    ? `This node did not fully identify its chain (${chainLabel(got)})`
    : `This node is on a different chain (${chainLabel(got)})`;
  return h`
    <div class="banner negative" data-role="wrong-chain">
      <span class="ic">${raw(icons.warning())}</span>
      <span>
        <span class="banner-title">${title}</span>
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
 * This node's tip is below what the wallet has read.
 *
 * **Which side is wrong is not knowable from here**, so the banner does not guess: it always
 * offers both ways out, and its copy assigns no blame. The previous version tried to decide, and
 * the rule it used was unreachable on the only journey a user takes — so the one case that needed
 * a Rescan button was the one that never got one.
 *
 * `walletAhead` survives as **emphasis only**: another node has said the same thing, or the gap is
 * large, so Rescan becomes the primary action. Both buttons are there either way.
 */
export function behindBannerMarkup(info, { canRescan = false } = {}) {
  const tip = String((info && info.tip) ?? '?');
  const wallet = String((info && info.wallet) ?? '?');
  const emphasis = !!(info && info.walletAhead);
  const rescan = raw(canRescan
    ? h`<button class="btn sm${emphasis ? ' btn-primary' : ''}" type="button" data-action="rescan-plain">Rescan wallet</button>`
    : '');
  return h`
    <div class="banner warn" data-role="behind">
      <span class="ic">${raw(emphasis ? icons.warning() : icons.info())}</span>
      <span>
        <span class="banner-title">This node's chain tip is below your wallet's scan position</span>
        The node is at block ${tip}; your wallet has read to ${wallet}. If the node is catching up,
        wait or try another node. If you switched networks, or a node misreported its height,
        rescan to read this one from the start.
      </span>
      <span class="banner-actions">
        <a class="btn sm" href="#settings" data-go="settings">Try another node</a>
        ${rescan}
      </span>
    </div>`;
}

/**
 * A node that would not name its chain at all, to a wallet that has none recorded yet.
 *
 * Blocking, and deliberately so: a wallet that adopts an unnamed chain can never afterwards tell
 * that it has been moved to a different one, which is the whole of the wrong-chain protection.
 * Nothing was read and nothing merged.
 */
export function identityUnknownBannerMarkup() {
  return h`
    <div class="banner negative" data-role="identity-unknown">
      <span class="ic">${raw(icons.warning())}</span>
      <span>
        <span class="banner-title">This node did not identify its chain</span>
        A node has to say which chain it is on before this wallet will read from it — otherwise
        there is no way to notice later that it has changed. Nothing has been read. Choose another
        node.
      </span>
      <span class="banner-actions">
        <a class="btn sm btn-primary" href="#settings" data-go="settings">Choose another node</a>
      </span>
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
