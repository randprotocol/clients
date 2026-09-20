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

ext.runtime.onInstalled.addListener(async (details) => {
  if (!details || details.reason !== 'install') return;
  try {
    const stored = await ext.storage.local.get(WALLET_KEY);
    // An install over storage that already has a wallet (a re-install, a profile restore) is
    // somebody who does not need to be told what this is.
    if (stored && stored[WALLET_KEY]) return;
    await ext.tabs.create({ url: ext.runtime.getURL('app.html#welcome') });
  } catch { /* no tab is better than a broken install */ }
});

// A browser restart empties `storage.session`, so the wallet is already locked; the listener is
// here only so the event has an owner and the worker starts cleanly.
ext.runtime.onStartup?.addListener(() => {});
