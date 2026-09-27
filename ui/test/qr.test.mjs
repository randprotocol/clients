// ui/lib/qr.js — the level tables, the `ecLevel` parameter, and a decode round trip.
//
// The website's port of this encoder (to level M) shipped with an off-by-one in its level-M block
// table from version 22 on (ISO/IEC 18004 Table 9 repeats 17 blocks at versions 21 AND 22). A
// behavioural test alone missed it there — a wrong table still picks *a* version and draws *a*
// square — so the tables are asserted literally here, and every level is decoded back by an
// independent decoder (./qr-decode.mjs) that de-interleaves by its own copy of the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes, EC_TABLES } from '../lib/qr.js';
import { decodeQr } from './qr-decode.mjs';

// ISO/IEC 18004 Table 9, versions 1–40 (index 0 unused): "EC codewords per block" and "number of
// EC blocks", typed here independently of qr.js (the same values as Project Nayuki's qrcodegen,
// which qr.js cites as its reference).
const ISO_L_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const ISO_L_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
const ISO_M_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const ISO_M_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

const bytes = (text) => new TextEncoder().encode(text);
// About what a `randpay:` link with a full address and a memo weighs (spec 2026-09-26 §2.2).
const LINK = `randpay:rand1${'x'.repeat(1690)}?memo=${'m'.repeat(20)}`;

test('the level-L tables match ISO/IEC 18004 Table 9 at every version', () => {
  assert.deepEqual(EC_TABLES.L.codewordsPerBlock, ISO_L_PER_BLOCK);
  assert.deepEqual(EC_TABLES.L.numBlocks, ISO_L_BLOCKS);
});

test('the level-M tables match ISO/IEC 18004 Table 9 at every version, the 21/22 duplicate 17 included', () => {
  assert.deepEqual(EC_TABLES.M.codewordsPerBlock, ISO_M_PER_BLOCK);
  assert.deepEqual(EC_TABLES.M.numBlocks, ISO_M_BLOCKS);
  assert.equal(EC_TABLES.M.numBlocks[21], 17);
  assert.equal(EC_TABLES.M.numBlocks[22], 17, 'a table missing the duplicate shifts every later version by one');
});

test('encodeBytes still encodes at level L by default, so existing callers are unchanged', () => {
  const r = decodeQr(encodeBytes(bytes('hello')));
  assert.equal(r.level, 1, 'format bits say L');
  assert.equal(r.rsOk, true);
  assert.equal(r.text, 'hello');
});

test('an ecLevel of M is stamped in the format bits and laid out by the level-M blocks', () => {
  const code = encodeBytes(bytes('hello'), 1, 'M');
  const r = decodeQr(code);
  assert.equal(r.level, 0, 'format bits say M');
  assert.equal(r.rsOk, true);
  assert.equal(r.text, 'hello');
});

test('an unknown ecLevel is refused, not silently read as L', () => {
  assert.throws(() => encodeBytes(bytes('x'), 1, 'Q'), /error-correction level/);
});

test('a full randpay: link round-trips at level M (a version past 22, where the website table broke)', () => {
  const r = decodeQr(encodeBytes(bytes(LINK), 1, 'M'));
  assert.ok(r.version > 22 && r.version <= 40, `version ${r.version}`);
  assert.equal(r.level, 0);
  assert.equal(r.rsOk, true, "every block's Reed-Solomon syndromes are zero");
  assert.equal(r.mode, 4, 'byte mode');
  assert.equal(r.text, LINK);
});

test('every version round-trips at both levels', () => {
  // One payload per version: the largest that still fits it, so each version's own block layout
  // (short and long blocks, the 8/16-bit length cutover at 10) is the one exercised.
  for (const level of ['L', 'M']) {
    const t = EC_TABLES[level];
    for (let ver = 1; ver <= 40; ver += 1) {
      let raw = (16 * ver + 128) * ver + 64;
      if (ver >= 2) { const a = Math.floor(ver / 7) + 2; raw -= (25 * a - 10) * a - 55; if (ver >= 7) raw -= 36; }
      const dataCw = Math.floor(raw / 8) - t.codewordsPerBlock[ver] * t.numBlocks[ver];
      const n = Math.floor((dataCw * 8 - 4 - (ver <= 9 ? 8 : 16)) / 8);
      const text = 'a'.repeat(n);
      const code = encodeBytes(bytes(text), 1, level);
      const r = decodeQr(code);
      assert.equal(r.version, ver, `${level} v${ver}: version`);
      assert.equal(r.rsOk, true, `${level} v${ver}: Reed-Solomon`);
      assert.equal(r.text, text, `${level} v${ver}: text`);
    }
  }
});
