// Shell hardening carried over into task 1.5 (part A): four fixes to ui/app.js that the send and
// settings screens depend on.
//
//   A1 — a backend group may be a class *instance* (methods on the prototype), and may carry more
//        than BACKEND_SHAPE names: `platform.name`, optional functions, a whole optional group.
//   A2 — a backend method that throws synchronously must come back as a rejected promise.
//   A3 — `app.idle()` must settle work that resumes an arbitrary number of microtask hops after
//        the last tracked promise, with no fixed pass count, and must know about the wallet
//        methods the shell itself wraps.
//   A4 — after a route change, focus must not be left on `<body>` or on a detached node.
//
// A5 (an abort arriving while home is still mounted) lives in screens.test.mjs, next to the other
// home/scan tests.
//
// Deliberately a file of its own rather than more tests appended to app.test.mjs: these register
// screens of their own into the process-wide screen registry, and `node --test` gives each file
// its own process, so they cannot interfere with the routing the other file's tests assume.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { registerScreen } from '../app.js';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

/** A screen that hands its render's `ctx` back to the test and does nothing else. */
const visits = [];
registerScreen('spy', {
  render: () => '<h1 class="sr-only">Spy</h1><div data-role="spy"></div>',
  after(ctx) { visits.push(ctx); },
});

/** Rebuilds a plain `{method: fn}` group as a class *instance*: every method lives on the
 *  prototype, which is how a real shell's backend (`class ChromeWallet { … }`) is shaped. */
function classGroup(defs, ownFields = {}) {
  class Group {}
  for (const [key, value] of Object.entries(defs)) {
    Group.prototype[key] = typeof value === 'function' ? (...args) => value(...args) : value;
  }
  const instance = new Group();
  Object.assign(instance, ownFields);
  return instance;
}

// ------------------------------------------------------------------------------------- A1 -----
test('A1: a backend whose groups are class instances keeps every method, field and optional extra', async (t) => {
  visits.length = 0;
  const src = unlockedBackend();
  const b = unlockedBackend();
  let permissionArg = null;
  let flowArg = null;
  b.wallet = classGroup(b.wallet);
  b.assets = classGroup(b.assets);
  b.platform = classGroup(b.platform, { name: 'class-fake' });
  // Optional functions a real shell adds beyond BACKEND_SHAPE, on the prototype like the rest.
  Object.getPrototypeOf(b.platform).ensureHostPermission = async (origin) => { permissionArg = origin; return true; };
  Object.getPrototypeOf(b.platform).openFlowInTab = async (flow) => { flowArg = flow; return true; };
  // An optional *group* BACKEND_SHAPE does not know about at all (a future `bridge`).
  b.bridge = classGroup({ quote: async (amount) => `quote:${amount}` });

  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];

  assert.equal(await ctx.backend.wallet.exists(), true, 'a prototype method survived');
  assert.equal((await ctx.backend.wallet.info()).address, (await src.wallet.info()).address);
  assert.equal((await ctx.backend.assets.list()).length, 2);
  assert.equal(ctx.backend.platform.name, 'class-fake', 'a non-function field is carried over');
  assert.equal(typeof ctx.backend.platform.ensureHostPermission, 'function');
  assert.equal(await ctx.backend.platform.ensureHostPermission('https://node.example/*'), true);
  assert.equal(permissionArg, 'https://node.example/*');
  assert.equal(await ctx.backend.platform.openFlowInTab('send'), true);
  assert.equal(flowArg, 'send');
  assert.equal(await ctx.backend.bridge.quote('5'), 'quote:5', 'an optional group is wrapped too');
});

// ------------------------------------------------------------------------------------- A2 -----
test('A2: a backend method that throws synchronously comes back as a rejected promise', async (t) => {
  visits.length = 0;
  const b = unlockedBackend();
  // Not `async`: a real shell's guard clause ("no wallet unlocked") throws right away.
  b.faucet = { request: () => { throw new Error('the faucet is closed'); } };
  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];

  let threwSynchronously = false;
  let promise = null;
  try { promise = ctx.backend.faucet.request(); } catch { threwSynchronously = true; }
  assert.equal(threwSynchronously, false, 'the shell never lets a sync throw escape as a throw');
  assert.ok(promise && typeof promise.then === 'function');
  await assert.rejects(() => promise, /the faucet is closed/);
});

test('A2: the fake rejects, rather than throwing, when sync.scan is given an aborted signal', async () => {
  const b = unlockedBackend();
  const ac = new AbortController();
  ac.abort();
  let threwSynchronously = false;
  let promise = null;
  try { promise = b.sync.scan(undefined, { signal: ac.signal }); } catch { threwSynchronously = true; }
  assert.equal(threwSynchronously, false);
  await assert.rejects(() => promise, (err) => err.name === 'AbortError');
});

// ------------------------------------------------------------------------------------- A3 -----
/** A screen whose reaction resumes `hops` microtask hops after the last tracked promise settles,
 *  *outside* `after()` — so `renderPromise` is long resolved by the time it navigates, and only
 *  `idle()`'s own drain can be what waits for it. */
const navigated = [];
function hopScreen(name, hops) {
  registerScreen(name, {
    render: () => `<h1 class="sr-only">${name}</h1>`,
    after(ctx) {
      (async () => {
        await ctx.backend.wallet.info();
        for (let i = 0; i < hops; i += 1) await Promise.resolve();
        if (!ctx.isCurrent()) return;
        navigated.push(name);
        ctx.go('#home');
      })();
    },
  });
}
hopScreen('hops5', 5);
hopScreen('hops40', 40);

for (const [name, hops] of [['hops5', 5], ['hops40', 40]]) {
  test(`A3: idle() waits for a handler that awaits ${hops} more microtask hops before navigating`, async (t) => {
    navigated.length = 0;
    const { app } = await mountApp(t, unlockedBackend(), { hash: `#${name}` });
    await app.idle();
    assert.deepEqual(navigated, [name]);
    assert.equal(location.hash, '#home');
  });
}

test('A3: idle() waits for the wallet methods the shell itself wraps', async (t) => {
  // `ctx.lockWallet()` is wrapped a second time by the shell (to end the session); that outer
  // promise is the one `idle()` used not to know about.
  visits.length = 0;
  const { app } = await mountApp(t, unlockedBackend(), { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];
  const before = app.session.id;
  let settled = false;
  ctx.lockWallet().then(() => { settled = true; }, () => { settled = true; });
  await app.idle();
  assert.equal(settled, true, 'idle() did not return before the lock had settled');
  assert.ok(app.session.id > before);
});

// ------------------------------------------------------------------------------------- A4 -----
test('A4: after a session ends under an open sheet, focus moves to the new screen', async (t) => {
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  root.querySelector('[data-action="wipe"]').click();
  await app.idle();
  assert.ok(root.querySelector('[role="dialog"]'));

  root.querySelector('[role="dialog"] [data-role="confirm"]').click();
  await app.idle();

  assert.equal(location.hash, '#welcome');
  const active = document.activeElement;
  assert.ok(active !== document.body, 'focus did not fall back to <body>');
  assert.ok(root.contains(active), 'focus is inside the app');
  assert.equal(active.tagName, 'H1');
  assert.equal(active.getAttribute('tabindex'), '-1', 'the title was made programmatically focusable');
});

registerScreen('autofocused', {
  render: () => '<h1 class="title">Autofocused</h1><input name="first"><input name="second" data-autofocus>',
});

test('A4: a route change prefers the screen’s [data-autofocus] element', async (t) => {
  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#home' });
  await app.idle();
  document.body.focus(); // as a browser leaves it when the focused node is torn down
  await app.go('#autofocused');
  await app.idle();
  // Identity compared through `assert.ok`, never `assert.equal`: a failing `assert.equal` on two
  // DOM nodes makes node's assert build a diff by inspecting both, and inspecting a linkedom node
  // graph exhausts the heap. Every node comparison in this suite carries its own message for the
  // same reason.
  assert.ok(document.activeElement === root.querySelector('[data-autofocus]'), 'the [data-autofocus] input has focus');
});

test('A4: a route change leaves focus alone when it is already somewhere real', async (t) => {
  // Something outside the app that a re-render cannot detach — the shell only takes focus when it
  // has been dropped on `<body>` or on a node that is no longer in the document.
  const outside = document.createElement('button');
  document.body.append(outside);
  t.after(() => outside.remove());
  const { app } = await mountApp(t, unlockedBackend(), { hash: '#home' });
  await app.idle();
  outside.focus();
  await app.go('#activity');
  await app.idle();
  assert.ok(document.activeElement === outside, 'the shell did not steal focus');
});

// ------------------------------------------------------------------------------------- A1b ----
test('trackGroup copies accessor properties without invoking them at mount', async (t) => {
  visits.length = 0;
  let reads = 0;
  const b = unlockedBackend();
  const plain = b.platform;
  b.platform = Object.create(Object.getPrototypeOf(plain), Object.getOwnPropertyDescriptors(plain));
  Object.defineProperty(b.platform, 'version', {
    configurable: true,
    enumerable: true,
    get() { reads += 1; return '9.9.9'; },
  });

  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  assert.equal(reads, 0, 'mounting a backend must not run its getters');

  const ctx = visits[0];
  assert.equal(ctx.backend.platform.version, '9.9.9', 'but reading through the wrapper works');
  assert.equal(reads, 1, 'and forwards to the original, once per read');
  assert.equal(ctx.backend.platform.version, '9.9.9');
  assert.equal(reads, 2);
});

// ------------------------------------------------------------------------------------- 1.5b ----
test('the shell counts scans started, and counts a scan finished only when it fulfils', async (t) => {
  // The send flow's unknown-outcome gate is lifted by "a scan that started after the failure and
  // finished". The shell is what can see both, because every backend call goes through it.
  const ctl = { starts: 0, settle: [], fail: [] };
  const b = unlockedBackend({
    sync: {
      scan: () => {
        ctl.starts += 1;
        return new Promise((resolve, reject) => { ctl.settle.push(resolve); ctl.fail.push(reject); });
      },
    },
  });
  visits.length = 0;
  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];
  assert.equal(ctx.state.scansStarted || 0, 0, 'nothing has scanned yet');

  ctx.backend.sync.scan(() => {});
  assert.equal(ctx.state.scansStarted, 1, 'counted at the call, not at the answer');
  assert.equal(ctx.state.scansConfirmed || 0, 0);

  ctl.fail[0](new Error('the node could not be reached'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.state.scansConfirmed || 0, 0, 'a scan that failed saw nothing');

  ctx.backend.sync.scan(() => {});
  assert.equal(ctx.state.scansStarted, 2);
  ctl.settle[1]({ notes: [], activity: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.state.scansConfirmed, 2, 'and one that fulfilled did');
});
