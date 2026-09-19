// Task 1.7 — the wide (desktop) two-pane layout: a list stays in the content pane while its
// detail opens beside it in `<aside class="detail">`.
//
// Everything here is about *two screen instances being mounted at once*, so every test asserts on
// which pane a thing is in, not just that it is on screen. Below 900 px (and in `mode: 'popup'` at
// any width) the app must behave exactly as it did before this task — the tests at the bottom pin
// that down, and the rest of ui/test/ (which runs at the compact default width) is the real proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { setViewportWidth, COMPACT_WIDTH, WIDE_WIDTH } from './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

const IN_HASH = `0x${'aa'.repeat(32)}`;
const OUT_HASH = `0x${'bb'.repeat(32)}`;
const WETH_HASH = `0x${'cc'.repeat(32)}`;
const TX_KEY = `tk-${'cd'.repeat(16)}`;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mounts wide (and restores the compact default afterwards, so no test leaks a viewport). */
async function wideApp(t, hash, backend = unlockedBackend(), opts = {}) {
  setViewportWidth(WIDE_WIDTH);
  t.after(() => setViewportWidth(COMPACT_WIDTH));
  const { app, root } = await mountApp(t, backend, { hash, ...opts });
  await app.idle();
  return { app, root, b: backend };
}

const contentPane = (root) => root.querySelector('main.app');
const detailPane = (root) => root.querySelector('aside.detail');
const rowFor = (root, go) => [...contentPane(root).querySelectorAll('[data-go]')]
  .find((el) => el.getAttribute('data-go') === go) || null;
const countCalls = (b, name) => b.calls.filter((c) => c[0] === name).length;

/**
 * An `unlockedBackend()` whose `nth` call to `group.method` blocks until `release()` is called.
 * `app.js` snapshots every backend method at mount, so the gate has to be installed before
 * mounting — hence the override rather than a post-mount reassignment (same shape as
 * screens.test.mjs's `stallFirst`, but able to pick a later call: the first is often the shell's
 * own, or the parent pane's).
 */
function gateNth(group, method, nth) {
  const src = unlockedBackend();
  let open;
  const gate = new Promise((r) => { open = r; });
  let n = 0;
  const b = unlockedBackend({
    [group]: {
      [method]: async (...args) => {
        n += 1;
        if (n === nth) await gate;
        return src[group][method](...args);
      },
    },
  });
  return { b, release: () => open() };
}

// ------------------------------------------------------------------ the two panes themselves ---

test('wide: opening a transaction keeps the activity list mounted and puts the tx beside it', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  const listBefore = contentPane(root).querySelector('.list');
  assert.ok(listBefore, 'the activity list is in the content pane');

  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();

  assert.ok(contentPane(root).querySelector('.list') === listBefore, 'the very same list node is still mounted');
  assert.match(contentPane(root).textContent, /Activity/);
  const detail = detailPane(root);
  assert.ok(detail, 'a detail pane exists');
  assert.match(detail.textContent, /Sent/);
  assert.equal(location.hash, `#tx/${OUT_HASH}`, 'the URL is the detail’s own hash');
  const row = rowFor(root, `tx/${OUT_HASH}`);
  assert.equal(row.getAttribute('aria-current'), 'true', 'the open row is marked');
});

test('wide: selecting a second row swaps only the detail pane and re-fetches nothing for the parent', async (t) => {
  const { app, root, b } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const listBefore = contentPane(root).querySelector('.list');
  const assetsListBefore = countCalls(b, 'assets.list');

  await app.go(`#tx/${IN_HASH}`);
  await app.idle();

  assert.ok(contentPane(root).querySelector('.list') === listBefore, 'the parent was not re-rendered');
  assert.equal(
    countCalls(b, 'assets.list') - assetsListBefore, 1,
    'only the new detail fetched — the parent did not fetch again',
  );
  assert.match(detailPane(root).textContent, /Received/);
  assert.equal(rowFor(root, `tx/${IN_HASH}`).getAttribute('aria-current'), 'true');
  assert.equal(rowFor(root, `tx/${OUT_HASH}`).getAttribute('aria-current'), null, 'the old row is unmarked');
});

test('wide: the detail pane closes with its close button, back to the parent route', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const close = detailPane(root).querySelector('[data-action="close-detail"]');
  assert.ok(close, 'the detail pane has a close button');
  assert.ok(detailPane(root).querySelector('[aria-label="Back"]') === null, 'and no compact back button');

  close.click();
  await app.idle();

  assert.equal(location.hash, '#activity');
  assert.equal(rowFor(root, `tx/${OUT_HASH}`).getAttribute('aria-current'), null);
  assert.doesNotMatch(detailPane(root) ? detailPane(root).textContent : '', /Sent/, 'the transaction is gone');
  assert.ok(document.activeElement === rowFor(root, `tx/${OUT_HASH}`), 'focus is back on the row that opened it');
});

test('wide: Escape closes the detail pane when no sheet is open', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.idle();

  assert.equal(location.hash, '#activity');
  assert.doesNotMatch(detailPane(root) ? detailPane(root).textContent : '', /Sent/);
});

test('wide: clicking the already-selected row closes the detail pane', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();

  rowFor(root, `tx/${OUT_HASH}`).click();
  await app.idle();

  assert.equal(location.hash, '#activity');
  assert.equal(rowFor(root, `tx/${OUT_HASH}`).getAttribute('aria-current'), null);
});

test('wide: opening a detail moves focus to the detail pane’s own title', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const focused = document.activeElement;
  assert.ok(detailPane(root).contains(focused), 'focus is inside the detail pane');
  assert.match(focused.textContent, /Transaction/);
});

// ------------------------------------------------------------------------ who the parent is ---

test('wide: a deep link straight to a transaction defaults its parent to activity', async (t) => {
  const { root } = await wideApp(t, `#tx/${OUT_HASH}`);
  assert.match(contentPane(root).textContent, /Activity/);
  assert.match(detailPane(root).textContent, /Sent/);
});

test('wide: a transaction opened from home keeps home in the content pane', async (t) => {
  const { app, root } = await wideApp(t, '#home');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(contentPane(root).querySelector('.hero'), 'home is still the content pane');
  assert.match(detailPane(root).textContent, /Sent/);
});

test('wide: an asset opens beside home', async (t) => {
  const { app, root } = await wideApp(t, '#home');
  await app.go('#asset/1');
  await app.idle();
  assert.ok(contentPane(root).querySelector('.hero'), 'home stays in the content pane');
  assert.match(detailPane(root).textContent, /wETH/);
  assert.equal(rowFor(root, 'asset/1').getAttribute('aria-current'), 'true');
});

test('wide: a note opened from a transaction keeps the same list in the content pane', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${IN_HASH}`);
  await app.idle();
  detailPane(root).querySelector('[data-go="note/3"]').click();
  await app.idle();
  assert.match(contentPane(root).textContent, /Activity/);
  assert.match(detailPane(root).textContent, /Shielded note/);
});

test('wide: an empty detail column says what to do on activity, and is absent on home', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  assert.ok(detailPane(root), 'activity reserves the detail column');
  assert.match(detailPane(root).textContent, /Select a transaction/);

  await app.go('#home');
  await app.idle();
  assert.ok(detailPane(root) === null, 'home with nothing selected has no detail column');
});

// ------------------------------------------------------------------------------- keyboard ----

test('wide: Down and Up move along the list and open each row, with focus staying in the list', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  const rows = [...contentPane(root).querySelectorAll('.row[data-go]')];
  assert.ok(rows.length >= 2, 'the fixture has rows to move between');
  rows[0].focus();

  rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await app.idle();
  assert.ok(document.activeElement === rows[1], 'roving focus stayed in the list');
  assert.equal(location.hash, `#${rows[1].getAttribute('data-go')}`, 'and the row opened in the detail pane');
  assert.equal(rows[1].getAttribute('aria-current'), 'true');
  assert.ok(detailPane(root).textContent.trim().length > 0);

  rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await app.idle();
  assert.ok(document.activeElement === rows[0], 'focus moved back up');
  assert.equal(location.hash, `#${rows[0].getAttribute('data-go')}`);
});

test('wide: Up on the first row and Down on the last do nothing', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  const rows = [...contentPane(root).querySelectorAll('.row[data-go]')];
  rows[0].focus();
  rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await app.idle();
  assert.ok(document.activeElement === rows[0], 'focus did not move past the first row');
  assert.equal(location.hash, '#activity', 'nothing was opened');

  const last = rows[rows.length - 1];
  last.focus();
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await app.idle();
  assert.ok(document.activeElement === last, 'focus did not move');
});

test('compact: the arrow keys do not hijack a list row', async (t) => {
  setViewportWidth(COMPACT_WIDTH);
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#activity' });
  await app.idle();
  const rows = [...contentPane(root).querySelectorAll('.row[data-go]')];
  rows[0].focus();
  rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await app.idle();
  assert.equal(location.hash, '#activity', 'no navigation');
  assert.ok(document.activeElement === rows[0], 'focus was not moved');
});

// ------------------------------------------------------------------- compact is unchanged ----

test('compact: a detail replaces the content pane and keeps its back button', async (t) => {
  setViewportWidth(COMPACT_WIDTH);
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#activity' });
  await app.idle();
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();

  assert.ok(detailPane(root) === null, 'no detail column below the breakpoint');
  assert.match(contentPane(root).textContent, /Sent/);
  assert.ok(contentPane(root).querySelector('[aria-label="Back"]'), 'the back button is still there');
  assert.ok(contentPane(root).querySelector('[data-action="close-detail"]') === null, 'and no close button');
});

test('popup mode is never two-pane, however wide the window is', async (t) => {
  setViewportWidth(WIDE_WIDTH);
  t.after(() => setViewportWidth(COMPACT_WIDTH));
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: `#tx/${OUT_HASH}`, mode: 'popup' });
  await app.idle();

  assert.ok(document.body.classList.contains('compact'));
  assert.ok(detailPane(root) === null, 'the popup is single-pane');
  assert.match(contentPane(root).textContent, /Sent/);
});

test('crossing the breakpoint re-lays-out without losing the route', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(detailPane(root));

  setViewportWidth(COMPACT_WIDTH);
  await app.idle();
  assert.equal(location.hash, `#tx/${OUT_HASH}`, 'the route survived');
  assert.ok(detailPane(root) === null, 'one pane now');
  assert.match(contentPane(root).textContent, /Sent/);

  setViewportWidth(WIDE_WIDTH);
  await app.idle();
  assert.match(contentPane(root).textContent, /Activity/, 'the parent is back in the content pane');
  assert.match(detailPane(root).textContent, /Sent/);
});

// ------------------------------------------------------------- lifecycle with two instances ---

test('a stale parent fetch cannot write into the parent that replaced it', async (t) => {
  // The activity list is mounted as a *parent* (the URL is the transaction), and its first fetch
  // is still in flight when the whole layout is replaced by home.
  const { b, release } = gateNth('assets', 'list', 1);
  setViewportWidth(WIDE_WIDTH);
  t.after(() => setViewportWidth(COMPACT_WIDTH));
  const { app, root } = await mountApp(t, b, { hash: '#faucet' });
  await app.idle();

  app.go(`#tx/${OUT_HASH}`); // deliberately not awaited: the parent's fetch is gated
  await tick();
  await app.go('#home');

  // `app.idle()` would wait on the gated call itself, so the gate opens first and idle() then
  // drains what the stale screen does with its answer.
  release();
  await app.idle();
  assert.ok(contentPane(root).querySelector('.hero'), 'home is on screen');
  assert.ok(contentPane(root).querySelector('[role="group"]') === null, 'the stale activity filters never landed');
});

test('a stale detail fetch cannot write into the detail that replaced it', async (t) => {
  // settings.get(): call 1 is the shell's own at mount, call 2 is the first transaction's.
  const { b, release } = gateNth('settings', 'get', 2);
  setViewportWidth(WIDE_WIDTH);
  t.after(() => setViewportWidth(COMPACT_WIDTH));
  const { app, root } = await mountApp(t, b, { hash: '#activity' });
  await app.idle();

  app.go(`#tx/${OUT_HASH}`); // gated mid-after()
  await tick();
  await app.go(`#tx/${IN_HASH}`);
  assert.match(detailPane(root).textContent, /Received/);

  release();
  await app.idle();
  assert.match(detailPane(root).textContent, /Received/, 'the stale transaction never painted');
  assert.doesNotMatch(detailPane(root).textContent, /Sent/);
});

test('a slow parent render cannot paint its own detail over the one now open', async (t) => {
  // The subtle one. The parent list is gated mid-render, so the render that opened transaction A
  // is still inside its *content* pane when the user opens transaction B. B reuses the parent
  // (nothing about the content pane changed, so A's content render is deliberately left alive to
  // finish) — and A, on resuming, must render the list and then stop, not carry on into a detail
  // pane that is no longer its own.
  const { b, release } = gateNth('assets', 'list', 1);
  setViewportWidth(WIDE_WIDTH);
  t.after(() => setViewportWidth(COMPACT_WIDTH));
  const { app, root } = await mountApp(t, b, { hash: '#faucet' });
  await app.idle();

  app.go(`#tx/${OUT_HASH}`); // the parent (activity) gates on its first assets.list
  await tick();
  await app.go(`#tx/${IN_HASH}`);
  assert.match(detailPane(root).textContent, /Received/, 'the second transaction is open');

  release();
  await app.idle();
  assert.match(contentPane(root).textContent, /Activity/, 'the parent finished rendering');
  assert.match(detailPane(root).textContent, /Received/, 'and left the open transaction alone');
  assert.doesNotMatch(detailPane(root).textContent, /Sent/);
});

test('swapping the detail pane drops the previous transaction’s key, as leaving a screen does', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const mask = detailPane(root).querySelector('[data-role="txkey"]');
  detailPane(root).querySelector('[data-role="reveal-key"]').click();
  assert.equal(mask.textContent, TX_KEY, 'the key is revealed in exactly one text node');

  await app.go(`#tx/${IN_HASH}`);
  await app.idle();

  assert.equal(mask.textContent, '', 'the swapped-out pane cleared its secret');
  assert.ok(!root.innerHTML.includes(TX_KEY), 'and nothing anywhere holds it');
});

test('closing the detail pane drops the transaction key too', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const mask = detailPane(root).querySelector('[data-role="txkey"]');
  detailPane(root).querySelector('[data-role="reveal-key"]').click();
  assert.equal(mask.textContent, TX_KEY);

  detailPane(root).querySelector('[data-action="close-detail"]').click();
  await app.idle();

  assert.equal(mask.textContent, '');
  assert.ok(!root.innerHTML.includes(TX_KEY));
});

test('locking while a detail is open tears down both panes and lands on the lock screen', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(detailPane(root));

  root.querySelector('.sidebar [data-action="lock"]').click();
  await app.idle();

  assert.equal(location.hash, '#lock');
  assert.ok(detailPane(root) === null, 'the detail pane is gone');
  assert.ok(!document.body.classList.contains('wide'), 'and so is the wide grid');
  assert.ok(!root.innerHTML.includes(TX_KEY));
});

test('destroy() tears down both panes', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(detailPane(root));

  app.destroy();
  assert.equal(root.innerHTML, '');
  assert.ok(!document.body.classList.contains('wide'));
});

test('idle() settles with both panes in flight', async (t) => {
  const { app, root, b } = await wideApp(t, '#activity');
  const before = b.calls.length;
  app.go(`#tx/${WETH_HASH}`);
  await app.idle();
  assert.ok(b.calls.length > before, 'the detail did fetch');
  assert.match(detailPane(root).textContent, /Received/);
});

test('the pinned chip and the toast region keep working with two panes', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(root.querySelector('.toast-area'), 'the toast region is still there');

  detailPane(root).querySelector('[data-role="copy-key"]').click();
  await app.idle();
  assert.match(root.querySelector('.toast-area').textContent, /Transaction key copied/);
  assert.ok(root.querySelector('.sidebar [data-role="pinned"]'), 'the sidebar still has its pinned slot');
});
