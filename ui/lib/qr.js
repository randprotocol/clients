// A small QR Code encoder: byte mode, error-correction level L (the default) or M, versions 1–40,
// all eight masks with the standard penalty scoring. Written for this extension after the
// algorithm of ISO/IEC 18004, with the version tables laid out as in Project Nayuki's QR Code
// generator (MIT), which is the reference this was checked against. A shielded address is ~1.7 KB,
// which fits from version 34 at level L (2 953 bytes at version 40); a `randpay:` link with a full
// address fits one code at level M from about version 33 (spec 2026-09-26 §2.2), which is the
// level the receive screen uses — M survives a scuffed or glared screen that L would not.
//
//   const qr = encodeBytes(new TextEncoder().encode(text));            // level L, as always
//   const qr = encodeBytes(new TextEncoder().encode(link), 1, 'M');    // level M
//   drawQr(canvas, qr, 6);                                             // qr: { size, get(x, y) }

/**
 * ISO/IEC 18004 Table 9, versions 1–40 (index 0 unused): EC codewords per block and number of EC
 * blocks, per level, plus the level's format-info bits (Table 25: L = 01, M = 00).
 *
 * Exported so ui/test/qr.test.mjs can assert every entry literally. The website's level-M port of
 * this file once shipped an M block table missing the duplicate 17 at versions 21 AND 22, which
 * shifted every later version by one — and a behavioural test alone did not see it, because a
 * wrong table still picks *a* version and draws *a* square. Checked for this file on 2026-09-27:
 * the L rows (the only ones it had) match Table 9 entry for entry; the M rows are new here.
 */
export const EC_TABLES = Object.freeze({
  L: Object.freeze({
    formatBits: 1,
    codewordsPerBlock: Object.freeze([-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]),
    numBlocks: Object.freeze([-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]),
  }),
  M: Object.freeze({
    formatBits: 0,
    codewordsPerBlock: Object.freeze([-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]),
    numBlocks: Object.freeze([-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]),
  }),
});

function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    r -= (25 * a - 10) * a - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function numDataCodewords(ver, table) {
  return Math.floor(numRawDataModules(ver) / 8) - table.codewordsPerBlock[ver] * table.numBlocks[ver];
}

// ---- Reed–Solomon over GF(2^8) with the QR polynomial 0x11D ----
function rsMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = rsMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = rsMul(root, 2);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMul(coef, factor); });
  }
  return result;
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

/**
 * `ecLevel` is `'L'` (the default — every caller from before it existed is unchanged) or `'M'`.
 * Anything else is refused rather than quietly encoded at L.
 */
export function encodeBytes(bytes, minVersion = 1, ecLevel = 'L') {
  const table = Object.prototype.hasOwnProperty.call(EC_TABLES, ecLevel) ? EC_TABLES[ecLevel] : null;
  if (!table) throw new Error(`unsupported QR error-correction level ${String(ecLevel)}: use L or M`);
  // Smallest version whose data capacity holds the byte-mode segment.
  let ver = minVersion;
  for (;; ver++) {
    if (ver > 40) throw new Error('data too long for a QR code');
    const cap = numDataCodewords(ver, table) * 8;
    const header = 4 + (ver <= 9 ? 8 : 16);
    if (header + bytes.length * 8 <= cap) break;
  }
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = numDataCodewords(ver, table) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // Split into blocks, append ECC, interleave.
  const numBlocks = table.numBlocks[ver];
  const blockEcc = table.codewordsPerBlock[ver];
  const rawCw = Math.floor(numRawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const blocks = [];
  const divisor = rsDivisor(blockEcc);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - blockEcc + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // placeholder so every block has the same length
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - blockEcc || j >= numShort) result.push(block[i]);
    });
  }

  // Draw.
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignmentPositions(ver);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => {
    const d = (table.formatBits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((b >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, bit); set(c, a, bit);
    }
  }
  // Data placement: zigzag from the bottom right, skipping column 6.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < result.length * 8) {
          modules[y][x] = ((result[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  // Masking: apply each, score, keep the best.
  const maskFn = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x];
  };
  const penalty = () => {
    let p = 0;
    const runPenalty = (hist) => { const n = hist[1]; const core = n > 0 && n % 3 === 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n; return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0); };
    const line = (get) => {
      let runColor = false, runX = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      const add = (len) => { hist.shift(); hist.push(len); };
      for (let i = 0; i < size; i++) {
        if (get(i) === runColor) { runX++; if (runX === 5) p += 3; else if (runX > 5) p++; }
        else { add(runX); if (!runColor) p += runPenalty(hist) * 40; runColor = get(i); runX = 1; }
      }
      add(runX); if (runColor) { add(0); }
      p += runPenalty(hist) * 40;
    };
    for (let y = 0; y < size; y++) line((x) => modules[y][x]);
    for (let x = 0; x < size; x++) line((y) => modules[y][x]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return p + k * 10;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const s = penalty();
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return { size, version: ver, mask: best, ecLevel, get: (x, y) => modules[y][x] };
}

/** Paint a code onto a canvas with a quiet zone of 4 modules. */
export function drawQr(canvas, qr, scale = 4) {
  const quiet = 4;
  const px = (qr.size + quiet * 2) * scale;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
}
