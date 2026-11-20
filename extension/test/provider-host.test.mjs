// provider-host.js under plain Node: the classic script is evaluated as the browser would load it,
// against a stubbed WebExtension API. What is checked is the policy — who learns the address, and
// when — not the plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// lib/derive-key.js first, as background.js loads it: the host's `deriveKey` uses its KDF.
vm.runInThisContext(readFileSync(new URL('../shared/lib/derive-key.js', import.meta.url), 'utf8'));
vm.runInThisContext(readFileSync(new URL('../shared/provider-host.js', import.meta.url), 'utf8'));

const ROOT = 'chrome-extension://abc/';
function fakeExt({ wallet = { address: 'rand1real', pk: 'pk' }, unlocked = true, sites = {} } = {}) {
  const local = { wallet, sites };
  const session = unlocked ? { unlocked: { key: 'x' } } : {};
  const sent = [];
  const pick = (bag) => async (key) => (key in bag ? { [key]: bag[key] } : {});
  return {
    sent, local,
    runtime: { getURL: (p) => ROOT + p },
    storage: {
      local: { get: pick(local), set: async (obj) => Object.assign(local, obj) },
      session: { get: pick(session) },
    },
    tabs: { sendMessage: async (tabId, msg) => { sent.push([tabId, msg]); } },
  };
}
const site = (origin = 'https://randbridge.org', tabId = 4) => ({ origin, url: origin + '/', tab: { id: tabId } });
const consentPage = () => ({ url: ROOT + 'connect.html?id=1' });

test('a first connect opens the consent window and answers pending', async () => {
  const ext = fakeExt();
  const opened = [];
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async (r) => { opened.push(r); }, newId: () => 'c1' });
  assert.deepEqual(await host.handle({ type: 'rand:connect' }, site()), { pending: 'c1' });
  assert.deepEqual(opened, [{ id: 'c1', origin: 'https://randbridge.org', tabId: 4 }]);
  // Nothing is known to the site before the verdict.
  assert.equal((await host.handle({ type: 'rand:getAddress' }, site())).error.code, 'NOT_CONNECTED');
});

test('approval stores the grant, tells the tab, and unlocks the address and hash for that origin only', async () => {
  const ext = fakeExt();
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'c1' });
  await host.handle({ type: 'rand:connect' }, site());
  const res = await host.handle({ type: 'rand:decision', id: 'c1', origin: 'https://randbridge.org', tabId: 4, approved: true, address: 'rand1real', hash: 'ab'.repeat(32) }, consentPage());
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(ext.sent, [[4, { type: 'rand:decision', id: 'c1', ok: true, result: { address: 'rand1real' } }]]);
  assert.deepEqual(await host.handle({ type: 'rand:connect' }, site()), { ok: true, result: { address: 'rand1real' } });
  assert.deepEqual(await host.handle({ type: 'rand:getRecipientHash' }, site()), { ok: true, result: 'ab'.repeat(32) });
  assert.equal((await host.handle({ type: 'rand:getAddress' }, site('https://evil.example'))).error.code, 'NOT_CONNECTED');
});

test('a refusal tells the tab USER_REJECTED and stores nothing', async () => {
  const ext = fakeExt();
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'c1' });
  await host.handle({ type: 'rand:connect' }, site());
  await host.handle({ type: 'rand:decision', id: 'c1', origin: 'https://randbridge.org', tabId: 4, approved: false }, consentPage());
  assert.equal(ext.sent[0][1].error.code, 'USER_REJECTED');
  assert.deepEqual(ext.local.sites, {});
});

test('a decision may only come from an extension page', async () => {
  const ext = fakeExt();
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'c1' });
  const res = await host.handle({ type: 'rand:decision', id: 'c1', origin: 'https://randbridge.org', tabId: 4, approved: true, address: 'rand1real', hash: 'x' }, site());
  assert.equal(res.error.code, 'FORBIDDEN');
  assert.deepEqual(ext.local.sites, {});
});

test('no wallet, a locked wallet, and a non-web origin are each refused with their own code', async () => {
  const noWallet = globalThis.makeRandProviderHost({ ext: fakeExt({ wallet: null }), openConsent: async () => {} });
  assert.equal((await noWallet.handle({ type: 'rand:connect' }, site())).error.code, 'NO_WALLET');
  const locked = globalThis.makeRandProviderHost({ ext: fakeExt({ unlocked: false }), openConsent: async () => {} });
  assert.equal((await locked.handle({ type: 'rand:connect' }, site())).error.code, 'LOCKED');
  const host = globalThis.makeRandProviderHost({ ext: fakeExt(), openConsent: async () => {} });
  assert.equal((await host.handle({ type: 'rand:connect' }, { url: 'file:///x.html' })).error.code, 'UNSUPPORTED_ORIGIN');
});

test('a grant given to another wallet\'s address is not honoured, and disconnect forgets a grant', async () => {
  const ext = fakeExt({ sites: { 'https://randbridge.org': { address: 'rand1old', hash: 'h', at: 1 } } });
  const host = globalThis.makeRandProviderHost({ ext, openConsent: async () => {}, newId: () => 'c2' });
  assert.equal((await host.handle({ type: 'rand:getAddress' }, site())).error.code, 'NOT_CONNECTED');
  assert.deepEqual(await host.handle({ type: 'rand:connect' }, site()), { pending: 'c2' });
  ext.local.sites['https://randbridge.org'] = { address: 'rand1real', hash: 'h', at: 2 };
  assert.deepEqual(await host.handle({ type: 'rand:getAddress' }, site()), { ok: true, result: 'rand1real' });
  assert.deepEqual(await host.handle({ type: 'rand:disconnect' }, site()), { ok: true, result: null });
  assert.equal((await host.handle({ type: 'rand:getAddress' }, site())).error.code, 'NOT_CONNECTED');
});

test('messages that are not ours are ignored', async () => {
  const host = globalThis.makeRandProviderHost({ ext: fakeExt(), openConsent: async () => {} });
  assert.equal(await host.handle({ type: 'something-else' }, site()), undefined);
});

// ---- deriveKey: a key bound to the asking origin, the purpose and the connected address ----

const SPEND = '1f'.repeat(32);
const DURIAN = 'https://durian.market';
const HEX64 = /^[0-9a-f]{64}$/;
/** A wallet on a device: storage.local and storage.session as the engine leaves them. */
function deriveExt({ address = 'rand1real', spendKey = SPEND, unlocked = true, granted = [DURIAN] } = {}) {
  const local = {
    wallet: { address, pk: 'pk' },
    sites: Object.fromEntries(granted.map((o) => [o, { address, hash: 'h'.repeat(64), at: 1 }])),
  };
  const session = unlocked ? { unlocked: { spend_key: spendKey, viewing_key: 'ab'.repeat(32) } } : {};
  const sent = [];
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const pick = (bag) => async (key) => (key in bag ? { [key]: copy(bag[key]) } : {});
  return {
    sent, local, session,
    runtime: { getURL: (p) => ROOT + p },
    storage: {
      local: { get: pick(local), set: async (obj) => Object.assign(local, copy(obj)) },
      session: { get: pick(session), set: async (obj) => Object.assign(session, copy(obj)) },
    },
    tabs: { sendMessage: async (tabId, msg, opts) => { sent.push(opts ? [tabId, msg, opts] : [tabId, msg]); } },
  };
}
function deriveHost(ext, { windowId = 55, ids = ['d1', 'd2', 'd3'] } = {}) {
  const opened = [];
  const queue = [...ids];
  const host = globalThis.makeRandProviderHost({
    ext, openConsent: async () => {}, newId: () => queue.shift(),
    openInvoke: async () => 99,
    openDerive: async (r) => { opened.push(r); return windowId; },
  });
  return { host, opened };
}
const page = (origin = DURIAN, tabId = 4, frameId = 0) => ({ origin, url: `${origin}/perps`, tab: { id: tabId }, frameId });
const deriveWin = () => ({ url: `${ROOT}derive.html?id=d1` });
const ask = (host, purpose = 'perps/trading', sender = page()) => host.handle({ type: 'rand:deriveKey', params: { purpose } }, sender);
/** Ask, approve in the window, and return the key the tab was given. */
async function approveOnce(ext, host, purpose = 'perps/trading', sender = page()) {
  const res = await ask(host, purpose, sender);
  assert.ok(res.pending, JSON.stringify(res));
  assert.deepEqual(await host.handle({ type: 'rand:deriveResult', id: res.pending, approved: true }, deriveWin()), { ok: true });
  const [, msg] = ext.sent.at(-1);
  assert.equal(msg.ok, true, JSON.stringify(msg));
  return msg.result.key;
}

test('deriveKey: an origin that is not connected is refused NOT_CONNECTED, without a window', async () => {
  const ext = deriveExt({ granted: [] });
  const { host, opened } = deriveHost(ext);
  assert.equal((await ask(host)).error.code, 'NOT_CONNECTED');
  assert.equal(opened.length, 0);
  // A grant for another site is not this site's.
  const { host: h2, opened: o2 } = deriveHost(deriveExt({ granted: ['https://randbridge.org'] }));
  assert.equal((await ask(h2)).error.code, 'NOT_CONNECTED');
  assert.equal(o2.length, 0);
});

test('deriveKey: the first request opens the approval window; Approve stores the yes and the tab gets the key', async () => {
  const ext = deriveExt();
  const { host, opened } = deriveHost(ext);
  assert.deepEqual(await ask(host), { pending: 'd1' });
  assert.deepEqual(opened, [{ id: 'd1', origin: DURIAN }]);
  const rec = ext.session.invokes.d1;
  assert.equal(rec.kind, 'derive');
  assert.equal(rec.origin, DURIAN, 'the origin is the sender\'s');
  assert.deepEqual(rec.request, { purpose: 'perps/trading' });
  assert.equal(rec.windowId, 55);
  // The window reads what it shows by id; a page cannot, and an invoke window cannot either.
  assert.deepEqual(await host.handle({ type: 'rand:deriveRequest', id: 'd1' }, deriveWin()), { ok: true, result: { origin: DURIAN, request: { purpose: 'perps/trading' } } });
  assert.equal((await host.handle({ type: 'rand:deriveRequest', id: 'd1' }, page())).error.code, 'FORBIDDEN');
  assert.equal((await host.handle({ type: 'rand:invokeRequest', id: 'd1' }, deriveWin())).error.code, 'GONE');
  // Only an extension page may approve.
  assert.equal((await host.handle({ type: 'rand:deriveResult', id: 'd1', approved: true }, page())).error.code, 'FORBIDDEN');
  assert.equal(ext.sent.length, 0);

  const answer = await host.handle({ type: 'rand:deriveResult', id: 'd1', approved: true }, deriveWin());
  assert.deepEqual(answer, { ok: true }, 'the window is told nothing but that it was heard');
  assert.equal(ext.sent.length, 1);
  const [tabId, msg, opts] = ext.sent[0];
  assert.equal(tabId, 4);
  assert.deepEqual(opts, { frameId: 0 }, 'to the frame that asked');
  assert.equal(msg.type, 'rand:decision');
  assert.equal(msg.id, 'd1');
  assert.equal(msg.ok, true);
  assert.deepEqual(Object.keys(msg.result), ['key']);
  assert.match(msg.result.key, HEX64);
  // It is the documented derivation, over the sender's origin and the connected address.
  assert.equal(msg.result.key, await globalThis.RandSiteKey.deriveSiteKey({ spendKey: SPEND, origin: DURIAN, purpose: 'perps/trading', address: 'rand1real' }));
  // The yes is stored under the site's entry, per purpose and tied to the address; the key is not stored anywhere.
  assert.deepEqual(Object.keys(ext.local.sites[DURIAN].siteKeys), ['perps/trading']);
  assert.equal(ext.local.sites[DURIAN].siteKeys['perps/trading'].address, 'rand1real');
  assert.deepEqual(ext.session.invokes, {});
  assert.doesNotMatch(JSON.stringify(ext.local) + JSON.stringify(ext.session), new RegExp(msg.result.key));
});

test('deriveKey: once approved, later requests answer at once with the same key and no window', async () => {
  const ext = deriveExt();
  const { host, opened } = deriveHost(ext);
  const key = await approveOnce(ext, host);
  const again = await ask(host);
  assert.deepEqual(again, { ok: true, result: { key } });
  assert.equal(opened.length, 1, 'no second window');
  // Another purpose is another question.
  assert.deepEqual(await ask(host, 'perps/other'), { pending: 'd2' });
  assert.equal(opened.length, 2);
});

test('deriveKey: same wallet, origin and purpose give the same key on another device; another origin or purpose a different one', async () => {
  const a = deriveExt({ granted: [DURIAN, 'https://www.durian.market', 'http://localhost:3000'] });
  const { host: ha } = deriveHost(a, { ids: ['d1', 'd2', 'd3', 'd4'] });
  const key = await approveOnce(a, ha);
  // A second device restored from the same spend key.
  const b = deriveExt();
  const { host: hb } = deriveHost(b);
  assert.equal(await approveOnce(b, hb), key);
  const otherOrigin = await approveOnce(a, ha, 'perps/trading', page('https://www.durian.market'));
  const otherPort = await approveOnce(a, ha, 'perps/trading', page('http://localhost:3000'));
  const otherPurpose = await approveOnce(a, ha, 'perps/staging');
  assert.equal(new Set([key, otherOrigin, otherPort, otherPurpose]).size, 4);
  // Another wallet, same site and purpose: another key.
  const c = deriveExt({ spendKey: '2e'.repeat(32), address: 'rand1other' });
  const { host: hc } = deriveHost(c);
  assert.notEqual(await approveOnce(c, hc), key);
});

test('deriveKey: the origin is the sender\'s, whatever the message says', async () => {
  const ext = deriveExt({ granted: [DURIAN, 'https://evil.example'] });
  const { host } = deriveHost(ext);
  const evil = page('https://evil.example');
  const res = await host.handle({ type: 'rand:deriveKey', origin: DURIAN, params: { purpose: 'perps/trading', origin: DURIAN } }, evil);
  assert.equal(ext.session.invokes[res.pending].origin, 'https://evil.example');
  assert.deepEqual(ext.session.invokes[res.pending].request, { purpose: 'perps/trading' }, 'nothing else of the params is kept');
  await host.handle({ type: 'rand:deriveResult', id: res.pending, approved: true, origin: DURIAN }, deriveWin());
  const key = ext.sent[0][1].result.key;
  assert.equal(key, await globalThis.RandSiteKey.deriveSiteKey({ spendKey: SPEND, origin: 'https://evil.example', purpose: 'perps/trading', address: 'rand1real' }));
  assert.notEqual(key, await globalThis.RandSiteKey.deriveSiteKey({ spendKey: SPEND, origin: DURIAN, purpose: 'perps/trading', address: 'rand1real' }));
  assert.equal(ext.local.sites[DURIAN].siteKeys, undefined, 'the yes went to the asking site only');
});

test('deriveKey: a purpose outside [a-z0-9./-]{1,64} is BAD_REQUEST, without a window', async () => {
  const ext = deriveExt();
  const { host, opened } = deriveHost(ext);
  for (const params of [{ purpose: '' }, { purpose: 'Perps' }, { purpose: 'perps trading' }, { purpose: 'a'.repeat(65) }, { purpose: 'perps/é' },
    { purpose: 'perps\n' }, { purpose: 7 }, { purpose: ['perps'] }, {}, null, undefined, 'perps']) {
    const res = await host.handle({ type: 'rand:deriveKey', params }, page());
    assert.equal(res.error && res.error.code, 'BAD_REQUEST', JSON.stringify(params));
  }
  assert.equal(opened.length, 0);
  assert.ok((await ask(host, 'a'.repeat(64))).pending, '64 characters is allowed');
});

test('deriveKey: a locked wallet is LOCKED, before a window and after an approval', async () => {
  const { host, opened } = deriveHost(deriveExt({ unlocked: false }));
  assert.equal((await ask(host)).error.code, 'LOCKED');
  assert.equal(opened.length, 0);
  // Approved earlier, locked now: no key.
  const ext = deriveExt();
  const h = deriveHost(ext).host;
  await approveOnce(ext, h);
  delete ext.session.unlocked;
  assert.equal((await ask(h)).error.code, 'LOCKED');
  // Locked while the window was open: the approval answers LOCKED and gives nothing.
  const ext2 = deriveExt();
  const h2 = deriveHost(ext2).host;
  await ask(h2);
  delete ext2.session.unlocked;
  await h2.handle({ type: 'rand:deriveResult', id: 'd1', approved: true }, deriveWin());
  assert.equal(ext2.sent[0][1].ok, false);
  assert.equal(ext2.sent[0][1].error.code, 'LOCKED');
  assert.equal(ext2.local.sites[DURIAN].siteKeys, undefined);
});

test('deriveKey: Reject or a closed window is USER_REJECTED and stores nothing', async () => {
  const ext = deriveExt();
  const { host } = deriveHost(ext);
  await ask(host);
  await host.handle({ type: 'rand:deriveResult', id: 'd1', approved: false }, deriveWin());
  assert.equal(ext.sent[0][1].error.code, 'USER_REJECTED');
  assert.equal(ext.local.sites[DURIAN].siteKeys, undefined);
  // Progress is not a thing a key request has.
  await ask(host);
  assert.equal((await host.handle({ type: 'rand:deriveProgress', id: 'd2', phase: 'submitting' }, deriveWin())).error.code, 'BAD_REQUEST');
  await host.windowClosed(55);
  assert.equal(ext.sent[1][1].id, 'd2');
  assert.equal(ext.sent[1][1].error.code, 'USER_REJECTED');
  assert.deepEqual(ext.session.invokes, {});
  assert.equal(ext.local.sites[DURIAN].siteKeys, undefined);
});

test('deriveKey: one request per site at a time, shared with invoke (BUSY)', async () => {
  const ext = deriveExt();
  const { host, opened } = deriveHost(ext);
  await ask(host);
  assert.equal((await ask(host)).error.code, 'BUSY');
  assert.equal((await host.handle({ type: 'rand:invoke', params: { program: 'ab'.repeat(32) } }, page())).error.code, 'BUSY');
  assert.equal(opened.length, 1);
});

test('deriveKey: disconnect forgets the approval; a yes given to another address is not honoured', async () => {
  const ext = deriveExt();
  const { host, opened } = deriveHost(ext);
  await approveOnce(ext, host);
  await host.handle({ type: 'rand:disconnect' }, page());
  assert.equal((await ask(host)).error.code, 'NOT_CONNECTED');
  // Connected again: the key is asked for again.
  ext.local.sites[DURIAN] = { address: 'rand1real', hash: 'h'.repeat(64), at: 3 };
  assert.ok((await ask(host)).pending);
  assert.equal(opened.length, 2);
  // A stored yes for another address (the site entry rewritten for this one) does not answer.
  const ext2 = deriveExt();
  ext2.local.sites[DURIAN].siteKeys = { 'perps/trading': { address: 'rand1old', at: 1 } };
  const d2 = deriveHost(ext2);
  assert.ok((await ask(d2.host)).pending);
  assert.equal(d2.opened.length, 1);
});

test('deriveKey: a host built without openDerive does not know the method', async () => {
  const host = globalThis.makeRandProviderHost({ ext: deriveExt(), openConsent: async () => {} });
  assert.equal((await ask(host)).error.code, 'UNKNOWN_METHOD');
});
