// lib/address-format.js — the withdraw window shows the destination the way the person typed it.
// Known pairs: the bridge's own coins (lib/withdraw-label.js) in their public forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { destinationText, base58, base58check, sha256 } from '../shared/lib/address-format.js';

const pad = (h) => h.padStart(64, '0');

test('Solana: base58 of the 32 bytes', () => {
  assert.equal(destinationText(5, 'ce010e60afedb22717bd63192f54145a3f965a33bb82d2c7029eb2ce1e208264'), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  assert.equal(destinationText(5, 'c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(destinationText(5, '0'.repeat(62) + '01'), `${'1'.repeat(31)}2`, 'leading zero bytes are 1s');
});

test('Tron: base58check of 0x41 and the 20 bytes', () => {
  assert.equal(destinationText(4, pad('a614f803b6fd780986a42c78ec9c7f77e6ded13c')), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(destinationText(4, `0x${pad('A614F803B6FD780986A42C78EC9C7F77E6DED13C')}`), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'case and 0x do not matter');
});

test('EVM: 0x and the 40 hex; anything else unchanged', () => {
  assert.equal(destinationText(2, pad('dac17f958d2ee523a2206206994597c13d831ec7')), '0xdac17f958d2ee523a2206206994597c13d831ec7');
  assert.equal(destinationText(3, pad('55d398326f99059ff775485246999027b3197955')), '0x55d398326f99059ff775485246999027b3197955');
  assert.equal(destinationText(9, 'ab'.repeat(32)), 'ab'.repeat(32));
  assert.equal(destinationText(5, 'not hex'), 'not hex');
});

test('sha256 and base58 agree with Node and the reference vectors', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 200]) {
    const msg = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(Buffer.from(sha256(msg)).toString('hex'), createHash('sha256').update(msg).digest('hex'), `length ${n}`);
  }
  assert.equal(base58(Uint8Array.from(Buffer.from('Hello World!'))), '2NEpo7TZRRrLZSi2U');
  assert.equal(base58(new Uint8Array([0, 0, 0])), '111');
  // Bitcoin's genesis address: version 0 ‖ hash160.
  assert.equal(base58check(Uint8Array.from(Buffer.from('0062e907b15cbf27d5425399ebf6f0fb50ebb88f18', 'hex'))), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
});
