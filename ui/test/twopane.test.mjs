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
import { registerScreen } from '../app.js';
import { TWO_PANE_AT, listParent } from '../lib/panes.js';

const IN_HASH = `0x${'aa'.repeat(32)}`;
const OUT_HASH = `0x${'bb'.repeat(32)}`;
const WETH_HASH = `0x${'cc'.repeat(32)}`;
const TX_KEY = `tk-${'cd'.repeat(16)}`;

const tick = () => new Promise((r) => setTimeout(r, 0));
const turns = async (n = 3) => { for (let i = 0; i < n; i += 1) await tick(); };

/**
 * A detail screen whose whole lifecycle a test can count: every mount appends to `probe.mounted`,
 * every cleanup increments `probe.cleanups`. That is what makes "exactly one live instance per
 * pane, zero orphaned cleanups" assertable rather than inferred — a screen that is mounted over
 * without being retired shows up here as a second mount with no matching cleanup.
 *
 * Registered at module scope, like every real screen; `node --test` gives this file its own
 * process, so nothing else sees it.
 */
const probe = { mounted: [], cleanups: [], sheets: 0 };
probe.reset = () => { probe.mounted.length = 0; probe.cleanups.length = 0; probe.sheets = 0; };
probe.countOf = (list, arg) => list.filter((a) => a === arg).length;
registerScreen('probe', {
  pane: 'detail',
  parent: (_arg, from) => listParent(from, '#activity'),
  render: () => '<h1 class="sr-only">Probe</h1>',
  after(ctx, root, arg) {
    root.innerHTML = `<h1 class="sr-only">Probe</h1><div class="card"><span class="title">probe ${String(arg)}</span></div>`;
    probe.mounted.push(arg);
    // `#probe/sheet` opens a real modal, for the Escape-precedence test.
    if (arg === 'sheet') {
      probe.sheets += 1;
      ctx.sheet('<h3 class="sheet-title">Probe sheet</h3><button class="btn" type="button" data-role="cancel">Cancel</button>');
    }
    return () => { probe.cleanups.push(arg); };
  },
});

/** Mounts wide (and restores the compact default afterwards, so no test leaks a viewport). */
async function wideApp(t, hash, backend = unlockedBackend(), opts = {}) {
  return atWidth(t, WIDE_WIDTH, hash, backend, opts);
}

/** Mounts at an exact viewport width. `WIDE_WIDTH` is past the two-pane breakpoint. */
async function atWidth(t, width, hash, backend = unlockedBackend(), opts = {}) {
  probe.reset();
  setViewportWidth(width);
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

// ======================================================================== fix round 1 =========
// Everything below is the fix round: pane identity, the second breakpoint, and the holes the
// review found in the first version.

// ---------------------------------------------------- pane identity is an epoch, not a key ---
// The first version compared pane *keys* to decide whether a slow render still owned a pane.
// A key is not an identity: `#tx/A → #tx/B → #tx/A` brings the old key back, so a render that had
// been asleep since the first A woke up believing it still owned the pane and mounted a second
// instance over the live one — orphaning its cleanup, which is where a revealed transaction key
// was left sitting in a detached node with its window listeners still attached.

test('ABA: a render asleep since #probe/A does not remount when #probe/A comes back', async (t) => {
  const { b, release } = gateNth('assets', 'list', 1); // the parent list's own first fetch
  const { app, root } = await atWidth(t, WIDE_WIDTH, '#faucet', b);

  app.go('#probe/A'); // the parent gates; this render is now asleep inside renderPane(content)
  await tick();
  await app.go('#probe/B');
  await app.go('#probe/A'); // the key the sleeping render captured is back
  assert.deepEqual(probe.mounted, ['B', 'A'], 'B then A, each once');

  release();
  await app.idle();

  assert.deepEqual(probe.mounted, ['B', 'A'], 'the sleeping render did not mount a third time');
  assert.equal(probe.countOf(probe.cleanups, 'B'), 1, "B's cleanup ran exactly once");
  assert.equal(probe.countOf(probe.cleanups, 'A'), 0, 'the live A was never torn down');
  const panes = app.debugPanes();
  assert.equal(panes.detail.key, 'probe:A', 'the detail pane holds what the URL says');
  assert.equal(panes.detail.hasCleanup, true, 'and exactly one live instance owns its cleanup');
  assert.match(detailPane(root).textContent, /probe A/);
});

test('ABA: the transaction open when a stale render wakes keeps its key, and no detached node holds one', async (t) => {
  const { b, release } = gateNth('assets', 'list', 1);
  const { app, root } = await atWidth(t, WIDE_WIDTH, '#faucet', b);

  app.go(`#tx/${OUT_HASH}`); // asleep in the parent render
  await tick();
  await app.go(`#tx/${IN_HASH}`);
  await app.go(`#tx/${OUT_HASH}`); // back to the key the sleeping render holds
  const liveMask = detailPane(root).querySelector('[data-role="txkey"]');
  detailPane(root).querySelector('[data-role="reveal-key"]').click();
  assert.equal(liveMask.textContent, TX_KEY, 'the key is revealed on the live instance');
  const fetchesBefore = countCalls(b, 'settings.get');

  release();
  await app.idle();

  assert.equal(countCalls(b, 'settings.get') - fetchesBefore, 0, 'no second detail fetch');
  assert.ok(detailPane(root).contains(liveMask), 'the live instance was not replaced');
  assert.equal(liveMask.textContent, TX_KEY, 'and still holds its own revealed key');
  assert.equal(app.debugPanes().detail.key, `tx:${OUT_HASH}`);
});

test('a revealed key is blanked even when the pane is remounted with the same route', async (t) => {
  // The mirror image: when the detail *is* legitimately replaced by the same route, the outgoing
  // instance must still be torn down — one cleanup, one blanked node, no listeners left behind.
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  const firstMask = detailPane(root).querySelector('[data-role="txkey"]');
  detailPane(root).querySelector('[data-role="reveal-key"]').click();
  assert.equal(firstMask.textContent, TX_KEY);

  await app.go(`#tx/${IN_HASH}`);
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();

  assert.equal(firstMask.textContent, '', 'the first instance blanked its own node');
  assert.ok(!root.innerHTML.includes(TX_KEY), 'and nothing on screen holds the key');
  const live = detailPane(root).querySelector('[data-role="txkey"]');
  assert.ok(live !== firstMask, 'the live instance is a new node');
});

test('a slow parent finishing after a different parent and detail took over writes nothing', async (t) => {
  // P1 (activity) is slow; the user moves to P2 (home) and opens D2 (an asset) before it answers.
  const { b, release } = gateNth('assets', 'list', 1);
  const { app, root } = await atWidth(t, WIDE_WIDTH, '#faucet', b);

  app.go(`#tx/${OUT_HASH}`); // P1 = activity, gated
  await tick();
  await app.go('#home');
  await app.go('#asset/1');
  assert.ok(contentPane(root).querySelector('.hero'), 'home is the content pane');

  release();
  await app.idle();

  assert.ok(contentPane(root).querySelector('.hero'), 'home survived');
  assert.ok(contentPane(root).querySelector('[role="group"]') === null, 'no activity filters landed');
  assert.match(detailPane(root).textContent, /wETH/, 'the asset is still open');
  const panes = app.debugPanes();
  assert.equal(panes.content.key, '1:home:');
  assert.equal(panes.detail.key, 'asset:1');
});

test('crossing the breakpoint while a detail fetch is pending leaves exactly one instance', async (t) => {
  // settings.get(): call 1 is the shell's own at mount, call 2 is the first transaction's.
  const { b, release } = gateNth('settings', 'get', 2);
  const { app, root } = await atWidth(t, WIDE_WIDTH, '#activity', b);

  app.go(`#tx/${OUT_HASH}`); // the detail pane's after() is gated
  await tick();
  setViewportWidth(COMPACT_WIDTH); // …and the layout collapses under it
  await turns(4);

  release();
  await app.idle();

  assert.ok(detailPane(root) === null, 'no detail column below the breakpoint');
  assert.match(contentPane(root).textContent, /Sent/, 'the transaction took the content pane');
  assert.equal(contentPane(root).querySelectorAll('[data-role="txkey"]').length, 1, 'mounted once');
  const panes = app.debugPanes();
  assert.equal(panes.detail.key, '', 'the detail pane is empty');
  assert.equal(panes.detail.hasCleanup, false, 'and owns no cleanup');
});

// ------------------------------------------------- the second breakpoint: room for two panes ---

test('two-pane starts at the second breakpoint, not at the sidebar breakpoint', async (t) => {
  assert.equal(TWO_PANE_AT, 1080, 'the shell and the stylesheet agree on one number');
  for (const [width, expectTwoPane] of [[900, false], [1079, false], [1080, true], [1200, true]]) {
    const { app, root } = await atWidth(t, width, `#tx/${OUT_HASH}`);
    const hasDetail = detailPane(root) !== null;
    assert.equal(hasDetail, expectTwoPane, `${width}px → ${expectTwoPane ? 'two' : 'one'} pane`);
    if (!expectTwoPane) {
      assert.match(contentPane(root).textContent, /Sent/, `${width}px: the detail replaces the content pane`);
      assert.ok(contentPane(root).querySelector('[aria-label="Back"]'), `${width}px: with a back button`);
    } else {
      assert.ok(detailPane(root).querySelector('[data-action="close-detail"]'), `${width}px: with a close button`);
    }
    app.destroy();
  }
});

test('between the two breakpoints there is a sidebar but only one pane', async (t) => {
  const { root } = await atWidth(t, 1000, '#activity');
  assert.ok(root.querySelector('.sidebar'), 'the sidebar is there from 900px');
  assert.ok(document.body.classList.contains('wide'), 'and the wide layout is on');
  assert.ok(detailPane(root) === null, 'but no detail column, not even the placeholder');
  assert.ok(!document.body.classList.contains('two-pane'));
});

test('the stylesheet and the shell cannot drift on the breakpoint', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../base.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`--two-pane-at:\\s*${TWO_PANE_AT}px`), 'the custom property records it');
  assert.match(css, new RegExp(`@media\\s*\\(min-width:\\s*${TWO_PANE_AT}px\\)`), 'and the media query uses it');
  assert.doesNotMatch(css, /:has\(\.detail\)/, 'the grid is driven by body.two-pane, not :has()');
});

test('the shell marks the two-pane layout with a class the grid can use', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  assert.ok(document.body.classList.contains('two-pane'), 'activity reserves its column');
  await app.go('#home');
  await app.idle();
  assert.ok(!document.body.classList.contains('two-pane'), 'home with nothing selected does not');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.ok(document.body.classList.contains('two-pane'));
  assert.ok(detailPane(root));
  app.destroy();
  assert.ok(!document.body.classList.contains('two-pane'), 'and destroy() clears it');
});

// -------------------------------------------------------------------------- smaller holes ----

test('a wallet session end takes the selection and the close target with it', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go(`#tx/${OUT_HASH}`);
  await app.idle();
  assert.equal(app.debugPanes().selected, `tx/${OUT_HASH}`);

  root.querySelector('.sidebar [data-action="lock"]').click();
  await app.idle();

  const panes = app.debugPanes();
  assert.equal(panes.selected, null, 'the previous wallet’s selection is gone');
  assert.equal(panes.closeTo, null, 'and so is its close target');
  assert.ok(!JSON.stringify(panes).includes(OUT_HASH), 'nothing in shell state names the old wallet’s transaction');
});

test('the arrow keys leave a modified keypress and a text field alone', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  const rows = [...contentPane(root).querySelectorAll('.row[data-go]')];
  rows[0].focus();
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, [mod]: true }));
    await tick();
    assert.equal(location.hash, '#activity', `${mod} + ArrowDown navigates nothing`);
    assert.ok(document.activeElement === rows[0], `${mod} + ArrowDown moves no focus`);
  }

  // A row that contains a text field (none today, but the filter chips and the send flow put
  // inputs inside the content pane): typing in one must never be hijacked.
  const input = document.createElement('input');
  rows[1].append(input);
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await tick();
  assert.equal(location.hash, '#activity', 'an input keeps its own arrow keys');
});

test('a note deep-linked with nothing to go on opens beside the activity list', async (t) => {
  const { root } = await wideApp(t, '#note/3');
  // Home also has an "Activity" heading, so the assertion is on what only the activity screen
  // has — its asset filter chips — and on the absence of home's balance hero.
  assert.ok(contentPane(root).querySelector('[role="group"]'), 'activity is the default parent');
  assert.ok(contentPane(root).querySelector('.hero') === null, 'not home');
  assert.match(detailPane(root).textContent, /Shielded note/);
});

test('closing a transaction opened from an asset puts focus back on its row', async (t) => {
  // The asset is a list too, so a transaction opened from it keeps it in the content pane; closing
  // returns to `#asset/1`, which on a wide screen is home + the asset — and the row that opened
  // the transaction is now in the *detail* pane, where focus has to follow it.
  const { app, root } = await atWidth(t, WIDE_WIDTH, '#asset/1');
  await app.idle();
  const assetRow = [...detailPane(root).querySelectorAll('[data-go]')]
    .find((el) => el.getAttribute('data-go') === `tx/${WETH_HASH}`);
  assert.ok(assetRow, 'the asset detail lists its own transactions');
  assetRow.click();
  await app.idle();
  assert.match(contentPane(root).textContent, /wETH/, 'the asset moved into the content pane');

  detailPane(root).querySelector('[data-action="close-detail"]').click();
  await app.idle();

  assert.equal(location.hash, '#asset/1');
  // Home (now the content pane) and the asset (now the detail pane) both list that transfer, so
  // "the row" is two nodes. Focus has to be on the one in the pane the user's attention moved to.
  const focused = document.activeElement;
  assert.equal(focused.getAttribute('data-go'), `tx/${WETH_HASH}`, 'focus is on the row that opened it');
  assert.ok(detailPane(root).contains(focused), 'the copy inside the asset pane, not home’s');
});

test('Escape with a sheet open closes the sheet, not the detail pane', async (t) => {
  const { app, root } = await wideApp(t, '#activity');
  await app.go('#probe/sheet');
  await app.idle();
  assert.equal(probe.sheets, 1);
  assert.ok(root.querySelector('[role="dialog"]'), 'the sheet is open');

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.idle();
  assert.ok(root.querySelector('[role="dialog"]') === null, 'the sheet closed');
  assert.equal(location.hash, '#probe/sheet', 'the detail pane stayed open');
  assert.ok(detailPane(root), 'and is still mounted');

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.idle();
  assert.equal(location.hash, '#activity', 'the second Escape closes the detail');
});

test('a hostile route argument renders the not-found state and breaks nothing', async (t) => {
  const HOSTILE = [
    '#tx/"]);alert(1)//',
    '#tx/<img src=x onerror=alert(1)>',
    '#asset/../../x',
    '#note/-1',
    `#tx/${'z'.repeat(5000)}`,
  ];
  const { app, root } = await wideApp(t, '#activity');
  for (const hash of HOSTILE) {
    await app.go(hash);
    await app.idle();
    const pane = detailPane(root) || contentPane(root);
    assert.match(pane.textContent, /not found/i, `${hash.slice(0, 40)} → not found`);
    assert.ok(root.querySelector('img') === null, 'no markup came out of the argument');
    assert.ok(root.querySelector('script') === null);
    // …and a real list is still mounted beside it, so the app is still usable. (Which list it is
    // depends on the argument: `#asset/<anything>` is itself a parent route, so it becomes the
    // remembered origin even when no such asset exists — a route string, behaving like one.)
    assert.ok(contentPane(root).textContent.trim().length > 0, 'the content pane still holds a screen');
    assert.ok(app.debugPanes().content.key, 'and the shell knows which');
  }
  await app.go('#activity');
  await app.idle();
  assert.match(contentPane(root).textContent, /Activity/, 'and it recovers');
});
