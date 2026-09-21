// Rand Wallet's Backend (ui/backend.js) for the browser extension.
//
// The same composition `web/wallet/main.js` does for a web page, over `chrome.storage` instead of
// IndexedDB: the shared engine (`ui/engine/backend-wasm.js`) is the wallet, and this file is only
// the three things that engine takes — where the bytes are kept, how to reach the wasm core, and
// what the UI may ask the browser for — plus the extension's own auto-lock.
//
// Nothing here is chain crypto and nothing here is a screen. `ui/engine/backend-wasm.js` never
// learns it is running in an extension, and `ui/screens/*` never learn there is a `chrome`.
//
// ---- what this shell cannot do ----
//
// Produce a transfer proof: it needs about 5.7 GB and wasm32 stops at 4 GiB, so `send.canProve()`
// is `{ok: false, reason}` and Send ends in that explanation rather than a Prove button. Which is
// also why the popup needs no escape into a tab (`platform.openFlowInTab`): the long-running steps
// that would outlive a closed 360×600 window are never reached. Everything else — keys, the
// address, scanning a real node, the note store, the faucet, viewing keys — is real.
import { makeWasmBackend, UNLOCKED_SESSION_KEY } from './ui/engine/backend-wasm.js';
import { ext } from './lib/browser.js';
import { call } from './lib/core.js';
import { wireIdleLock } from './lib/idle-lock.js';
import { makePlatform } from './lib/platform.js';

/**
 * The `storage` half of `makeWasmBackend`, over the two `chrome.storage` areas.
 *
 *   local    the encrypted vault, the public wallet facts, the settings, the cached asset
 *            registry and the note store — a cache of chain data, rebuildable from leaf 0.
 *            Nothing in it is a secret at rest.
 *   session  the unlocked spend key, and only while the wallet is unlocked. MV3's session area is
 *            memory the *browser* holds, not the page: it is emptied when the browser closes and
 *            is unreadable from a content script (its default access level is trusted contexts
 *            only), and — the reason the extension's auto-lock can work at all — it survives the
 *            popup being destroyed and the service worker being evicted, so deleting one key from
 *            it is a lock that every open page of this extension can see happen.
 *
 * `compareAndSet` is deliberately absent. It is OPTIONAL in the storage contract and feature-
 * detected at both of its call sites, which fall back to a plain `set`; `chrome.storage` has no
 * conditional write to build it out of. Both call sites lose something, and it is worth naming
 * both rather than only the obvious one:
 *
 *   1. **the note store.** Two contexts of this wallet (the popup and an app tab) scanning at the
 *      same instant can overwrite each other's write. Not destructive — the engine merges rather
 *      than truncates, and the scan lock and BroadcastChannel already keep them out of each
 *      other's way most of the time — so the worst case is a scan redone, never a note lost.
 *   2. **the unlock-failure counter** (`bumpFailures` in `ui/engine/backend-wasm.js`, which uses
 *      `compareAndSet` where it exists so two contexts failing at the same instant still count as
 *      two). Without it, a popup and an app tab can read the same count, both write count + 1,
 *      and **two failed attempts are recorded as one** — the shared backoff grows more slowly
 *      than the guessing actually did. It is a real under-count, not a theoretical one, and it
 *      does not corrupt anything. What it is not is the wallet's at-rest protection: that is the
 *      KDF (PBKDF2-SHA256, 600 000 iterations) paid in full on every single attempt, wrong
 *      password or not. The backoff is there to make bulk guessing tedious, and the contract
 *      already says so (ui/backend.js, "what a failed unlock costs, across tabs": N contexts can
 *      each have one attempt in flight, so the rate scales with them even where the count does
 *      not).
 */
function extensionStorage() {
  const local = ext.storage.local;
  const session = ext.storage.session;
  // `chrome.storage` answers with an object keyed by what was asked for; the contract's storage
  // answers with the value itself.
  const one = (bag, key) => (bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined);
  return {
    async get(key) { return one(await local.get(key), key); },
    async set(key, value) { await local.set({ [key]: value }); },
    async remove(key) { await local.remove(key); },
    async clear() {
      await local.clear();
      // `wallet.wipe()` is the only caller, and a wipe that left the unlocked spend key sitting in
      // the session area would be a wipe in name only.
      try { await session.clear(); } catch { /* nothing to clear */ }
    },
    session: {
      async get(key) { return one(await session.get(key), key); },
      async set(key, value) { await session.set({ [key]: value }); },
      async remove(key) { await session.remove(key); },
    },
  };
}

/**
 * `extensionBackend()` → a Backend, ready for `mount()`. Called once by each page (the popup and
 * the app tab), which is one backend per page: `storage` is the browser's, so the two see the same
 * wallet, and the engine's own multi-tab coordination (Web Locks, a BroadcastChannel) works
 * between them exactly as it does between two tabs of the web wallet.
 *
 * The idle lock is wired here, before the backend is handed to anyone: `mount()` snapshots every
 * group it is given, so a method replaced afterwards would never be the one the UI calls.
 */
export function extensionBackend() {
  const backend = makeWasmBackend({
    core: { call },            // lib/core.js: the wasm core in a Web Worker, as `call(method, params)`
    storage: extensionStorage(),
    platform: makePlatform(),
  });

  const disposeIdleLock = wireIdleLock(backend, ext, { sessionKey: UNLOCKED_SESSION_KEY });

  // `dispose?()` is OPTIONAL in the contract and is called by the shell's `destroy()`, last. It
  // must be idempotent and must not throw, so both halves run whatever the other does.
  const disposeEngine = typeof backend.dispose === 'function' ? backend.dispose.bind(backend) : null;
  backend.dispose = () => {
    try { disposeIdleLock(); } catch { /* already gone */ }
    if (disposeEngine) { try { disposeEngine(); } catch { /* already gone */ } }
  };

  return backend;
}
