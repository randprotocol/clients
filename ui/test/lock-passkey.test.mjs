// The lock screen with a passkey set up: Touch ID is the default — offered first and asked for at
// once — and the password is the way back when it cannot answer or no longer opens the wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { fakeBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

const PW = 'correct horse battery';

function passkey({ password = PW, cancel = false, enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    label: () => 'Touch ID',
    available: async () => true,
    enabled: async () => enabled,
    async recoverPassword() {
      calls.push('recover');
      if (cancel) throw Object.assign(new Error('Unlock was cancelled.'), { code: 'CANCELLED' });
      return password;
    },
    async disable() { calls.push('disable'); },
  };
}

async function locked(pk) {
  const b = fakeBackend();
  await b.wallet.create(PW);
  await b.wallet.lock();
  b.wallet.passkey = pk;
  return b;
}
const settle = async (app) => { for (let i = 0; i < 5; i += 1) { await app.idle(); await new Promise((r) => setTimeout(r, 0)); } };

test('with Touch ID set up, the lock screen asks for it at once and lands on #home', async (t) => {
  const pk = passkey();
  const b = await locked(pk);
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  await settle(app);
  assert.deepEqual(pk.calls, ['recover'], 'asked for once, without a click');
  assert.equal(location.hash, '#home');
  assert.equal(await b.wallet.isUnlocked(), true);
  void root;
});

test('a dismissed prompt leaves the button and the password, and says how to retry', async (t) => {
  const pk = passkey({ cancel: true });
  const b = await locked(pk);
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  await settle(app);
  assert.match(location.hash, /^#lock/);
  const btn = root.querySelector('[data-action="passkey"]');
  assert.equal(btn.textContent, 'Unlock with Touch ID');
  assert.equal(root.querySelector('[data-role="passkey-slot"]').hidden, false);
  assert.match(root.querySelector('[data-role="passkey-note"]').textContent, /Cancelled/);
  assert.equal(root.querySelector('form button[type=submit]').textContent, 'Unlock with password');
});

test('a password changed since Touch ID sealed it: the record is dropped and the password asked for', async (t) => {
  const pk = passkey({ password: 'an old password, long gone' });
  const b = await locked(pk);
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  await settle(app);
  assert.match(location.hash, /^#lock/);
  assert.deepEqual(pk.calls, ['recover', 'disable']);
  assert.equal(root.querySelector('[data-role="passkey-slot"]').hidden, true);
  assert.match(root.querySelector('#lock-password-error').textContent, /Touch ID no longer opens this wallet/);
});

test('without a passkey set up the screen is the password screen it always was', async (t) => {
  const pk = passkey({ enabled: false });
  const b = await locked(pk);
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  await settle(app);
  assert.deepEqual(pk.calls, []);
  assert.equal(root.querySelector('[data-role="passkey-slot"]').hidden, true);
  assert.equal(root.querySelector('form button[type=submit]').textContent, 'Unlock');
});

test('after a password unlock, a device that can do it is offered Touch ID once, with the password just typed', async (t) => {
  const enabled = [];
  const pk = { ...passkey({ enabled: false }), enable: async (pw) => { enabled.push(pw); } };
  const b = await locked(pk);
  try { globalThis.localStorage?.removeItem('rand-wallet.passkeyOfferDeclined'); } catch {}
  const { app, root } = await mountApp(t, b);
  await app.go('#lock');
  await settle(app);
  root.querySelector('input[name=password]').value = PW;
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle(app);
  const turnOn = document.querySelector('[data-role="turn-on"]');
  assert.ok(turnOn, 'the offer is shown');
  assert.match(turnOn.textContent, /Turn on Touch ID/);
  turnOn.click();
  await settle(app);
  assert.deepEqual(enabled, [PW], 'set up with the password that just unlocked');
  assert.equal(location.hash, '#home');
});
