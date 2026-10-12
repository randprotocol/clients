import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { confirmsFingerprint, lastFourOf, MAX_FILE_BYTES } from '../screens/signers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const signerBackend = (over = {}) => {
  const b = unlockedBackend(over);
  return b;
};

test('confirmation is the fingerprint\'s last four, without case or dashes', () => {
  assert.equal(lastFourOf('NFYW-K8E9-E5K9-AAK3'), 'aak3');
  assert.ok(confirmsFingerprint('NFYW-K8E9-E5K9-AAK3', ' aak3 '));
  assert.ok(!confirmsFingerprint('NFYW-K8E9-E5K9-AAK3', 'AAK'));
  assert.ok(!confirmsFingerprint('', ''));
});

test('settings offers the signers screen only where the backend has the group', async (t) => {
  const { app, root } = await mountApp(t, signerBackend(), { hash: '#settings' });
  await app.idle();
  assert.ok(root.querySelector('[data-go="signers"]'));
});

test('a proposal\'s lines are shown verbatim, as text, with the caveat', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const lines = [...root.querySelectorAll('[data-role="line"]')].map((n) => n.textContent);
  assert.equal(lines.length, 6);
  assert.ok(lines.slice(0, 4).every((l) => l.endsWith('(owner key verified; delivery key NOT verifiable from this proposal)')));
});

test('sign stays disabled until the last four are typed, and asks for the password each time', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const sign = root.querySelector('[data-role="sign"]');
  assert.equal(sign.disabled, true);
  const confirm = root.querySelector('input[data-role="confirm"]');
  confirm.value = 'aak3'; confirm.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(sign.disabled, false);
  root.querySelector('input[data-role="password"]').value = 'unlocked-password-1';
  sign.click();
  await app.idle(); await tick();
  assert.equal(root.querySelector('[data-role="share"]').value, '1:' + 'ab'.repeat(8));
  assert.equal(root.querySelector('input[data-role="password"]').value, '', 'the password field is emptied');
});

test('every paying output asks for its payee, and the typed addresses reach check and sign', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const seen = [];
  const original = b.signers.check;
  b.signers.check = async (id, proposal, payees) => { seen.push(payees); return original(id, proposal, payees); };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const inputs = root.querySelectorAll('input[data-role="payee"]');
  assert.equal(inputs.length, 1, 'only output 2 pays someone: dummies and change ask nothing');
  inputs[0].value = 'rand1payee';
  root.querySelector('[data-role="check-payees"]').click();
  await app.idle(); await tick();
  assert.deepEqual(seen.at(-1), ['rand1payee']);
});

test('a refused check names the node and offers Retry, and nothing can be signed', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  b.signers.check = async () => ({ summary: { outputs: [], recipients_checked: true, lines: ['fee 0.001 RAND'], policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', expires_at: 2024, fee: '1000000', burns: { burn_a: '0', burn_asset: 0, burn_r: '0' } },
    signable: false, refusal: { code: 'no-node', node: 'https://rpc.example', message: 'No node answered at https://rpc.example, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.' } });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  assert.match(root.querySelector('[data-role="refusal"]').textContent, /rpc\.example/);
  assert.ok(root.querySelector('[data-role="retry"]'));
  assert.equal(root.querySelector('[data-role="sign"]'), null);
});

test('the popup offers the side panel instead of a file picker', async (t) => {
  const b = signerBackend();
  b.platform.openSidebar = async () => {};
  const { app, root } = await mountApp(t, b, { hash: '#signers', mode: 'popup' });
  await app.idle();
  assert.equal(root.querySelector('input[type=file]'), null);
  assert.ok(root.querySelector('[data-role="to-sidebar"]'));
});

test('a profile label from storage is text, never markup', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: '<img src=x onerror=alert(1)>', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signers' });
  await app.idle();
  assert.equal(root.querySelector('img'), null);
});

test('every refusal code shows its message and nothing can be signed', async (t) => {
  for (const code of ['malformed-summary', 'unchecked-recipient', 'no-node', 'wrong-chain', 'wrong-genesis', 'expired']) {
    const b = signerBackend();
    await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
    const base = (await b.signers.check('s1', '{}', [])).summary;
    b.signers.check = async () => ({ summary: base, signable: false, refusal: { code, message: `message for ${code}` } });
    const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
    await app.idle();
    root.querySelector('textarea[data-role="proposal"]').value = '{}';
    root.querySelector('[data-role="check"]').click();
    await app.idle(); await tick();
    assert.equal(root.querySelector('[data-role="refusal"]').textContent, `message for ${code}`);
    assert.equal(root.querySelector('[data-role="sign"]'), null);
    app.destroy(); root.remove();
  }
});

test('an unreadable profiles record shows its message instead of a blank screen', async (t) => {
  const b = signerBackend();
  b.signers.list = async () => { throw Object.assign(new Error('the saved signer profiles could not be opened'), { code: 'signers-unreadable' }); };
  const { app, root } = await mountApp(t, b, { hash: '#signers' });
  await app.idle(); await tick();
  assert.match(root.querySelector('[data-role="error"]').textContent, /could not be opened/);
});

test('a share can be saved as a file where the platform can', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const saved = [];
  b.platform.saveText = async (f) => { saved.push(f); };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const confirm = root.querySelector('input[data-role="confirm"]');
  confirm.value = 'AAK3'; confirm.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('input[data-role="password"]').value = 'unlocked-password-1';
  root.querySelector('[data-role="sign"]').click();
  await app.idle(); await tick();
  root.querySelector('[data-role="save-share"]').click();
  assert.deepEqual(saved, [{ name: 'share-1.txt', text: '1:' + 'ab'.repeat(8) + '\n' }]);
});

test('a file over the cap is refused, not read', async (t) => {
  const b = signerBackend();
  const { app, root } = await mountApp(t, b, { hash: '#signers' });
  await app.idle();
  const input = root.querySelector('input[data-file="policy"]');
  const big = { size: MAX_FILE_BYTES + 1, text: async () => { throw new Error('read'); } };
  Object.defineProperty(input, 'files', { value: [big] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  assert.match(root.querySelector('[data-role="error"]').textContent, /larger/);
  assert.equal(root.querySelector('textarea[data-role="policy"]').value, '');
});
