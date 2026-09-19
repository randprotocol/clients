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
import { icons } from '../lib/icons.js';
import { explorerLink } from '../screens/detail.js';

const IN_HASH = `0x${'aa'.repeat(32)}`;
const OUT_HASH = `0x${'bb'.repeat(32)}`;
const FAUCET_HASH = `0x${'ff'.repeat(32)}`;
const TX_KEY = `tk-${'cd'.repeat(16)}`;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mounts straight at `hash` and waits for both the initial render and anything it kicked off in
 *  the background (a scan, a tracked backend call) to settle. */
async function at(t, hash, b = unlockedBackend()) {
  const { app, root } = await mountApp(t, b, { hash });
  await app.idle();
  return { root, b, app };
}

/**
 * An `unlockedBackend()` whose FIRST call to `group.method` blocks until `release()` is called;
 * every later call behaves normally. `app.js`'s `trackedBackend()` snapshots each backend method
 * once, at mount() time, so a stall has to be installed before mounting — hence the override
 * rather than a post-mount reassignment.
 */
function stallFirst(group, method) {
  const src = unlockedBackend(); // same fixture data, used to answer once the gate opens
  let open;
  const gate = new Promise((r) => { open = r; });
  let n = 0;
  const b = unlockedBackend({
    [group]: {
      [method]: async (...args) => {
        n += 1;
        if (n === 1) await gate;
        return src[group][method](...args);
      },
    },
  });
  return { b, release: () => open() };
}

// ---------------------------------------------------------------------------------- lifecycle ---
// Every screen fetches its data in `after()`, after its markup is already in the DOM. `mainEl` is
// reused across screens, so a fetch that resolves once the user has navigated away must not write
// into whatever screen is on display by then. app.js hands each render its own `ctx` view with
// `ctx.isCurrent()`; these tests pin that behaviour down for every screen in this task.
const FIRST_FETCH = [
  { screen: 'home', hash: '#home', group: 'wallet', method: 'info' },
  { screen: 'asset', hash: '#asset/1', group: 'assets', method: 'list' },
  { screen: 'activity', hash: '#activity', group: 'assets', method: 'list' },
  { screen: 'tx detail', hash: `#tx/${OUT_HASH}`, group: 'assets', method: 'list' },
  { screen: 'receive', hash: '#receive', group: 'wallet', method: 'info' },
];

for (const { screen, hash, group, method } of FIRST_FETCH) {
  test(`${screen}: a first fetch resolving after navigating away never touches the next screen`, async (t) => {
    const { b, release } = stallFirst(group, method);
    // `faucet` is the neutral screen here: its after() makes no backend calls at all, so it can
    // never be the thing that is stalled, and mounting on it cannot deadlock.
    const { app, root } = await mountApp(t, b, { hash: '#faucet' });
    app.go(hash); // deliberately not awaited: its first fetch is stalled mid-after()
    await tick();
    await app.go('#faucet');
    assert.ok(root.querySelector('[data-role="request"]'), 'faucet is on screen again');

    release();
    await app.idle();
    assert.ok(root.querySelector('[data-role="request"]'), 'faucet survived the stale fetch');
    assert.equal(root.querySelector('.hero'), null);
    assert.equal(root.querySelector('.card'), null);
    assert.equal(root.querySelector('canvas'), null);
  });

  test(`${screen}: destroy() during the first fetch makes no further backend calls`, async (t) => {
    const { b, release } = stallFirst(group, method);
    const { app, root } = await mountApp(t, b, { hash: '#faucet' });
    app.go(hash);
    await tick();
    app.destroy();
    const callsAtDestroy = b.calls.length;

    release();
    await app.idle();
    assert.equal(root.innerHTML, '');
    assert.equal(b.calls.length, callsAtDestroy, 'a destroyed app fetches nothing more');
  });
}

// -------------------------------------------------------------------------------------- home ---
test('home shows RAND hero, four actions, both assets', async (t) => {
  const { root } = await at(t, '#home');
  assert.match(root.querySelector('.hero .amount').textContent, /3\.5/);
  assert.match(root.querySelector('.hero').textContent, /RAND/);
  assert.deepEqual([...root.querySelectorAll('.btn-round')].map((n) => n.dataset.go), ['receive', 'send', 'faucet', 'explore/bridge']);
  assert.equal(root.querySelectorAll('.row[data-go^="asset/"]').length, 2);
});

test('home renders skeletons before any data resolves', async (t) => {
  const b = unlockedBackend({
    // Both sources of list data are stalled: the scan now starts alongside the cached read (so the
    // sync bar appears immediately), so a scan that resolved would legitimately fill the lists.
    sync: { cached: () => new Promise(() => {}), scan: () => new Promise(() => {}) },
  });
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  await tick();
  assert.ok(root.querySelector('.skeleton'));
  assert.ok(app);
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
  // render is no longer the current one, so `ctx.isCurrent()` is false for every reaction it left.
  assert.doesNotThrow(() => resolveScan({ notes: [], activity: [], scannedHeight: 5, head: 5, lastSyncMs: Date.now() }));
  await app.idle();
  assert.ok(root.querySelector('canvas'));
  assert.equal(root.querySelector('.banner'), null);
  assert.equal(root.querySelector('.hero'), null);
});

test('home: three rapid retries run exactly one scan', async (t) => {
  let resolveScan;
  const b = unlockedBackend({ sync: { scan: () => new Promise((r) => { resolveScan = r; }) } });
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  const scans = () => b.calls.filter((c) => c[0] === 'sync.scan').length;
  assert.equal(scans(), 1, 'the visit itself starts one scan');

  const btn = root.querySelector('[data-action="sync"]');
  assert.ok(btn);
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  btn.click(); btn.click(); btn.click();
  await tick();
  assert.equal(scans(), 1, 'retries while a scan is in flight are ignored');

  resolveScan(await b.sync.cached());
  await app.idle();
  assert.equal(scans(), 1);
  assert.equal(btn.disabled, false);
  assert.equal(btn.hasAttribute('aria-busy'), false);
});

test('home: leaving and coming back mid-scan attaches to the running scan', async (t) => {
  let resolveScan;
  const b = unlockedBackend({ sync: { scan: () => new Promise((r) => { resolveScan = r; }) } });
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  await app.go('#faucet');
  await app.go('#home');
  assert.equal(b.calls.filter((c) => c[0] === 'sync.scan').length, 1);
  assert.equal(root.querySelector('[data-action="sync"]').disabled, true, 'still shown as busy');

  resolveScan(await b.sync.cached());
  await app.idle();
});

test('home: progress ticks and a scan result keep keyboard focus where it was', async (t) => {
  let onProgress, resolveScan;
  const b = unlockedBackend({
    sync: { scan: (cb) => { onProgress = cb; return new Promise((r) => { resolveScan = r; }); } },
  });
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  const send = root.querySelector('[data-go="send"]');
  assert.ok(send);
  send.focus();
  assert.equal(document.activeElement, send);

  onProgress({ scanned: 10, head: 100 });
  onProgress({ scanned: 60, head: 100 });
  await tick();
  assert.equal(document.activeElement, send, 'a progress tick must not rebuild the page');

  resolveScan(await b.sync.cached());
  await app.idle();
  assert.equal(document.activeElement, send, 'the scan result must not rebuild the page either');
  assert.ok(root.contains(send));
});

test('home: the sync bar is indeterminate while scanning with no progress yet', async (t) => {
  const b = unlockedBackend({ sync: { scan: () => new Promise(() => {}) } });
  const { root } = await mountApp(t, b, { hash: '#home' });
  const bar = root.querySelector('[data-role="progress"]');
  assert.ok(bar, 'a progress bar is shown as soon as a scan starts');
  assert.equal(bar.hasAttribute('hidden'), false);
  assert.equal(bar.getAttribute('data-indeterminate'), 'true');
});

test('home: the address pill copies the address', async (t) => {
  const b = unlockedBackend();
  const { root } = await at(t, '#home', b);
  const pill = root.querySelector('[data-role="copy-address"]');
  assert.ok(pill);
  assert.equal(pill.getAttribute('aria-label'), 'Copy address');
  assert.ok(pill.querySelector('svg'), 'the pill carries the copy affordance the gallery shows');
  pill.click();
  await new Promise((r) => setTimeout(r, 0));
  const call = b.calls.find((c) => c[0] === 'platform.copy');
  assert.ok(call);
  assert.match(call[1], /^rand1/);
});

test('home: the sync control uses the refresh icon, not the activity clock', async (t) => {
  const { root } = await at(t, '#home');
  const btn = root.querySelector('.hero [data-action="sync"]');
  assert.ok(btn);
  // linkedom re-serialises `<path …/>` as `<path … />`, so compare on a normalised form.
  const norm = (s) => s.replace(/\s*\/>/g, '/>');
  assert.equal(norm(btn.innerHTML), icons.refresh());
  assert.notEqual(norm(btn.innerHTML), icons.activity());
});

// ------------------------------------------------------------------------------------ asset ---
test('asset detail: RPL asset shows a keyboard-reachable disabled Send with the exact helper text', async (t) => {
  const { root } = await at(t, '#asset/1');
  const sendBtn = [...root.querySelectorAll('.btn-round')].find((b) => b.textContent.includes('Send'));
  assert.ok(sendBtn);
  // aria-disabled, not `disabled`: a `disabled` button is skipped by the keyboard, so its helper
  // text would never be announced (see the aria-describedby tie below).
  assert.equal(sendBtn.hasAttribute('disabled'), false);
  assert.equal(sendBtn.getAttribute('aria-disabled'), 'true');
  const hint = root.querySelector('[data-role="rpl-hint"]');
  assert.ok(hint);
  assert.ok(hint.id);
  assert.equal(sendBtn.getAttribute('aria-describedby'), hint.id);
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
  assert.equal(root.querySelectorAll('.row').length, 4);
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

// --------------------------------------------------------------------------------- list rows ---
test('every list of rows is a real <ul>/<li>, not bare buttons under role=list', async (t) => {
  for (const hash of ['#home', '#activity', '#asset/0']) {
    const { root } = await at(t, hash);
    const lists = [...root.querySelectorAll('[role="list"]')];
    assert.ok(lists.length > 0, `${hash} has at least one list`);
    for (const list of lists) {
      assert.equal(list.tagName, 'UL', `${hash}: role=list is on a <ul>`);
      for (const child of list.children) {
        assert.equal(child.tagName, 'LI', `${hash}: every list child is an <li>`);
      }
    }
    for (const row of root.querySelectorAll('.row')) {
      assert.equal(row.parentElement.tagName, 'LI', `${hash}: every row sits in an <li>`);
    }
  }
});

test('activity rows render all four contract kinds, and an unknown kind neutrally', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const b = unlockedBackend({
    sync: {
      cached: () => ({
        notes: [],
        activity: [
          { kind: 'faucet', asset: 0, amount: '10000000000', time: now - 60, hash: FAUCET_HASH },
          { kind: 'pending', asset: 0, amount: '1000000000', time: now - 30, hash: `0x${'de'.repeat(32)}`, status: 'proving' },
          { kind: 'in', asset: 0, amount: '1000000000', time: now - 90, hash: IN_HASH },
          { kind: 'out', asset: 0, amount: '1000000000', time: now - 120, hash: OUT_HASH },
          { kind: 'sideways', asset: 0, amount: '1000000000', time: now - 150, hash: `0x${'ed'.repeat(32)}` },
        ],
        scannedHeight: 1, head: 1, lastSyncMs: Date.now(),
      }),
      scan: () => new Promise(() => {}),
    },
  });
  const { root } = await at(t, '#activity', b);
  const rows = [...root.querySelectorAll('.row')];
  const byHash = (hash) => rows.find((r) => r.dataset.go === `tx/${hash}`);

  const faucetRow = byHash(FAUCET_HASH);
  assert.ok(faucetRow, 'a faucet item renders a row');
  assert.match(faucetRow.querySelector('.row-title').textContent, /Faucet/);
  assert.match(faucetRow.querySelector('.row-end .amount').textContent, /^\+/);
  assert.ok(faucetRow.querySelector('.avatar.faucet'), 'positive-tinted droplet avatar');
  assert.doesNotMatch(faucetRow.textContent, /Pending/);

  const pendingRow = rows.find((r) => r.textContent.includes('Proving'));
  assert.ok(pendingRow, 'a pending item shows the status it was given');
  assert.ok(pendingRow.querySelector('.avatar.pending'));

  assert.match(byHash(IN_HASH).querySelector('.row-title').textContent, /Received/);
  assert.match(byHash(OUT_HASH).querySelector('.row-title').textContent, /Sent/);

  const unknownRow = byHash(`0x${'ed'.repeat(32)}`);
  assert.match(unknownRow.querySelector('.row-title').textContent, /sideways/);
  assert.doesNotMatch(unknownRow.querySelector('.row-title').textContent, /Pending/);
  assert.equal(unknownRow.querySelector('.avatar.pending'), null);
});

test('asset rows never repeat the same text on both lines', async (t) => {
  const { root } = await at(t, '#home');
  const rows = [...root.querySelectorAll('.row[data-go^="asset/"]')];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const title = row.querySelector('.row-title').textContent.replace('RPL', '').trim();
    const sub = row.querySelector('.row-sub').textContent.trim();
    assert.notEqual(title.toLowerCase(), sub.toLowerCase());
  }
  const randRow = rows.find((r) => r.dataset.go === 'asset/0');
  assert.match(randRow.querySelector('.row-title').textContent, /Rand/);
  assert.match(randRow.querySelector('.row-sub').textContent, /Native token/);
  const wethRow = rows.find((r) => r.dataset.go === 'asset/1');
  assert.match(wethRow.querySelector('.row-title').textContent, /Wrapped Ether/);
  assert.match(wethRow.querySelector('.row-sub').textContent, /wETH/);
});

test('an asset with no name falls back to its symbol and a registry subtitle', async (t) => {
  const b = unlockedBackend({
    assets: { list: () => [
      { index: 0, id: 'rand', symbol: 'RAND', decimals: 9, balance: '1000000000', pending: '0' },
      { index: 4, id: 'rpl-4', symbol: 'RPL#4', decimals: 9, balance: '5000000000', pending: '0' },
    ] },
  });
  const { root } = await at(t, '#home', b);
  const rand = root.querySelector('.row[data-go="asset/0"]');
  assert.match(rand.querySelector('.row-title').textContent, /RAND/);
  assert.match(rand.querySelector('.row-sub').textContent, /Native token/);
  const rpl = root.querySelector('.row[data-go="asset/4"]');
  assert.match(rpl.querySelector('.row-title').textContent, /RPL#4/);
  assert.match(rpl.querySelector('.row-sub').textContent, /Registry asset · #4/);
});

// ------------------------------------------------------------------------------------ detail ---
test('tx detail: Open in randscan never passes a key to openExternal', async (t) => {
  const b = unlockedBackend();
  const { root } = await at(t, `#tx/${OUT_HASH}`, b);

  const explorerBtn = root.querySelector('[data-role="explorer"]');
  assert.ok(explorerBtn);
  assert.equal(explorerBtn.textContent.trim(), 'Open in randscan');
  explorerBtn.click();

  const call = b.calls.find((c) => c[0] === 'platform.openExternal');
  assert.ok(call, 'platform.openExternal was called');
  const url = call[1];
  assert.ok(!url.includes(TX_KEY), 'the URL must never contain the transaction key');
  assert.ok(url.includes(OUT_HASH), 'the URL should carry the (public) transaction hash');
  assert.equal(url, `https://randscan.org/tx/${OUT_HASH}`);
});

test('tx detail: the transaction key never appears in any DOM attribute', async (t) => {
  const b = unlockedBackend();
  const { root } = await at(t, `#tx/${OUT_HASH}`, b);

  const attributesContainKey = () => [...root.querySelectorAll('*')].some(
    (el) => [...el.attributes].some((a) => String(a.value).includes(TX_KEY)),
  );
  assert.equal(attributesContainKey(), false, 'hidden: no attribute carries the key');
  assert.doesNotMatch(root.textContent, new RegExp(TX_KEY));

  root.querySelector('[data-role="reveal-key"]').click();
  assert.match(root.querySelector('[data-role="txkey"]').textContent, new RegExp(TX_KEY));
  assert.equal(attributesContainKey(), false, 'revealed: still no attribute carries the key');

  root.querySelector('[data-role="copy-key"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(b.calls.some((c) => c[0] === 'platform.copy' && c[1] === TX_KEY));
});

test('tx detail: no explorer button without a configured explorer, or with a bad hash', async (t) => {
  const noExplorer = unlockedBackend({ settings: { get: () => ({ rpcUrl: 'http://127.0.0.1:8899', theme: 'system', autoLockMin: 15, explorerUrl: '', chainId: 13 }) } });
  const a = await at(t, `#tx/${OUT_HASH}`, noExplorer);
  assert.equal(a.root.querySelector('[data-role="explorer"]'), null);

  const now = Math.floor(Date.now() / 1000);
  const badHash = 'javascript:alert(1)';
  const weird = unlockedBackend({
    sync: {
      cached: () => ({ notes: [], activity: [{ kind: 'in', asset: 0, amount: '1', time: now, hash: badHash }], scannedHeight: 1, head: 1, lastSyncMs: Date.now() }),
      scan: () => new Promise(() => {}),
    },
  });
  const c = await mountApp(t, weird, { hash: `#tx/${badHash}` });
  await tick();
  assert.equal(c.root.querySelector('[data-role="explorer"]'), null, 'a hash that is not 32 bytes of hex is never put in a URL');
});

test('tx detail: the explorer label follows the configured host', async (t) => {
  const b = unlockedBackend({ settings: { get: () => ({ rpcUrl: 'http://127.0.0.1:8899', theme: 'system', autoLockMin: 15, explorerUrl: 'https://scan.example', chainId: 13 }) } });
  const { root } = await at(t, `#tx/${OUT_HASH}`, b);
  assert.equal(root.querySelector('[data-role="explorer"]').textContent.trim(), 'Open in explorer');
});

test('tx detail: a faucet transaction is not shown as pending', async (t) => {
  const { root } = await at(t, `#tx/${FAUCET_HASH}`);
  assert.match(root.querySelector('.card').textContent, /Faucet/);
  assert.doesNotMatch(root.querySelector('.card-head').textContent, /Pending/);
  assert.match(root.querySelector('.amount').textContent, /^\+/);
});

test('tx detail: an item with no optional fields renders only what it has', async (t) => {
  // The faucet fixture carries no address/block/fee/txKey — every one of those rows is optional in
  // the Backend contract (see ui/backend.js) and must simply be absent, not empty or broken.
  const { root } = await at(t, `#tx/${FAUCET_HASH}`);
  const labels = [...root.querySelectorAll('.kv .k')].map((n) => n.textContent);
  assert.deepEqual(labels, []);
  assert.equal(root.querySelector('[data-role="txkey"]'), null);
  assert.equal(root.querySelector('[data-role="reveal-key"]'), null);
});

test('tx detail: the fee uses the native asset decimals, not a hard-coded 9', async (t) => {
  const b = unlockedBackend({
    assets: { list: () => [
      { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 6, balance: '3500000', pending: '0' },
    ] },
  });
  const { root } = await at(t, `#tx/${OUT_HASH}`, b);
  const feeRow = [...root.querySelectorAll('.kv')].find((n) => n.textContent.includes('Fee'));
  assert.ok(feeRow);
  // fee '2100000' at 6 decimals is 2.1 RAND, not 0.0021.
  assert.match(feeRow.querySelector('.v').textContent, /^2\.1 RAND$/);
});

// ------------------------------------------------------------------------------------ receive ---
test('receive shows the address and a QR canvas', async (t) => {
  const { root } = await at(t, '#receive');
  assert.ok(root.querySelector('canvas'));
  assert.match(root.querySelector('.mono').textContent, /^rand1/);
});

test('receive shows the complete address, not just a shortened one', async (t) => {
  const b = unlockedBackend();
  const address = (await b.wallet.info()).address;
  const { root } = await at(t, '#receive', b);
  const full = root.querySelector('[data-role="full-address"]');
  assert.ok(full, 'the full address is on screen');
  assert.equal(full.textContent, address);
  assert.ok(full.classList.contains('mono'));
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
  // `tzOffsetMinutes: 0` pins this to UTC so the expectations do not depend on the test machine's
  // own zone (see the UTC−7 case below for the local-day behaviour the default gives a viewer).
  const g = groupByDay([{ time: now / 1000 }, { time: now / 1000 - 86400 }, { time: now / 1000 - 7 * 86400 }], now, 0);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', '12 Sep 2026']);
});

test('groupByDay buckets by the viewer’s local day, not the UTC day', () => {
  // Both items fall on 19 Sep 2026 in UTC (12:00 and 04:00), but at UTC−7 the 04:00 one is the
  // evening before: 18 Sep, 21:00 local.
  const now = Date.UTC(2026, 8, 19, 12);
  const items = [{ time: now / 1000 }, { time: now / 1000 - 8 * 3600 }];
  assert.deepEqual(groupByDay(items, now, 0).map((x) => x.label), ['Today']);
  assert.deepEqual(groupByDay(items, now, 420).map((x) => x.label), ['Today', 'Yesterday']);
});

test('groupByDay across a month/year boundary', () => {
  const now = Date.UTC(2027, 0, 2, 3); // 2 Jan 2027
  const g = groupByDay([
    { time: now / 1000 },
    { time: now / 1000 - 86400 },
    { time: now / 1000 - 2 * 86400 },
  ], now, 0);
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

// ----------------------------------------------------------------------------------- network ---
test('the network label is derived from settings.chainId, never hard-coded', async (t) => {
  const { root } = await at(t, '#home');
  const chip = root.querySelector('.sidebar-foot .chip, .sidebar .chip');
  assert.ok(chip);
  assert.equal(chip.textContent.trim(), 'Chain 13');

  const other = unlockedBackend({ settings: { get: () => ({ rpcUrl: 'http://127.0.0.1:8899', theme: 'system', autoLockMin: 15, explorerUrl: 'https://randscan.org', chainId: 99 }) } });
  const second = await at(t, '#home', other);
  assert.equal(second.root.querySelector('.sidebar .chip').textContent.trim(), 'Chain 99');
});

test('the fake backend reports the live chain id', async () => {
  const b = unlockedBackend();
  assert.equal((await b.settings.get()).chainId, 13);
});

// ------------------------------------------------------------------------------------- guard ---
test('no screen in this task hard-codes a chain number or a fallback explorer URL', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  // Recursive since task 1.5: the send flow is a directory of modules, and every one of them is
  // as much "a screen" as a top-level file is.
  async function* walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) yield* walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.js')) yield [`${prefix}${entry.name}`, new URL(entry.name, dir)];
    }
  }
  let checked = 0;
  for await (const [name, url] of walk(new URL('../screens/', import.meta.url))) {
    const src = await readFile(url, 'utf8');
    checked += 1;
    assert.doesNotMatch(src, /rand\.example/, `${name} ships a test-fixture URL`);
    assert.doesNotMatch(src, /chain\s*(id)?\s*[:=]\s*['"]?\d/i, `${name} hard-codes a chain number`);
  }
  assert.ok(checked >= 10, 'every screen module was actually read');
  assert.ok(fakeBackend);
});

// ------------------------------------------------------------------- sessions and the scan ----
// `ctx.state` (where the one in-flight scan lives) is emptied whenever the wallet session ends,
// and a scan carries the session id it started under. Neither a returning screen nor a late
// resolve may carry one wallet's data into the next one's screen.

// A scan that never settles keeps `app.idle()` waiting for ever (it is a tracked backend call),
// so these tests drain the queue with plain turns instead.
const turns = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** A backend whose sync.scan() never settles on its own; `settle(...)`/`fail(...)` drives it. */
function controlledScan(overrides = {}) {
  const ctl = { calls: 0, signals: [], settle: null, fail: null };
  const b = unlockedBackend({
    ...overrides,
    sync: {
      ...(overrides.sync || {}),
      scan: (_onProgress, opts) => {
        ctl.calls += 1;
        ctl.signals.push(opts && opts.signal);
        return new Promise((resolve, reject) => { ctl.settle = resolve; ctl.fail = reject; });
      },
    },
  });
  return { b, ctl };
}

const OLD_ACTIVITY = {
  notes: [],
  activity: [{ kind: 'in', asset: 0, amount: '99000000000', time: Math.floor(Date.now() / 1000), hash: `0x${'9a'.repeat(32)}`, address: `rand1${'old'.repeat(13)}o` }],
  scannedHeight: 9, head: 9, lastSyncMs: Date.now(),
};

test('a scan from before a wipe never paints under the new wallet', async (t) => {
  const { b, ctl } = controlledScan();
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  assert.equal(ctl.calls, 1, 'session 1 started a scan');
  const staleSettle = ctl.settle;

  // Lock → wipe → create a brand-new wallet → home, all inside the same mount.
  root.querySelector('.sidebar [data-action="lock"]').click();
  await turns();
  root.querySelector('[data-action="wipe"]').click();
  await turns();
  root.querySelector('[role="dialog"] [data-role="confirm"]').click();
  await turns();
  assert.equal(location.hash, '#welcome');

  await app.go('#create');
  root.querySelector('input[name=password]').value = 'a brand new password';
  root.querySelector('input[name=confirm]').value = 'a brand new password';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await turns();
  await app.go('#home');
  await turns();

  const callsBefore = ctl.calls;
  assert.ok(callsBefore > 1, 'the new session started a scan of its own');

  staleSettle(OLD_ACTIVITY); // the previous wallet's scan finally answers
  await turns();
  assert.doesNotMatch(root.textContent, /99/, "the previous wallet's balance is not shown");
  assert.doesNotMatch(root.innerHTML, /rand1oldold/, "the previous wallet's activity is not shown");
  assert.equal(ctl.calls, callsBefore, 'and no extra scan was started by the stale resolve');
});

test('a scan from before a lock never paints after unlocking', async (t) => {
  const { b, ctl } = controlledScan();
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  const staleSettle = ctl.settle;
  assert.equal(ctl.calls, 1);

  root.querySelector('.sidebar [data-action="lock"]').click();
  await turns();
  root.querySelector('input[name=password]').value = 'unlocked-password-1';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await turns();
  assert.equal(location.hash, '#home');
  assert.equal(ctl.calls, 2, 'the unlocked session starts its own scan, it does not attach');

  staleSettle(OLD_ACTIVITY);
  await turns();
  assert.doesNotMatch(root.textContent, /99/);
  assert.doesNotMatch(root.innerHTML, /rand1oldold/);
});

test('sync.scan is given the session signal, and an abort is not reported as a node failure', async (t) => {
  const { b, ctl } = controlledScan();
  const { app, root } = await mountApp(t, b, { hash: '#home' });
  const signal = ctl.signals[0];
  assert.ok(signal, 'sync.scan receives { signal } as its second argument');
  assert.equal(signal.aborted, false);

  const staleFail = ctl.fail;
  root.querySelector('.sidebar [data-action="lock"]').click();
  await turns();
  assert.equal(signal.aborted, true, 'ending the session aborts the scan');

  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  staleFail(err);
  await turns();
  assert.equal(root.querySelector('.banner.negative'), null, 'an aborted scan is not an error to show');
});

test('the fake backend honours an aborted signal on sync.scan', async () => {
  const b = unlockedBackend();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => b.sync.scan(undefined, { signal: ac.signal }), (err) => err.name === 'AbortError');
  const fine = await b.sync.scan(undefined, { signal: new AbortController().signal });
  assert.ok(Array.isArray(fine.activity));
});

// --------------------------------------------------------------------------- read-only data ----
test('the tx detail screen never mutates the object the backend returned', async (t) => {
  const cached = await unlockedBackend().sync.cached();
  const item = cached.activity.find((a) => a.hash === OUT_HASH);
  assert.ok(item.txKey, 'the fixture has a key to begin with');
  const before = { ...item };
  // The same object identity every call, the way a caching backend would answer.
  const b = unlockedBackend({ sync: { cached: () => cached, scan: () => cached } });
  const { root } = await at(t, `#tx/${OUT_HASH}`, b);
  assert.ok(root.querySelector('[data-role="txkey"]'));
  root.querySelector('[data-role="reveal-key"]').click();
  assert.deepEqual({ ...item }, before, 'the backend’s own object is untouched');
  assert.equal(item.txKey, before.txKey);
});

// ------------------------------------------------------------------------------ explorer URL ---
test('explorerLink refuses plain http except on a local explorer', () => {
  const hash = OUT_HASH;
  assert.equal(explorerLink('https://randscan.org', hash).label, 'Open in randscan');
  assert.equal(explorerLink('http://randscan.org', hash), null, 'no plaintext to a remote host');
  assert.equal(explorerLink('http://explorer.example', hash), null);
  assert.equal(explorerLink('http://localhost:3000', hash).url, `http://localhost:3000/tx/${hash}`);
  assert.equal(explorerLink('http://127.0.0.1:3000', hash).url, `http://127.0.0.1:3000/tx/${hash}`);
  assert.equal(explorerLink('http://localhost:3000', hash).label, 'Open in explorer');
  assert.equal(explorerLink('javascript:alert(1)', hash), null);
  assert.equal(explorerLink('', hash), null);
  assert.equal(explorerLink('https://randscan.org', 'not-a-hash'), null);
});

// -------------------------------------------------------- abort while home is still on screen ---
// The existing abort test locks the wallet first, which navigates away — home is unmounted by the
// time the stale scan rejects, so `live()` short-circuits and the `isAbortError` guard below it is
// never reached. This one aborts the scan *under a mounted, current home*, which is the only path
// that actually exercises the guard (task 1.5, part A5).
test('an abort that arrives while home is still on screen is not shown as a node failure', async (t) => {
  const { b, ctl } = controlledScan();
  const { root } = await mountApp(t, b, { hash: '#home' });
  await turns();
  assert.equal(ctl.calls, 1);
  assert.ok(root.querySelector('.hero'), 'home is still the screen on display');

  const aborted = new Error('The operation was aborted.');
  aborted.name = 'AbortError';
  ctl.fail(aborted);
  await turns();
  assert.ok(root.querySelector('.hero'), 'and still is');
  assert.equal(root.querySelector('.banner.negative'), null, 'an abort is not a node failure');
});

test('a real scan failure while home is still on screen does show the banner', async (t) => {
  // The counterpart to the test above: without it, "no banner" would also pass if home simply
  // never rendered one.
  const { b, ctl } = controlledScan();
  const { root } = await mountApp(t, b, { hash: '#home' });
  await turns();
  ctl.fail(new Error('Cannot reach the fullnode.'));
  await turns();
  const banner = root.querySelector('.banner.negative');
  assert.ok(banner);
  assert.match(banner.textContent, /Cannot reach the fullnode/);
});
