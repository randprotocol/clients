// The extension's side of `window.rand` (inpage.js → content.js → here), as a classic script so
// background.js can load it in both browsers (Chrome's service worker via importScripts, Firefox's
// event page from the manifest's `scripts` list). It puts one factory on the global:
//
//     makeRandProviderHost({ ext, openConsent }) → { handle(msg, sender) }
//
// What a site can learn, and when:
//   * `connect`      — the address, once the user has approved THIS origin in the consent window
//                      (connect.html). Needs a wallet, and needs it unlocked: a locked wallet on a
//                      shared machine must not start handing its address to pages.
//   * `getAddress`, `getRecipientHash` — the same address and its bridge recipient hash, for an
//                      origin already approved. The hash is computed by the consent page
//                      (lib/recipient-hash.js) and stored with the approval.
//   * `disconnect`   — forgets the approval.
//   * `invoke`       — an RPL-2 program call (durian.market's swaps), for an origin already
//                      approved and a wallet that is unlocked. The request is parked in
//                      storage.session under `invokes` and the approval window (invoke.html) is
//                      opened on it; that window shows the user what leaves the wallet and what
//                      comes back, and on Approve proves and submits it. Its outcome comes back
//                      as `rand:invokeResult` — the hash, or a refusal with a `code` — and goes to
//                      the tab that asked, never to one the message names. A window closed
//                      before it answered answers for itself (`windowClosed`).
// The origin is always `sender`'s — the page's own message carries no parameters at all except an
// invoke's request, which is the thing the user is asked to approve and nothing else. An
// approval is tied to the address it was given for: import a different wallet and every site is
// disconnected until it asks again. Approvals live in storage.local under `sites`, so a wipe
// clears them with the rest.
//
// Tested under Node by extension/test/provider-host.test.mjs, which evaluates this file as the
// classic script it is.
(function (root) {
  const SITES_KEY = 'sites';
  const WALLET_KEY = 'wallet';     // ui/engine/backend-shared.js K.wallet: {address, pk}
  const UNLOCKED_KEY = 'unlocked'; // its UNLOCKED_SESSION_KEY, in storage.session
  const INVOKES_KEY = 'invokes';   // storage.session: id → {origin, tabId, request, windowId, phase, at}
  const WORD8_RE = /^(0x)?[0-9a-fA-F]{64}$/;
  /** Phases after which the transaction may have reached the node (ui/engine/execute.js). */
  const ON_THE_WIRE = new Set(['submitting', 'confirming']);

  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const one = (bag, key) => (bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined);

  function makeRandProviderHost({ ext, openConsent, openInvoke, newId }) {
    const local = ext.storage.local;
    const session = ext.storage.session;
    const id = newId || (() => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
    const extensionRoot = () => { try { return ext.runtime.getURL(''); } catch { return null; } };

    const wallet = async () => one(await local.get(WALLET_KEY), WALLET_KEY) || null;
    const unlocked = async () => { try { return !!one(await session.get(UNLOCKED_KEY), UNLOCKED_KEY); } catch { return false; } };
    const sites = async () => one(await local.get(SITES_KEY), SITES_KEY) || {};
    /** The approval this origin holds for the wallet that is on the device now, or null. */
    async function grant(origin) {
      const w = await wallet();
      if (!w || !w.address) return null;
      const s = (await sites())[origin];
      return s && s.address === w.address && typeof s.hash === 'string' ? s : null;
    }
    /** The asking page's web origin, or null for anything that is not http(s) (a file:, an
     *  extension page, a sender with no URL at all). */
    function originOf(sender) {
      const raw = sender && typeof sender.origin === 'string' && sender.origin !== 'null' ? sender.origin : sender && sender.url;
      try {
        const u = new URL(raw);
        return /^https?:$/.test(u.protocol) ? u.origin : null;
      } catch { return null; }
    }

    /** The consent page's verdict. Only an extension page may deliver one. */
    async function decide(msg, sender) {
      const rootUrl = extensionRoot();
      if (!rootUrl || !sender || typeof sender.url !== 'string' || !sender.url.startsWith(rootUrl)) return fail('FORBIDDEN', 'not the consent page');
      const { id: consentId, origin, tabId } = msg;
      if (typeof consentId !== 'string' || typeof origin !== 'string') return fail('BAD_REQUEST', 'malformed decision');
      let verdict;
      if (msg.approved === true) {
        const w = await wallet();
        if (!w || w.address !== msg.address || typeof msg.hash !== 'string') {
          verdict = { ok: false, error: { code: 'NO_WALLET', message: 'The wallet changed while you were deciding. Try again.' } };
        } else {
          const all = await sites();
          all[origin] = { address: w.address, hash: msg.hash, at: Date.now() };
          await local.set({ [SITES_KEY]: all });
          verdict = { ok: true, result: { address: w.address } };
        }
      } else {
        verdict = { ok: false, error: { code: 'USER_REJECTED', message: 'The connection was not approved in Rand Wallet.' } };
      }
      if (Number.isInteger(tabId)) {
        try { await ext.tabs.sendMessage(tabId, { type: 'rand:decision', id: consentId, ...verdict }); } catch { /* the tab is gone */ }
      }
      return { ok: true };
    }

    // ---- invoke ----
    const invokes = async () => { try { return one(await session.get(INVOKES_KEY), INVOKES_KEY) || {}; } catch { return {}; } };
    const saveInvokes = (all) => session.set({ [INVOKES_KEY]: all });
    const fromExtensionPage = (sender) => {
      const rootUrl = extensionRoot();
      return !!rootUrl && !!sender && typeof sender.url === 'string' && sender.url.startsWith(rootUrl);
    };
    /** Answer the tab that asked, and forget the request. Idempotent: a second answer finds nothing. */
    async function settle(invokeId, verdict) {
      const all = await invokes();
      const rec = all[invokeId];
      if (!rec) return false;
      delete all[invokeId];
      await saveInvokes(all);
      if (Number.isInteger(rec.tabId)) {
        try { await ext.tabs.sendMessage(rec.tabId, { type: 'rand:decision', id: invokeId, ...verdict }); } catch { /* the tab is gone */ }
      }
      return true;
    }

    async function startInvoke(origin, sender, params) {
      const w = await wallet();
      if (!w || !w.address) return fail('NO_WALLET', 'Rand Wallet has no wallet yet.');
      if (!(await unlocked())) return fail('LOCKED', 'Rand Wallet is locked.');
      if (!(await grant(origin))) return fail('NOT_CONNECTED', 'Rand Wallet is not connected to this site.');
      // The shape is checked in full by the window's engine (ui/engine/invoke.js); here only enough
      // to refuse junk without opening a window for it.
      if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.program !== 'string' || !WORD8_RE.test(params.program)) {
        return fail('BAD_REQUEST', 'Rand Wallet could not read that request.');
      }
      const all = await invokes();
      // One request per site at a time: a page cannot stack windows on the user.
      if (Object.values(all).some((r) => r && r.origin === origin)) {
        return fail('BUSY', 'Rand Wallet is already showing a request from this site. Finish or cancel it first.');
      }
      const invokeId = id();
      const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : undefined;
      all[invokeId] = { origin, tabId, request: params, windowId: null, phase: null, at: Date.now() };
      await saveInvokes(all);
      let windowId = null;
      try {
        windowId = await openInvoke({ id: invokeId, origin });
      } catch (err) {
        delete all[invokeId];
        await saveInvokes(all);
        return fail('UNAVAILABLE', `Rand Wallet could not open its window: ${(err && err.message) || err}`);
      }
      if (Number.isInteger(windowId)) {
        const now = await invokes();
        if (now[invokeId]) { now[invokeId].windowId = windowId; await saveInvokes(now); }
      }
      return { pending: invokeId };
    }

    /** From the approval window only: the request it is showing, the phases it reaches, its result. */
    async function fromWindow(msg, sender) {
      if (!fromExtensionPage(sender)) return fail('FORBIDDEN', 'not the approval window');
      const invokeId = msg.id;
      if (typeof invokeId !== 'string') return fail('BAD_REQUEST', 'malformed invoke message');
      if (msg.type === 'rand:invokeRequest') {
        const rec = (await invokes())[invokeId];
        return rec ? { ok: true, result: { origin: rec.origin, request: rec.request } } : fail('GONE', 'That request is no longer waiting.');
      }
      if (msg.type === 'rand:invokeProgress') {
        const all = await invokes();
        if (all[invokeId] && typeof msg.phase === 'string') { all[invokeId].phase = msg.phase.slice(0, 32); await saveInvokes(all); }
        return { ok: true };
      }
      // rand:invokeResult
      let verdict;
      if (msg.ok === true && msg.result && typeof msg.result.tx === 'string' && WORD8_RE.test(msg.result.tx)) {
        verdict = { ok: true, result: { tx: msg.result.tx.replace(/^0x/, '').toLowerCase() } };
      } else {
        const e = msg.error || {};
        verdict = {
          ok: false,
          error: {
            code: typeof e.code === 'string' && /^[A-Z_]{2,32}$/.test(e.code) ? e.code : 'UNKNOWN',
            message: typeof e.message === 'string' && e.message ? e.message.slice(0, 300) : 'Rand Wallet did not complete the request.',
          },
        };
      }
      await settle(invokeId, verdict);
      return { ok: true };
    }

    /**
     * The approval window `windowId` closed. A request it had not answered is answered here: never
     * approved, or stopped before anything left the device, is a refusal; closed once the
     * transaction may have reached the node is UNKNOWN_OUTCOME — the site follows the chain, and
     * must not offer to send it again as if nothing happened.
     */
    async function windowClosed(windowId) {
      const all = await invokes();
      for (const [invokeId, rec] of Object.entries(all)) {
        if (!rec || rec.windowId !== windowId) continue;
        const verdict = ON_THE_WIRE.has(rec.phase)
          ? { ok: false, error: { code: 'UNKNOWN_OUTCOME', message: 'The Rand Wallet window was closed while the transaction was being sent; it may still arrive. Check the chain before trying again.' } }
          : rec.phase
            ? { ok: false, error: { code: 'INTERRUPTED', message: 'The Rand Wallet window was closed before the transaction was sent. Nothing was sent.' } }
            : { ok: false, error: { code: 'USER_REJECTED', message: 'The request was not approved in Rand Wallet.' } };
        // eslint-disable-next-line no-await-in-loop -- one window, one request
        await settle(invokeId, verdict);
      }
    }

    async function handle(msg, sender) {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('rand:')) return undefined;
      if (msg.type === 'rand:decision') return decide(msg, sender);
      if (msg.type === 'rand:invokeRequest' || msg.type === 'rand:invokeProgress' || msg.type === 'rand:invokeResult') return fromWindow(msg, sender);
      const origin = originOf(sender);
      if (!origin) return fail('UNSUPPORTED_ORIGIN', 'This page cannot connect to Rand Wallet.');
      switch (msg.type) {
        case 'rand:connect': {
          const w = await wallet();
          if (!w || !w.address) return fail('NO_WALLET', 'Rand Wallet has no wallet yet.');
          if (!(await unlocked())) return fail('LOCKED', 'Rand Wallet is locked.');
          const g = await grant(origin);
          if (g) return { ok: true, result: { address: g.address } };
          const consentId = id();
          await openConsent({ id: consentId, origin, tabId: sender && sender.tab ? sender.tab.id : undefined });
          return { pending: consentId };
        }
        case 'rand:getAddress': {
          const g = await grant(origin);
          return g ? { ok: true, result: g.address } : fail('NOT_CONNECTED', 'Rand Wallet is not connected to this site.');
        }
        case 'rand:getRecipientHash': {
          const g = await grant(origin);
          return g ? { ok: true, result: g.hash } : fail('NOT_CONNECTED', 'Rand Wallet is not connected to this site.');
        }
        case 'rand:invoke':
          if (typeof openInvoke !== 'function') return fail('UNKNOWN_METHOD', 'This Rand Wallet does not support invoke.');
          return startInvoke(origin, sender, msg.params);
        case 'rand:disconnect': {
          const all = await sites();
          if (all[origin]) { delete all[origin]; await local.set({ [SITES_KEY]: all }); }
          return { ok: true, result: null };
        }
        default:
          return fail('UNKNOWN_METHOD', `Rand Wallet does not know ${msg.type}.`);
      }
    }

    return { handle, windowClosed };
  }

  root.makeRandProviderHost = makeRandProviderHost;
})(globalThis);
