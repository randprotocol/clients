import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { mount, resolveRoute } from '../app.js';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';

test('route gating', () => {
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#home').name, 'welcome');
  assert.equal(resolveRoute({ exists: false, unlocked: false }, '#import').name, 'import');
  assert.equal(resolveRoute({ exists: true, unlocked: false }, '#send').name, 'lock');
  assert.deepEqual(resolveRoute({ exists: true, unlocked: true }, '#asset/1'), { name: 'asset', arg: '1' });
  assert.equal(resolveRoute({ exists: true, unlocked: true }, '').name, 'home');
});
test('first run shows welcome with create and import', async () => {
  const root = document.createElement('div'); document.body.append(root);
  await mount(root, fakeBackend());
  assert.ok(root.querySelector('[data-go="create"]'));
  assert.ok(root.querySelector('[data-go="import"]'));
  assert.equal(root.querySelector('.tabbar, .sidebar'), null);
});
test('create → password → backup check → home', async () => {
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend(); const app = await mount(root, b);
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

test("mode: 'popup' sets body.compact", async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, unlockedBackend(), { mode: 'popup' });
  assert.ok(document.body.classList.contains('compact'));
  assert.ok(document.body.classList.contains('popup'));
  app.destroy();
});

test('the tab bar exists once unlocked and marks the active tab with aria-current', async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const app = await mount(root, unlockedBackend());
  const nav = root.querySelector('.tabbar, .sidebar');
  assert.ok(nav);
  assert.equal(nav.tagName, 'NAV');
  const current = root.querySelector('[aria-current="page"]');
  assert.ok(current);
  assert.equal(current.getAttribute('data-go'), 'home');
  app.destroy();
});

test('backup screen never puts the spend key in location.hash', async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend();
  const app = await mount(root, b);
  await app.go('#create');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('input[name=confirm]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.match(location.hash, /^#backup/);
  const spendKey = await b.wallet.exportSpendKey();
  assert.doesNotMatch(location.hash, new RegExp(spendKey));
  assert.ok(!location.hash.includes('sk-'));
  app.destroy();
});

test('lock screen: wrong password shows an inline error and stays on #lock', async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const app = await mount(root, b);
  await app.go('#lock');
  root.querySelector('input[name=password]').value = 'totally the wrong one';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.match(location.hash, /^#lock/);
  const errorField = root.querySelector('.field.invalid');
  assert.ok(errorField);
  const input = errorField.querySelector('input[name=password]');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.ok(input.getAttribute('aria-describedby'));
  app.destroy();
});

test('lock screen: correct password lands on #home', async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const app = await mount(root, b);
  await app.go('#lock');
  root.querySelector('input[name=password]').value = 'correct horse battery';
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal(location.hash, '#home');
  assert.equal(await b.wallet.isUnlocked(), true);
  app.destroy();
});

test('a sheet opens with role=dialog and closes on Escape, restoring focus', async () => {
  location.hash = '';
  const root = document.createElement('div'); document.body.append(root);
  const b = fakeBackend();
  await b.wallet.create('correct horse battery');
  await b.wallet.lock();
  const app = await mount(root, b);
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
  app.destroy();
});
