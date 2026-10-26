// provider-host.js's `withdraw` under plain Node, the classic script evaluated as the browser loads it.
// A withdraw is an invoke's sibling: the same preconditions, the same parked-in-session record and
// the same rule for a window closed unanswered, but its own approval window, its own message
// family, and phases that are forwarded to the asking tab so the site can show a progress view.
// What matters here is what the kinds share (one pending request per origin, whichever kind) and
// what they must not share (a window of one kind cannot read or answer the other's record).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../shared/provider-host.js', import.meta.url), 'utf8'));

const ROOT = 'chrome-extension://abc/';
const ORIGIN = 'https://randbridge.org';
const TX = 'ab'.repeat(32);
const TOKEN = 'cd'.repeat(32);
const TO = 'ef'.repeat(32);

function fakeExt({ wallet = { address: 'rand1real', pk: 'pk' }, unlocked = true, granted = true } = {}) {
  const local = { wallet, sites: granted ? { [ORIGIN]: { address: 'rand1real', hash: 'h'.repeat(64), at: 1 } } : {} };
  const session = unlocked ? { unlocked: { key: 'x' } } : {};
  const sent = [];
  const pick = (bag) => async (key) => (key in bag ? { [key]: JSON.parse(JSON.stringify(bag[key])) } : {});
  return {
    sent, local, session,
    runtime: { getURL: (p) => ROOT + p },
    storage: {
      local: { get: pick(local), set: async (obj) => Object.assign(local, obj) },
      session: { get: pick(session), set: async (obj) => Object.assign(session, JSON.parse(JSON.stringify(obj))) },
    },
    tabs: { sendMessage: async (tabId, msg) => { sent.push([tabId, msg]); } },
  };
}
const site = (origin = ORIGIN, tabId = 4) => ({ origin, url: `${origin}/bridge`, tab: { id: tabId } });
const win = () => ({ url: `${ROOT}withdraw.html?id=w1` });
const REQ = { asset: 1, amount: '1500000', toChain: 1, token: TOKEN, to: TO, chainId: 21, title: 'Withdraw' };
const invokeReq = { program: 'db'.repeat(32), inputs: [1] };

function hostWith(ext, { ids = ['w1', 'w2'], withWithdraw = true } = {}) {
  const opened = { withdraw: [], invoke: [] };
  const host = globalThis.makeRandProviderHost({
    ext, openConsent: async () => {}, newId: () => ids.shift(),
    openInvoke: async (r) => { opened.invoke.push(r); return 76; },
    ...(withWithdraw ? { openWithdraw: async (r) => { opened.withdraw.push(r); return 77; } } : {}),
  });
  return { host, opened };
}

test('withdraw from a granted origin parks the request with kind withdraw and opens one window', async () => {
  const ext = fakeExt();
  const { host, opened } = hostWith(ext);
  assert.deepEqual(await host.handle({ type: 'rand:withdraw', params: REQ }, site()), { pending: 'w1' });
  assert.deepEqual(opened.withdraw, [{ id: 'w1', origin: ORIGIN }]);
  assert.equal(opened.invoke.length, 0);
  const rec = ext.session.invokes.w1;
  assert.equal(rec.kind, 'withdraw');
  assert.equal(rec.origin, ORIGIN, 'the origin is the sender\'s');
  assert.equal(rec.tabId, 4);
  assert.equal(rec.windowId, 77);
  assert.deepEqual(rec.request, REQ);
  assert.deepEqual(await host.handle({ type: 'rand:withdrawRequest', id: 'w1' }, win()), { ok: true, result: { origin: ORIGIN, request: REQ } });
  assert.equal((await host.handle({ type: 'rand:withdrawRequest', id: 'w1' }, site())).error.code, 'FORBIDDEN');
});

test('refusals before any window', async () => {
  const cases = [
    [fakeExt({ wallet: null }), 'NO_WALLET', REQ],
    [fakeExt({ unlocked: false }), 'LOCKED', REQ],
    [fakeExt({ granted: false }), 'NOT_CONNECTED', REQ],
    [fakeExt(), 'BAD_REQUEST', null],
    [fakeExt(), 'BAD_REQUEST', [REQ]],
    [fakeExt(), 'BAD_REQUEST', 'nope'],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, token: 'nope' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, token: TOKEN.slice(2) }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, to: 'nope' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, asset: -1 }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, asset: 1.5 }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, asset: '1' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, amount: '0' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, amount: '01' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, amount: '-5' }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, amount: 5 }],
    [fakeExt(), 'BAD_REQUEST', { ...REQ, amount: '1'.repeat(31) }],
  ];
  for (const [ext, code, params] of cases) {
    const { host, opened } = hostWith(ext);
    const res = await host.handle({ type: 'rand:withdraw', params }, site());
    assert.equal(res.error && res.error.code, code, JSON.stringify(params));
    assert.equal(opened.withdraw.length, 0, `${code}: no window`);
    assert.deepEqual(ext.session.invokes || {}, {}, `${code}: nothing parked`);
  }
  // 30 digits is the longest amount accepted.
  const { host } = hostWith(fakeExt());
  assert.deepEqual(await host.handle({ type: 'rand:withdraw', params: { ...REQ, amount: '9'.repeat(30) } }, site()), { pending: 'w1' });
});

test('a host built without openWithdraw does not know the method', async () => {
  const { host } = hostWith(fakeExt(), { withWithdraw: false });
  assert.equal((await host.handle({ type: 'rand:withdraw', params: REQ }, site())).error.code, 'UNKNOWN_METHOD');
});

test('one request per origin across kinds', async () => {
  const a = hostWith(fakeExt());
  await a.host.handle({ type: 'rand:invoke', params: invokeReq }, site());
  assert.equal((await a.host.handle({ type: 'rand:withdraw', params: REQ }, site())).error.code, 'BUSY');
  assert.equal(a.opened.withdraw.length, 0);

  const b = hostWith(fakeExt());
  await b.host.handle({ type: 'rand:withdraw', params: REQ }, site());
  assert.equal((await b.host.handle({ type: 'rand:invoke', params: invokeReq }, site())).error.code, 'BUSY');
  assert.equal(b.opened.invoke.length, 0);
  assert.equal((await b.host.handle({ type: 'rand:withdraw', params: REQ }, site())).error.code, 'BUSY');
  // Another origin is not held up by it.
  const ext = fakeExt();
  ext.local.sites['https://other.example'] = { address: 'rand1real', hash: 'h'.repeat(64), at: 1 };
  const c = hostWith(ext);
  await c.host.handle({ type: 'rand:withdraw', params: REQ }, site());
  assert.deepEqual(await c.host.handle({ type: 'rand:withdraw', params: REQ }, site('https://other.example', 5)), { pending: 'w2' });
});

test('progress is forwarded to the asking tab', async () => {
  const ext = fakeExt();
  const { host } = hostWith(ext);
  await host.handle({ type: 'rand:withdraw', params: REQ }, site());
  assert.equal((await host.handle({ type: 'rand:withdrawProgress', id: 'w1', phase: 'proving' }, site())).error.code, 'FORBIDDEN');
  assert.equal(ext.sent.length, 0);
  await host.handle({ type: 'rand:withdrawProgress', id: 'w1', phase: 'proving', tabId: 99 }, win());
  assert.deepEqual(ext.sent, [[4, { type: 'rand:phase', id: 'w1', phase: 'proving' }]]);
  assert.equal(ext.session.invokes.w1.phase, 'proving', 'and remembered for a window closed later');
  // An invoke's progress is not forwarded: only withdraw has a progress view on the site.
});

test('result answers the tab once', async () => {
  const ext = fakeExt();
  const { host } = hostWith(ext);
  await host.handle({ type: 'rand:withdraw', params: REQ }, site());
  assert.equal((await host.handle({ type: 'rand:withdrawResult', id: 'w1', ok: true, result: { tx: TX } }, site())).error.code, 'FORBIDDEN');
  await host.handle({ type: 'rand:withdrawResult', id: 'w1', ok: true, result: { tx: `0x${'AB'.repeat(32)}` } }, win());
  assert.deepEqual(ext.sent, [[4, { type: 'rand:decision', id: 'w1', ok: true, result: { tx: TX } }]]);
  assert.deepEqual(ext.session.invokes, {});
  await host.handle({ type: 'rand:withdrawResult', id: 'w1', ok: false, error: { code: 'X', message: 'late' } }, win());
  assert.equal(ext.sent.length, 1, 'a second answer finds nothing to answer');
});

test('closing the window', async () => {
  for (const [phase, code] of [[null, 'USER_REJECTED'], ['proving', 'INTERRUPTED'], ['submitting', 'UNKNOWN_OUTCOME']]) {
    const ext = fakeExt();
    const { host } = hostWith(ext);
    await host.handle({ type: 'rand:withdraw', params: REQ }, site());
    if (phase) await host.handle({ type: 'rand:withdrawProgress', id: 'w1', phase }, win());
    ext.sent.length = 0;
    await host.windowClosed(12); // some other window
    assert.equal(ext.sent.length, 0);
    await host.windowClosed(77);
    assert.equal(ext.sent.length, 1, phase);
    assert.equal(ext.sent[0][1].type, 'rand:decision');
    assert.equal(ext.sent[0][1].error.code, code, `phase ${phase}`);
    assert.deepEqual(ext.session.invokes, {});
    if (code === 'INTERRUPTED') assert.match(ext.sent[0][1].error.message, /Withdraw/, 'points at the wallet\'s own Withdraw screen');
  }
});

test('kinds do not cross', async () => {
  const ext = fakeExt();
  const { host } = hostWith(ext);
  await host.handle({ type: 'rand:withdraw', params: REQ }, site());
  for (const type of ['rand:invokeRequest', 'rand:invokeProgress', 'rand:invokeResult']) {
    assert.equal((await host.handle({ type, id: 'w1', phase: 'proving', ok: true, result: { tx: TX } }, win())).error.code, 'GONE', type);
  }
  assert.equal(ext.sent.length, 0);
  assert.equal(ext.session.invokes.w1.phase, null);
  // And the other way round: an invoke record is not a withdraw's.
  const ext2 = fakeExt();
  const h2 = hostWith(ext2, { ids: ['i1'] }).host;
  await h2.handle({ type: 'rand:invoke', params: invokeReq }, site());
  for (const type of ['rand:withdrawRequest', 'rand:withdrawProgress', 'rand:withdrawResult']) {
    assert.equal((await h2.handle({ type, id: 'i1', phase: 'proving', ok: true, result: { tx: TX } }, win())).error.code, 'GONE', type);
  }
  assert.equal(ext2.sent.length, 0);
});

test('a window that could not be opened answers at once and parks nothing', async () => {
  const ext = fakeExt();
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'w1', openWithdraw: async () => { throw new Error('no windows API'); } });
  assert.equal((await host.handle({ type: 'rand:withdraw', params: REQ }, site())).error.code, 'UNAVAILABLE');
  assert.deepEqual(ext.session.invokes, {});
});
