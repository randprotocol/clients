import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBytes, decryptBytes, encryptSecret, decryptSecret } from '../engine/crypto.js';

test('a byte record opens to the same bytes, and only with its password', async () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const rec = await encryptBytes('pw-long-enough', seed);
  assert.deepEqual(await decryptBytes('pw-long-enough', rec), seed);
  await assert.rejects(decryptBytes('another-password', rec), /wrong password/);
  assert.equal(await decryptSecret('pw-long-enough', await encryptSecret('pw-long-enough', 'text')), 'text', 'string records unchanged');
});
