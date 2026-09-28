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
// The origin is always `sender`'s — the page's own message carries no parameters at all. An
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

  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const one = (bag, key) => (bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined);

  function makeRandProviderHost({ ext, openConsent, newId }) {
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

    async function handle(msg, sender) {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('rand:')) return undefined;
      if (msg.type === 'rand:decision') return decide(msg, sender);
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
        case 'rand:disconnect': {
          const all = await sites();
          if (all[origin]) { delete all[origin]; await local.set({ [SITES_KEY]: all }); }
          return { ok: true, result: null };
        }
        default:
          return fail('UNKNOWN_METHOD', `Rand Wallet does not know ${msg.type}.`);
      }
    }

    return { handle };
  }

  root.makeRandProviderHost = makeRandProviderHost;
})(globalThis);
