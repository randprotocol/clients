// provider-host.js's `invoke` under plain Node, the classic script evaluated as the browser loads it.
// The policy: who may ask, that the request waits in storage.session for the approval window, that
// only an extension page may answer it, that the answer goes to the tab that asked, and that a window
// closed before answering answers for itself — honestly about whether anything may have been sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../shared/provider-host.js', import.meta.url), 'utf8'));

const ROOT = 'chrome-extension://abc/';
const ORIGIN = 'https://durian.market';
const PROGRAM = 'db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda';
const TX = 'ab'.repeat(32);

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
const page = (origin = ORIGIN, tabId = 4) => ({ origin, url: `${origin}/swap`, tab: { id: tabId } });
const win = () => ({ url: `${ROOT}invoke.html?id=i1` });
const request = (over = {}) => ({ program: PROGRAM, inputs: [1], reads: [], writes: [], inflow: { rand: '1', asset: 0, amount: '0', kind: 'none' }, pays: [], mints: [], summary: { title: 'Swap' }, ...over });

function hostWith(ext, { windowId = 77 } = {}) {
  const opened = [];
  const host = globalThis.makeRandProviderHost({
    ext, openConsent: async () => {}, newId: () => 'i1',
    openInvoke: async (r) => { opened.push(r); return windowId; },
  });
  return { host, opened };
}

test('an approved site\'s invoke opens the approval window and answers pending; the request waits in the session', async () => {
  const ext = fakeExt();
  const { host, opened } = hostWith(ext);
  assert.deepEqual(await host.handle({ type: 'rand:invoke', params: request() }, page()), { pending: 'i1' });
  assert.deepEqual(opened, [{ id: 'i1', origin: ORIGIN }]);
  const rec = ext.session.invokes.i1;
  assert.equal(rec.origin, ORIGIN, 'the origin is the sender\'s');
  assert.equal(rec.tabId, 4);
  assert.equal(rec.windowId, 77);
  assert.equal(rec.request.program, PROGRAM);
  // The window reads it back by id; a page cannot.
  assert.deepEqual(await host.handle({ type: 'rand:invokeRequest', id: 'i1' }, win()), { ok: true, result: { origin: ORIGIN, request: rec.request } });
  assert.equal((await host.handle({ type: 'rand:invokeRequest', id: 'i1' }, page())).error.code, 'FORBIDDEN');
});

test('no wallet, a locked wallet, an origin never connected and junk are refused without a window', async () => {
  for (const [ext, code, params] of [
    [fakeExt({ wallet: null }), 'NO_WALLET', request()],
    [fakeExt({ unlocked: false }), 'LOCKED', request()],
    [fakeExt({ granted: false }), 'NOT_CONNECTED', request()],
    [fakeExt(), 'BAD_REQUEST', request({ program: 'nope' })],
    [fakeExt(), 'BAD_REQUEST', null],
  ]) {
    const { host, opened } = hostWith(ext);
    const res = await host.handle({ type: 'rand:invoke', params }, page());
    assert.equal(res.error && res.error.code, code);
    assert.equal(opened.length, 0, `${code}: no window`);
  }
  const { host } = hostWith(fakeExt());
  assert.equal((await host.handle({ type: 'rand:invoke', params: request() }, { url: 'file:///x.html' })).error.code, 'UNSUPPORTED_ORIGIN');
});

test('one request per site at a time', async () => {
  const ext = fakeExt();
  const { host, opened } = hostWith(ext);
  await host.handle({ type: 'rand:invoke', params: request() }, page());
  assert.equal((await host.handle({ type: 'rand:invoke', params: request() }, page())).error.code, 'BUSY');
  assert.equal(opened.length, 1);
});

test('the window\'s result goes to the tab that asked, once, and the request is forgotten', async () => {
  const ext = fakeExt();
  const { host } = hostWith(ext);
  await host.handle({ type: 'rand:invoke', params: request() }, page());
  // A result naming another tab is still delivered to the one that asked.
  await host.handle({ type: 'rand:invokeResult', id: 'i1', tabId: 99, ok: true, result: { tx: `0x${TX.toUpperCase()}` } }, win());
  assert.deepEqual(ext.sent, [[4, { type: 'rand:decision', id: 'i1', ok: true, result: { tx: TX } }]]);
  assert.deepEqual(ext.session.invokes, {});
  await host.handle({ type: 'rand:invokeResult', id: 'i1', ok: false, error: { code: 'X', message: 'late' } }, win());
  assert.equal(ext.sent.length, 1, 'a second answer finds nothing to answer');
});

test('only an extension page may answer, and a refusal\'s code and message are bounded', async () => {
  const ext = fakeExt();
  const { host } = hostWith(ext);
  await host.handle({ type: 'rand:invoke', params: request() }, page());
  assert.equal((await host.handle({ type: 'rand:invokeResult', id: 'i1', ok: true, result: { tx: TX } }, page())).error.code, 'FORBIDDEN');
  assert.equal(ext.sent.length, 0);
  await host.handle({ type: 'rand:invokeResult', id: 'i1', ok: false, error: { code: '<script>', message: 'x'.repeat(1000) } }, win());
  const [, msg] = ext.sent[0];
  assert.equal(msg.error.code, 'UNKNOWN');
  assert.equal(msg.error.message.length, 300);
  const ext2 = fakeExt();
  const h2 = hostWith(ext2).host;
  await h2.handle({ type: 'rand:invoke', params: request() }, page());
  await h2.handle({ type: 'rand:invokeResult', id: 'i1', ok: true, result: { tx: 'not-a-hash' } }, win());
  assert.equal(ext2.sent[0][1].ok, false, 'a result that is not a hash is not passed on as one');
});

test('a window closed unanswered: never approved is USER_REJECTED, mid-proof INTERRUPTED, once sending UNKNOWN_OUTCOME', async () => {
  for (const [phase, code] of [[null, 'USER_REJECTED'], ['proving', 'INTERRUPTED'], ['submitting', 'UNKNOWN_OUTCOME']]) {
    const ext = fakeExt();
    const { host } = hostWith(ext);
    await host.handle({ type: 'rand:invoke', params: request() }, page());
    if (phase) await host.handle({ type: 'rand:invokeProgress', id: 'i1', phase }, win());
    await host.windowClosed(12); // some other window
    assert.equal(ext.sent.length, 0);
    await host.windowClosed(77);
    assert.equal(ext.sent.length, 1, phase);
    assert.equal(ext.sent[0][1].error.code, code, `phase ${phase}`);
    assert.deepEqual(ext.session.invokes, {});
  }
});

test('a window that could not be opened answers at once and parks nothing', async () => {
  const ext = fakeExt();
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'i1', openInvoke: async () => { throw new Error('no windows API'); } });
  const res = await host.handle({ type: 'rand:invoke', params: request() }, page());
  assert.equal(res.error.code, 'UNAVAILABLE');
  assert.deepEqual(ext.session.invokes, {});
});
