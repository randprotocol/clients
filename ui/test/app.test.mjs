import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount, registerScreen, resolveRoute } from '../app.js';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

test('route gating', () => {
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#home').name, 'welcome');
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#import').name, 'import');
  assert.equal(resolveRoute({ exists: true, unlocked: false }, '#send').name, 'lock');
  assert.deepEqual(resolveRoute({ exists: true, unlocked: true }, '#asset/1'), { name: 'asset', arg: '1' });
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '').name, 'home');

  // A wallet exists: welcome/create/import must never come back, locked or not — reaching
  // wallet.create()/import() a second time overwrites (loses) the existing keys.
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '#create').name, 'home');
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '#import').name, 'home');
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '#welcome').name, 'home');
  assert.equal(resolveRoute({ exists: true, unlocked: false }, '#create').name, 'lock');
  // backup stays reachable once unlocked (it's how create/import land there in the first place).
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '#backup').name, 'backup');
});
test('first run shows welcome with create and import', async (t) => {
  const { root } = await mountApp(t, fakeBackend());
  assert.ok(root.querySelector('[data-go="create"]'));
  assert.ok(root.querySelector('[data-go="import"]'));
  assert.equal(root.querySelector('.tabbar, .sidebar'), null);
});
test('create → password → backup check → home', async (t) => {
  const b = fakeBackend();
  const { app, root } = await mountApp(t, b);
  await app.go('#create');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal(b.calls.filter(c => c[0] === 'wallet.create').length, 1);
  assert.match(location.hash, /^#backup/);
});

// --- additional coverage ---

test('mount throws on an invalid backend', async () => {
  await assert.rejects(() => mount(document.createElement('div'), {}));
  await assert.rejects(() => mount(document.createElement('div'), { wallet: {} }));
});

test("mode: 'popup' sets body.compact", async (t) => {
  await mountApp(t, unlockedBackend(), { mode: 'popup' });
  assert.ok(document.body.classList.contains('compact'));
  assert.ok(document.body.classList.contains('popup'));
});

test('the tab bar exists once unlocked and marks the active tab with aria-current', async (t) => {
  const { root } = await mountApp(t, unlockedBackend());
  const nav = root.querySelector('.tabbar, .sidebar');
  assert.ok(nav);
  assert.equal(nav.tagName, 'NAV');
  const current = root.querySelector('[aria-current="page"]');
  assert.ok(current);
  assert.equal(current.getAttribute('data-go'), 'home');
});

test('backup screen never puts the spend key in location.hash', async (t) => {
  const b = fakeBackend();
  const { app, root } = await mountApp(t, b);
  await app.go('#create');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.match(location.hash, /^#backup/);
  const spendKey = await b.wallet.exportSpendKey();
  assert.doesNotMatch(location.hash, new RegExp(spendKey));
  assert.ok(!location.hash.includes('sk-'));
});

test('lock screen: wrong password shows an inline error and stays on #lock', async (t) => {
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  root.querySelector('input[name=password]').value = 'totally the wrong one';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.match(location.hash, /^#lock/);
  const errorField = root.querySelector('.field.invalid');
  assert.ok(errorField);
  const input = errorField.querySelector('input[name=password]');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'lock-password-error');
});

test('lock screen: correct password lands on #home', async (t) => {
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal(location.hash, '#home');
  assert.equal(await b.wallet.isUnlocked(), true);
});

test('a sheet opens with role=dialog and closes on Escape, restoring focus', async (t) => {
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  const trigger = root.querySelector('[data-action="wipe"]');
  assert.ok(trigger);
  trigger.focus();
  trigger.click();
  await app.idle();
  const dialog = root.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.idle();
  assert.equal(root.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
});

test('create/import are unreachable once a wallet exists: #create redirects to #home without creating', async (t) => {
  const b = unlockedBackend();
  const { app } = await mountApp(t, b);
  await app.go('#create');
  assert.equal(location.hash, '#home');
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.create').length, 0);

  await app.go('#import');
  assert.equal(location.hash, '#home');
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.import').length, 0);
});

test('create screen: password field restores aria-describedby to the hint once valid again', async (t) => {
  const { app, root } = await mountApp(t, fakeBackend());
  await app.go('#create');
  const pw = root.querySelector('input[name=password]');
  const confirm = root.querySelector('input[name=confirm]');

  // Submitting a too-short password points aria-describedby at the error.
  pw.value = 'short';
  confirm.value = 'short';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal(pw.getAttribute('aria-invalid'), 'true');
  assert.equal(pw.getAttribute('aria-describedby'), 'password-error');

  // Typing past 10 characters (the live 'input' handler, not a submit) must restore it to the
  // field's own hint, not leave it pointed at an error message that no longer applies.
  pw.value = 'now it is long enough';
  pw.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  assert.equal(pw.hasAttribute('aria-invalid'), false);
  assert.equal(pw.getAttribute('aria-describedby'), 'password-hint');
});

test("destroy() unhooks the app: a later hashchange does not re-render, and body classes it added are cleared", async (t) => {
  location.hash = '';
  const root = document.createElement('div');
  document.body.append(root);
  const app = await mount(root, unlockedBackend());
  // Safety net, same as mountApp() gives every other test: this test calls destroy() itself
  // partway through (it is the thing under test), but a failed assertion between that call and
  // the manual root.remove() at the end must not leak the mount into the rest of the suite.
  // destroy() and root.remove() are both idempotent, so re-running them here is harmless whether
  // the test's own cleanup already ran or not.
  t.after(() => { try { app.destroy(); } catch { /* already torn down */ } root.remove(); });
  assert.ok(document.body.classList.contains('compact') || document.body.classList.contains('wide'));
  assert.ok(root.querySelector('.tabbar, .sidebar'));

  app.destroy();
  assert.equal(root.innerHTML, '');
  assert.ok(!document.body.classList.contains('compact'));
  assert.ok(!document.body.classList.contains('wide'));
  assert.ok(!document.body.classList.contains('popup'));
  assert.ok(!document.body.classList.contains('nav-on'));

  // A hashchange after destroy() must not resurrect the (now detached-from-the-app) root, and
  // must not re-add any body class — the window-level listener was removed by destroy().
  location.hash = '#activity';
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(root.innerHTML, '');
  assert.ok(!document.body.classList.contains('compact'));
  assert.ok(!document.body.classList.contains('wide'));

  root.remove();
  location.hash = '';
});

// ============================================================================ sessions =========
// A "session" is one stretch of one wallet being looked at. It ends on lock, wipe, unlock,
// create, import and destroy(); `ctx.state` is emptied and `ctx.session.signal` aborts at exactly
// that moment, so nothing derived from one wallet can be shown under the next one.

/** A screen that only records what `ctx.state`/`ctx.session` look like each time it is visited. */
const probeVisits = [];
registerScreen('probe', {
  render: () => '<div data-role="probe"></div>',
  after(ctx) {
    probeVisits.push({ sentinel: ctx.state.sentinel, sessionId: ctx.session.id, state: ctx.state, ctx });
    ctx.state.sentinel = `from-session-${ctx.session.id}`;
  },
});

async function unlockVia(app, root, password) {
  root.querySelector('input[name=password]').value = password;
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
}

test('ctx.session: a fresh mount is session 1 and exposes an unaborted signal', async (t) => {
  probeVisits.length = 0;
  const { app } = await mountApp(t, unlockedBackend(), { hash: '#probe' });
  await app.idle();
  assert.equal(probeVisits.length, 1);
  assert.equal(probeVisits[0].sessionId, 1);
  assert.equal(probeVisits[0].sentinel, undefined);
});

test('ctx.state keeps nothing from the previous session across a lock/unlock', async (t) => {
  probeVisits.length = 0;
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#probe' });
  await app.idle();
  const firstState = probeVisits[0].state;
  assert.equal(firstState.sentinel, 'from-session-1');

  root.querySelector('.sidebar [data-action="lock"]').click();
  await app.idle();
  assert.equal(location.hash, '#lock');

  await unlockVia(app, root, 'unlocked-password-1');
  await app.go('#probe');
  await app.idle();

  assert.equal(probeVisits.length, 2);
  assert.equal(probeVisits[1].sentinel, undefined, 'the sentinel from session 1 is gone');
  assert.notEqual(probeVisits[1].state, firstState, 'ctx.state is a different object');
  assert.ok(probeVisits[1].sessionId > probeVisits[0].sessionId);
});

test('ctx.session.signal aborts when the wallet is locked, and again when it is unlocked', async (t) => {
  probeVisits.length = 0;
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#probe' });
  await app.idle();
  const first = probeVisits[0];
  const firstSignal = app.session.signal;
  assert.equal(firstSignal.aborted, false);

  root.querySelector('.sidebar [data-action="lock"]').click();
  await app.idle();
  assert.equal(firstSignal.aborted, true, 'locking ends the session');
  const lockedSignal = app.session.signal;
  assert.equal(lockedSignal.aborted, false);
  assert.ok(app.session.id > first.sessionId);

  await unlockVia(app, root, 'unlocked-password-1');
  assert.equal(lockedSignal.aborted, true, 'unlocking ends the locked-out session too');
  assert.equal(app.session.aborted, undefined); // the session object is just {id, signal}
});

test('creating a wallet starts the new session before #backup renders', async (t) => {
  const b = fakeBackend();
  const { app, root } = await mountApp(t, b);
  await app.go('#create');
  const before = app.session.id;
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  assert.match(location.hash, /^#backup/);
  assert.ok(app.session.id > before, 'a new wallet is a new session');
  assert.equal(app.session.signal.aborted, false, 'and #backup runs inside it');
  // #backup must still be able to read the key it was sent there to show.
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.exportSpendKey').length, 1);
  assert.ok(root.querySelector('[data-role="key"]'));
});

test('wiping from the lock screen ends the session and closes the sheet', async (t) => {
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  const before = app.session.id;
  const beforeSignal = app.session.signal;
  root.querySelector('[data-action="wipe"]').click();
  await app.idle();
  root.querySelector('[role="dialog"] [data-role="confirm"]').click();
  await app.idle();

  assert.equal(await b.wallet.exists(), false);
  assert.equal(location.hash, '#welcome');
  assert.equal(root.querySelector('[role="dialog"]'), null, 'the sheet closed cleanly');
  assert.equal(root.querySelector('.scrim'), null);
  assert.equal(beforeSignal.aborted, true);
  assert.ok(app.session.id > before);
});

test('destroy() ends the session: the signal aborts and ctx.state is cleared', async (t) => {
  probeVisits.length = 0;
  location.hash = '#probe';
  const root = document.createElement('div');
  document.body.append(root);
  const app = await mount(root, unlockedBackend());
  t.after(() => { try { app.destroy(); } catch { /* already torn down */ } root.remove(); });
  await app.idle();
  const signal = app.session.signal;
  const state = probeVisits[0].state;

  app.destroy();
  assert.equal(signal.aborted, true);
  assert.equal(state.sentinel, undefined, 'the session state was emptied, not just replaced');
  root.remove();
  location.hash = '';
});

test('destroy() during the first await leaves the container empty and the body classes off', async (t) => {
  // The wallet-state read that opens every render is an await; a destroy() landing inside it used
  // to let that render carry on and re-insert the sidebar/tab bar into the emptied container.
  let release;
  const gate = new Promise((r) => { release = r; });
  const src = unlockedBackend();
  let n = 0;
  const b = unlockedBackend({ wallet: { exists: async () => { n += 1; if (n > 1) await gate; return src.wallet.exists(); } } });

  location.hash = '';
  const root = document.createElement('div');
  document.body.append(root);
  const app = await mount(root, b);
  t.after(() => { try { app.destroy(); } catch { /* already torn down */ } root.remove(); });

  app.go('#activity'); // not awaited: its very first await is gated
  await new Promise((r) => setTimeout(r, 0));
  app.destroy();
  release();
  await app.idle();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(root.innerHTML, '');
  assert.ok(!document.body.classList.contains('compact'));
  assert.ok(!document.body.classList.contains('wide'));
  assert.ok(!document.body.classList.contains('nav-on'));
  root.remove();
});

test('backup: a spend key arriving after the user navigated away is never written to the DOM', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = fakeBackend();
  b.wallet.exportSpendKey = async () => { await gate; return `sk-${'ab'.repeat(32)}`; };
  const { app, root } = await mountApp(t, b);
  await app.go('#create');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(location.hash, /^#backup/);

  await app.go('#home');
  release();
  await app.idle();
  await new Promise((r) => setTimeout(r, 0));

  assert.doesNotMatch(root.innerHTML, /sk-/, 'the key never reached the DOM');
  assert.doesNotMatch(location.hash, /sk-/);
  assert.equal(root.querySelector('[data-role="key"]'), null);
});

test('a screen that bypasses the helpers and calls backend.wallet.lock() still ends the session', async (t) => {
  // The helpers on ctx read better, but they are not the guarantee: the shell intercepts the
  // wallet methods themselves, so a screen written later cannot leave a session behind.
  probeVisits.length = 0;
  const { app } = await mountApp(t, unlockedBackend(), { hash: '#probe' });
  await app.idle();
  const { ctx } = probeVisits[0];
  const signal = app.session.signal;
  const before = app.session.id;

  await ctx.backend.wallet.lock();
  assert.equal(signal.aborted, true);
  assert.ok(app.session.id > before);
  assert.equal(ctx.state.sentinel, undefined);
});
