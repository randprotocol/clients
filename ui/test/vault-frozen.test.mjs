// A vault record written by the pre-Task-5 ui/engine/crypto.js (commit 395707d), frozen as a
// fixture: the refactored decryptSecret/decryptBytes must still open every record already on disk.
// The fixture was made by running `git show 395707d:ui/engine/crypto.js` under node; never regenerate it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decryptSecret, decryptBytes } from '../engine/crypto.js';

const vector = JSON.parse(readFileSync(new URL('./fixtures/vault-pre-task5.json', import.meta.url), 'utf8'));

test('a pre-refactor vault record opens through decryptSecret to the exact plaintext', async () => {
  assert.equal(await decryptSecret(vector.password, vector.record), vector.plaintext);
});

test('a pre-refactor vault record opens through decryptBytes to the plaintext\'s exact bytes', async () => {
  assert.deepEqual(await decryptBytes(vector.password, vector.record), new TextEncoder().encode(vector.plaintext));
});

test('the frozen record still refuses the wrong password', async () => {
  await assert.rejects(decryptSecret(`${vector.password}x`, vector.record), /wrong password/);
});
