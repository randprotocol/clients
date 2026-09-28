// `window.rand` — what a Rand site sees of this wallet. Runs in the page's own world (the
// manifest's `world: "MAIN"` content script, at document_start, so it is there before the page's
// scripts run) and knows nothing: every call is posted to content.js, which is the only side that
// can reach the extension. The contract is the one randbridge.org/web/lib/rand/provider.ts
// expects — `isRandWallet`, `connect`, `getAddress`, `getRecipientHash`, `disconnect`, `on`, and
// the rand:announceProvider / rand:requestProvider handshake for a page that ran first.
//
// What is never here: keys, balances, notes, signing. The extension answers with the address and
// its bridge recipient hash, after the user has said yes to this origin, and nothing else.
(() => {
  if (window.rand && window.rand.isRandWallet) return;
  const TO_CONTENT = 'rand-wallet:page';
  const FROM_CONTENT = 'rand-wallet:content';
  const pending = new Map();
  const listeners = { accountChanged: new Set(), disconnect: new Set() };
  let seq = 0;

  const request = (method) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++seq}`;
    pending.set(id, { resolve, reject });
    window.postMessage({ target: TO_CONTENT, id, method }, window.location.origin);
  });
  const emit = (event, payload) => {
    for (const cb of listeners[event] || []) { try { cb(payload); } catch { /* a listener's problem */ } }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.target !== FROM_CONTENT) return;
    if (d.event) { emit(d.event, d.payload); return; }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) { p.resolve(d.result); return; }
    const err = new Error((d.error && d.error.message) || 'Rand Wallet refused.');
    err.code = (d.error && d.error.code) || 'UNKNOWN';
    p.reject(err);
  });

  const provider = Object.freeze({
    isRandWallet: true,
    connect: () => request('connect'),
    getAddress: () => request('getAddress'),
    getRecipientHash: () => request('getRecipientHash'),
    disconnect: () => request('disconnect').then(() => { emit('disconnect', null); }),
    on(event, cb) {
      if (!listeners[event] || typeof cb !== 'function') return () => {};
      listeners[event].add(cb);
      return () => listeners[event].delete(cb);
    },
  });
  Object.defineProperty(window, 'rand', { value: provider, writable: false, configurable: false, enumerable: true });

  const announce = () => window.dispatchEvent(new CustomEvent('rand:announceProvider', { detail: Object.freeze({ provider }) }));
  window.addEventListener('rand:requestProvider', announce);
  announce();
})();
