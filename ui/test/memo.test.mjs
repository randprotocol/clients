// A memo is the sender's text, shown to the payee and, from a randpay: link, to the payer on the
// confirmation before a send. Final whole-branch review, finding 3: it must never be able to draw
// a second recipient line, and bidi or other control characters must not reorder or hide what is
// around them. `displayMemo` is what every memo on screen goes through; the confirmation line
// carries no memo text at all, and the memo is its own line below it.
//
// Code points are written as numbers (`cp(0x202E)`), never as escapes in the source, so what a
// test feeds in is unambiguous whatever an editor does with invisible characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { displayMemo } from '../lib/memo.js';
import { confirmationLine, memoLine } from '../screens/send/state.js';

const cp = (...points) => String.fromCodePoint(...points);
const R = cp(0xFFFD);
const FAKE = `${cp(10, 10)}to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1000 RAND`;

test('displayMemo replaces C0 and C1 controls with U+FFFD and keeps ordinary single spaces', () => {
  assert.equal(displayMemo(`rent${cp(10)}march`), `rent${R}march`);
  assert.equal(displayMemo(`a${cp(13, 9)}b${cp(0)}c${cp(0x7F)}d${cp(0x85)}e${cp(0x9F)}f`), `a${R}${R}b${R}c${R}d${R}e${R}f`);
  const ordinary = `one space, ${cp(0xE9)} and ${cp(0x1F600)}`;
  assert.equal(displayMemo(ordinary), ordinary);
});

test('displayMemo neutralises every bidi control and the line/paragraph separators', () => {
  const points = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C, 0x2028, 0x2029];
  assert.equal(displayMemo(`x${cp(...points)}y`), `x${R.repeat(points.length)}y`);
});

test('displayMemo of nothing is empty', () => {
  assert.equal(displayMemo(''), '');
  assert.equal(displayMemo(null), '');
  assert.equal(displayMemo(undefined), '');
});

test('the confirmation line names the recipient only — no memo text can reach it', () => {
  const line = confirmationLine({ name: null, fingerprint: 'BBBB-BBBB-BBBB-BBBB', amount: '1', symbol: 'RAND', memo: FAKE });
  assert.equal(line, 'to fingerprint BBBB-BBBB-BBBB-BBBB · 1 RAND');
  assert.equal(confirmationLine({ name: 'bob', fingerprint: 'BBBB-BBBB-BBBB-BBBB', amount: '1', symbol: 'RAND' }),
    'to bob · fingerprint BBBB-BBBB-BBBB-BBBB · 1 RAND');
});

test('the memo line is its own line, one line, whatever the memo holds', () => {
  const line = memoLine(FAKE);
  assert.equal(line, `memo "${R}${R}to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1000 RAND"`);
  for (const lb of [10, 13, 0x2028, 0x2029]) assert.ok(!line.includes(cp(lb)), `no line break ${lb}`);
  assert.ok(line.startsWith('memo "'), 'it can only ever read as a memo');
  assert.equal(memoLine(''), 'memo ""');
  assert.equal(memoLine(`${cp(0x202E)}evil`), `memo "${R}evil"`);
});

// ---- Final review 2, item A: one display rule, applied before any truncation, on every surface.
// Memos are live on chains 14 and 15 (the ledger accepts a 1860-byte envelope anywhere under the
// 2048 cap), so anyone can pay a dust note carrying any memo to any public address.
const TAIL = 'to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND';
export const HOSTILE = [
  `x${cp(0x3000).repeat(120)}${TAIL}`,
  `x${' '.repeat(400)}${TAIL}`,
  `x${cp(0x2003).repeat(60)}${TAIL}`,
  `${cp(13, 0x1B)}[2K${TAIL}`,
  `${cp(10, 10)}to alice${cp(0x2028)}${TAIL}${cp(0x2029)}`,
  `${cp(0x202E)}DNAR 1${cp(0x202C)} ${cp(0x2066)}${TAIL}${cp(0x2069, 0x200E, 0x200F, 0x061C)}`,
  `a${cp(0x200B, 0x200C, 0x200D)}b${cp(0x2060, 0x2061, 0x2062, 0x2063, 0x2064)}c${cp(0xFEFF)}d${cp(0xAD)}e`,
  `${cp(9)}${TAIL}${cp(0x7F, 0x85, 0x9B)}31m`,
];

/** No line break, no control/format/separator character, no space but U+0020, no run of two. */
export function assertDisplayable(shown, from) {
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(shown), `a control or format character in ${JSON.stringify(shown)} (from ${JSON.stringify(from)})`);
  assert.ok(!/[^\P{Zs} ]/u.test(shown), `a non-ASCII space in ${JSON.stringify(shown)}`);
  assert.ok(!/ {2}/.test(shown), `a run of spaces in ${JSON.stringify(shown)}`);
}

test('displayMemo: a hostile memo is one line, hides nothing and cannot pad itself out', () => {
  for (const m of HOSTILE) assertDisplayable(displayMemo(m), m);
  assert.equal(displayMemo(`x${cp(0x3000).repeat(120)}to alice`), 'x to alice');
  assert.equal(displayMemo(`x${' '.repeat(400)}to alice`), 'x to alice');
  assert.equal(displayMemo(`${cp(13, 0x1B)}[2Kto alice`), `${R}${R}[2Kto alice`);
  assert.equal(displayMemo(`a${cp(0x200B)}b${cp(0xFEFF)}c${cp(0xAD)}d`), `a${R}b${R}c${R}d`);
  assert.equal(displayMemo(`two  spaces, ${cp(0xE9)} and ${cp(0x1F600)}`), `two spaces, ${cp(0xE9)} and ${cp(0x1F600)}`);
});

test('the memo line and the confirmation line stay one line whatever the memo or contact name holds', () => {
  for (const m of HOSTILE) {
    const line = memoLine(m);
    assertDisplayable(line, m);
    const conf = confirmationLine({ name: m, fingerprint: 'BBBB-BBBB-BBBB-BBBB', amount: '1', symbol: 'RAND' });
    assertDisplayable(conf, m);
  }
});

test('every memo view is one line that never wraps: the memo-line class is nowrap + ellipsis', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../components.css', import.meta.url), 'utf8');
  const rule = (sel) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `a ${sel} rule`);
    return m[2];
  };
  const line = rule('.memo-line');
  assert.match(line, /white-space:\s*nowrap/);
  assert.match(line, /overflow:\s*hidden/);
  assert.match(line, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(rule('.memo'), /pre-wrap/, 'no memo view wraps its lines');
});

// Fullnode issue #64: `rand_getLimits.envelope_bytes` is the node's word. On a chain whose genesis
// sets no envelope size (14–17) the ledger admits any envelope up to 2 048 bytes, so a node
// answering 1860 there would have a wallet seal a 1 860-byte envelope among everyone else's
// 1 348 — a permanent public tag on its transactions. The memo field is never offered on those
// chains, whatever the node says; the core refuses the memo and seals legacy there regardless.
test('memoSupportedFor never believes a memo claim on a chain pinned as pre-memo (#64)', async () => {
  const { memoSupportedFor, LEGACY_ENVELOPE_CHAIN_IDS } = await import('../lib/memo.js');
  assert.deepEqual(LEGACY_ENVELOPE_CHAIN_IDS, [14, 15, 16, 17]);
  for (const chain of LEGACY_ENVELOPE_CHAIN_IDS) {
    assert.equal(memoSupportedFor(1860, chain), false, `chain ${chain}`);
    assert.equal(memoSupportedFor(null, chain), false, `chain ${chain}`);
  }
  // Chain 18 is cut with envelope_bytes 1860: the claim stands there, and on any later chain.
  assert.equal(memoSupportedFor(1860, 18), true);
  assert.equal(memoSupportedFor(1860, 19), true);
  assert.equal(memoSupportedFor(null, 18), false);
  assert.equal(memoSupportedFor(1024, 18), false);
  // Without a chain id the size rule alone decides, as before.
  assert.equal(memoSupportedFor(1860), true);
  assert.equal(memoSupportedFor(1861), false);
});
