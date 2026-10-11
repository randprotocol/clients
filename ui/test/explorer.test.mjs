import test from 'node:test';
import assert from 'node:assert/strict';
import { explorerLink, TX_HASH_RE } from '../lib/explorer.js';

const HASH = 'ab'.repeat(32);

test('TX_HASH_RE takes 32 hex bytes with an optional 0x and nothing else', () => {
  assert.ok(TX_HASH_RE.test(HASH));
  assert.ok(TX_HASH_RE.test(`0x${HASH.toUpperCase()}`));
  for (const bad of ['', HASH.slice(2), `${HASH}00`, `0x0x${HASH}`, `${HASH.slice(2)}zz`, ` ${HASH}`, `${HASH}\n/..`]) {
    assert.ok(!TX_HASH_RE.test(bad), JSON.stringify(bad));
  }
});

test('a randscan link drops the 0x and is labelled for randscan', () => {
  const l = explorerLink('https://randscan.org', `0x${HASH}`);
  assert.deepEqual(l, { url: `https://randscan.org/transactions/${HASH}`, label: 'Open in randscan' });
  assert.equal(explorerLink('https://testnet.randscan.org/', HASH).url, `https://testnet.randscan.org/transactions/${HASH}`);
  assert.equal(explorerLink('https://testnet.randscan.org/', HASH).label, 'Open in randscan');
});

test('another https explorer keeps its path and gets the generic label', () => {
  const l = explorerLink('https://scan.example.com/rand', HASH);
  assert.deepEqual(l, { url: `https://scan.example.com/rand/transactions/${HASH}`, label: 'Open in explorer' });
  // a host that merely ends in the same letters is not randscan
  assert.equal(explorerLink('https://notrandscan.org', HASH).label, 'Open in explorer');
});

test('plain http is only for a local explorer', () => {
  assert.equal(explorerLink('http://localhost:3000', HASH).url, `http://localhost:3000/transactions/${HASH}`);
  assert.equal(explorerLink('http://127.0.0.1:3000', HASH).url, `http://127.0.0.1:3000/transactions/${HASH}`);
  assert.equal(explorerLink('http://scan.example.com', HASH), null);
});

test('nothing safe to link to gives null', () => {
  assert.equal(explorerLink('', HASH), null);
  assert.equal(explorerLink(null, HASH), null);
  assert.equal(explorerLink('https://randscan.org', 'not-a-hash'), null);
  assert.equal(explorerLink('https://randscan.org', undefined), null);
  assert.equal(explorerLink('not a url', HASH), null);
  assert.equal(explorerLink('javascript:alert(1)', HASH), null);
  assert.equal(explorerLink('ftp://randscan.org', HASH), null);
});
