// `window.rand` — what a Rand site sees of this wallet. Runs in the page's own world (the
// manifest's `world: "MAIN"` content script, at document_start, so it is there before the page's
// scripts run) and knows nothing: every call is posted to content.js, which is the only side that
// can reach the extension. The contract is the one randbridge.org/web/lib/rand/provider.ts
// expects — `isRandWallet`, `connect`, `getAddress`, `getRecipientHash`, `disconnect`, `on`, and
// the rand:announceProvider / rand:requestProvider handshake for a page that ran first — plus
// `invoke(request) → {tx}`, an RPL-2 program call (durian.market's `web/lib/rand/provider.ts`),
// which the user approves in the wallet's own window before anything is proved.
//
// What is never here: keys, balances, notes, signing. The extension answers with the address and
// its bridge recipient hash, after the user has said yes to this origin, and — for an `invoke` the
// user approved — the transaction hash; nothing else.
(() => {
  if (window.rand && window.rand.isRandWallet) return;
  const TO_CONTENT = 'rand-wallet:page';
  const FROM_CONTENT = 'rand-wallet:content';
  const pending = new Map();
  const listeners = { accountChanged: new Set(), disconnect: new Set() };
  let seq = 0;

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++seq}`;
    pending.set(id, { resolve, reject });
    const msg = { target: TO_CONTENT, id, method };
    if (params !== undefined) msg.params = params;
    window.postMessage(msg, window.location.origin);
  });
  const refused = (code, message) => Object.assign(new Error(message), { code });
  // The request as plain JSON, copied here in the page's world: no getters, no prototypes and no
  // BigInt reach the relay (amounts are decimal strings in the contract).
  const plain = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
  };
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
    invoke: (req) => {
      const params = plain(req);
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return Promise.reject(refused('BAD_REQUEST', 'Rand Wallet could not read that request.'));
      }
      return request('invoke', params);
    },
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
