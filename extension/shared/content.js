// The relay between the page's `window.rand` (inpage.js, in the page's world) and the extension
// (background.js). Isolated world, classic script, no imports. It forwards exactly four method
// names and nothing the page put in the message: the background decides everything from who is
// asking (`sender`), never from what they said. A connect that needs the user's consent comes back
// as `{pending: id}`; the verdict arrives later as a `rand:decision` message and is handed to the
// page then.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const FROM_PAGE = 'rand-wallet:page';
  const TO_PAGE = 'rand-wallet:content';
  const METHODS = new Set(['connect', 'getAddress', 'getRecipientHash', 'disconnect']);
  const waiting = new Map(); // consent id → the page's request id
  const unavailable = { ok: false, error: { code: 'UNAVAILABLE', message: 'Rand Wallet did not answer. Reload the page and try again.' } };
  const reply = (id, body) => window.postMessage({ target: TO_PAGE, id, ...body }, window.location.origin);

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.target !== FROM_PAGE || typeof d.id !== 'string' || !METHODS.has(d.method)) return;
    let res;
    try { res = await ext.runtime.sendMessage({ type: `rand:${d.method}` }); } catch { res = null; }
    if (!res) { reply(d.id, unavailable); return; }
    if (res.pending) { waiting.set(res.pending, d.id); return; }
    reply(d.id, res);
  });

  ext.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'rand:decision' || typeof msg.id !== 'string') return;
    const pageId = waiting.get(msg.id);
    if (!pageId) return;
    waiting.delete(msg.id);
    reply(pageId, msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
  });
})();
