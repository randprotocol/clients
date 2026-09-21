// The settings screen (#settings) — task 1.5.
//
// Everything the node or the platform supplies (a status field, a chain id, an error message) is
// text, never markup: the escaping checks below are as much a part of this screen's contract as
// the behaviour is.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

const PASSWORD = 'unlocked-password-1'; // unlockedBackend()'s own

/**
 * `assert.equal(node, null)` is a landmine here: when it *fails*, node's assert builds a diff by
 * inspecting both values, and inspecting a linkedom node graph exhausts the heap — the whole file
 * dies with SIGKILL, no message, pointing at the wrong test. Never let assert inspect a DOM node.
 */
function assertGone(el, what) {
  assert.ok(el === null || el === undefined, `${what} should not be on the page`);
}

async function settings(t, b = unlockedBackend()) {
  const { app, root } = await mountApp(t, b, { hash: '#settings' });
  await app.idle();
  return { app, root, b };
}

function submitNetwork(root) {
  root.querySelector('[data-role="network-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** Answers the re-auth sheet a secret is behind, and returns the sheet element. */
async function reauth(app, root, trigger, password = PASSWORD) {
  root.querySelector(trigger).click();
  await app.idle();
  const dialog = root.querySelector('[role="dialog"]');
  dialog.querySelector('input[name=password]').value = password;
  dialog.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  return dialog;
}

// ---------------------------------------------------------------------------- network ---------

test('the RPC URL must be https, or plain http only on this machine', async (t) => {
  const { app, root, b } = await settings(t);
  const input = root.querySelector('input[name=rpcUrl]');
  const field = input.closest('.field');

  input.value = 'http://node.example:8899';
  submitNetwork(root);
  await app.idle();
  assert.ok(field.classList.contains('invalid'));
  assert.match(field.querySelector('.field-error').textContent, /https/i);
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 0);

  input.value = 'http://127.0.0.1:8899';
  submitNetwork(root);
  await app.idle();
  assert.equal(field.classList.contains('invalid'), false, 'a local node may be plain http');
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 1);

  input.value = 'https://rpc.example';
  submitNetwork(root);
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 2);
  assert.equal((await b.settings.get()).rpcUrl, 'https://rpc.example');
});

test('clearing the RPC URL goes back to the default nodes, and asks for no new host', async (t) => {
  // Task 5.0: this one field OVERRIDES the default endpoint set. Without a way to empty it, the
  // first URL anyone ever saved would be the only node their wallet could ever use, and the
  // failover the defaults exist for would be permanently out of reach.
  const b = unlockedBackend({ platform: { ensureHostPermission: async () => true } });
  const { app, root } = await settings(t, b);
  const input = root.querySelector('input[name=rpcUrl]');
  const field = input.closest('.field');

  input.value = '   ';
  submitNetwork(root);
  await app.idle();
  assert.equal(field.classList.contains('invalid'), false, 'an empty field was treated as a mistake');
  assert.equal(b.calls.filter((c) => c[0] === 'platform.ensureHostPermission').length, 0,
    'it asked for permission to reach a host it is not going to reach');
  assert.equal(b.calls.filter((c) => c[0] === 'rpc.probe').length, 0, 'going back to the defaults probed nothing');
  assert.deepEqual(b.calls.filter((c) => c[0] === 'settings.set').map((c) => c[1]), [{ rpcUrl: '' }]);
  assert.equal((await b.settings.get()).rpcUrl, '');
  const status = root.querySelector('[data-role="network-status"]').textContent;
  assert.match(status, /default nodes/i);
  assert.match(status, /rpc\.randprotocol\.org/, 'it did not say which nodes those are');
});

test('with no override saved, the hint names the default nodes rather than inventing one', async (t) => {
  const b = unlockedBackend();
  await b.settings.set({ rpcUrl: '' });
  const { root } = await settings(t, b);
  const hint = root.querySelector('#settings-rpc-hint').textContent;
  assert.match(hint, /default nodes/i);
  assert.match(hint, /rpc\.randprotocol\.org/);
  assert.equal(root.querySelector('input[name=rpcUrl]').getAttribute('placeholder'), 'https://rpc.randprotocol.org');
});

test('a refused host permission abandons the save', async (t) => {
  const b = unlockedBackend({ platform: { ensureHostPermission: async () => false } });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  submitNetwork(root);
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'platform.ensureHostPermission').length, 1);
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 0, 'nothing was saved');
  assert.match(root.querySelector('[data-role="network-status"]').textContent, /permission/i);
  assert.notEqual((await b.settings.get()).rpcUrl, 'https://rpc.example');
});

test('Test connection asks the browser for permission to reach a typed host first', async (t) => {
  // An extension reaches nothing it has no permission for: without asking, Test would report
  // "No answer" for a node that is up, behind a browser error rather than a node one.
  const b = unlockedBackend({
    platform: { ensureHostPermission: async () => false },
    rpc: { probe: async (url) => ({ url, chainId: 14, height: 7 }) },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'platform.ensureHostPermission').length, 1, 'the host was never asked about');
  assert.equal(b.calls.filter((c) => c[0] === 'rpc.probe').length, 0, 'it probed without permission');
  assert.match(root.querySelector('[data-role="network-status"]').textContent, /permission/i);
});

test('Test connection reports the height and the chain id', async (t) => {
  const b = unlockedBackend({
    rpc: {
      probe: async (url) => {
        assert.equal(url, 'http://127.0.0.1:8899', 'with the field empty, the SAVED endpoint is the one tested');
        return { url, chainId: 14, height: 1402918 };
      },
    },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  const probed = b.calls.filter((c) => c[0] === 'rpc.probe');
  assert.equal(probed.length, 1);
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /1,?402,?918/);
  assert.match(status.textContent, /14/);
  assertGone(root.querySelector('[data-role="network-status"] .banner.warn, [data-role="network-status"].warn'), 'root.querySelector([data-role="network-status"] .banner.warn');
});

test('Test connection checks the URL in the FIELD, not the saved one', async (t) => {
  // The whole of the settings UX bug: a typed URL was being judged by what the saved pool said.
  const b = unlockedBackend({
    rpc: { probe: async (url) => ({ url, chainId: 14, height: 7 }) },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  const [, probed] = b.calls.find((c) => c[0] === 'rpc.probe') || [];
  assert.equal(probed, 'https://rpc.example', 'the field’s URL was never asked');
  assert.match(root.querySelector('[data-role="network-status"]').textContent, /Connected/);
});

test('Test connection warns when the node is on another chain', async (t) => {
  const b = unlockedBackend({
    rpc: {
      probe: async (url) => ({ url, chainId: 99, height: 7 }),
    },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /99/);
  assert.match(status.textContent, /14/, 'and says which chain the wallet expects');
  assert.ok(status.querySelector('.banner.warn') || status.classList.contains('warn'), 'and warns about it');
});

test('a node’s own words reach the page as text, never as markup', async (t) => {
  const b = unlockedBackend({
    rpc: { probe: async () => { throw new Error('<img src=x onerror="alert(1)"> unreachable'); } },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /unreachable/);
  assertGone(status.querySelector('img'), 'status.querySelector(img)');
  assert.ok(root.innerHTML.includes('&lt;img'), 'escaped, not parsed');
});

test('Save refuses a node that does not answer — nothing is persisted', async (t) => {
  // The green "Saved" under a dead URL was the other half of the settings UX bug.
  const b = unlockedBackend({
    rpc: { probe: async (url) => { throw new Error(`cannot reach ${url}: timed out`); } },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  submitNetwork(root);
  await app.idle();
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /Not saved/);
  assert.match(status.textContent, /timed out/);
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 0, 'the dead URL was saved anyway');
  assert.notEqual((await b.settings.get()).rpcUrl, 'https://rpc.example');
});

test('Save refuses a node on another chain — nothing is persisted', async (t) => {
  const b = unlockedBackend({
    rpc: { probe: async (url) => ({ url, chainId: 99, height: 7 }) },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  submitNetwork(root);
  await app.idle();
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /Not saved/);
  assert.match(status.textContent, /chain 99/);
  assert.match(status.textContent, /chain 14/);
  assert.equal(b.calls.filter((c) => c[0] === 'settings.set').length, 0, 'a wrong-chain node was saved anyway');
});

test('Save accepts a node that answers on the right chain', async (t) => {
  const b = unlockedBackend({
    rpc: { probe: async (url) => ({ url, chainId: 14, height: 119894 }) },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('input[name=rpcUrl]').value = 'https://rpc.example';
  submitNetwork(root);
  await app.idle();
  const [, probed] = b.calls.find((c) => c[0] === 'rpc.probe') || [];
  assert.equal(probed, 'https://rpc.example', 'the candidate was never checked');
  assert.equal((await b.settings.get()).rpcUrl, 'https://rpc.example');
  assert.match(root.querySelector('[data-role="network-status"]').textContent, /Saved/);
});

// -------------------------------------------------------------------------- appearance --------

test('the theme applies instantly and is persisted', async (t) => {
  const { app, root, b } = await settings(t);
  const control = root.querySelector('[data-role="theme"]');
  assert.equal(control.getAttribute('role'), 'radiogroup');
  const dark = control.querySelector('[data-value="dark"]');
  assert.equal(control.querySelector('[data-value="system"]').getAttribute('aria-checked'), 'true');

  dark.click();
  await app.idle();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(dark.getAttribute('aria-checked'), 'true');
  assert.equal(control.querySelector('[data-value="system"]').getAttribute('aria-checked'), 'false');
  assert.equal((await b.settings.get()).theme, 'dark');
});

test('auto-lock offers a handful of minutes and Never', async (t) => {
  const { app, root, b } = await settings(t);
  const select = root.querySelector('select[name=autoLockMin]');
  assert.deepEqual([...select.querySelectorAll('option')].map((o) => o.value), ['1', '5', '15', '60', '0']);
  assert.match(select.querySelector('option[value="0"]').textContent, /never/i);
  assert.equal(select.value, '15', 'the saved setting is selected');

  // linkedom's `select.value` is getter-only, so the choice is made the way a user's click makes
  // it — by selecting the option — rather than by assigning to `.value`.
  select.querySelector('option[value="60"]').selected = true;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await app.idle();
  assert.equal((await b.settings.get()).autoLockMin, 60);
});

// ---------------------------------------------------------------------------- security --------

test('the viewing key is behind a password re-entry that never unlocks the wallet', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  const sessionBefore = app.session.id;

  // A wrong password says so and shows nothing.
  await reauth(app, root, '[data-role="show-viewing-key"]', 'not the password');
  assert.ok(root.querySelector('[role="dialog"] .field.invalid'), 'the sheet reports the bad password');
  assertGone(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'), 'root.querySelector([data-role="viewing-key-slot"] [data-role');

  root.querySelector('[role="dialog"] input[name=password]').value = PASSWORD;
  root.querySelector('[role="dialog"] form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();

  assertGone(root.querySelector('[role="dialog"]'), 'the sheet closed');
  assert.ok(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'));
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.unlock').length, 0, 're-auth is not an unlock');
  assert.ok(b.calls.filter((c) => c[0] === 'wallet.verifyPassword').length >= 1);
  assert.equal(app.session.id, sessionBefore, 'and the session survived it');
});

test('the viewing key itself is only ever in one text node', async (t) => {
  const b = unlockedBackend();
  const key = await b.wallet.viewingKey();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="show-viewing-key"]');
  const slot = root.querySelector('[data-role="viewing-key-slot"]');
  assert.ok(!root.textContent.includes(key), 'masked until revealed');

  slot.querySelector('[data-role="hold"]').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 750));
  assert.ok(root.textContent.includes(key), 'revealed');
  const attributes = [...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value)).join(' ');
  assert.ok(!attributes.includes(key), 'never in an attribute');
  assert.ok(!location.hash.includes(key));

  slot.querySelector('[data-role="copy"]').click();
  await app.idle();
  assert.deepEqual(b.calls.filter((c) => c[0] === 'platform.copy').at(-1), ['platform.copy', key]);
});

test('exporting the spend key needs the password, the warning and the checkbox', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="export-spend-key"]');
  const slot = root.querySelector('[data-role="spend-key-slot"]');
  assert.ok(slot);
  assert.match(slot.textContent, /anyone with this key can spend/i);

  const hold = slot.querySelector('[data-role="hold"]');
  const understand = slot.querySelector('input[name=understand]');
  assert.ok(understand);
  assert.equal(hold.disabled, true, 'nothing is revealed until the box is ticked');

  understand.checked = true;
  understand.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(hold.disabled, false);
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.exportSpendKey').length, 1);
});

test('wiping needs the word WIPE typed, and then wipes', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  const input = root.querySelector('input[name=wipe]');
  const button = root.querySelector('[data-role="wipe"]');
  assert.equal(button.disabled, true);

  input.value = 'wipe';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(button.disabled, true, 'the exact word, not a near miss');

  input.value = 'WIPE';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(button.disabled, false);

  button.click();
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.wipe').length, 1);
  assert.equal(await b.wallet.exists(), false);
  assert.equal(location.hash, '#welcome');
});

// ------------------------------------------------------------------------------- about --------

test('about names the app, the platform and the version, and opens links externally', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  const about = root.querySelector('[data-role="about"]');
  assert.match(about.textContent, /Rand Wallet/);
  assert.match(about.textContent, /fake/, 'platform.name');
  assert.match(about.textContent, /1\.5/, 'platform.version when the backend offers one');

  const link = about.querySelector('[data-role="external"]');
  link.click();
  await app.idle();
  const opened = b.calls.filter((c) => c[0] === 'platform.openExternal');
  assert.equal(opened.length, 1);
  assert.match(opened[0][1], /^https:/);
});

test('about leaves the version out when the backend has none', async (t) => {
  const b = unlockedBackend();
  delete b.platform.version;
  const { root } = await settings(t, b);
  const about = root.querySelector('[data-role="about"]');
  assert.match(about.textContent, /fake/);
  assert.doesNotMatch(about.textContent, /1\.5/);
});

// =============================================================== fix round 1 ====================

test('Copy spend key is gated on the same checkbox as the reveal', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="export-spend-key"]');
  const slot = root.querySelector('[data-role="spend-key-slot"]');
  const copy = slot.querySelector('[data-role="copy"]');
  assert.equal(copy.disabled, true, 'copying is a disclosure too');

  copy.click();
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'platform.copy').length, 0);

  const understand = slot.querySelector('input[name=understand]');
  understand.checked = true;
  understand.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(copy.disabled, false);
  copy.click();
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'platform.copy').length, 1);
});

test('the re-auth sheet cannot be submitted twice while a check is in flight', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let checks = 0;
  const b = unlockedBackend({
    wallet: { verifyPassword: async (pw) => { checks += 1; await gate; return pw === PASSWORD; } },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="show-viewing-key"]').click();
  await app.idle();
  const dialog = root.querySelector('[role="dialog"]');
  const form = dialog.querySelector('form');
  dialog.querySelector('input[name=password]').value = PASSWORD;

  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dialog.querySelector('[data-role="reauth-submit"]').disabled, true, 'the button is busy');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(checks, 1, 'a parallel submit is ignored, not queued');

  release();
  await app.idle();
  assert.ok(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'));
});

test('a block height past 2^53 is grouped without losing a digit', async (t) => {
  const huge = '9007199254740993123'; // Number() would round this
  const b = unlockedBackend({
    rpc: { probe: async (url) => ({ url, chainId: 14, height: huge }) },
  });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="test-connection"]').click();
  await app.idle();
  const status = root.querySelector('[data-role="network-status"]').textContent;
  assert.match(status, /9,007,199,254,740,993,123/);
});

test('Connecting… is not painted as a success', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = unlockedBackend({ rpc: { probe: async (url) => { await gate; return { url, chainId: 14, height: 5 }; } } });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="test-connection"]').click();
  await new Promise((r) => setTimeout(r, 0));
  const status = root.querySelector('[data-role="network-status"]');
  assert.match(status.textContent, /Connecting/i);
  assertGone(status.querySelector('.banner.positive'), 'nothing is known yet');
  assert.ok(status.querySelector('.banner'));
  release();
  await app.idle();
  assert.ok(status.querySelector('.banner.positive'), 'and the answer is');
});

test('hiding the key panel forgets the secret and asks for the password again', async (t) => {
  const b = unlockedBackend();
  const key = await b.wallet.viewingKey();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="show-viewing-key"]');
  const slot = root.querySelector('[data-role="viewing-key-slot"]');
  slot.querySelector('[data-role="timed"]').click();
  assert.ok(root.textContent.includes(key), 'the non-hold reveal shows it');

  slot.querySelector('[data-role="done"]').click();
  await app.idle();
  assert.ok(!root.textContent.includes(key), 'the panel is gone');
  assert.ok(root.querySelector('[data-role="show-viewing-key"]'), 'and it is behind the password again');

  const verifiesBefore = b.calls.filter((c) => c[0] === 'wallet.verifyPassword').length;
  await reauth(app, root, '[data-role="show-viewing-key"]');
  assert.equal(b.calls.filter((c) => c[0] === 'wallet.verifyPassword').length, verifiesBefore + 1);
});

test('a revealed secret is hidden again when the window loses focus', async (t) => {
  const b = unlockedBackend();
  const key = await b.wallet.viewingKey();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="show-viewing-key"]');
  const slot = root.querySelector('[data-role="viewing-key-slot"]');
  slot.querySelector('[data-role="timed"]').click();
  assert.ok(root.textContent.includes(key));

  window.dispatchEvent(new Event('blur'));
  await app.idle();
  assert.ok(!root.textContent.includes(key), 'it does not stay on a screen nobody is looking at');
});

// ============================================================ follow-up 1.5b ===================

test('a key dropped because the window lost focus closes its panel and says so', async (t) => {
  const b = unlockedBackend();
  const key = await b.wallet.viewingKey();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="show-viewing-key"]');
  const slot = root.querySelector('[data-role="viewing-key-slot"]');
  slot.querySelector('[data-role="timed"]').click();
  assert.ok(root.textContent.includes(key));

  window.dispatchEvent(new Event('blur'));
  await app.idle();

  assert.ok(!root.textContent.includes(key), 'the key is gone');
  assertGone(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'), 'the inert panel');
  assert.ok(root.querySelector('[data-role="show-viewing-key"]'), 'the password gate is back');
  assert.match(root.textContent, /Key hidden — enter your password to view it again\./);
});

test('a copied key is dropped a minute later, and the panel goes with it', async (t) => {
  const b = unlockedBackend();
  const key = await b.wallet.viewingKey();
  const { app, root } = await settings(t, b);
  await reauth(app, root, '[data-role="show-viewing-key"]');
  const slot = root.querySelector('[data-role="viewing-key-slot"]');

  // Mock timers from here on: the drop is a minute away, and `app.idle()` (which hops a real
  // macrotask) must not be used while they are enabled.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  slot.querySelector('[data-role="copy"]').click();
  for (let i = 0; i < 8; i += 1) await Promise.resolve(); // let the copy's await chain run
  assert.deepEqual(b.calls.filter((c) => c[0] === 'platform.copy').at(-1), ['platform.copy', key]);
  assert.ok(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'), 'still open just after');

  t.mock.timers.tick(59_000);
  assert.ok(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'), 'and at 59 s');
  t.mock.timers.tick(2_000);
  assertGone(root.querySelector('[data-role="viewing-key-slot"] [data-role="hold"]'), 'the panel at 61 s');
  assert.ok(root.querySelector('[data-role="show-viewing-key"]'), 'the password gate is back');
  t.mock.timers.reset();
});
