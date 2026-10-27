// The extension's side of `window.rand` (inpage.js → content.js → here), as a classic script so
// background.js can load it in both browsers (Chrome's service worker via importScripts, Firefox's
// event page from the manifest's `scripts` list). It puts one factory on the global:
//
//     makeRandProviderHost({ ext, openConsent, openInvoke, openWithdraw }) → { handle(msg, sender), windowClosed(id) }
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
//   * `withdraw`     — a bridge burn (randbridge.org's one-click withdraw), asked the same way and
//                      with the same preconditions, but approved in its own window (withdraw.html)
//                      and answered by `rand:withdrawResult`. It is the same kind of parked
//                      request — one record store, `kind` telling the two apart — so one origin
//                      has one request at a time whichever it is: a page cannot stack a swap and a
//                      burn on the user. The window's proof phases are also forwarded to the
//                      asking tab (`rand:phase`), display only, for the site's progress view.
//                      A window of one kind cannot read or answer the other kind's record.
// What a site is told when the wallet refuses: a code and a FIXED sentence for that code
// (`SITE_ERRORS`, the same table as lib/site-errors.js), never the window's own reason, which can
// name a balance, a note's value or the user's own prover host. A window's answer is re-worded
// here whatever it says, so nothing the window computed but the code and the hash reaches a page.
// The origin is always `sender`'s — the page's own message carries no parameters at all except an
// invoke's or a withdraw's request, which is the thing the user is asked to approve and nothing else. An
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
  const INVOKES_KEY = 'invokes';   // storage.session: id → {kind, origin, tabId, request, windowId, phase, at}; no kind reads as 'invoke'
  const HEX32_RE = /^[0-9a-fA-F]{64}$/;
  const AMOUNT_RE = /^[1-9][0-9]{0,29}$/;
  const WORD8_RE = /^(0x)?[0-9a-fA-F]{64}$/;
  /** Phases after which the transaction may have reached the node (ui/engine/execute.js). */
  const ON_THE_WIRE = new Set(['submitting', 'confirming']);

  // lib/site-errors.js `SITE_ERRORS`, copied: this classic script cannot import a module, and
  // extension/test/site-errors.test.mjs checks the two are equal.
  const SHARED = {
    USER_REJECTED: 'The request was not approved in Rand Wallet.',
    GONE: 'That request is no longer waiting.',
    LOCKED: 'Rand Wallet is locked.',
    BAD_REQUEST: 'Rand Wallet could not read that request.',
    PROVER_UNAVAILABLE: 'Rand Wallet has no prover it can use for this right now, so nothing was sent. Open Rand Wallet to see why.',
  };
  const SITE_ERRORS = Object.freeze({
    withdraw: Object.freeze({
      ...SHARED,
      CANNOT_WITHDRAW: 'Rand Wallet cannot make this withdrawal. Open Rand Wallet to see why.',
      WRONG_CHAIN: 'This request is for a different Rand chain than this wallet is on.',
      UNAVAILABLE: 'Rand Wallet cannot reach or use the bridge right now. Nothing was sent.',
      BRIDGE_DISABLED: 'The bridge is off on this Rand chain. Nothing was sent.',
      PROOF_PENDING: 'An earlier proof is still waiting in Rand Wallet. Open Rand Wallet to resume or cancel it.',
      UNKNOWN_OUTCOME: 'Rand Wallet could not tell whether the burn was sent. Check its activity before trying again.',
    }),
    invoke: Object.freeze({
      ...SHARED,
      CANNOT_INVOKE: 'Rand Wallet cannot make this transaction. Open Rand Wallet to see why.',
      UNSUPPORTED: 'This Rand Wallet cannot run programs.',
      PROGRAMS_UNSUPPORTED: 'This chain does not run programs yet, so Rand Wallet cannot send this. Nothing was sent.',
      NO_PROGRAM: 'There is no such program on this chain. Nothing was sent.',
      STALE_READ: 'The pool changed since this page read it. Nothing was sent; the site can quote again.',
      PROGRAM_REFUSED: 'The program would not accept this request, so nothing was sent.',
      VAULT_SHORT: 'The pool does not hold enough to pay this out. Nothing was sent; the site can quote again.',
      UNKNOWN_OUTCOME: 'Rand Wallet could not tell whether the transaction was sent. Check its activity before trying again.',
    }),
  });
  const CANNOT = { withdraw: 'CANNOT_WITHDRAW', invoke: 'CANNOT_INVOKE' };
  /** A window's refusal as the site may hear it: a listed code and its sentence, or the catch-all. */
  function siteError(kind, code) {
    const table = SITE_ERRORS[kind];
    const c = typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code) ? code : CANNOT[kind];
    return { code: c, message: table[c] };
  }

  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const one = (bag, key) => (bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined);

  function makeRandProviderHost({ ext, openConsent, openInvoke, openWithdraw, newId }) {
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
    const kindOf = (rec) => (rec && rec.kind === 'withdraw' ? 'withdraw' : 'invoke');
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

    /**
     * The shape a page's withdraw must have to be worth a window: the cheap, structural half. The
     * flow in withdraw.js reads the rest (the wallet's chain, the asset, the destination) and
     * refuses what it cannot burn, with the reason in the window.
     */
    function withdrawShapeOk(p) {
      return !!p && typeof p === 'object' && !Array.isArray(p)
        && Number.isInteger(p.asset) && p.asset >= 0
        && typeof p.amount === 'string' && AMOUNT_RE.test(p.amount)
        && typeof p.token === 'string' && HEX32_RE.test(p.token)
        && typeof p.to === 'string' && HEX32_RE.test(p.to);
    }
    function invokeShapeOk(p) {
      // The shape is checked in full by the window's engine (ui/engine/invoke.js); here only enough
      // to refuse junk without opening a window for it.
      return !!p && typeof p === 'object' && !Array.isArray(p) && typeof p.program === 'string' && WORD8_RE.test(p.program);
    }

    /** Park a request of `kind` and open its window; the shared body of `invoke` and `withdraw`. */
    async function start(kind, origin, sender, params) {
      const w = await wallet();
      if (!w || !w.address) return fail('NO_WALLET', 'Rand Wallet has no wallet yet.');
      if (!(await unlocked())) return fail('LOCKED', 'Rand Wallet is locked.');
      if (!(await grant(origin))) return fail('NOT_CONNECTED', 'Rand Wallet is not connected to this site.');
      if (!(kind === 'withdraw' ? withdrawShapeOk(params) : invokeShapeOk(params))) {
        return fail('BAD_REQUEST', 'Rand Wallet could not read that request.');
      }
      const all = await invokes();
      // One request per site at a time, of either kind: a page cannot stack windows on the user.
      if (Object.values(all).some((r) => r && r.origin === origin)) {
        return fail('BUSY', 'Rand Wallet is already showing a request from this site. Finish or cancel it first.');
      }
      const invokeId = id();
      const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : undefined;
      all[invokeId] = { kind, origin, tabId, request: params, windowId: null, phase: null, at: Date.now() };
      await saveInvokes(all);
      let windowId = null;
      try {
        windowId = await (kind === 'withdraw' ? openWithdraw : openInvoke)({ id: invokeId, origin });
      } catch (err) {
        delete all[invokeId];
        await saveInvokes(all);
        return fail('UNAVAILABLE', 'Rand Wallet could not open its window. Nothing was sent.');
      }
      if (Number.isInteger(windowId)) {
        const now = await invokes();
        if (now[invokeId]) { now[invokeId].windowId = windowId; await saveInvokes(now); }
      }
      return { pending: invokeId };
    }

    /**
     * From the approval window only: the request it is showing, the phases it reaches, its result.
     * `rand:invoke*` and `rand:withdraw*` are one protocol in two spellings; each reaches only the
     * records of its own kind, so a window cannot be pointed at (or answer for) the other's.
     */
    async function fromWindow(msg, sender) {
      if (!fromExtensionPage(sender)) return fail('FORBIDDEN', 'not the approval window');
      const invokeId = msg.id;
      if (typeof invokeId !== 'string') return fail('BAD_REQUEST', 'malformed invoke message');
      const m = /^rand:(invoke|withdraw)(Request|Progress|Result)$/.exec(msg.type);
      const kind = m[1];
      const gone = () => fail('GONE', 'That request is no longer waiting.');
      if (m[2] === 'Request') {
        const rec = (await invokes())[invokeId];
        return rec && kindOf(rec) === kind ? { ok: true, result: { origin: rec.origin, request: rec.request } } : gone();
      }
      if (m[2] === 'Progress') {
        const all = await invokes();
        const rec = all[invokeId];
        if (!rec || kindOf(rec) !== kind) return gone();
        if (typeof msg.phase === 'string') {
          rec.phase = msg.phase.slice(0, 32);
          await saveInvokes(all);
          // The site's progress view; display only. The tab is the record's, not the message's.
          if (kind === 'withdraw' && Number.isInteger(rec.tabId)) {
            try { await ext.tabs.sendMessage(rec.tabId, { type: 'rand:phase', id: invokeId, phase: rec.phase }); } catch { /* the tab is gone */ }
          }
        }
        return { ok: true };
      }
      // Result
      const rec = (await invokes())[invokeId];
      if (rec && kindOf(rec) !== kind) return gone();
      let verdict;
      if (msg.ok === true && msg.result && typeof msg.result.tx === 'string' && WORD8_RE.test(msg.result.tx)) {
        verdict = { ok: true, result: { tx: msg.result.tx.replace(/^0x/, '').toLowerCase() } };
      } else {
        // The code, if this kind lists it, and the fixed sentence for it; the window's message is
        // dropped (see SITE_ERRORS).
        verdict = { ok: false, error: siteError(kind, (msg.error || {}).code) };
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
            ? { ok: false, error: { code: 'INTERRUPTED', message: kindOf(rec) === 'withdraw'
              // A burn's remote proof outlives its window: the wallet keeps the job, and its own
              // Withdraw screen finishes or cancels it.
              ? 'The Rand Wallet window was closed before the withdrawal was sent. Nothing was sent yet; open Rand Wallet, then zUSD, then Withdraw to finish or cancel it.'
              : 'The Rand Wallet window was closed before the transaction was sent. Nothing was sent.' } }
            : { ok: false, error: { code: 'USER_REJECTED', message: 'The request was not approved in Rand Wallet.' } };
        // eslint-disable-next-line no-await-in-loop -- one window, one request
        await settle(invokeId, verdict);
      }
    }

    async function handle(msg, sender) {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('rand:')) return undefined;
      if (msg.type === 'rand:decision') return decide(msg, sender);
      if (/^rand:(invoke|withdraw)(Request|Progress|Result)$/.test(msg.type)) return fromWindow(msg, sender);
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
          return start('invoke', origin, sender, msg.params);
        case 'rand:withdraw':
          if (typeof openWithdraw !== 'function') return fail('UNKNOWN_METHOD', 'This Rand Wallet does not support withdraw.');
          return start('withdraw', origin, sender, msg.params);
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
  root.RAND_SITE_ERRORS = SITE_ERRORS;
})(globalThis);
