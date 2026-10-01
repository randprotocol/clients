// The part of the extension that runs when no page of it does.
//
// It is an MV3 service worker in Chrome and an event page in Firefox, and **both load it as a
// classic script**, so there is not an `import` in this file — which is exactly why the two
// strings below are spelled out rather than taken from `ui/engine/backend-wasm.js`. They are not
// free to drift: `extension/test/smoke.mjs` reads this file and checks `UNLOCKED_SESSION_KEY`
// against that module's own export, and `extension/test/idle-lock.test.mjs` checks the alarm name
// against `lib/idle-lock.js`'s.
//
// ---- why the lock lives here ----
//
// The popup's JavaScript context is destroyed the instant it loses focus, so a `setTimeout` armed
// while it was open never fires; an idle MV3 service worker is evicted after about thirty
// seconds, so one armed here would not fire either. `chrome.alarms` survives both — the browser
// wakes this script when the alarm comes due, whether or not anything of ours is running — so the
// alarm is what auto-lock is built on, and this listener is the lock itself.
//
// The lock is one deletion: the unlocked wallet session lives in `storage.session`, which is a
// store the *browser* holds, so removing that key locks the wallet for every context at once. If
// a popup or an app tab happens to be open, `lib/idle-lock.js` there sees the change through
// `storage.onChanged` and routes that page to the lock screen; if none is, there is nothing to
// route and the next page to open simply finds a locked wallet.
const ext = globalThis.browser ?? globalThis.chrome;

/** Armed by `lib/idle-lock.js`. Kept in step with its `AUTOLOCK_ALARM`. */
const AUTOLOCK_ALARM = 'autolock';
/** `ui/engine/backend-wasm.js`'s `UNLOCKED_SESSION_KEY`, checked against it by smoke.mjs. */
const UNLOCKED_SESSION_KEY = 'unlocked';
/** Its `K.wallet` — the public facts (address, public key), and only a marker here. */
const WALLET_KEY = 'wallet';

// ---- what this deliberately does NOT consult ----
//
// The engine has a way to postpone a lock it has decided on: `holdUnlock()` marks a stretch of
// user-initiated work the idle timer must not cut in half (`unlockHolds` / `lockDeferred` in
// `ui/engine/backend-wasm.js`), so a transfer is never left half-proved with its spend key pulled
// out from under it. **This listener bypasses that entirely** — it deletes the key whatever any
// page happens to be doing, because a background script has no handle on another context's
// backend object to ask.
//
// That is harmless *today*, and only because of a fact that is checked elsewhere: the only caller
// of `holdUnlock()` is `send.send`, and in this wasm backend `send.canProve()` is unconditionally
// false, so `send.send` refuses before it holds anything for longer than a rejected promise. No
// hold in this shell ever outlives a tick. If that ever changes — a shell here that can prove, or
// any second caller of `holdUnlock()` — this listener becomes able to lock in the middle of it,
// and the lock would have to be routed through a page that owns the backend (a message to the
// open contexts, with this direct deletion as the fallback when none answers).
ext.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== AUTOLOCK_ALARM) return;
  // A one-shot alarm is cleared by the browser once it fires, so there is nothing to cancel.
  try { await ext.storage.session.remove(UNLOCKED_SESSION_KEY); } catch { /* nothing to remove */ }
});

// ---- the page provider, put back into tabs that already have the site open ----
//
// The browser orphans a tab's content scripts when the extension is reloaded (a store update, a
// developer's reload of an unpacked build) and never re-injects them: every open randbridge.org
// tab would answer "Rand Wallet did not respond" until the user thought to reload it. So on
// install and on update the two scripts go back in — inpage.js first (it returns at once when the
// page already has a `window.rand`), then content.js, which retires the orphaned relay (see the
// takeover notice in content.js). The sites are the manifests' `content_scripts.matches`, and
// extension/test/background.test.mjs holds the three in step. A tab the extension may not touch
// (a localhost the user never granted) refuses the injection; that tab keeps its orphan and its
// "reload the page" answer, which is the situation before this existed.
const PROVIDER_SITES = ['https://randbridge.org/*', 'https://*.randbridge.org/*', 'https://durian.market/*', 'https://www.durian.market/*', 'http://localhost/*', 'http://127.0.0.1/*'];

async function reinjectProvider() {
  if (!ext.scripting || !ext.tabs || typeof ext.tabs.query !== 'function') return;
  let tabs;
  try { tabs = await ext.tabs.query({ url: PROVIDER_SITES }); } catch { return; }
  for (const tab of tabs || []) {
    // A tab whose URL is hidden from us is one we have no permission for.
    if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== 'string') continue;
    try { await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ['inpage.js'], world: 'MAIN' }); } catch { /* not ours to touch */ }
    try { await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch { /* same tab, same answer */ }
  }
}

// On the worker's global so extension/test/bridge-chrome.e2e.test.mjs can run it against a real
// page: a driver cannot reload an unpacked extension without losing it.
globalThis.reinjectRandProvider = reinjectProvider;

ext.runtime.onInstalled.addListener(async (details) => {
  if (!details) return;
  if (details.reason === 'install') {
    try {
      const stored = await ext.storage.local.get(WALLET_KEY);
      // An install over storage that already has a wallet (a re-install, a profile restore) is
      // somebody who does not need to be told what this is.
      if (!(stored && stored[WALLET_KEY])) await ext.tabs.create({ url: ext.runtime.getURL('app.html#welcome') });
    } catch { /* no tab is better than a broken install */ }
  }
  if (details.reason === 'install' || details.reason === 'update') await reinjectProvider();
});

// A browser restart empties `storage.session`, so the wallet is already locked; the listener is
// here only so the event has an owner and the worker starts cleanly.
ext.runtime.onStartup?.addListener(() => {});

// ---- the page provider (`window.rand`) ----
//
// inpage.js/content.js relay a Rand site's requests here; provider-host.js decides. Chrome's
// service worker pulls that file in with importScripts; Firefox's event page lists it before this
// one in the manifest's `background.scripts`, so the factory is already on the global there.
if (typeof importScripts === 'function' && typeof globalThis.makeRandProviderHost !== 'function') importScripts('provider-host.js');

const providerHost = globalThis.makeRandProviderHost({
  ext,
  // The consent window: a small popup of our own page, sized like the toolbar popup. The verdict
  // comes back as a `rand:decision` message from that page (see connect.js).
  openConsent: async ({ id, origin, tabId }) => {
    const query = new URLSearchParams({ id, origin, tab: Number.isInteger(tabId) ? String(tabId) : '' });
    await ext.windows.create({ url: ext.runtime.getURL(`connect.html?${query}`), type: 'popup', width: 380, height: 600 });
  },
  // The approval window for a site's `invoke` (invoke.html): it reads the request from the host by
  // id, and stays open for the whole proof — minutes — so it is a window of its own, not the
  // toolbar popup, which the browser destroys the moment it loses focus. Its id is kept so that
  // closing it answers the site (`windowClosed`).
  openInvoke: async ({ id, origin }) => {
    const query = new URLSearchParams({ id, origin });
    const win = await ext.windows.create({ url: ext.runtime.getURL(`invoke.html?${query}`), type: 'popup', width: 400, height: 660 });
    return win && Number.isInteger(win.id) ? win.id : null;
  },
});

ext.windows?.onRemoved?.addListener((windowId) => { void providerHost.windowClosed(windowId); });

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('rand:')) return false;
  providerHost.handle(msg, sender).then(
    (res) => sendResponse(res ?? { ok: false, error: { code: 'UNKNOWN_METHOD', message: 'Rand Wallet does not know that request.' } }),
    (err) => sendResponse({ ok: false, error: { code: 'INTERNAL', message: (err && err.message) || String(err) } }));
  return true; // the answer is asynchronous
});
