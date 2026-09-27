// An independent decoder for a code produced by `ui/lib/qr.js`'s `encodeBytes`, following the
// standard QR algorithm (ISO/IEC 18004) on its own: read format info -> unmask -> walk the same
// zigzag order -> de-interleave blocks -> a Reed-Solomon syndrome check per block (detection only,
// no correction — a clean encode should have zero syndromes) -> parse the byte-mode segment.
//
// Copied from the website's `tests/qr-decode.mjs` (randprotocol/website, feat/address-sharing @
// 4b8e276), where it caught an off-by-one in a ported level-M block table. Two changes for this
// repository: it reads the `{size, get(x, y)}` object `encodeBytes` returns as well as a plain
// matrix, and it carries BOTH levels' tables (L and M), choosing by the level stamped in the
// code's own format information — so a code whose format bits say one level while its blocks are
// laid out for the other fails the Reed-Solomon check rather than decoding by luck.
//
// Deliberately does NOT import qr.js's tables — it carries its own copy of ISO/IEC 18004 Table 9,
// typed independently, matching qr.test.mjs's literal tables. That independence is the point: an
// encoder table error lays data out by the wrong count while this de-interleaves by the right one,
// so the syndromes come out non-zero and the round trip fails.
const TABLES = {
  // format-info level field: L = 01, M = 00 (ISO/IEC 18004 Table 25)
  1: {
    perBlock: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    blocks: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  },
  0: {
    perBlock: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    blocks: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  },
};

function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    r -= (25 * a - 10) * a - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < num; pos -= step) result.splice(1, 0, pos);
  return result;
}

// GF(256) with the QR polynomial 0x11D, log/antilog tables for the Reed-Solomon syndrome check.
function rsMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
const EXP = new Array(512);
const LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = rsMul(x, 2); }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** `block` is one block's data codewords followed by its `eccLen` ECC codewords, highest-degree
 * coefficient first. `true` iff every syndrome (the block's polynomial evaluated at
 * alpha^0..alpha^(eccLen-1), by Horner's method) is zero, i.e. the block decodes with no errors —
 * expected always here, since this reads a code straight out of `encodeBytes`, never a
 * photographed one that could have picked up noise. */
function rsSyndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (const c of block) s = gfMul(s, EXP[i]) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

/**
 * Decode a code `encodeBytes()` produced (or a plain 0/1 matrix): `{version, level, mask, rsOk, mode, len, text}`. `level`
 * and `mask` are read from the format info actually stamped on the matrix (not assumed); `rsOk`
 * is the Reed-Solomon syndrome check per block; `text` is the decoded byte-mode payload (UTF-8).
 */
export function decodeQr(code) {
  const m = Array.isArray(code)
    ? code
    : Array.from({ length: code.size }, (_, y) => Array.from({ length: code.size }, (_, x) => code.get(x, y)));
  const size = m.length;
  const ver = (size - 17) / 4;
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { isFn[y][x] = true; };
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) mark(x, y);
    }
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const ap = alignmentPositions(ver);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ap[i] + dx, ap[j] + dy);
  }
  for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(size - 11 + j, i); mark(i, size - 11 + j); }
  }

  // Format info: two 15-bit copies around the top-left finder pattern; read the first copy.
  const bit = (x, y) => (m[y][x] ? 1 : 0);
  const bits = [];
  for (let i = 0; i <= 5; i++) bits[i] = bit(8, i);
  bits[6] = bit(8, 7); bits[7] = bit(8, 8); bits[8] = bit(7, 8);
  for (let i = 9; i < 15; i++) bits[i] = bit(14 - i, 8);
  let b = 0;
  for (let i = 0; i < 15; i++) b |= bits[i] << i;
  const unmasked = b ^ 0x5412;
  const data = unmasked >>> 10;
  const level = data >> 3;
  const mask = data & 7;

  const maskFn = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ][mask];

  // Read codeword bits in the same zigzag order the encoder writes them in.
  const bitsOut = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x]) bitsOut.push((m[y][x] ? 1 : 0) ^ (maskFn(x, y) ? 1 : 0));
      }
    }
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bitsOut.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bitsOut[i + k];
    codewords.push(v);
  }

  const table = TABLES[level];
  if (!table) return { version: ver, level, mask, rsOk: false, mode: -1, len: 0, text: '' };
  const numBlocks = table.blocks[ver];
  const blockEcc = table.perBlock[ver];
  const rawCw = Math.floor(numRawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const dataLens = [];
  for (let i = 0; i < numBlocks; i++) dataLens.push(shortLen - blockEcc + (i < numShort ? 0 : 1));
  const maxData = Math.max(...dataLens);

  // De-interleave: data codewords column by column across blocks, then the ECC codewords.
  const blockData = dataLens.map(() => []);
  let idx = 0;
  for (let i = 0; i < maxData; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < dataLens[j]) { blockData[j].push(codewords[idx]); idx++; }
    }
  }
  const blockEccArr = dataLens.map(() => []);
  for (let i = 0; i < blockEcc; i++) for (let j = 0; j < numBlocks; j++) { blockEccArr[j].push(codewords[idx]); idx++; }

  let allOk = true;
  const dataOut = [];
  for (let j = 0; j < numBlocks; j++) {
    if (!rsSyndromesZero(blockData[j].concat(blockEccArr[j]), blockEcc)) allOk = false;
    dataOut.push(...blockData[j]);
  }

  // Byte-mode segment: 4-bit mode, an 8- or 16-bit length (the same version-10 cutover the
  // encoder uses), then that many bytes.
  let bitPos = 0;
  const dataBits = [];
  for (const cw of dataOut) for (let k = 7; k >= 0; k--) dataBits.push((cw >> k) & 1);
  const readN = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dataBits[bitPos++]; return v; };
  const mode = readN(4);
  const len = readN(ver <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(readN(8));

  return { version: ver, level, mask, rsOk: allOk, mode, len, text: Buffer.from(bytes).toString('utf8') };
}
