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

test('displayMemo replaces C0 and C1 controls with U+FFFD and keeps ordinary spaces', () => {
  assert.equal(displayMemo(`rent${cp(10)}march`), `rent${R}march`);
  assert.equal(displayMemo(`a${cp(13, 9)}b${cp(0)}c${cp(0x7F)}d${cp(0x85)}e${cp(0x9F)}f`), `a${R}${R}b${R}c${R}d${R}e${R}f`);
  const ordinary = `two  spaces, ${cp(0xE9)} and ${cp(0x1F600)}`;
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
