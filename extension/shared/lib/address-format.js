// A withdraw's destination as the person typed it on the site, so the approval window can show
// it in a form they can compare: the bridge carries every destination as 32 bytes of hex, which
// is how no one writes a Solana or Tron address. Pure, synchronous and dependency-free (it loads
// under plain Node for extension/test/address-format.test.mjs, and nothing remote is fetched).
//
//   Solana (bridge chain 5)   base58 of the 32 bytes — the public key as wallets print it.
//   Tron   (bridge chain 4)   base58check of 0x41 ‖ the 20-byte address — the `T…` form.
//   EVM    (bridge chains 2, 3) `0x` + the 40 hex of the address, lower case (no checksum helper
//                             ships in the extension, and the mixed-case form needs keccak).
//   anything else             the 64 hex characters, unchanged.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const bytesOf = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));

/** Base58 (Bitcoin alphabet) of `bytes`. */
export function base58(bytes) {
  const digits = []; // base 58, least significant first
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '';
  for (const byte of bytes) { if (byte !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

// SHA-256 (FIPS 180-4), synchronous, for base58check's checksum only.
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(msg) {
  const len = msg.length;
  const padded = new Uint8Array((((len + 9) + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) ov.setUint32(i * 4, h[i]);
  return out;
}

/** Base58check: base58 of `payload` ‖ the first four bytes of SHA-256(SHA-256(payload)). */
export function base58check(payload) {
  const sum = sha256(sha256(payload)).slice(0, 4);
  const all = new Uint8Array(payload.length + 4);
  all.set(payload);
  all.set(sum, payload.length);
  return base58(all);
}

export const CHAIN_TRON = 4;
export const CHAIN_SOLANA = 5;
const EVM = [2, 3];

/**
 * The destination `to` (64 lower-case hex, no 0x, as lib/withdraw-flow.js normalises it) for
 * bridge chain `toChain`, in the form that chain's own wallets print.
 */
export function destinationText(toChain, to) {
  const chain = Number(toChain);
  const hex = String(to || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return hex;
  if (chain === CHAIN_SOLANA) return base58(bytesOf(hex));
  if (chain === CHAIN_TRON) return base58check(bytesOf(`41${hex.slice(24)}`));
  if (EVM.includes(chain)) return `0x${hex.slice(24)}`;
  return hex;
}
