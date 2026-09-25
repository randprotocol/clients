// Home: balance hero, the four round actions, the asset list and a recent-activity preview.
//
// The screen is built exactly once, by `render()`: hero, actions and two list containers, with
// skeleton rows where the data will go. `after()` then fills *containers*, never the whole screen
// — a progress tick touches only the bar's `--pct` and the status line, a scan result touches only
// the two lists and the hero figure. Repainting `root.innerHTML` on every tick (what this screen
// used to do) drops keyboard focus mid-sync and restarts the bar's own transition, so the bar
// never actually animates.
//
// Two lifecycle rules, both enforced by the shell rather than by flags in here:
//   * every reaction that touches the DOM after an await first checks `ctx.isCurrent()` — false
//     as soon as another screen has taken over, or the app was destroyed (see ui/app.js);
//   * there is at most one `sync.scan()` in flight per mounted app. The promise lives on
//     `ctx.state` (one object for the whole mount, shared by every render), so leaving home and
//     coming straight back attaches to the running scan instead of starting a second one that
//     would race the first and repaint with staler data.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, shortAddress, timeAgo } from '../lib/format.js';
import { totalInRand } from '../lib/assets.js';
import { assetRowMarkup, activityRowMarkup, listMarkup } from '../lib/rows.js';
import { wrongChainBannerMarkup, behindBannerMarkup, identityUnknownBannerMarkup, canRescan, confirmRescan } from '../lib/chain-banner.js';
import { wireSelection } from '../lib/panes.js';
import { brandMarkup, paintField } from '../lib/entropy.js';

// Veiling the balance is a per-device convenience for a screen someone else can see, not a wallet
// setting: it lives in localStorage and changes nothing the backend knows. A class on <html> so
// every amount on screen (the hero, the asset rows) veils together; see components.css.
const VEIL_KEY = 'rand-wallet:veil';
function readVeil() {
  try { return localStorage.getItem(VEIL_KEY) === '1'; } catch { return false; }
}
function writeVeil(on) {
  try { localStorage.setItem(VEIL_KEY, on ? '1' : '0'); } catch { /* private mode: this session only */ }
}
function applyVeil(on) {
  document.documentElement.classList.toggle('veiled', on);
}

const ACTIONS = [
  { go: 'receive', icon: 'arrowDownLeft', label: 'Receive' },
  { go: 'send', icon: 'arrowUpRight', label: 'Send' },
  { go: 'faucet', icon: 'droplet', label: 'Faucet' },
  { go: 'explore/bridge', icon: 'bridge', label: 'Bridge' },
];

function actionsMarkup() {
  return raw(h`<div class="actions">${raw(ACTIONS.map((a) => h`
    <button class="btn-round${a.go === 'send' ? ' primary' : ''}" type="button" data-go="${a.go}">
      <span class="ic">${raw(icons[a.icon]())}</span>
      <span class="cap">${a.label}</span>
    </button>`).join(''))}</div>`);
}

function skeletonRows(n) {
  return Array.from({ length: n }, () => h`
    <li>
      <div class="row">
        <span class="skeleton circle"></span>
        <span class="row-main">
          <span class="skeleton line lg"></span>
          <span class="skeleton line sm"></span>
        </span>
      </div>
    </li>`);
}

function emptyActivityMarkup() {
  return h`
    <div class="card">
      <div class="empty">
        <span class="avatar lg">${raw(icons.activity())}</span>
        <span class="empty-title">No activity yet</span>
        <span>Transactions you send or receive will appear here.</span>
        <button class="btn sm" type="button" data-go="faucet">Get test RAND from the faucet</button>
      </div>
    </div>`;
}

/** The whole screen, built once. Everything `after()` fills later is a `[data-role]` container
 *  that stays put across every update. */
function shellMarkup() {
  return h`
    <h1 class="sr-only">Home</h1>
    <div class="topbar">
      ${raw(brandMarkup())}
      <span class="grow"></span>
      <span data-role="address-slot"></span>
    </div>
    <section class="hero" aria-label="Balance">
      <canvas class="field" aria-hidden="true"></canvas>
      <span class="amount" data-role="hero-amount"><span class="skeleton line lg"></span></span>
      <span class="sub" data-role="hero-sub" hidden></span>
      <div data-role="progress-slot"><div class="progress" data-role="progress" role="progressbar" aria-label="Syncing" data-indeterminate="true" hidden><span class="progress-bar"></span></div></div>
      <div class="hero-foot">
        <span class="dot" data-role="sync-dot"></span>
        <span data-role="sync-text"></span>
        <span class="grow"></span>
        <button class="btn-icon" type="button" data-action="veil" aria-pressed="false" aria-label="Hide balances">${raw(icons.eye())}</button>
        <button class="btn-icon" type="button" data-action="sync" aria-label="Sync now">${raw(icons.refresh())}</button>
      </div>
    </section>
    ${actionsMarkup()}
    <div data-role="banner-slot"></div>
    <h2 class="section-title">Assets</h2>
    <div class="card flush" data-role="assets">${listMarkup(skeletonRows(2))}</div>
    <h2 class="section-title">Activity</h2>
    <div data-role="activity"><div class="card flush">${listMarkup(skeletonRows(2))}</div></div>`;
}

/**
 * The app-wide scan record: `{inFlight, progress, listeners}`, kept on `ctx.state` (the one object
 * that outlives a render) rather than in this screen's closure. Nothing secret goes in it.
 */
function scanStore(ctx) {
  if (!ctx.state.scan) ctx.state.scan = { sessionId: null, inFlight: null, progress: null, listeners: new Set() };
  return ctx.state.scan;
}

/** An error that means "this was cancelled", not "the node failed" — see ui/backend.js. */
function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20);
}

/**
 * Starts the session's one scan if none is running, and returns `{promise, sessionId}`.
 *
 * Every scan is stamped with the wallet session it belongs to. `ctx.state` is emptied when a
 * session ends, so in practice the store is already fresh — but the id is recorded and checked
 * anyway, because "a scan may only ever be attached to, progress-reported to, or painted from,
 * within the session that started it" is the rule that keeps one wallet's history off the next
 * wallet's screen, and it should not depend on a second mechanism being remembered.
 */
function startScan(ctx, store) {
  const session = ctx.session;
  if (store.inFlight && store.sessionId === session.id) {
    return { promise: store.inFlight, sessionId: store.sessionId, alreadyRunning: true };
  }
  store.sessionId = session.id;
  store.progress = null;
  const fanout = (p) => {
    if (ctx.session.id !== session.id) return; // a tick from a wallet nobody is looking at
    store.progress = p;
    for (const fn of [...store.listeners]) {
      try { fn(p); } catch (err) { console.error('rand-wallet: sync progress listener failed', err); }
    }
  };
  const p = Promise.resolve(ctx.backend.sync.scan(fanout, { signal: session.signal }));
  store.inFlight = p;
  const done = () => { if (store.inFlight === p && store.sessionId === session.id) store.inFlight = null; };
  p.then(done, done); // also marks `p` handled: every consumer attaches its own reactions after
  return { promise: p, sessionId: session.id, alreadyRunning: false };
}

registerScreen('home', {
  render: () => shellMarkup(),
  // Deliberately NOT async: the shell is already on screen, so `after()` wires it up, kicks the
  // fetches off and returns its cleanup immediately. Awaiting data here would make `mount()` (and
  // every navigation to home) block on the node.
  after(ctx, root) {
    const el = {
      addressSlot: root.querySelector('[data-role="address-slot"]'),
      amount: root.querySelector('[data-role="hero-amount"]'),
      sub: root.querySelector('[data-role="hero-sub"]'),
      progress: root.querySelector('[data-role="progress"]'),
      dot: root.querySelector('[data-role="sync-dot"]'),
      syncText: root.querySelector('[data-role="sync-text"]'),
      syncBtn: root.querySelector('.hero [data-action="sync"]'),
      veilBtn: root.querySelector('.hero [data-action="veil"]'),
      field: root.querySelector('.hero canvas.field'),
      banner: root.querySelector('[data-role="banner-slot"]'),
      assets: root.querySelector('[data-role="assets"]'),
      activity: root.querySelector('[data-role="activity"]'),
    };

    let address = '';
    let assets = [];
    let sync = null;
    let scanning = false;
    let dataStamp = -1; // 0 = from sync.cached(), 1 = from sync.scan(): never go backwards
    // Home is a list (of assets, and of recent activity), so on a wide screen a row of it can be
    // open in the detail pane beside it. The shell notifies this when the selection moves, so
    // opening another row costs one attribute — never a repaint of these lists.
    const selection = wireSelection(ctx, root);

    // The field is seeded from the address, which arrives after the first paint: it waits on ink
    // until then (no placeholder pattern that would then jump to the real one).
    const field = el.field ? paintField(el.field) : null;

    function paintVeil(on) {
      applyVeil(on);
      el.veilBtn.setAttribute('aria-pressed', String(on));
      el.veilBtn.innerHTML = on ? icons.eyeOff() : icons.eye();
    }
    paintVeil(readVeil());

    // ---- painters: each one owns exactly one container ----
    function paintAddress() {
      el.addressSlot.innerHTML = address
        // Short form (the gallery's `rand1q9x…7k2m`): the topbar also carries the brand, and a
        // 360 px popup has no room for more. The full address lives on the Receive screen.
        ? h`<button class="chip action" type="button" data-role="copy-address" aria-label="Copy address"><span class="mono">${shortAddress(address, 8, 4)}</span>${raw(icons.copy())}</button>`
        : '';
    }

    function paintHero() {
      const rand = assets.find((a) => a.index === 0);
      const decimals = rand ? rand.decimals : 9;
      el.amount.innerHTML = h`<span class="fig">${formatUnits(totalInRand(assets), 6, decimals)}</span><span class="unit">RAND</span>`;
      const pending = rand && rand.pending && rand.pending !== '0';
      if (pending) {
        el.sub.textContent = `+${formatUnits(rand.pending, 6, decimals)} RAND pending`;
        el.sub.removeAttribute('hidden');
      } else {
        el.sub.textContent = '';
        el.sub.setAttribute('hidden', '');
      }
    }

    function paintSyncLine() {
      el.syncText.textContent = scanning
        ? 'Syncing…'
        : (sync && sync.lastSyncMs ? `Synced ${timeAgo(sync.lastSyncMs)}` : 'Not synced yet');
      el.dot.classList.toggle('busy', scanning);
    }

    function paintAssets() {
      el.assets.innerHTML = h`${listMarkup(assets.map((a) => assetRowMarkup(a)))}`;
      for (const node of el.assets.querySelectorAll('.avatar[data-hue]')) node.style.setProperty('--hue', node.dataset.hue);
      // Fresh row nodes: the wide layout's "this one is open beside you" marker goes back on.
      selection.apply();
    }

    function paintActivity() {
      const byIndex = new Map(assets.map((a) => [a.index, a]));
      const recent = [...((sync && sync.activity) || [])].sort((a, b) => b.time - a.time).slice(0, 5);
      el.activity.innerHTML = recent.length === 0
        ? emptyActivityMarkup()
        : h`<div class="card flush">${listMarkup(recent.map((item) => activityRowMarkup(item, byIndex)))}</div>`;
      selection.apply();
    }

    function applyData(stamp, nextAssets, nextSync) {
      if (stamp < dataStamp) return; // a slower cached() must never overwrite a fresher scan
      dataStamp = stamp;
      if (nextAssets) assets = nextAssets;
      if (nextSync) sync = nextSync;
      paintHero();
      paintAssets();
      paintActivity();
      paintSyncLine();
    }

    // ---- the sync bar: the only thing a progress tick is allowed to touch ----
    function showProgress(p) {
      const determinate = p && p.head > 0;
      if (determinate) {
        const pct = Math.max(0, Math.min(1, p.scanned / p.head));
        el.progress.removeAttribute('data-indeterminate');
        el.progress.style.setProperty('--pct', String(pct));
        el.progress.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
        el.progress.setAttribute('aria-valuemin', '0');
        el.progress.setAttribute('aria-valuemax', '100');
      } else {
        // Scanning, but the node has not said how far along it is (it may never call onProgress at
        // all): a sliding indeterminate bar, which prefers-reduced-motion freezes into a static
        // one (see base.css's blanket `animation: none`).
        el.progress.setAttribute('data-indeterminate', 'true');
        el.progress.removeAttribute('aria-valuenow');
      }
    }

    function setScanning(on) {
      scanning = on;
      if (on) {
        el.progress.removeAttribute('hidden');
        el.syncBtn.disabled = true;
        el.syncBtn.setAttribute('aria-busy', 'true');
      } else {
        el.progress.setAttribute('hidden', '');
        el.syncBtn.disabled = false;
        el.syncBtn.removeAttribute('aria-busy');
      }
      paintSyncLine();
    }

    function showBanner(message) {
      el.banner.innerHTML = h`
        <div class="banner negative">
          <span class="ic">${raw(icons.warning())}</span>
          <span><span class="banner-title">Could not reach the node</span>${message} <a href="#settings" data-go="settings">Check settings</a></span>
          <span class="grow"></span>
          <button class="btn sm" type="button" data-action="sync">Retry</button>
        </div>`;
    }

    /** `sync.scan()` reported `recovered` (ui/backend.js): the local cache had to be reset, so the
     *  wallet is re-reading the chain from the start. Informational, not an error — nothing is
     *  lost that the chain cannot supply again — but it explains why this sync is a long one. */
    function showRecoveredBanner() {
      el.banner.innerHTML = h`
        <div class="banner">
          <span class="ic">${raw(icons.info())}</span>
          <span><span class="banner-title">Rescanning from the start after a storage problem</span>Your notes are safe on chain; this sync will take longer than usual.</span>
        </div>`;
    }

    // The two chain banners are ui/lib/chain-banner.js: home, activity and the send entry all
    // show the same blocking state, because `sync.cached()` carries it for the whole wallet.
    function showWrongChainBanner(info) {
      el.banner.innerHTML = wrongChainBannerMarkup(info, { canRescan: canRescan(ctx) });
    }

    function showBehindBanner(info) {
      el.banner.innerHTML = behindBannerMarkup(info, { canRescan: canRescan(ctx) });
    }

    /** Another tab of this wallet is doing the scanning; this one is showing what it has. */
    function showOtherTabBanner() {
      el.banner.innerHTML = h`
        <div class="banner">
          <span class="ic">${raw(icons.info())}</span>
          <span><span class="banner-title">Another tab is syncing</span>This tab is showing what it has so far, and will refresh when that finishes.</span>
        </div>`;
    }

    /** One place decides what a scan result has to say, so the branches cannot drift apart. */
    function paintScanNotice(fresh) {
      // A result from a node the wallet has since been pointed away from: its numbers are sound
      // but they are not this node's, so say nothing and let the fresh scan below speak.
      if (fresh && fresh.staleNode) { el.banner.innerHTML = ''; return; }
      if (fresh && fresh.wrongChain) { showWrongChainBanner(fresh.wrongChain); return; }
      if (fresh && fresh.identityUnknown) { el.banner.innerHTML = identityUnknownBannerMarkup(); return; }
      if (fresh && fresh.behind) { showBehindBanner(fresh.behind); return; }
      if (fresh && fresh.recovered) { showRecoveredBanner(); return; }
      if (fresh && fresh.otherTab) { showOtherTabBanner(); return; }
      el.banner.innerHTML = '';
    }

    // ---- this session's single scan ----
    // `mySession` is the session this render belongs to; every reaction below checks it as well as
    // `ctx.isCurrent()`, because a screen can be current under a *different* wallet (lock → wipe →
    // create → home is all one mount) and a result from the previous wallet must never paint.
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;
    const store = scanStore(ctx);
    const onProgress = (p) => { if (live()) showProgress(p); };
    store.listeners.add(onProgress);

    function attachScan() {
      const { promise, alreadyRunning } = startScan(ctx, store);
      setScanning(true);
      showProgress(alreadyRunning ? store.progress : null);
      promise.then(
        async (fresh) => {
          if (!live()) return;
          let freshAssets = assets;
          try { freshAssets = await ctx.backend.assets.list(); } catch { /* keep the assets we had */ }
          if (!live()) return;
          paintScanNotice(fresh);
          setScanning(false);
          applyData(1, freshAssets, fresh);
          // The node changed underneath that scan, so what just landed describes the old one.
          // Read the new one rather than leaving its tip on screen (guarded: the fresh scan
          // cannot itself be stale unless the user changes node again, which starts this over).
          if (fresh && fresh.staleNode && live()) attachScan();
        },
        (err) => {
          if (!live()) return;
          setScanning(false);
          // An abort means the wallet session ended under us (lock/wipe/unlock/teardown). That is
          // not a node failure and must not be reported as one.
          if (isAbortError(err)) return;
          showBanner((err && err.message) || 'The node could not be reached.');
        },
      );
    }

    // ---- first paint ----
    paintSyncLine();
    attachScan();

    (async () => {
      try {
        const info = await ctx.backend.wallet.info();
        if (!live()) return;
        address = info.address || '';
        paintAddress();
        if (address) field?.reseed(address);
      } catch { /* no address to show; the rest of the screen still works */ }

      let cachedAssets, cachedSync;
      try {
        [cachedAssets, cachedSync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
      } catch (err) {
        if (!live()) return;
        if (isAbortError(err)) return;
        showBanner((err && err.message) || 'Something went wrong.');
        return;
      }
      if (!live()) return;
      applyData(0, cachedAssets, cachedSync);
    })();

    /** Paints the result of a rescan exactly as a scan's result is painted. */
    async function applyRescan(fresh) {
      if (!fresh || !live()) return;
      let freshAssets = assets;
      try { freshAssets = await ctx.backend.assets.list(); } catch { /* keep what we had */ }
      if (!live()) return;
      paintScanNotice(fresh);
      setScanning(false);
      applyData(1, freshAssets, fresh);
      // Same rule as a scan (see attachScan above): the node changed underneath the rescan, so
      // what just landed describes the old one. Read the new one rather than leaving its tip on
      // screen.
      if (fresh.staleNode && live()) attachScan();
    }

    // The two banners' own ways out. `rescan-chain` drops the old chain's history; `rescan-plain`
    // keeps the notes and simply re-reads, which is what a wallet that got ahead of its node needs.
    const offRescanChain = on(root, '[data-action="rescan-chain"]', 'click', async (evt) => {
      evt.preventDefault();
      el.banner.innerHTML = '';
      setScanning(true);
      await applyRescan(await confirmRescan(ctx, { forChain: true }));
      if (live()) setScanning(false);
    });
    const offRescanPlain = on(root, '[data-action="rescan-plain"]', 'click', async (evt) => {
      evt.preventDefault();
      el.banner.innerHTML = '';
      setScanning(true);
      await applyRescan(await confirmRescan(ctx, {}));
      if (live()) setScanning(false);
    });

    const offSync = on(root, '[data-action="sync"]', 'click', (evt) => {
      evt.preventDefault();
      // One scan at a time per session, however many times this is tapped.
      if (store.inFlight && store.sessionId === ctx.session.id) return;
      el.banner.innerHTML = '';
      attachScan();
    });
    const offVeil = on(root, '[data-action="veil"]', 'click', (evt) => {
      evt.preventDefault();
      const next = !document.documentElement.classList.contains('veiled');
      writeVeil(next);
      paintVeil(next);
    });
    const offCopy = on(root, '[data-role="copy-address"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!address) return;
      await ctx.backend.platform.copy(address);
      if (!live()) return;
      ctx.toast('Address copied', { kind: 'positive' });
    });

    // Another tab finished a scan, or reset the store. Refresh from what it wrote rather than
    // starting a scan of our own — which is what makes the `otherTab` banner's "this will refresh
    // when that finishes" true rather than a hopeful sentence.
    const offChanged = (() => {
      const subscribe = ctx.backend.sync.onChanged;
      if (typeof subscribe !== 'function') return () => {};
      let off;
      try {
        off = subscribe(async () => {
          if (!live()) return;
          let fresh;
          let freshAssets = assets;
          try {
            [fresh, freshAssets] = await Promise.all([ctx.backend.sync.cached(), ctx.backend.assets.list()]);
          } catch { return; }
          if (!live()) return;
          paintScanNotice(fresh);
          applyData(1, freshAssets, fresh);
        });
      } catch { return () => {}; }
      return typeof off === 'function' ? off : () => {};
    })();

    // `on()` binds to `root`, which is a *pane element* the shell reuses across screens — so every
    // listener taken out here has to be handed back, or it outlives this screen holding this
    // render's closure (its assets, its sync result) past a lock or a wipe. The same is true of
    // the backend subscription: it holds this render's `applyData` closure until it is dropped.
    return () => {
      store.listeners.delete(onProgress);
      offSync();
      offVeil();
      offCopy();
      field?.destroy();
      offRescanChain();
      offRescanPlain();
      offChanged();
      selection.destroy();
    };
  },
});
