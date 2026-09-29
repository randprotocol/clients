// The relay between the page's `window.rand` (inpage.js, in the page's world) and the extension
// (background.js). Isolated world, classic script, no imports. It forwards exactly four method
// names and nothing the page put in the message: the background decides everything from who is
// asking (`sender`), never from what they said. A connect that needs the user's consent comes back
// as `{pending: id}`; the verdict arrives later as a `rand:decision` message and is handed to the
// page then.
//
// ---- two relays on one page ----
//
// Reloading the extension — a store update, or a developer's reload of an unpacked build —
// orphans this script in every tab that has it: from then on `ext.runtime` throws "Extension
// context invalidated", and the browser does not put a fresh script in. background.js does, on
// install and on update (`scripting.executeScript`), so for the rest of that page's life an orphan
// and a live relay share it. Both hear every page request; the page must hear one answer, the live
// one's. So a relay announces itself on the window when it starts, and any relay already there
// unhooks itself on hearing it — if the notice is from a relay born after it, since its own notice
// from page load is still on the bus when it is injected early. The notice carries no secret: a page script can post one too, and
// all it gets for that is a `window.rand` that no longer answers — the page can already ignore its
// own provider, and can already post itself forged replies on this same bus, so nothing crosses a
// trust boundary here.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const FROM_PAGE = 'rand-wallet:page';
  const TO_PAGE = 'rand-wallet:content';
  const TAKEOVER = 'rand-wallet:content-takeover';
  const METHODS = new Set(['connect', 'getAddress', 'getRecipientHash', 'disconnect']);
  const waiting = new Map(); // consent id → the page's request id
  /** When this relay was born: it yields to a later one only. Worlds of one document share a
   *  time origin, so the clock reads the same across them. */
  const born = performance.now();
  // Two ways for the background to be out of reach, with two remedies. "Extension context
  // invalidated" is this script being the stale half — the extension reloaded under the page —
  // and reloading the page fixes it (background.js also re-injects, see above). Anything else —
  // "Receiving end does not exist", or a listener that answered nothing — is the background being
  // the stale half: an unpacked build whose files moved on while Chrome kept the old service worker
  // registered, until someone presses Reload at chrome://extensions. Reloading the page alone
  // would change nothing there, so the page is told which.
  const unavailable = { ok: false, error: { code: 'UNAVAILABLE', message: 'Rand Wallet did not answer. Reload the page and try again.' } };
  const noBackground = { ok: false, error: { code: 'NO_BACKGROUND', message: 'Rand Wallet is installed, but its background script did not answer. Reload the extension, then reload this page.' } };
  const reply = (id, body) => window.postMessage({ target: TO_PAGE, id, ...body }, window.location.origin);
  const fromThisPage = (e) => e.source === window && e.origin === window.location.origin && !!e.data;

  const onPage = async (e) => {
    if (!fromThisPage(e)) return;
    const d = e.data;
    if (d.target !== FROM_PAGE || typeof d.id !== 'string' || !METHODS.has(d.method)) return;
    let res, why = '';
    try { res = await ext.runtime.sendMessage({ type: `rand:${d.method}` }); } catch (e) { res = null; why = String((e && e.message) || e); }
    if (!res) { reply(d.id, /invalidated/i.test(why) ? unavailable : noBackground); return; }
    if (res.pending) { waiting.set(res.pending, d.id); return; }
    reply(d.id, res);
  };

  const onDecision = (msg) => {
    if (!msg || msg.type !== 'rand:decision' || typeof msg.id !== 'string') return;
    const pageId = waiting.get(msg.id);
    if (!pageId) return;
    waiting.delete(msg.id);
    reply(pageId, msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
  };

  const onTakeover = (e) => {
    if (!fromThisPage(e)) return;
    const d = e.data;
    if (d.target !== TAKEOVER || typeof d.born !== 'number' || d.born <= born) return;
    window.removeEventListener('message', onPage);
    window.removeEventListener('message', onTakeover);
    try { ext.runtime.onMessage.removeListener(onDecision); } catch { /* an orphan has no runtime to unhook from */ }
  };

  window.addEventListener('message', onPage);
  window.addEventListener('message', onTakeover);
  ext.runtime.onMessage.addListener(onDecision);
  window.postMessage({ target: TAKEOVER, born }, window.location.origin);
})();
