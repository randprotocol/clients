// `randpay:` deep links for the web wallet (task 14, spec 2026-09-26 §3.3).
//
// Two small pieces, split out of main.js so they are testable without a browser (see
// test/deep-link.test.mjs's header): registering `web+randpay` — browsers only allow a
// `web+`-prefixed custom scheme, unlike a native app's own scheme — and normalizing the hash the
// browser lands the page on back to the plain `#send?uri=<randpay: link>` shape the shared router
// (`ui/lib/panes.js`'s `parseHash`, `ui/screens/send.js`) already understands from a pasted or
// scanned link. Neither function here parses the link's fields (the address, the amount, the
// memo) — that stays `core.call('uri_parse')`, reached through the send screen exactly as it
// would be for a paste; this only adapts the browser's own scheme quirk and route shape.

export const SCHEME = 'web+randpay';

/**
 * Registers this page as the handler for `web+randpay:` links — a receive screen's own payment
 * link, another wallet's QR read out loud, a link on a page — so the browser offers "Rand Wallet"
 * the next time one is activated. `registerProtocolHandler` throws in a browser that does not
 * support it and in an insecure or `file://` context, so this is always wrapped: a wallet that
 * cannot register one still works by paste (the extensions never register one at all — see
 * `chrome/`, `firefox/`). Returns whether it registered, for a caller that wants to know; `main.js`
 * does not.
 */
export function registerRandpayHandler(nav = (typeof navigator !== 'undefined' ? navigator : null), origin = (typeof location !== 'undefined' ? location.origin : '')) {
  if (!nav || typeof nav.registerProtocolHandler !== 'function') return false;
  try {
    nav.registerProtocolHandler(SCHEME, `${origin}/#/send?uri=%s`);
    return true;
  } catch {
    return false;
  }
}

/**
 * `#/send?uri=<encoded link>` — the shape `registerRandpayHandler`'s own URL template lands the
 * page on, and what a bookmark or a typed URL in that form lands on too — to the plain
 * `#send?uri=<randpay: link>` the shared router expects. `null` if `hash` is not that shape at
 * all (so a caller can tell "nothing to do" from "rewrote it to itself").
 *
 * Two purely browser-side quirks live here, nowhere else:
 *   * the leading `/` some browsers keep before the route name;
 *   * the `web+` prefix `registerProtocolHandler` requires the *scheme* to carry, stripped
 *     case-insensitively (the browser echoes whatever case the original link used).
 * Everything past the scheme — the address, the amount, the memo — is still exactly the link's
 * own text; this never reads any of it.
 */
export function normalizeDeepLinkHash(hash) {
  const m = /^#\/?send\?uri=(.*)$/i.exec(String(hash || ''));
  if (!m) return null;
  let link;
  try { link = decodeURIComponent(m[1]); } catch { link = m[1]; }
  link = link.replace(/^web\+randpay:/i, 'randpay:');
  return `#send?uri=${encodeURIComponent(link)}`;
}
