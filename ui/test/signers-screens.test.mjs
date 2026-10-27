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
  assert.equal(inputs.length, 1, 'the list starts with one empty row');
  inputs[0].value = 'rand1payee'; inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  const amt = root.querySelector('input[data-role="payee-amount"]');
  amt.value = ' 10.5 '; amt.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('[data-role="check-payees"]').click();
  await app.idle(); await tick();
  assert.deepEqual(seen.at(-1), ['rand1payee:10.5']);
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

for (const [name, mutate] of [['a null summary', () => null], ['non-array outputs and lines', (s) => ({ ...s, outputs: 'x', lines: {} })], ['lines that are not all strings', (s) => ({ ...s, lines: ['ok', 1] })]]) {
  test(`${name} shows the malformed-summary refusal, with no Sign button`, async (t) => {
    const b = signerBackend();
    await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
    const base = (await b.signers.check('s1', '{}', [])).summary;
    b.signers.check = async () => ({ summary: mutate(base), signable: false, refusal: { code: 'malformed-summary', message: 'incomplete answer' } });
    const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
    await app.idle();
    root.querySelector('textarea[data-role="proposal"]').value = '{}';
    root.querySelector('[data-role="check"]').click();
    await app.idle(); await tick();
    assert.equal(root.querySelector('[data-role="refusal"]').textContent, 'incomplete answer');
    assert.equal(root.querySelector('[data-role="sign"]'), null);
  });
}

test('a blank payee field is refused on the screen and nothing is sent to check', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const original = b.signers.check;
  let calls = 0;
  b.signers.check = async (...a) => { calls += 1; return original(...a); };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  assert.equal(calls, 1);
  root.querySelector('[data-role="check-payees"]').click();
  await app.idle(); await tick();
  assert.equal(calls, 1, 'a blank payee never reaches check');
  assert.ok(root.querySelector('[data-role="payee-error"]').textContent.length > 0);
  assert.equal(root.querySelector('[data-role="payee-error"]').hasAttribute('hidden'), false);
});

test('a failing save shows the error and a good one shows the path', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  let fail = true;
  b.platform.saveText = async () => { if (fail) throw new Error('disk full'); return '/Downloads/share-1-2.txt'; };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const confirm = root.querySelector('input[data-role="confirm"]');
  confirm.value = 'aak3'; confirm.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('input[data-role="password"]').value = 'unlocked-password-1';
  root.querySelector('[data-role="sign"]').click();
  await app.idle(); await tick();
  root.querySelector('[data-role="save-share"]').click();
  await tick();
  assert.match(root.querySelector('[data-role="share-note"]').textContent, /disk full/);
  fail = false;
  root.querySelector('[data-role="save-share"]').click();
  await tick();
  assert.match(root.querySelector('[data-role="share-note"]').textContent, /share-1-2\.txt/);
});

async function checked(t, summaryOver, checkFn) {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const original = b.signers.check;
  const seen = [];
  b.signers.check = async (id, proposal, payees) => {
    seen.push(payees);
    if (checkFn) return checkFn(payees, () => original(id, proposal, payees));
    const r = await original(id, proposal, payees);
    return summaryOver ? { ...r, summary: summaryOver(r.summary) } : r;
  };
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  return { app, root, seen };
}
const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const submit = async (app, root) => { root.querySelector('[data-role="check-payees"]').click(); await app.idle(); await tick(); };

test('two rows send two addr:amount entries, rows can be added and removed', async (t) => {
  const { app, root, seen } = await checked(t);
  root.querySelector('[data-role="add-payment"]').click();
  root.querySelector('[data-role="add-payment"]').click();
  assert.equal(root.querySelectorAll('input[data-role="payee"]').length, 3);
  root.querySelectorAll('[data-role="remove-payment"]')[2].click();
  const [a, b] = root.querySelectorAll('input[data-role="payee"]');
  const [x, y] = root.querySelectorAll('input[data-role="payee-amount"]');
  type(a, 'rand1a'); type(x, '1'); type(b, ' rand1b '); type(y, '2.25');
  await submit(app, root);
  assert.deepEqual(seen.at(-1), ['rand1a:1', 'rand1b:2.25']);
});

test('an empty row, a row without an amount or a bad amount refuses on the screen', async (t) => {
  const { app, root, seen } = await checked(t);
  const n = seen.length;
  await submit(app, root);
  const err = () => root.querySelector('[data-role="payee-error"]');
  assert.ok(err().textContent && !err().hasAttribute('hidden'));
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  await submit(app, root);
  assert.match(err().textContent, /amount/i);
  type(root.querySelector('input[data-role="payee-amount"]'), 'abc');
  await submit(app, root);
  assert.ok(!err().hasAttribute('hidden'));
  assert.equal(seen.length, n, 'nothing reached check');
});

test('with a non-RAND paying output a row may leave its amount empty, and a note says why', async (t) => {
  const { app, root, seen } = await checked(t, (s) => ({ ...s, outputs: s.outputs.map((o) => (o.amount === '10000000000' ? { ...o, asset: 7 } : o)) }));
  assert.ok(root.querySelector('[data-role="nonrand-note"]'));
  type(root.querySelector('input[data-role="payee"]'), 'rand1tok');
  await submit(app, root);
  assert.deepEqual(seen.at(-1), ['rand1tok']);
});

test('a RAND-only summary shows no non-RAND note and needs the amount', async (t) => {
  const { app, root, seen } = await checked(t);
  assert.equal(root.querySelector('[data-role="nonrand-note"]'), null);
  const n = seen.length;
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  await submit(app, root);
  assert.equal(seen.length, n);
});

test('the core\'s three payee sentences reach the screen verbatim', async (t) => {
  for (const msg of ['expected recipient AB12-CD34 is paid 3, not 5', 'expected recipient AB12-CD34 is not paid', 'output 2 pays AB12-CD34, not an expected recipient']) {
    const b = signerBackend();
    await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
    const original = b.signers.check;
    let first = true;
    b.signers.check = async (...a) => { if (first) { first = false; return original(...a); } throw new Error(msg); };
    const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
    await app.idle();
    root.querySelector('textarea[data-role="proposal"]').value = '{}';
    root.querySelector('[data-role="check"]').click();
    await app.idle(); await tick();
    type(root.querySelector('input[data-role="payee"]'), 'rand1a');
    type(root.querySelector('input[data-role="payee-amount"]'), '5');
    await submit(app, root);
    assert.equal(root.querySelector('[data-role="error"]').textContent, msg);
    app.destroy(); root.remove();
  }
});

test('the optional-amount exception is per row: only a non-RAND owner\'s row may go unpinned', async (t) => {
  const fps = { rand1tok: 'F', rand1r: 'G' };
  const { app, root, seen } = await checked(t, null, async (payees, base) => {
    const r = await base();
    const outputs = [{ to_account: false, amount: '5', asset: 7, owner_fingerprint: 'F', matches: 'x' }, { to_account: false, amount: '9', asset: 0, owner_fingerprint: 'G', matches: 'y' }];
    return { ...r, summary: { ...r.summary, outputs, expected: payees.map((e) => ({ entry: e, fingerprint: fps[e.split(':')[0]] || null })) } };
  });
  root.querySelector('[data-role="add-payment"]').click();
  const [a, b] = root.querySelectorAll('input[data-role="payee"]');
  type(a, 'rand1tok'); type(b, 'rand1r');
  await submit(app, root);
  assert.deepEqual(seen.at(-1), ['rand1tok', 'rand1r'], 'unfingerprinted rows may be sent address-only to find out');
  assert.equal(root.querySelectorAll('[data-role="nonrand-note"]').length, 1, 'the note stays on the non-RAND row alone');
  const n = seen.length;
  await submit(app, root);
  assert.equal(seen.length, n, 'the RAND row now needs its amount');
  assert.match(root.querySelector('[data-role="payee-error"]').textContent, /amount/i);
  type(root.querySelectorAll('input[data-role="payee-amount"]')[1], '9');
  await submit(app, root);
  assert.deepEqual(seen.at(-1), ['rand1tok', 'rand1r:9']);
});

test('editing a payment after a check disarms Sign until the payments are checked again', async (t) => {
  const { app, root } = await checked(t);
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  type(root.querySelector('input[data-role="payee-amount"]'), '1');
  await submit(app, root);
  const arm = () => { const c = root.querySelector('input[data-role="confirm"]'); c.value = 'aak3'; c.dispatchEvent(new Event('input', { bubbles: true })); };
  arm();
  assert.equal(root.querySelector('[data-role="sign"]').disabled, false);
  assert.equal(root.querySelector('[data-role="stale-note"]').hasAttribute('hidden'), true);
  type(root.querySelector('input[data-role="payee-amount"]'), '2');
  assert.equal(root.querySelector('[data-role="sign"]').disabled, true);
  assert.equal(root.querySelector('[data-role="stale-note"]').hasAttribute('hidden'), false);
  await submit(app, root);
  arm();
  assert.equal(root.querySelector('[data-role="sign"]').disabled, false);
  root.querySelector('[data-role="add-payment"]').click();
  assert.equal(root.querySelector('[data-role="sign"]').disabled, true, 'add disarms');
  await submit(app, root);
  assert.ok(root.querySelector('[data-role="payee-error"]').textContent, 'the blank new row is refused, so Sign stays off');
  assert.equal(root.querySelector('[data-role="sign"]').disabled, true);
});

test('the top Check does not re-arm Sign after a row was edited', async (t) => {
  const { app, root } = await checked(t);
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  type(root.querySelector('input[data-role="payee-amount"]'), '1');
  await submit(app, root);
  type(root.querySelector('input[data-role="payee-amount"]'), '2');
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const c = root.querySelector('input[data-role="confirm"]'); c.value = 'aak3'; c.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-role="sign"]').disabled, true);
  assert.equal(root.querySelector('[data-role="stale-note"]').hasAttribute('hidden'), false);
});

test('an edit while a check is in flight leaves Sign disabled when it lands', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const { app, root } = await checked(t, null, async (payees, base) => { n += 1; if (n > 1) await gate; return base(); });
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  type(root.querySelector('input[data-role="payee-amount"]'), '1');
  root.querySelector('[data-role="check-payees"]').click();
  await tick();
  type(root.querySelector('input[data-role="payee-amount"]'), '2');
  release();
  await app.idle(); await tick();
  const c = root.querySelector('input[data-role="confirm"]'); c.value = 'aak3'; c.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-role="sign"]').disabled, true);
});

// ---- final fix wave ----
test('a payee paid both RAND and a token keeps its amount required, and the screen says why', async (t) => {
  const fps = { rand1payee: 'X' };
  const { app, root, seen } = await checked(t, null, async (payees, base) => {
    const r = await base();
    const outputs = [{ to_account: false, amount: '900000000000', asset: 0, owner_fingerprint: 'X', matches: 'a' }, { to_account: false, amount: '1', asset: 5, owner_fingerprint: 'X', matches: 'b' }];
    return { ...r, summary: { ...r.summary, outputs, expected: payees.map((e) => ({ entry: e, fingerprint: fps[e.split(':')[0]] || null })) } };
  });
  type(root.querySelector('input[data-role="payee"]'), 'rand1payee');
  await submit(app, root);
  assert.deepEqual(seen.at(-1), ['rand1payee'], 'an unfingerprinted row may be sent address-only to find out');
  assert.equal(root.querySelector('[data-role="nonrand-note"]'), null, 'no exception offered to a RAND payee');
  assert.ok(root.querySelector('[data-role="mixed-note"]'), 'the both-RAND-and-token sentence is shown');
  const n = seen.length;
  await submit(app, root);
  assert.equal(seen.length, n, 'the amount is now required');
  assert.match(root.querySelector('[data-role="payee-error"]').textContent, /amount/i);
});

test('editing the proposal after a check clears the review and disarms Sign', async (t) => {
  const { app, root } = await checked(t);
  type(root.querySelector('input[data-role="payee"]'), 'rand1a');
  type(root.querySelector('input[data-role="payee-amount"]'), '1');
  await submit(app, root);
  const c = root.querySelector('input[data-role="confirm"]'); c.value = 'aak3'; c.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-role="sign"]').disabled, false);
  const ta = root.querySelector('textarea[data-role="proposal"]');
  ta.value = `${ta.value} `; ta.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-role="sign"]'), null, 'the review is cleared');
  assert.equal(root.querySelector('[data-role="line"]'), null);
});

test('typing the same proposal text back leaves a fresh review alone', async (t) => {
  const { app, root } = await checked(t);
  const ta = root.querySelector('textarea[data-role="proposal"]');
  const before = root.querySelectorAll('[data-role="line"]').length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(root.querySelectorAll('[data-role="line"]').length, before);
});

// ---- MSC-2: the fee is shown beside the payments, with the signer's limit.
test('the review shows the fee and the signer\'s limit beside the payments', async (t) => {
  const b = signerBackend();
  await b.signers.add({ label: 'treasury', policy: 'P', key: 'K', password: 'unlocked-password-1' });
  const { app, root } = await mountApp(t, b, { hash: '#signer/s1' });
  await app.idle();
  root.querySelector('textarea[data-role="proposal"]').value = '{"x":1}';
  root.querySelector('[data-role="check"]').click();
  await app.idle(); await tick();
  const text = root.querySelector('[data-role="review"]').textContent;
  assert.match(text, /Fee: 0\.001 RAND · at most 0\.1 RAND · expires at height 2024/);
});

test('the add form takes the signer\'s fee limit in RAND and hands it to add', async (t) => {
  const b = signerBackend();
  const seen = [];
  const original = b.signers.add;
  b.signers.add = async (args) => { seen.push(args.maxFee); return original(args); };
  const { app, root } = await mountApp(t, b, { hash: '#signers' });
  await app.idle();
  const limit = root.querySelector('input[data-role="max-fee"]');
  assert.equal(limit.value, '0.1', 'the default is shown, not hidden');
  root.querySelector('[data-role="label"]').value = 'treasury';
  root.querySelector('textarea[data-role="policy"]').value = 'P';
  root.querySelector('textarea[data-role="key"]').value = 'K';
  limit.value = '0.25';
  root.querySelector('[data-role="preview"]').click();
  await app.idle(); await tick();
  root.querySelector('[data-role="add-password"]').value = 'unlocked-password-1';
  root.querySelector('[data-role="save"]').click();
  await app.idle(); await tick();
  assert.deepEqual(seen, ['0.25']);
});
