// `extension/shared/lib/idle-lock.js` against a fake `ext`: the whole of the extension's
// auto-lock, with no browser anywhere near it.
//
// Why this file exists at all. `makeWasmBackend`'s own idle timer is a `setTimeout`, which is
// right for a shell whose JS context outlives the wallet session and wrong for a popup — the
// popup's context is destroyed the instant it loses focus, so a timer armed while it was open
// never fires and auto-lock silently never happens. An MV3 service worker does not fix it either
// (Chrome evicts an idle one after ~30 s). `chrome.alarms` survives both, so the extension arms an
// alarm instead and learns that it fired by watching `storage.session` change underneath it.
//
//   node --test extension/test/idle-lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireIdleLock, AUTOLOCK_ALARM } from '../shared/lib/idle-lock.js';
import { UNLOCKED_SESSION_KEY } from '../../ui/engine/backend-wasm.js';

/** Resolves once every pending microtask has run — `noteActivity` is fire-and-forget by contract. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The four corners of the WebExtension API `idle-lock.js` is allowed to touch. */
function fakeExt() {
  const listeners = new Set();
  return {
    alarms: {
      created: [],
      cleared: [],
      async create(name, info) { this.created.push({ name, info }); },
      async clear(name) { this.cleared.push(name); return true; },
    },
    storage: {
      onChanged: {
        listeners,
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
      },
    },
    /** What the browser does to every extension context when some context writes storage. */
    emit(changes, area) { for (const fn of [...listeners]) fn(changes, area); },
  };
}

/** Just enough of a Backend for the wrapper to wrap: the five wallet methods, and settings. */
function fakeBackend({ autoLockMin = 15, unlocked = true } = {}) {
  const calls = [];
  const state = { autoLockMin, unlocked };
  const wallet = {
    async isUnlocked() { return state.unlocked; },
    async unlock(password) { calls.push(['unlock', password]); state.unlocked = true; return { address: 'rand1unlocked' }; },
    async create(password) { calls.push(['create', password]); state.unlocked = true; return { address: 'rand1created' }; },
    async import(secret, password) { calls.push(['import', secret, password]); state.unlocked = true; return { address: 'rand1imported' }; },
    async lock() { calls.push(['lock']); state.unlocked = false; },
    async wipe() { calls.push(['wipe']); state.unlocked = false; },
    noteActivity() { calls.push(['noteActivity']); },
    // The one `makeWasmBackend` provides, driven by the internal timer this design bypasses.
    // `wireIdleLock` must replace it, not add beside it.
    onLocked() { calls.push(['onLocked:engine']); return () => {}; },
  };
  const settings = {
    async get() { return { autoLockMin: state.autoLockMin, theme: 'system' }; },
    async set(patch) { Object.assign(state, patch); calls.push(['settings.set', { ...patch }]); return { autoLockMin: state.autoLockMin }; },
  };
  return { wallet, settings, calls, state };
}

/** A `storage.session` change that removed the unlocked session — what a lock looks like. */
const REMOVED = { [UNLOCKED_SESSION_KEY]: { oldValue: { spend_key: 'not-a-real-key' } } };

function wire(backend, ext, options = {}) {
  return wireIdleLock(backend, ext, { sessionKey: UNLOCKED_SESSION_KEY, ...options });
}

test('the alarm name is the one background.js listens for', () => {
  assert.equal(AUTOLOCK_ALARM, 'autolock');
});

test('wireIdleLock refuses to guess the session storage key', () => {
  assert.throws(() => wireIdleLock(fakeBackend(), fakeExt(), {}), /session/i);
});

test('noteActivity arms the alarm for the configured minutes, and still calls through', async () => {
  const backend = fakeBackend({ autoLockMin: 15 });
  const ext = fakeExt();
  wire(backend, ext);

  assert.equal(backend.wallet.noteActivity(), undefined, 'noteActivity answers nothing, by contract');
  await flush();

  assert.deepEqual(ext.alarms.created, [{ name: 'autolock', info: { delayInMinutes: 15 } }]);
  assert.deepEqual(backend.calls, [['noteActivity']]);
});

test('autoLockMin 0 clears the alarm rather than creating one', async () => {
  const backend = fakeBackend({ autoLockMin: 0 });
  const ext = fakeExt();
  wire(backend, ext);

  backend.wallet.noteActivity();
  await flush();

  assert.deepEqual(ext.alarms.created, []);
  assert.deepEqual(ext.alarms.cleared, ['autolock']);
});

test('a locked wallet arms nothing', async () => {
  const backend = fakeBackend({ autoLockMin: 15, unlocked: false });
  const ext = fakeExt();
  wire(backend, ext);

  backend.wallet.noteActivity();
  await flush();

  assert.deepEqual(ext.alarms.created, []);
  assert.deepEqual(ext.alarms.cleared, ['autolock']);
});

test('unlock, create and import each arm the alarm and pass their answer through', async () => {
  for (const [method, args] of [['unlock', ['a-password']], ['create', ['a-password']], ['import', ['a-secret', 'a-password']]]) {
    const backend = fakeBackend({ autoLockMin: 5, unlocked: false });
    const ext = fakeExt();
    wire(backend, ext);

    const answer = await backend.wallet[method](...args);

    assert.equal(typeof answer.address, 'string', `${method} returns the original's answer`);
    assert.deepEqual(backend.calls, [[method, ...args]]);
    assert.deepEqual(ext.alarms.created, [{ name: 'autolock', info: { delayInMinutes: 5 } }], `${method} arms the alarm`);
  }
});

test('lock and wipe clear the alarm', async () => {
  for (const method of ['lock', 'wipe']) {
    const backend = fakeBackend();
    const ext = fakeExt();
    wire(backend, ext);

    await backend.wallet[method]();

    assert.deepEqual(backend.calls, [[method]]);
    assert.deepEqual(ext.alarms.cleared, ['autolock']);
    assert.deepEqual(ext.alarms.created, []);
  }
});

test('saving a new auto-lock interval re-arms the alarm at the new interval', async () => {
  const backend = fakeBackend({ autoLockMin: 15 });
  const ext = fakeExt();
  wire(backend, ext);

  await backend.settings.set({ autoLockMin: 1 });

  assert.deepEqual(backend.calls, [['settings.set', { autoLockMin: 1 }]]);
  assert.deepEqual(ext.alarms.created, [{ name: 'autolock', info: { delayInMinutes: 1 } }]);
});

test('a settings change that is not about auto-lock leaves the alarm alone', async () => {
  const backend = fakeBackend({ autoLockMin: 15 });
  const ext = fakeExt();
  wire(backend, ext);

  await backend.settings.set({ theme: 'dark' });

  assert.deepEqual(ext.alarms.created, []);
  assert.deepEqual(ext.alarms.cleared, []);
});

test('the unlocked session disappearing underneath this page is a lock', async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  wire(backend, ext);

  const seen = [];
  const off = backend.wallet.onLocked((detail) => seen.push(detail));
  // The engine's own onLocked must have been replaced, not called.
  assert.ok(!backend.calls.some(([name]) => name === 'onLocked:engine'));

  ext.emit(REMOVED, 'session');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'idle');

  off();
  ext.emit(REMOVED, 'session');
  assert.equal(seen.length, 1, 'unsubscribing stops it');
});

test("a lock this page asked for does not come back as a lock nobody asked for", async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  wire(backend, ext);

  const seen = [];
  backend.wallet.onLocked((detail) => seen.push(detail));

  await backend.wallet.lock();
  ext.emit(REMOVED, 'session'); // the browser telling every context what this page just did
  assert.deepEqual(seen, [], 'the shell already knows about a lock it asked for');

  // …and the suppression is spent: the NEXT disappearance is the alarm's, and must be routed.
  ext.emit(REMOVED, 'session');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'idle');
});

test('a wipe this page asked for is not reported as an idle lock either', async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  wire(backend, ext);

  const seen = [];
  backend.wallet.onLocked((detail) => seen.push(detail));

  await backend.wallet.wipe();
  ext.emit(REMOVED, 'session');

  assert.deepEqual(seen, []);
});

test('the suppression expires, so a crashed lock cannot swallow a real one', async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  let clock = 1_000_000;
  wire(backend, ext, { now: () => clock, selfLockWindowMs: 2000 });

  const seen = [];
  backend.wallet.onLocked((detail) => seen.push(detail));

  await backend.wallet.lock();
  clock += 2001;
  ext.emit(REMOVED, 'session');

  assert.equal(seen.length, 1, 'a change long after this page locked is somebody else’s');
});

test('writes that are not the session disappearing are ignored', async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  wire(backend, ext);

  const seen = [];
  backend.wallet.onLocked((detail) => seen.push(detail));

  ext.emit(REMOVED, 'local'); // the wrong area
  ext.emit({ settings: { oldValue: { theme: 'dark' } } }, 'session'); // the wrong key
  ext.emit({ [UNLOCKED_SESSION_KEY]: { newValue: { spend_key: 'x' } } }, 'session'); // an unlock
  ext.emit({}, 'session');

  assert.deepEqual(seen, []);
});

test('disposing stops watching storage', async () => {
  const backend = fakeBackend();
  const ext = fakeExt();
  const dispose = wire(backend, ext);

  const seen = [];
  backend.wallet.onLocked((detail) => seen.push(detail));

  dispose();
  assert.equal(ext.storage.onChanged.listeners.size, 0);
  ext.emit(REMOVED, 'session');
  assert.deepEqual(seen, []);
  dispose(); // idempotent, and never throws
});

test('a browser that fails every alarm call does not break the wallet', async () => {
  const backend = fakeBackend({ autoLockMin: 5, unlocked: false });
  const ext = fakeExt();
  ext.alarms.create = async () => { throw new Error('no alarms here'); };
  ext.alarms.clear = async () => { throw new Error('no alarms here'); };
  wire(backend, ext);

  const answer = await backend.wallet.unlock('a-password');
  assert.equal(answer.address, 'rand1unlocked');
  backend.wallet.noteActivity();
  await flush();
});
