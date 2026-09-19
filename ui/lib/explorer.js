// Building the one outbound link the wallet ever offers: a transaction on a block explorer.
//
// Moved out of screens/detail.js in task 1.5 so the send flow's `#sent` screen can reuse it
// instead of growing a second copy of the rules. `screens/detail.js` re-exports `explorerLink`,
// so anything that already imported it from there still works.
//
// Importable under plain Node: no `document`/`window` access at module scope.

// 32 bytes of hex, with the `0x` prefix this chain's hashes are written with throughout (see
// `send.send()`'s return shape in ui/backend.js) optional.
export const TX_HASH_RE = /^(0x)?[0-9a-f]{64}$/i;

/**
 * `{url, label}` for the explorer button, or `null` when there is nothing safe (or nothing
 * configured) to link to. `explorerUrl` comes from the user's own settings; `hash` comes from the
 * node, so it is validated before it is allowed anywhere near a URL.
 */
export function explorerLink(explorerUrl, hash) {
  if (!explorerUrl || !TX_HASH_RE.test(String(hash || ''))) return null;
  let base;
  try {
    base = new URL(String(explorerUrl).endsWith('/') ? String(explorerUrl) : `${explorerUrl}/`);
  } catch { return null; }
  // https only. Plain http is allowed for a developer's own explorer on this machine and nowhere
  // else: a transaction hash sent in clear to a remote host is a privacy leak, and a plaintext
  // response is something a network can rewrite.
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '[::1]';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) return null;
  const url = new URL(`tx/${hash}`, base);
  const onRandscan = base.hostname === 'randscan.org' || base.hostname.endsWith('.randscan.org');
  return { url: url.href, label: onRandscan ? 'Open in randscan' : 'Open in explorer' };
}
