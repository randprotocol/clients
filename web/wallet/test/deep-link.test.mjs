// `randpay:` deep links for the web wallet (task 14, spec 2026-09-26 §3.3): registering
// `web+randpay` with `navigator.registerProtocolHandler`, and normalizing the hash a browser
// lands the page on back to the plain `#send?uri=<randpay: link>` shape the shared router
// already understands from a pasted or scanned link.
//
// `../deep-link.js` is deliberately its own module, imported by `main.js` rather than tested
// through it: `main.js`'s `boot()` runs at import time (it is the page's actual entry point) and
// reaches for `Worker`, which does not exist under `node --test` — importing it here would either
// throw or leave a rejected boot dangling. Splitting the two lines of browser-adaptation logic
// out is what makes them testable without a browser at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../../ui/test/dom-env.mjs';
import { mountApp } from '../../../ui/test/helpers.mjs';
import { unlockedBackend } from '../../../ui/test/fake-backend.mjs';
import { registerRandpayHandler, normalizeDeepLinkHash, SCHEME } from '../deep-link.js';

const TO = `rand1${'p'.repeat(40)}`;
const randRow = { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' };
const listing = { assets: { list: async () => [{ ...randRow }] } };

// ------------------------------------------------------------------ normalizeDeepLinkHash ------

test('a plain #/send?uri= is re-shaped to #send?uri=, byte-identical link', () => {
  const link = `randpay:${TO}?amount=1`;
  const hash = `#/send?uri=${encodeURIComponent(link)}`;
  assert.equal(normalizeDeepLinkHash(hash), `#send?uri=${encodeURIComponent(link)}`);
});

test('a web+randpay: prefix (what registerProtocolHandler requires the scheme to carry) is stripped', () => {
  const link = `web+randpay:${TO}?amount=1`;
  const hash = `#/send?uri=${encodeURIComponent(link)}`;
  const normalized = normalizeDeepLinkHash(hash);
  assert.equal(normalized, `#send?uri=${encodeURIComponent(`randpay:${TO}?amount=1`)}`);
});

test('the web+ prefix is matched case-insensitively, as a browser may echo it', () => {
  const link = `WEB+RANDPAY:${TO}`;
  const hash = `#/send?uri=${encodeURIComponent(link)}`;
  assert.equal(normalizeDeepLinkHash(hash), `#send?uri=${encodeURIComponent(`randpay:${TO}`)}`);
});

test('a hash already in the shared router’s shape (no leading slash) is accepted too', () => {
  const link = `randpay:${TO}`;
  assert.equal(normalizeDeepLinkHash(`#send?uri=${encodeURIComponent(link)}`), `#send?uri=${encodeURIComponent(link)}`);
});

test('anything that is not #send?uri=… is left alone (null, not a rewrite)', () => {
  assert.equal(normalizeDeepLinkHash('#activity'), null);
  assert.equal(normalizeDeepLinkHash('#send/0'), null);
  assert.equal(normalizeDeepLinkHash(''), null);
  assert.equal(normalizeDeepLinkHash(undefined), null);
});

// -------------------------------------------------------------------- registerRandpayHandler ---

test('registers web+randpay at the send route, with the origin the page is actually on', () => {
  const calls = [];
  const nav = { registerProtocolHandler: (...args) => calls.push(args) };
  assert.equal(registerRandpayHandler(nav, 'https://wallet.example'), true);
  assert.deepEqual(calls, [[SCHEME, 'https://wallet.example/#/send?uri=%s']]);
});

test('a browser that throws (no support, or a non-secure/file:// context) does not crash boot', () => {
  const nav = { registerProtocolHandler: () => { throw new DOMException('nope', 'SecurityError'); } };
  assert.equal(registerRandpayHandler(nav, 'https://wallet.example'), false);
});

test('a browser with no registerProtocolHandler at all is a no-op, not a throw', () => {
  assert.equal(registerRandpayHandler({}, 'https://wallet.example'), false);
});

// --------------------------------------------------------------- end to end through the router -
// What actually happens at boot: `boot()` rewrites `location.hash` with `normalizeDeepLinkHash`
// before `mount()` ever reads it. This exercises that hand-off into the real router and send
// screen (task 14's router requirement), including the web+ prefix, without importing main.js.

test('normalized into the router: #/send?uri=<web+randpay: link> lands on send, filled', async (t) => {
  const link = `web+randpay:${TO}?amount=3`;
  const rawHash = `#/send?uri=${encodeURIComponent(link)}`;
  const normalized = normalizeDeepLinkHash(rawHash);
  assert.ok(normalized, 'the boot-time rewrite recognised the deep link');

  const { app, root } = await mountApp(t, unlockedBackend(listing), { hash: normalized });
  await app.idle();
  assert.equal(root.querySelector('textarea[name=to]').value, `randpay:${TO}?amount=3`);
  assert.match(root.querySelector('[data-role="to-link"]').textContent, /Payment link/);
  assert.equal(root.querySelector('input[name=amount]').value, '3');
});
