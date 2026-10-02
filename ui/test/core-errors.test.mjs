// ui/engine/core-errors.js: the wallet core's English sentences put into the user's language at
// the one place a core rejection becomes the engine's Error (coreApi in ui/engine/wallet.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../i18n.js';
import { translateCoreError, translatedCoreError } from '../engine/core-errors.js';
import { coreApi } from '../engine/wallet.js';

/** A dictionary for just the keys these tests ask for, in a recognisable shape. */
const DICT = {
  'amount must be greater than zero': 'DE: Betrag muss größer als null sein',
  'insufficient balance: have {have}, need {need}': 'DE: zu wenig Guthaben: {have} vorhanden, {need} nötig',
  '{units} units of asset {asset}': 'DE: {units} Einheiten von Asset {asset}',
  'the RAND fee: {reason}': 'DE: die RAND-Gebühr: {reason}',
  'too many decimal places (max {n})': 'DE: zu viele Nachkommastellen (höchstens {n})',
  'shielded address must start with rand1': 'DE: eine geschützte Adresse beginnt mit rand1',
  'recipient: {reason}': 'DE: Empfänger: {reason}',
};

async function inGerman(t) {
  await setLocale('de', { dictionary: DICT });
  t.after(() => setLocale('en'));
}

test('in English every message comes back byte for byte', () => {
  for (const m of [
    'amount must be greater than zero',
    'insufficient balance: have 1.5 RAND, need 2 RAND',
    'the RAND fee: insufficient balance: have 0.001 RAND, need 0.01 RAND',
    'something the table does not know',
  ]) assert.equal(translateCoreError(m), m);
});

test('an exact sentence is looked up whole', async (t) => {
  await inGerman(t);
  assert.equal(translateCoreError('amount must be greater than zero'), 'DE: Betrag muss größer als null sein');
  assert.equal(translateCoreError('shielded address must start with rand1'), 'DE: eine geschützte Adresse beginnt mit rand1');
});

test('a patterned sentence keeps its values in the holes', async (t) => {
  await inGerman(t);
  assert.equal(translateCoreError('too many decimal places (max 9)'), 'DE: zu viele Nachkommastellen (höchstens 9)');
  assert.equal(
    translateCoreError('insufficient balance: have 1.5 RAND, need 2 RAND'),
    'DE: zu wenig Guthaben: 1.5 RAND vorhanden, 2 RAND nötig',
  );
  // An amount the core wrote as units of an asset is itself translated inside the outer sentence.
  assert.equal(
    translateCoreError('insufficient balance: have 3 units of asset 2, need 5 units of asset 2'),
    'DE: zu wenig Guthaben: DE: 3 Einheiten von Asset 2 vorhanden, DE: 5 Einheiten von Asset 2 nötig',
  );
});

test('a composed sentence translates its inner part too', async (t) => {
  await inGerman(t);
  assert.equal(
    translateCoreError('the RAND fee: insufficient balance: have 0.001 RAND, need 0.01 RAND'),
    'DE: die RAND-Gebühr: DE: zu wenig Guthaben: 0.001 RAND vorhanden, 0.01 RAND nötig',
  );
  assert.equal(
    translateCoreError('recipient: shielded address must start with rand1'),
    'DE: Empfänger: DE: eine geschützte Adresse beginnt mit rand1',
  );
});

test('anything unmatched passes through unchanged', async (t) => {
  await inGerman(t);
  assert.equal(translateCoreError('missing parameter spend_key'), 'missing parameter spend_key');
  assert.equal(translateCoreError('a throwaway key for every dummy (wallet bug)'), 'a throwaway key for every dummy (wallet bug)');
  assert.equal(translateCoreError(''), '');
  assert.equal(translateCoreError(undefined), undefined);
  assert.equal(translateCoreError(42), 42);
});

test('translatedCoreError keeps the Error object and its fields; a bare string becomes an Error', async (t) => {
  await inGerman(t);
  const err = Object.assign(new Error('amount must be greater than zero'), { code: 'X' });
  const out = translatedCoreError(err);
  assert.equal(out, err);
  assert.equal(out.message, 'DE: Betrag muss größer als null sein');
  assert.equal(out.code, 'X');
  const fromString = translatedCoreError('amount must be greater than zero');
  assert.ok(fromString instanceof Error);
  assert.equal(fromString.message, 'DE: Betrag muss größer als null sein');
  const other = { weird: true };
  assert.equal(translatedCoreError(other), other);
});

test('coreApi rejects with the translated message', async (t) => {
  await inGerman(t);
  const core = { call: async () => { throw new Error('too many decimal places (max 9)'); } };
  await assert.rejects(coreApi(core).call('parse_amount', { text: '1.0000000001', decimals: 9 }),
    { message: 'DE: zu viele Nachkommastellen (höchstens 9)' });
});
