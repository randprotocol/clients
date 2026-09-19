// Tests for the home, asset, activity, receive, faucet and tx/note detail screens (task 1.4).
// The brief's Step 1 tests are here verbatim except: the amended `rand1` address prefix (not the
// forbidden word — see amendment 1), and using the shared `mountApp` test helper (amendment 12)
// instead of a bespoke `mount()` call, adapted only where that helper's `t.after` cleanup and
// controlled-hash mounting are needed to avoid deadlocking a test that deliberately stalls a
// backend call (see `mountApp`'s `hash` option and the comments below).
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { groupByDay, avatarFor, totalInRand } from '../lib/assets.js';

/** Mounts straight at `hash` and waits for both the initial render and anything it kicked off in
 *  the background (a scan, a tracked backend call) to settle. */
async function at(t, hash, b = unlockedBackend()) {
  const { app, root } = await mountApp(t, b, { hash });
  await app.idle();
  return { root, b, app };
}

// -------------------------------------------------------------------------------------- home ---
test('home shows RAND hero, four actions, both assets', async (t) => {
  const { root } = await at(t, '#home');
  assert.match(root.querySelector('.hero .amount').textContent, /3\.5/);
  assert.match(root.querySelector('.hero').textContent, /RAND/);
  assert.deepEqual([...root.querySelectorAll('.btn-round')].map((n) => n.dataset.go), ['receive', 'send', 'faucet', 'explore/bridge']);
  assert.equal(root.querySelectorAll('.row[data-go^="asset/"]').length, 2);
});

test('home renders skeletons before the scan resolves', async (t) => {
  const b = unlockedBackend();
  let release;
  // app.js's trackedBackend() snapshots each backend method reference once, at mount() time —
  // so sync.cached must be replaced *before* mounting, or the wrapped ctx.backend.sync.cached
  // would still call the original (fast-resolving) function. Mount at a route that never touches
  // sync.cached() itself (receive only reads wallet.info()), so a cached() that never resolves on
  // its own cannot deadlock the mount — only the subsequent, deliberately-unawaited navigation to
  // #home below, which is exactly the render under test.
  b.sync.cached = () => new Promise((r) => { release = r; });
  const { app, root } = await mountApp(t, b, { hash: '#receive' });
  await app.idle();

  app.go('#home'); // not awaited: this is the render under test, still mid-flight
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(root.querySelector('.skeleton'));

  release({ notes: [], activity: [], scannedHeight: 0, head: 0, lastSyncMs: 0 });
  await app.idle();
});

test('rpc failure shows a retry banner, not a blank screen', async (t) => {
  const b = unlockedBackend();
  b.sync.scan = async () => { throw new Error('cannot reach http://x: timed out'); };
  const { root } = await at(t, '#home', b);
  assert.match(root.querySelector('.banner').textContent, /cannot reach/);
  assert.ok(root.querySelector('.banner [data-action="sync"]'));
  assert.ok(root.querySelector('.banner [data-go="settings"]'));
});

test('home: a scan started before navigating away must not touch the next screen', async (t) => {
  const b = unlockedBackend();
  let resolveScan;
  b.sync.scan = (onProgress) => {
    if (typeof onProgress === 'function') onProgress({ scanned: 0, head: 0 });
    return new Promise((r) => { resolveScan = r; });
  };
  // mount() itself only awaits the cached-data fetch, not the scan (see home.js's after()) — so
  // this resolves promptly even though the scan it starts never will, on its own.
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  assert.ok(root.querySelector('.hero'));

  await app.go('#receive');
  assert.ok(root.querySelector('canvas'));

  // Resolving the stale scan now must not throw and must not write into receive's DOM — home's
  // after() returned a cleanup that flipped its `alive` flag false on this navigation.
  assert.doesNotThrow(() => resolveScan({ notes: [], activity: [], scannedHeight: 5, head: 5, lastSyncMs: Date.now() }));
  await app.idle();
  assert.ok(root.querySelector('canvas'));
  assert.equal(root.querySelector('.banner'), null);
  assert.equal(root.querySelector('.hero'), null);
});

// ------------------------------------------------------------------------------------ asset ---
test('asset detail: RPL asset shows a disabled Send with the exact helper text', async (t) => {
  const { root } = await at(t, '#asset/1');
  const sendBtn = [...root.querySelectorAll('.btn-round')].find((b) => b.textContent.includes('Send'));
  assert.ok(sendBtn);
  assert.equal(sendBtn.disabled, true);
  assert.match(root.textContent, /RPL transfers are not available on this network\./);
});

test('asset detail: RAND shows an enabled Send linking to #send/0', async (t) => {
  const { root } = await at(t, '#asset/0');
  const sendBtn = root.querySelector('[data-go="send/0"]');
  assert.ok(sendBtn);
  assert.equal(sendBtn.disabled, false);
  assert.doesNotMatch(root.textContent, /RPL transfers are not available/);
});

// ---------------------------------------------------------------------------------- activity ---
test("activity: filtering by asset shows only that asset's rows", async (t) => {
  const { root } = await at(t, '#activity');
  assert.equal(root.querySelectorAll('.row').length, 3);
  const wethChip = [...root.querySelectorAll('[data-filter]')].find((c) => c.textContent === 'wETH');
  assert.ok(wethChip);
  wethChip.click();
  assert.equal(root.querySelectorAll('.row').length, 1);
  assert.ok(root.querySelector('.chip.on').textContent.includes('wETH'));
});

test('activity: shows the empty state when there is no activity', async (t) => {
  const empty = { notes: [], activity: [], scannedHeight: 0, head: 0, lastSyncMs: Date.now() };
  const b = unlockedBackend({ sync: { cached: () => empty, scan: (onProgress) => { if (typeof onProgress === 'function') onProgress({ scanned: 0, head: 0 }); return empty; } } });
  const { root } = await at(t, '#activity', b);
  assert.ok(root.querySelector('.empty'));
  assert.match(root.querySelector('.empty').textContent, /No activity yet/);
  assert.ok(root.querySelector('.empty [data-go="faucet"]'));
});

// ------------------------------------------------------------------------------------ detail ---
test('tx detail: View in explorer never passes a key to openExternal', async (t) => {
  const b = unlockedBackend();
  const outHash = `0x${'bb'.repeat(32)}`;
  const txKey = `tk-${'cd'.repeat(16)}`;
  const { root } = await at(t, `#tx/${outHash}`, b);

  const explorerBtn = root.querySelector('[data-role="explorer"]');
  assert.ok(explorerBtn);
  explorerBtn.click();

  const call = b.calls.find((c) => c[0] === 'platform.openExternal');
  assert.ok(call, 'platform.openExternal was called');
  const url = call[1];
  assert.ok(!url.includes(txKey), 'the URL must never contain the transaction key');
  assert.ok(url.includes(outHash), 'the URL should carry the (public) transaction hash');
});

// ------------------------------------------------------------------------------------ receive ---
test('receive shows the address and a QR canvas', async (t) => {
  const { root } = await at(t, '#receive');
  assert.ok(root.querySelector('canvas'));
  assert.match(root.querySelector('.mono').textContent, /^rand1/);
});

// ------------------------------------------------------------------------------------- faucet ---
test('faucet: disables the button while in flight and shows the node error inline on failure', async (t) => {
  const b = unlockedBackend();
  let reject;
  b.faucet.request = () => new Promise((_resolve, rj) => { reject = rj; });
  const { root } = await at(t, '#faucet', b);

  const btn = root.querySelector('[data-role="request"]');
  assert.equal(btn.disabled, false);
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(btn.disabled, true);

  reject(new Error('Try again in 12 hours.'));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(root.querySelector('.banner').textContent, /Try again in 12 hours\./);
  assert.equal(btn.disabled, false);
});

// -------------------------------------------------------------------------------- lib/assets ---
test('groupByDay labels', () => {
  const now = Date.UTC(2026, 8, 19, 12);
  const g = groupByDay([{ time: now / 1000 }, { time: now / 1000 - 86400 }, { time: now / 1000 - 7 * 86400 }], now);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', '12 Sep 2026']);
});

test('groupByDay across a month/year boundary', () => {
  const now = Date.UTC(2027, 0, 2, 3); // 2 Jan 2027
  const g = groupByDay([
    { time: now / 1000 },
    { time: now / 1000 - 86400 },
    { time: now / 1000 - 2 * 86400 },
  ], now);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', '31 Dec 2026']);
});

test('avatarFor is deterministic and gives RAND the aurora marker', () => {
  const rand = { index: 0, id: 'rand', symbol: 'RAND' };
  const weth = { index: 1, id: 'wrapped-eth', symbol: 'wETH' };

  const randAvatar = avatarFor(rand);
  assert.equal(randAvatar.text, 'R');
  assert.equal(randAvatar.hue, null);

  const a = avatarFor(weth);
  const b2 = avatarFor(weth);
  assert.equal(a.hue, b2.hue);
  assert.equal(typeof a.hue, 'number');
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.equal(a.text, 'W');
});

test('totalInRand returns the RAND balance only, ignoring RPL assets', () => {
  const assets = [
    { index: 0, id: 'rand', symbol: 'RAND', balance: '2500000000' },
    { index: 1, id: 'wrapped-eth', symbol: 'wETH', balance: '999999999' },
  ];
  assert.equal(totalInRand(assets), '2500000000');
  assert.equal(totalInRand([]), '0');
});
