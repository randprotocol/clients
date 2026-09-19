import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount, resolveRoute } from '../app.js';
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
