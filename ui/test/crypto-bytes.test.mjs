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

// MSC-1: a record is capped on both sides, or what one build saves another cannot open.
test('a record is capped on write as on read, and a wider cap is honoured by both', async () => {
  const big = 'p'.repeat(10_000);
  await assert.rejects(encryptSecret('pw-long-enough', big), (e) => e.code === 'RECORD_TOO_LARGE');
  const rec = await encryptSecret('pw-long-enough', big, { maxBytes: 256 << 10 });
  assert.equal(await decryptSecret('pw-long-enough', rec, { maxBytes: 256 << 10 }), big);
  await assert.rejects(decryptSecret('pw-long-enough', rec), (e) => e.name === 'VaultDamagedError' && e.reason === 'oversize');
  await assert.rejects(decryptSecret('pw-long-enough', { ...rec, ct: 'AAAA' }, { maxBytes: 256 << 10 }), (e) => e.name === 'VaultDamagedError' && e.reason === 'structure');
  const bytes = await encryptBytes('pw-long-enough', new Uint8Array(5000), { maxBytes: 8192 });
  assert.equal((await decryptBytes('pw-long-enough', bytes, { maxBytes: 8192 })).length, 5000);
  await assert.rejects(encryptBytes('pw-long-enough', new Uint8Array(5000)), (e) => e.code === 'RECORD_TOO_LARGE');
});
