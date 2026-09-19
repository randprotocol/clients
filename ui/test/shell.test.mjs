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
import { markUnknownOutcome, unknownOutcome } from '../screens/send/state.js';

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

test('a scan from an ended session never touches the next session’s counters', async (t) => {
  // `endSession()` replaces `ctx.state`, and a scan started under the old wallet settles later. If
  // its fulfilment writes its ordinal into the *new* session's `scansConfirmed`, that session
  // starts life believing a scan has already confirmed — and the send flow's unknown-outcome gate
  // (which is lifted by `scansConfirmed > atStarted`, and records `atStarted = 0` in a fresh
  // session) is lifted before any scan has run at all.
  const ctl = { settle: [] };
  const b = unlockedBackend({
    sync: { scan: () => new Promise((resolve) => { ctl.settle.push(resolve); }) },
  });
  visits.length = 0;
  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];

  ctx.backend.sync.scan(() => {});
  assert.equal(ctx.state.scansStarted, 1);

  const before = app.session.id;
  ctx.endSession();
  assert.ok(app.session.id > before, 'the session ended');
  assert.equal(ctx.state.scansStarted || 0, 0, 'the new session starts from zero');

  ctl.settle[0]({ notes: [], activity: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.state.scansConfirmed || 0, 0, 'the old session’s scan did not credit the new one');

  // …which is what keeps the unknown-outcome notice standing in the new session.
  markUnknownOutcome(ctx, { hash: null });
  assert.ok(unknownOutcome(ctx), 'the unknown-outcome record was lifted by a scan from another wallet');
});

// ------------------------------------------------------------------------------------- 1.6 ----
test('wallet.onLocked: a lock the backend decided on ends the session and shows the lock screen', async (t) => {
  // Every real backend locks on an idle timer of its own (`settings.autoLockMin`). Without this
  // hook the previous wallet's screen — and its data — would stay on display until something
  // happened to re-render.
  visits.length = 0;
  let fire = null;
  let unsubscribed = 0;
  const b = unlockedBackend();
  let locked = false;
  b.wallet.isUnlocked = async () => !locked;
  b.wallet.onLocked = (cb) => { fire = cb; return () => { unsubscribed += 1; }; };

  const { app, root } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];
  ctx.state.somethingFromThisWallet = 'balance';
  const before = app.session.id;
  assert.ok(typeof fire === 'function', 'the shell subscribed');

  locked = true;
  fire({ reason: 'idle' });
  await app.idle();

  assert.ok(app.session.id > before, 'the wallet session ended');
  assert.equal(ctx.state.somethingFromThisWallet, undefined, 'and everything derived from it went');
  assert.equal(location.hash, '#lock');
  assert.ok(root.querySelector('input[name=password]'), 'the lock screen is on display');

  app.destroy();
  assert.equal(unsubscribed, 1, 'destroy() unsubscribes');
});

test('wallet.onLocked: a backend without one still mounts (it is optional)', async (t) => {
  const b = unlockedBackend();
  assert.equal(typeof b.wallet.onLocked, 'undefined');
  const { app } = await mountApp(t, b, { hash: '#home' });
  await app.idle();
  assert.equal(location.hash, '#home');
});

test('a backend whose wrapped methods are accessors still mounts and works', async (t) => {
  // `trackGroup` forwards an accessor property with a getter and *no setter*. The shell then
  // re-wraps `sync.scan` and the five session-ending `wallet.*` methods by assignment — which on
  // a getter-only property throws "Cannot set property … which has only a getter" in strict mode
  // (an ES module is always strict), so such a backend could not be mounted at all.
  visits.length = 0;
  const b = unlockedBackend();
  const scan = b.sync.scan;
  const lock = b.wallet.lock;
  let scans = 0;
  let locks = 0;
  Object.defineProperty(b.sync, 'scan', {
    configurable: true,
    enumerable: true,
    get() { return (...args) => { scans += 1; return scan(...args); }; },
  });
  Object.defineProperty(b.wallet, 'lock', {
    configurable: true,
    enumerable: true,
    get() { return (...args) => { locks += 1; return lock(...args); }; },
  });

  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];

  await ctx.backend.sync.scan(() => {});
  assert.equal(scans, 1, 'the accessor-backed scan ran');
  assert.equal(ctx.state.scansConfirmed, 1, 'and the shell still counted it');

  const before = app.session.id;
  await ctx.lockWallet();
  assert.equal(locks, 1, 'the accessor-backed lock ran');
  assert.ok(app.session.id > before, 'and the shell still ended the session around it');
});

// ------------------------------------------------------------------------- fix round 1 --------
test('wallet.onLocked and wallet.noteActivity are forwarded synchronously, not promise-wrapped', async (t) => {
  // `trackGroup` turns every backend method into one that returns a Promise, which is right for an
  // operation and wrong for a subscription: `onLocked(cb)` answers with the *unsubscribe function*,
  // and a screen that called the Promise it got back instead would throw.
  visits.length = 0;
  const b = unlockedBackend();
  let unsubscribed = 0;
  let noted = 0;
  b.wallet.onLocked = () => () => { unsubscribed += 1; };
  b.wallet.noteActivity = () => { noted += 1; return undefined; };

  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  const ctx = visits[0];

  const off = ctx.backend.wallet.onLocked(() => {});
  assert.equal(typeof off, 'function', 'onLocked came back wrapped in a Promise');
  off();
  assert.equal(unsubscribed, 1);

  const before = noted;
  const answer = ctx.backend.wallet.noteActivity();
  assert.equal(answer, undefined, 'noteActivity came back wrapped in a Promise');
  assert.equal(noted, before + 1);

  // …and an ordinary method is still tracked.
  const p = ctx.backend.wallet.exists();
  assert.equal(typeof p.then, 'function');
  await p;
});

test('the shell tells the backend about user input, throttled, and stops on destroy', async (t) => {
  // The backend's idle timer keys off this and nothing else (ui/backend.js), so the shell has to
  // actually send it — and must not send one per keystroke.
  visits.length = 0;
  const b = unlockedBackend();
  const events = [];
  b.wallet.noteActivity = () => { events.push(Date.now()); };
  const { app, root } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();

  const fire = (type) => root.dispatchEvent(new window.Event(type, { bubbles: true }));
  fire('pointerdown');
  assert.equal(events.length, 1, 'a pointer event was not reported');
  for (let i = 0; i < 20; i += 1) fire('keydown');
  assert.equal(events.length, 1, 'every keystroke was reported — the throttle is missing');

  // A different event type on a child node still bubbles up to the container.
  const child = root.querySelector('[data-role="spy"]');
  child.dispatchEvent(new window.Event('wheel', { bubbles: true }));
  assert.equal(events.length, 1, 'still inside the throttle window');

  app.destroy();
  const after = events.length;
  fire('pointerdown');
  fire('keydown');
  assert.equal(events.length, after, 'the shell kept reporting activity after destroy()');
});

test('a backend with no noteActivity is fine, and user input costs nothing', async (t) => {
  const b = unlockedBackend();
  assert.equal(typeof b.wallet.noteActivity, 'undefined');
  const { app, root } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  assert.doesNotThrow(() => root.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
});

// ------------------------------------------------------------------------- fix round 2 --------
test('destroy() disposes the backend, last, and survives one that throws', async (t) => {
  // A real backend holds things outside its own object — a BroadcastChannel, a port. Without this
  // they outlive the mount that opened them.
  const order = [];
  const b = unlockedBackend();
  b.wallet.onLocked = () => () => order.push('unsubscribed');
  b.dispose = () => order.push('disposed');
  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  app.destroy();
  assert.deepEqual(order, ['unsubscribed', 'disposed']);
  assert.doesNotThrow(() => app.destroy(), 'a second destroy must be harmless');

  const noisy = unlockedBackend();
  noisy.dispose = () => { throw new Error('the port was already closed'); };
  const second = await mountApp(t, noisy, { hash: '#spy' });
  await second.app.idle();
  assert.doesNotThrow(() => second.app.destroy(), 'a failing dispose must not fail a teardown');
});

test('a backend with no dispose is fine', async (t) => {
  const b = unlockedBackend();
  assert.equal(typeof b.dispose, 'undefined');
  const { app } = await mountApp(t, b, { hash: '#spy' });
  await app.idle();
  assert.doesNotThrow(() => app.destroy());
});
