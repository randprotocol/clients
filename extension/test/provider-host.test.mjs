// provider-host.js under plain Node: the classic script is evaluated as the browser would load it,
// against a stubbed WebExtension API. What is checked is the policy — who learns the address, and
// when — not the plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
