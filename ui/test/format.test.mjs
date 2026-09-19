import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, parseUnits, shortAddress } from '../lib/format.js';
import { h, raw } from '../lib/dom.js';

test('formatUnits honours decimals', () => {
  assert.equal(formatUnits('1500000000'), '1.5');
  assert.equal(formatUnits('1500000', 9, 6), '1.5');   // (units, maxFrac, decimals)
});
test('parseUnits round-trips', () => assert.equal(parseUnits('0.25').toString(), '250000000'));
test('h escapes, raw does not', () => {
  assert.equal(h`<p>${'<b>'}</p>`, '<p>&lt;b&gt;</p>');
  assert.equal(h`<p>${raw('<b>x</b>')}</p>`, '<p><b>x</b></p>');
});

// --- additional coverage ---

test('shortAddress still works unchanged', () => {
  assert.equal(shortAddress('rand1' + 'q'.repeat(40)), shortAddress('rand1' + 'q'.repeat(40), 12, 6));
});

test('formatUnits with custom decimals=6 and default maxFrac', () => {
  assert.equal(formatUnits('1500000', 9, 6), '1.5');
  assert.equal(formatUnits('1000000', 9, 6), '1');
});

test('parseUnits with custom decimals', () => {
  assert.equal(parseUnits('0.25', 6).toString(), '250000');
  assert.equal(parseUnits('1', 6).toString(), '1000000');
});

test('parseUnits rejects more fractional digits than decimals', () => {
  assert.throws(() => parseUnits('0.1234567890'), /at most 9 decimal places/);
  assert.throws(() => parseUnits('0.1234567', 6), /at most 6 decimal places/);
  // exactly at the limit is fine
  assert.doesNotThrow(() => parseUnits('0.123456', 6));
});

test('h: null/undefined/false interpolate as empty string', () => {
  assert.equal(h`<p>${null}${undefined}${false}</p>`, '<p></p>');
});

test('h: array of raw()/strings is joined, non-raw items escaped individually', () => {
  const items = ['<a>', raw('<b>'), '<c>'];
  assert.equal(h`<ul>${items}</ul>`, '<ul>&lt;a&gt;<b>&lt;c&gt;</ul>');
});

test('h: array of plain strings is escaped item by item and joined', () => {
  assert.equal(h`<ul>${['<x>', '<y>']}</ul>`, '<ul>&lt;x&gt;&lt;y&gt;</ul>');
});
