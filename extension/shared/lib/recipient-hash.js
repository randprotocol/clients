// The bridge's recipient hash, computed here so the wallet can vouch for it independently of the
// bridge's status service (randbridge.org/status/src/address.rs `recipient_hash`):
//
//     blake3("rand-shielded-recipient" || raw)      raw = base58(address without "rand1"), 1216 bytes
//
// The bridge page asks the wallet for this and compares it with what the service registered; a
// service that mapped the address to some other hash is caught before any money moves. Pure and
// dependency-free on purpose — a store reviewer reads it, and extension/test/recipient-hash.test.mjs
// pins it to the bridge's own fixture. BLAKE3 is written out in full (chunks, the parent tree, the
// root flag) rather than special-cased to this input length, so a longer address form would still
// hash correctly.
const PREFIX = 'rand1';
const RAW_LEN = 1216;
const DOMAIN = new TextEncoder().encode('rand-shielded-recipient');

// ---- base58 (the Bitcoin alphabet, as bs58 in the bridge and the core) ----
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(text) {
  const bytes = [];
  for (const c of text) {
    const digit = INDEX.get(c);
    if (digit === undefined) throw new Error('not base58');
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const c of text) { if (c === '1') zeros++; else break; }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---- BLAKE3 (RFC-less; the reference implementation's structure) ----
const IV = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1, CHUNK_END = 2, PARENT = 4, ROOT = 8;
const BLOCK = 64, CHUNK = 1024;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
function g(s, a, b, c, d, mx, my) {
  s[a] = (s[a] + s[b] + mx) >>> 0; s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;      s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0; s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;      s[b] = rotr(s[b] ^ s[c], 7);
}
function compress(cv, block, counter, blockLen, flags) {
  const s = [...cv, IV[0], IV[1], IV[2], IV[3], counter >>> 0, Math.floor(counter / 0x100000000) >>> 0, blockLen, flags];
  let m = block;
  for (let r = 0; r < 7; r++) {
    g(s, 0, 4, 8, 12, m[0], m[1]); g(s, 1, 5, 9, 13, m[2], m[3]); g(s, 2, 6, 10, 14, m[4], m[5]); g(s, 3, 7, 11, 15, m[6], m[7]);
    g(s, 0, 5, 10, 15, m[8], m[9]); g(s, 1, 6, 11, 12, m[10], m[11]); g(s, 2, 7, 8, 13, m[12], m[13]); g(s, 3, 4, 9, 14, m[14], m[15]);
    if (r < 6) m = PERMUTATION.map((i) => m[i]);
  }
  for (let i = 0; i < 8; i++) { s[i] = (s[i] ^ s[i + 8]) >>> 0; s[i + 8] = (s[i + 8] ^ cv[i]) >>> 0; }
  return s;
}
function words(bytes, at, len) {
  const w = new Array(16).fill(0);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[at + i] << (8 * (i & 3));
  return w.map((x) => x >>> 0);
}
/** A chunk's output: its chaining value, or — with `root` — the 32-byte hash. */
function chunkOutput(bytes, at, len, index, root) {
  let cv = IV;
  const blocks = Math.max(1, Math.ceil(len / BLOCK));
  for (let b = 0; b < blocks; b++) {
    const off = b * BLOCK, blen = Math.min(BLOCK, len - off);
    let flags = 0;
    if (b === 0) flags |= CHUNK_START;
    if (b === blocks - 1) { flags |= CHUNK_END; if (root) flags |= ROOT; }
    cv = compress(cv, words(bytes, at + off, blen), index, blen, flags).slice(0, 8);
  }
  return cv;
}
function parentOutput(left, right, root) {
  return compress(IV, [...left, ...right], 0, BLOCK, PARENT | (root ? ROOT : 0)).slice(0, 8);
}
/** Hash the chunks [from, to) of `bytes`; the top call is the root. */
function subtree(bytes, from, to, root) {
  const chunks = to - from;
  if (chunks === 1) {
    const at = from * CHUNK;
    return chunkOutput(bytes, at, Math.min(CHUNK, bytes.length - at), from, root);
  }
  let left = 1;
  while (left * 2 < chunks) left *= 2;
  return parentOutput(subtree(bytes, from, from + left, false), subtree(bytes, from + left, to, false), root);
}
export function blake3(bytes) {
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const out = subtree(bytes, 0, chunks, true);
  const hash = new Uint8Array(32);
  out.forEach((w, i) => { for (let j = 0; j < 4; j++) hash[i * 4 + j] = (w >>> (8 * j)) & 0xff; });
  return hash;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The recipient hash of a full shielded address, as lowercase hex; throws on any other input. */
export function recipientHash(address) {
  const text = String(address ?? '').trim();
  if (!text.startsWith(PREFIX)) throw new Error('a Rand address starts with rand1');
  const raw = base58Decode(text.slice(PREFIX.length));
  if (raw.length !== RAW_LEN) throw new Error(`address decodes to ${raw.length} bytes, expected ${RAW_LEN}`);
  const input = new Uint8Array(DOMAIN.length + raw.length);
  input.set(DOMAIN, 0);
  input.set(raw, DOMAIN.length);
  return hex(blake3(input));
}
