// The key a site gets from `window.rand.deriveKey({purpose})`: 32 bytes, bound to this wallet, to
// the site that asked, to what it asked for and to the address it is connected with. A classic
// script, like provider-host.js, so the background can load it in both browsers (Chrome's service
// worker by importScripts, Firefox's event page from the manifest's `scripts` list); it puts one
// frozen object on the global, `RandSiteKey`, and imports nothing.
//
// ---- the construction (a second implementation reproduces it from this alone) ----
//
//     key = HKDF-SHA-256(IKM  = the wallet's spend key, its 32 bytes (the 64 hex characters the
//                               core writes, decoded),
//                        salt = UTF-8("rand-wallet/site-key/v1"),
//                        info = LP("rand-wallet/site-key/v1") || LP(origin) || LP(purpose) || LP(address),
//                        L    = 32)
//
// where LP(s) is the UTF-8 bytes of s preceded by their length as a 4-byte big-endian integer, so
// no two different (origin, purpose, address) can give the same info. `origin` is the asking page's
// web origin exactly as `URL.origin` writes it (scheme://host, and :port only when it is not the
// scheme's default) — the background takes it from the message's sender, never from the page;
// `purpose` matches PURPOSE_RE; `address` is the wallet's `rand1…` address the site is connected
// with. The key is returned as 64 lowercase hex characters.
//
// ---- why the spend key, and why it is safe ----
//
// The spend key is the wallet's root secret: it is what a backup (the key file) holds and what an
// import restores, so the same wallet gives the same site key on every device, with nothing new to
// back up. It is also the one secret only this wallet holds — the viewing key is not, since a
// prover that makes a proof for this wallet is given it, so it is never an input here. HKDF is
// one-way: the site key reveals nothing about the spend key, and a key for one (origin, purpose,
// address) says nothing about the key for any other. The spend key is never published on chain
// (it is a private witness inside the wallet's own proofs), and the domain string makes this
// derivation's outputs unrelated to anything else ever computed from it.
(function (root) {
  const DOMAIN = 'rand-wallet/site-key/v1';
  const PURPOSE_RE = /^[a-z0-9./-]{1,64}$/;
  const SPEND_KEY_RE = /^[0-9a-fA-F]{64}$/;
  const utf8 = (s) => new TextEncoder().encode(s);

  /** LP(field) for each field, concatenated. */
  function lengthPrefixed(fields) {
    const parts = fields.map(utf8);
    const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
    const view = new DataView(out.buffer);
    let at = 0;
    for (const p of parts) {
      view.setUint32(at, p.length, false);
      out.set(p, at + 4);
      at += 4 + p.length;
    }
    return out;
  }

  /** HKDF's info for these inputs (exported for the test vector). */
  function siteKeyInfo({ origin, purpose, address }) {
    return lengthPrefixed([DOMAIN, origin, purpose, address]);
  }

  /** An http(s) origin in URL.origin's own spelling, and nothing else. */
  function isWebOrigin(origin) {
    if (typeof origin !== 'string' || !origin) return false;
    try {
      const u = new URL(origin);
      return /^https?:$/.test(u.protocol) && u.origin === origin;
    } catch { return false; }
  }

  /** → Promise<64 lowercase hex>. Throws on any input that is not what the wallet would pass. */
  async function deriveSiteKey({ spendKey, origin, purpose, address }) {
    if (typeof spendKey !== 'string' || !SPEND_KEY_RE.test(spendKey)) throw new Error('site key: not a spend key');
    if (!isWebOrigin(origin)) throw new Error('site key: not a web origin');
    if (typeof purpose !== 'string' || !PURPOSE_RE.test(purpose)) throw new Error('site key: bad purpose');
    if (typeof address !== 'string' || !address) throw new Error('site key: no address');
    const ikm = new Uint8Array(32);
    for (let i = 0; i < 32; i++) ikm[i] = parseInt(spendKey.slice(2 * i, 2 * i + 2), 16);
    let bits;
    try {
      const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(DOMAIN), info: siteKeyInfo({ origin, purpose, address }) },
        base, 256);
    } finally {
      ikm.fill(0); // best effort: the copy this function made
    }
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  root.RandSiteKey = Object.freeze({ DOMAIN, PURPOSE_RE, deriveSiteKey, siteKeyInfo });
})(globalThis);
