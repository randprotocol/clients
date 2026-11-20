// lib/derive-key.js under plain Node, evaluated as the classic script the background loads. What is
// checked is the construction itself: HKDF-SHA-256 over the wallet's spend key, salt the fixed
// domain string, info the length-prefixed (domain, origin, purpose, address) — recomputed here by a
// second, independent implementation (node:crypto's hkdfSync) and pinned to a vector, so a change
// to any byte of it fails here before it changes every site's key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hkdfSync } from 'node:crypto';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../shared/lib/derive-key.js', import.meta.url), 'utf8'));
const { DOMAIN, PURPOSE_RE, deriveSiteKey, siteKeyInfo } = globalThis.RandSiteKey;

const SPEND = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ORIGIN = 'https://durian.market';
const PURPOSE = 'perps/trading';
const ADDRESS = 'rand1qexampleaddress';
const base = { spendKey: SPEND, origin: ORIGIN, purpose: PURPOSE, address: ADDRESS };

/** The construction, written out again with node:crypto: what a second implementation does. */
function reference({ spendKey, origin, purpose, address }) {
  const lp = (s) => {
    const b = Buffer.from(s, 'utf8');
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  const info = Buffer.concat([lp('rand-wallet/site-key/v1'), lp(origin), lp(purpose), lp(address)]);
  return Buffer.from(hkdfSync('sha256', Buffer.from(spendKey, 'hex'), Buffer.from('rand-wallet/site-key/v1', 'utf8'), info, 32)).toString('hex');
}

test('the domain string and the purpose rule are the documented ones', () => {
  assert.equal(DOMAIN, 'rand-wallet/site-key/v1');
  assert.equal(PURPOSE_RE.source, '^[a-z0-9./-]{1,64}$');
});

test('the pinned vector, and an independent HKDF-SHA-256 agrees with it', async () => {
  const key = await deriveSiteKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, reference(base));
  // Pinned: the README's worked vector. Changing it changes every site's key for every wallet.
  assert.equal(key, '60ff86759cc122f6277ce23e0f2430640780354cc214445b5e6297daf50f31b1');
  assert.equal(Buffer.from(siteKeyInfo(base)).toString('hex'),
    '0000001772616e642d77616c6c65742f736974652d6b65792f7631'
    + '0000001568747470733a2f2f64757269616e2e6d61726b6574'
    + '0000000d70657270732f74726164696e67'
    + '0000001472616e6431716578616d706c6561646472657373');
});

test('the same inputs give the same key; each input changes it', async () => {
  const k = await deriveSiteKey(base);
  assert.equal(await deriveSiteKey({ ...base }), k, 'deterministic');
  // An uppercase spend key is the same key (the core's hex is lowercase; an import lowercases).
  assert.equal(await deriveSiteKey({ ...base, spendKey: SPEND.toUpperCase() }), k);
  const others = [
    { ...base, origin: 'https://evil.example' },
    { ...base, origin: 'http://durian.market' },
    { ...base, origin: 'https://durian.market:8443' },
    { ...base, purpose: 'perps/trading2' },
    { ...base, address: 'rand1qotheraddress' },
    { ...base, spendKey: SPEND.replace(/^00/, '01') },
  ];
  const keys = await Promise.all(others.map(deriveSiteKey));
  for (const [i, other] of keys.entries()) assert.notEqual(other, k, JSON.stringify(others[i]));
  assert.equal(new Set(keys).size, keys.length, 'all different from each other too');
});

test('the info is length-prefixed, so moving bytes between fields is a different input', () => {
  const a = Buffer.from(siteKeyInfo({ origin: 'https://a.example', purpose: 'x/y', address: 'rand1q' }));
  const b = Buffer.from(siteKeyInfo({ origin: 'https://a.example', purpose: 'x', address: '/yrand1q' }));
  assert.notDeepEqual(a, b);
  // The layout: four u32-big-endian length prefixes, each before its UTF-8 field.
  assert.equal(a.readUInt32BE(0), DOMAIN.length);
  assert.equal(a.subarray(4, 4 + DOMAIN.length).toString('utf8'), DOMAIN);
});

test('inputs that are not what the wallet would pass are refused, not derived from', async () => {
  for (const bad of [
    { ...base, spendKey: '' },
    { ...base, spendKey: SPEND.slice(2) },
    { ...base, spendKey: 'zz' + SPEND.slice(2) },
    { ...base, spendKey: undefined },
    { ...base, origin: 'https://durian.market/' },
    { ...base, origin: 'durian.market' },
    { ...base, origin: 'chrome-extension://abc' },
    { ...base, origin: '' },
    { ...base, purpose: '' },
    { ...base, purpose: 'Perps' },
    { ...base, purpose: 'a'.repeat(65) },
    { ...base, purpose: 'perps trading' },
    { ...base, purpose: 7 },
    { ...base, address: '' },
    { ...base, address: null },
  ]) {
    await assert.rejects(deriveSiteKey(bad), undefined, JSON.stringify(bad));
  }
});
