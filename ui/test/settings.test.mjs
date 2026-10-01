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

// ------------------------------------------------------------------------------ prover ---------
// Delegated proving, Phase 1 (spec 2026-09-28 §4.4). The pairing link carries a secret token and
// the save carries the wallet's password: neither may reach the page's markup or `ctx.state`.

// The core's `prover_history_warning`, as the screen mirrors it (web/wallet's integration test holds
// the real core's sentence equal to the screen's).
const PROVER_WARNING = 'This prover will be able to read this wallet\'s whole history — every payment '
  + 'received and sent, before and after today. It cannot spend. To keep your history private, run your own.';
const PROVER_TOKEN = '7a'.repeat(32);
const proverLink = ({ url = 'https://prover.example', own = true } = {}) =>
  `randprover:KEY?url=${encodeURIComponent(url)}&token=${PROVER_TOKEN}${own ? '&own=1' : ''}`;

function submitProver(root, { link = proverLink(), password = PASSWORD } = {}) {
  root.querySelector('[name=proverLink]').value = link;
  root.querySelector('[name=proverPassword]').value = password;
  root.querySelector('[data-role="prover-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

const pairedSetting = { mode: 'remote', name: 'prover.example', url: 'https://prover.example', kemEk: 'ek', fingerprint: 'ABCD-EFGH-JKMN-PQRS', own: true };

test('the Prover section is there only when the backend has the prover group', async (t) => {
  const b = unlockedBackend();
  delete b.prover;
  const { root } = await settings(t, b);
  assertGone(root.querySelector('[data-role="prover-form"]'), 'the prover form');
  assert.equal([...root.querySelectorAll('.section-title')].some((el) => el.textContent === 'Prover'), false);
});

test('the Prover section says the device proves, and shows the history warning verbatim above the password', async (t) => {
  const { root } = await settings(t);
  const section = root.querySelector('[data-role="prover-form"]').closest('.card');
  assert.match(section.querySelector('[data-role="prover-state"]').textContent, /This device/);
  const warning = section.querySelector('[data-role="prover-warning"]');
  assert.ok(warning.textContent.includes(PROVER_WARNING), 'the warning is verbatim');
  // Part of the form, before the password: there is no way to reach Save without passing it.
  const html = section.innerHTML;
  assert.ok(html.indexOf('data-role="prover-warning"') < html.indexOf('name="proverPassword"'));
  assertGone(warning.querySelector('button'), 'a dismiss button on the warning');
  assertGone(section.querySelector('[data-role="scan-prover"]'), 'a scan button without platform.scanQr');
});

test('a paired prover shows its name, fingerprint and whether it answers', async (t) => {
  const b = unlockedBackend({
    settings: { get: () => ({ ...defaultish(), prover: pairedSetting }) },
    prover: { probe: () => ({ ok: true, queue: { depth: 1, max: 4, proving: 1 }, witnessKinds: ['spend_key'], fee: null, hcBundles: [] }) },
  });
  const { root } = await settings(t, b);
  const state = root.querySelector('[data-role="prover-state"]');
  assert.match(state.textContent, /prover\.example/);
  assert.match(state.textContent, /ABCD-EFGH-JKMN-PQRS/);
  assert.match(root.querySelector('[data-role="prover-probe"]').textContent, /Answering · 1 of 4/);
  assert.ok(b.calls.some((c) => c[0] === 'prover.probe'));

  const down = unlockedBackend({
    settings: { get: () => ({ ...defaultish(), prover: pairedSetting }) },
    prover: { probe: () => ({ ok: false, reason: 'the prover at https://prover.example did not answer (<b>x</b>)' }) },
  });
  const second = await settings(t, down);
  const probe = second.root.querySelector('[data-role="prover-probe"]');
  assert.match(probe.textContent, /did not answer \(<b>x<\/b>\)/, 'the reason is text, not markup');
});

function defaultish() {
  return { rpcUrl: '', rpcUrls: ['https://rpc.randprotocol.org'], theme: 'system', autoLockMin: 15, explorerUrl: 'https://randscan.org', chainId: 14 };
}

test('a bad pairing link shows the engine\'s sentence and pairs nothing', async (t) => {
  const b = unlockedBackend({ platform: { ensureHostPermission: async () => true } });
  const { app, root } = await settings(t, b);
  submitProver(root, { link: 'randprover:KEY?url=http%3A%2F%2F10.0.0.2%3A8546&token=' + PROVER_TOKEN });
  await app.idle();
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Use https for a prover/);
  assert.equal(b.calls.filter((c) => c[0] === 'prover.pair').length, 0);
  assert.equal(b.calls.filter((c) => c[0] === 'platform.ensureHostPermission').length, 0);
});

test('Save asks for the prover\'s host inside the click, then pairs with the typed password', async (t) => {
  const b = unlockedBackend({ platform: { ensureHostPermission: async () => true } });
  const { app, root } = await settings(t, b);
  submitProver(root);
  await app.idle();

  const order = b.calls.map((c) => c[0]).filter((m) => ['prover.preview', 'platform.ensureHostPermission', 'prover.pair'].includes(m));
  assert.deepEqual(order, ['prover.preview', 'platform.ensureHostPermission', 'prover.pair']);
  assert.equal(b.calls.find((c) => c[0] === 'platform.ensureHostPermission')[1], 'https://prover.example');
  const pair = b.calls.find((c) => c[0] === 'prover.pair');
  assert.equal(pair[1], proverLink());
  assert.equal(pair[2], PASSWORD);

  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Paired/);
  assert.match(root.querySelector('[data-role="prover-state"]').textContent, /prover\.example/);
  // Both secrets are gone from the form, and neither is anywhere in the page.
  assert.equal(root.querySelector('[name=proverPassword]').value, '');
  assert.equal(root.querySelector('[name=proverLink]').value, '');
  assert.equal(root.innerHTML.includes(PROVER_TOKEN), false, 'the token is in the DOM');
  assert.equal(root.innerHTML.includes(PASSWORD), false, 'the password is in the DOM');
});

test('a refused host permission pairs nothing', async (t) => {
  const b = unlockedBackend({ platform: { ensureHostPermission: async () => false } });
  const { app, root } = await settings(t, b);
  submitProver(root);
  await app.idle();
  assert.equal(b.calls.filter((c) => c[0] === 'prover.pair').length, 0);
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Not paired/);
});

test('a wrong password is the engine\'s refusal, and the password field is emptied', async (t) => {
  const { app, root } = await settings(t);
  submitProver(root, { password: 'not-the-password-9' });
  await app.idle();
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /wrong password/);
  assert.equal(root.querySelector('[name=proverPassword]').value, '');
  assert.match(root.querySelector('[data-role="prover-state"]').textContent, /This device/);
});

test('a link that is not marked own is paired, and the engine\'s history warning is relayed', async (t) => {
  // Split authorisation: such a prover makes the proofs too (the job carries the viewing key), so
  // the screen says where proofs now go AND what that prover can then read — never "my own".
  const { app, root } = await settings(t);
  submitProver(root, { link: proverLink({ own: false }) });
  await app.idle();
  const status = root.querySelector('[data-role="prover-status"]').textContent;
  assert.match(status, /Paired — this prover can read your history/);
  assert.match(status, /Proofs this device cannot make go to/);
  assert.ok(status.includes(PROVER_WARNING), 'the engine\'s warning, verbatim');
  const state = root.querySelector('[data-role="prover-state"]');
  assert.match(state.textContent, /Paired prover · /);
  assert.doesNotMatch(state.textContent, /My own prover|not usable/, 'a pairing not marked own is called the user\'s own');
  assert.match(state.querySelector('[data-role="prover-not-own"]').textContent, /can read this wallet's whole history\. It cannot spend\./);
});

test('Use the RandProtocol prover pairs the built-in prover in one step, behind the password and the warning', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  await app.idle();
  const box = root.querySelector('[data-role="trusted-prover"]');
  assert.ok(box && !box.hasAttribute('hidden'), 'the action is offered once the engine names a trusted prover');
  assert.match(box.textContent, /prover\.randprotocol\.org/);
  assert.match(box.textContent, /fingerprint [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  // The warning is part of the form, above the password and this button's password field alike.
  const html = root.querySelector('[data-role="prover-form"]').innerHTML;
  assert.ok(html.indexOf('data-role="trusted-prover"') < html.indexOf('data-role="prover-warning"'));
  assert.ok(html.indexOf('data-role="prover-warning"') < html.indexOf('name="proverPassword"'));
  // No password: nothing is paired.
  root.querySelector('[data-role="use-trusted-prover"]').click();
  await app.idle();
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Enter this wallet's password/);
  assert.equal(b.calls.filter((c) => c[0] === 'prover.pairTrusted').length, 0);
  // With it: the engine's one-step pairing, with that password and nothing else; the field is
  // emptied, the state says a paired prover (not "my own"), the status carries the warning.
  root.querySelector('[name=proverPassword]').value = PASSWORD;
  root.querySelector('[data-role="use-trusted-prover"]').click();
  await app.idle();
  assert.deepEqual(b.calls.filter((c) => c[0] === 'prover.pairTrusted').map((c) => c.slice(1)), [[PASSWORD]]);
  assert.equal(b.calls.filter((c) => c[0] === 'prover.pair').length, 0, 'the link never passes through the screen');
  assert.equal(root.querySelector('[name=proverPassword]').value, '');
  const status = root.querySelector('[data-role="prover-status"]').textContent;
  assert.match(status, /Paired — this prover can read your history/);
  assert.match(status, /go to RandProtocol/);
  assert.ok(status.includes(PROVER_WARNING));
  const state = root.querySelector('[data-role="prover-state"]').textContent;
  assert.match(state, /Paired prover · RandProtocol/);
  assert.doesNotMatch(state, /My own prover/);
  assert.equal(root.innerHTML.includes('c3'.repeat(32)), false, 'the built-in token is in the page');
});

test('a backend without a trusted prover offers no such action, and a refused one pairs nothing', async (t) => {
  const none = unlockedBackend({ prover: { trusted: () => null } });
  const first = await settings(t, none);
  await first.app.idle();
  assert.ok(first.root.querySelector('[data-role="trusted-prover"]').hasAttribute('hidden'));
  const refusing = unlockedBackend({ prover: { pairTrusted: () => { throw new Error('The prover at that address has a different key from the one the link names. Do not pair it.'); } } });
  const { app, root } = await settings(t, refusing);
  await app.idle();
  root.querySelector('[name=proverPassword]').value = PASSWORD;
  root.querySelector('[data-role="use-trusted-prover"]').click();
  await app.idle();
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Not paired.*different key/);
  assert.match(root.querySelector('[data-role="prover-state"]').textContent, /This device/);
});

test('a pairing marked own carries no history note under it', async (t) => {
  const { app, root } = await settings(t);
  submitProver(root, { link: proverLink({ own: true }) });
  await app.idle();
  const status = root.querySelector('[data-role="prover-status"]').textContent;
  assert.match(status, /PairedProofs this device cannot make go to/);
  assert.doesNotMatch(status, /read your history/);
  const state = root.querySelector('[data-role="prover-state"]');
  assert.match(state.textContent, /My own prover · /);
  assertGone(state.querySelector('[data-role="prover-not-own"]'), 'a history note under the user\'s own prover');
});

test('an empty link empties the password field too', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await settings(t, b);
  submitProver(root, { link: '' });
  await app.idle();
  assert.match(root.querySelector('[data-role="prover-status"]').textContent, /Paste the randprover: link/);
  assert.equal(root.querySelector('[name=proverPassword]').value, '');
  assert.equal(b.calls.filter((c) => c[0] === 'prover.preview').length, 0);
});

test('Scan fills the pairing link where the platform has a camera', async (t) => {
  const b = unlockedBackend({ platform: { scanQr: async () => ` ${proverLink()} ` } });
  const { app, root } = await settings(t, b);
  root.querySelector('[data-role="scan-prover"]').click();
  await app.idle();
  assert.equal(root.querySelector('[name=proverLink]').value, proverLink());
});

test('Forget returns proving to this device', async (t) => {
  const b = unlockedBackend();
  b.calls.length = 0;
  await b.prover.pair(proverLink(), PASSWORD);
  const { app, root } = await settings(t, b);
  assert.match(root.querySelector('[data-role="prover-state"]').textContent, /prover\.example/);
  root.querySelector('[data-role="forget-prover"]').click();
  await app.idle();
  assert.ok(b.calls.some((c) => c[0] === 'prover.forget'));
  assert.match(root.querySelector('[data-role="prover-state"]').textContent, /This device/);
  assertGone(root.querySelector('[data-role="forget-prover"]'), 'Forget after forgetting');
});

// ------------------------------------------------------------------------- prover host ---------
// "Prove for my other devices" (spec 2026-09-28 §5): only the desktop app has `platform.proverHost`
// — the fullnode's prover service run inside the app on 127.0.0.1. Turning it on shows the pairing
// link (the text, always, and its QR); Regenerate retires the old link.

const HOST_TOKEN = '5c'.repeat(32);
// About the real length: a 1 184-byte key in base58 is ~1 615 characters, ~1 740 with the rest.
const hostLink = (token = HOST_TOKEN) => `randprover:${'K'.repeat(1615)}?url=http%3A%2F%2F127.0.0.1%3A8600&token=${token}&own=1`;

/** A fake `platform.proverHost` that records its calls in `calls` and keeps its own running flag. */
function fakeHost({ running = false, startError = null } = {}) {
  const calls = [];
  const state = { running, token: HOST_TOKEN };
  const status = () => (state.running
    ? { running: true, addr: '127.0.0.1:8600', fingerprint: 'WXYZ-2345-6789-ABCD', proving: false }
    : { running: false, addr: null, fingerprint: 'WXYZ-2345-6789-ABCD', proving: false });
  return {
    calls,
    host: {
      start: async () => { calls.push('start'); if (startError) throw new Error(startError); state.running = true; return status(); },
      stop: async () => { calls.push('stop'); state.running = false; return status(); },
      status: async () => { calls.push('status'); return status(); },
      link: async () => { calls.push('link'); return hostLink(state.token); },
      rotate: async () => { calls.push('rotate'); state.token = '6d'.repeat(32); return hostLink(state.token); },
    },
  };
}

function toggleHost(root, checked) {
  const box = root.querySelector('input[name=proverHost]');
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the "Prove for my other devices" toggle is there only when the platform can host a prover', async (t) => {
  const { root } = await settings(t);
  assertGone(root.querySelector('input[name=proverHost]'), 'the host toggle without platform.proverHost');

  const { host } = fakeHost();
  const withHost = await settings(t, unlockedBackend({ platform: { proverHost: host } }));
  const box = withHost.root.querySelector('input[name=proverHost]');
  assert.ok(box, 'the host toggle');
  assert.match(box.closest('label').textContent, /Prove for my other devices/);
  assert.equal(box.checked, false);
  assertGone(withHost.root.querySelector('[data-role="prover-host-link"]:not([hidden])'), 'a link while the prover is off');
});

test('turning it on starts the prover and shows its link, as text and as a QR; off stops it', async (t) => {
  const { host, calls } = fakeHost();
  const { app, root } = await settings(t, unlockedBackend({ platform: { proverHost: host } }));

  toggleHost(root, true);
  await app.idle();
  assert.deepEqual(calls.filter((c) => c !== 'status'), ['start', 'link']);
  const wrap = root.querySelector('[data-role="prover-host-link"]');
  assert.equal(wrap.hasAttribute('hidden'), false);
  assert.equal(root.querySelector('[data-role="prover-host-link-text"]').textContent, hostLink());
  assert.ok(root.querySelector('[data-role="prover-qr"]'), 'the QR code');
  const status = root.querySelector('[data-role="prover-host-status"]').textContent;
  assert.match(status, /127\.0\.0\.1:8600/);
  assert.match(status, /WXYZ-2345-6789-ABCD/);

  toggleHost(root, false);
  await app.idle();
  assert.equal(calls.filter((c) => c === 'stop').length, 1);
  assert.ok(wrap.hasAttribute('hidden'), 'the link stays up after the prover stopped');
  assert.equal(root.innerHTML.includes(HOST_TOKEN), false, 'the token is still in the page after stopping');
  assert.match(root.querySelector('[data-role="prover-host-status"]').textContent, /Off/);
});

test('a prover already running when Settings opens is shown on, with its link', async (t) => {
  const { host, calls } = fakeHost({ running: true });
  const { root } = await settings(t, unlockedBackend({ platform: { proverHost: host } }));
  assert.equal(root.querySelector('input[name=proverHost]').checked, true);
  assert.equal(root.querySelector('[data-role="prover-host-link-text"]').textContent, hostLink());
  assert.equal(calls.includes('start'), false, 'opening Settings started nothing');
});

test('a refused start (too little memory, a busy port) leaves the toggle off and says why, as text', async (t) => {
  const { host } = fakeHost({ startError: 'This computer cannot prove for other devices right now: <b>6.7 GB</b> needed' });
  const { app, root } = await settings(t, unlockedBackend({ platform: { proverHost: host } }));
  toggleHost(root, true);
  await app.idle();
  assert.equal(root.querySelector('input[name=proverHost]').checked, false);
  const status = root.querySelector('[data-role="prover-host-status"]');
  assert.match(status.textContent, /<b>6\.7 GB<\/b> needed/, 'the reason is text, not markup');
  assert.ok(root.querySelector('[data-role="prover-host-link"]').hasAttribute('hidden'));
});

test('Copy copies the link, and Regenerate replaces it with a new one', async (t) => {
  const { host, calls } = fakeHost({ running: true });
  const b = unlockedBackend({ platform: { proverHost: host } });
  const { app, root } = await settings(t, b);

  root.querySelector('[data-role="copy-prover-link"]').click();
  await app.idle();
  assert.deepEqual(b.calls.filter((c) => c[0] === 'platform.copy').map((c) => c[1]), [hostLink()]);

  root.querySelector('[data-role="rotate-prover-link"]').click();
  await app.idle();
  assert.equal(calls.filter((c) => c === 'rotate').length, 1);
  assert.equal(root.querySelector('[data-role="prover-host-link-text"]').textContent, hostLink('6d'.repeat(32)));
  assert.equal(root.innerHTML.includes(HOST_TOKEN), false, 'the retired link is still on the page');
});

test('the host toggle is offered even where the backend has no prover group', async (t) => {
  const { host } = fakeHost();
  const b = unlockedBackend({ platform: { proverHost: host } });
  delete b.prover;
  const { root } = await settings(t, b);
  assert.ok(root.querySelector('input[name=proverHost]'));
  assertGone(root.querySelector('[data-role="prover-form"]'), 'the pairing form without the prover group');
});
