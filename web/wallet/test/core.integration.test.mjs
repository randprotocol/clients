// The same Backend, on the *real* wasm core rather than a stub: keys, the address, the vault and
// the unlock cycle, end to end. Nothing is stubbed here but the storage (a Map) and the node
// (there is none — every method exercised below is offline by nature).
//
// The core is loaded with `initSync` under Node, the way extension/test/smoke.mjs does it, so this
// runs in `node --test` with no browser. `rand_wallet_bg.wasm` is git-ignored build output; if it
// is absent and cannot be built, the whole file skips with a message rather than failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';
import { BUNDLE_INPUTS } from '../../../ui/engine/wallet.js';
import { assertBackend } from '../../../ui/backend.js';

const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);
const PASSWORD = 'a-real-password-for-a-real-vault';

const haveCore = existsSync(CORE_JS) && existsSync(CORE_WASM);
const skip = haveCore
  ? false
  : 'the wasm core is not built — run core/scripts/build-wasm.sh (a few minutes) to run this file';

/** The same `{call(method, params)}` shape the browser shells hand the backend, synchronous here. */
async function realCore() {
  const mod = await import(CORE_JS.href);
  mod.initSync({ module: readFileSync(CORE_WASM) });
  return {
    async call(method, params = {}) {
      const reply = JSON.parse(mod.call(method, JSON.stringify(params)));
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
  };
}

function mapStorage() {
  const local = new Map();
  const session = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    local,
    sessionMap: session,
    async get(k) { return clone(local.get(k)); },
    async set(k, v) { local.set(k, clone(v)); },
    async remove(k) { local.delete(k); },
    async clear() { local.clear(); session.clear(); },
    session: {
      async get(k) { return session.get(k); },
      async set(k, v) { session.set(k, v); },
      async remove(k) { session.delete(k); },
    },
  };
}

async function build() {
  const core = await realCore();
  const storage = mapStorage();
  const backend = makeWasmBackend({
    core,
    storage,
    platform: { name: 'node-integration', openExternal() {}, copy() {} },
    // No node is reachable from a test machine; nothing below asks for one.
    fetch: async () => { throw new Error('this test does not talk to a node'); },
    // Node has a real BroadcastChannel and a ref'd one would keep this process alive for ever.
    locks: null,
    broadcast: null,
  });
  return { backend, storage, core };
}

test('the real core satisfies the Backend contract', { skip }, async () => {
  const { backend } = await build();
  assertBackend(backend);
});

test('create → a real address, a real vault, a real viewing key', { skip }, async () => {
  const { backend, storage, core } = await build();
  const constants = await core.call('version');

  assert.equal(await backend.wallet.exists(), false);
  const created = await backend.wallet.create(PASSWORD);

  // The address comes from the core's own human-readable part, never a literal in JavaScript.
  assert.ok(constants.address_hrp, 'the core reports an address prefix');
  assert.ok(created.address.startsWith(constants.address_hrp), `address ${created.address.slice(0, 12)}… does not start with ${constants.address_hrp}`);
  // `rand1` + base58 of 32 + 1184 bytes; 1665 or 1666 characters (see extension/test/smoke.mjs).
  assert.ok([1665, 1666].includes(created.address.length), `address length ${created.address.length}`);
  assert.match(created.pk, /^[0-9a-f]{64}$/);

  const parsed = await backend.wallet.parseAddress(created.address);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.pk, created.pk);
  assert.equal((await backend.wallet.parseAddress('rand1nope')).valid, false);

  // The vault is a real AES-GCM ciphertext, and the plaintext is only in the session.
  const vault = storage.local.get('vault');
  assert.equal(vault.kdf, 'pbkdf2-sha256');
  assert.equal(vault.iter, 600000);
  const spendKey = await backend.wallet.exportSpendKey();
  assert.match(spendKey, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify([...storage.local.entries()]).includes(spendKey), false, 'the spend key is in persistent storage');
  assert.equal(storage.sessionMap.get('unlocked').spend_key, spendKey);

  const viewingKey = await backend.wallet.viewingKey();
  assert.match(viewingKey, /^[0-9a-f]{64}$/);
  assert.notEqual(viewingKey, spendKey);

  // The settings this shell starts with come from the core, so they describe the chain it was
  // built against and cannot drift from it.
  const settings = await backend.settings.get();
  assert.equal(settings.chainId, constants.default_chain_id);
});

test('lock and unlock round-trip through the real vault', { skip }, async () => {
  const { backend } = await build();
  const created = await backend.wallet.create(PASSWORD);
  const spendKey = await backend.wallet.exportSpendKey();

  await backend.wallet.lock();
  assert.equal(await backend.wallet.isUnlocked(), false);
  await assert.rejects(() => backend.wallet.exportSpendKey(), /locked/);

  await assert.rejects(() => backend.wallet.unlock('not the password'), /^Error: wrong password$/);
  assert.equal(await backend.wallet.isUnlocked(), false);

  const reopened = await backend.wallet.unlock(PASSWORD);
  assert.equal(reopened.address, created.address);
  assert.equal(await backend.wallet.isUnlocked(), true);
  assert.equal(await backend.wallet.exportSpendKey(), spendKey, 'the same key came back out');
});

test('verifyPassword answers true and false without touching the session', { skip }, async () => {
  const { backend } = await build();
  await backend.wallet.create(PASSWORD);
  assert.equal(await backend.wallet.verifyPassword(PASSWORD), true);
  assert.equal(await backend.wallet.verifyPassword(`${PASSWORD}!`), false);
  assert.equal(await backend.wallet.verifyPassword(''), false);
  assert.equal(await backend.wallet.isUnlocked(), true, 're-authentication is not unlocking');
});

test('import brings a key back, in both forms the core accepts', { skip }, async () => {
  const { backend } = await build();
  const created = await backend.wallet.create(PASSWORD);
  const spendKey = await backend.wallet.exportSpendKey();
  await backend.wallet.wipe();

  const reimported = await backend.wallet.import(spendKey, PASSWORD);
  assert.equal(reimported.address, created.address, 'the same key gives the same address');

  await backend.wallet.wipe();
  const fromKeyFile = await backend.wallet.import(JSON.stringify({ version: 2, spend_key: spendKey }), PASSWORD);
  assert.equal(fromKeyFile.address, created.address);

  await backend.wallet.wipe();
  await assert.rejects(() => backend.wallet.import('not-a-key', `${PASSWORD}x`), /64 hex|key file/);
  assert.equal(await backend.wallet.exists(), false, 'a refused import leaves no wallet behind');
});

test('an empty wallet has one asset, no notes and cannot prove', { skip }, async () => {
  const { backend } = await build();
  await backend.wallet.create(PASSWORD);

  const assets = await backend.assets.list(); // the registry RPC fails; RAND still answers
  assert.equal(assets.length, 1);
  assert.equal(assets[0].index, 0);
  assert.equal(assets[0].symbol, 'RAND');
  assert.equal(assets[0].balance, '0');

  const cached = await backend.sync.cached();
  assert.deepEqual(cached.notes, []);
  assert.deepEqual(cached.activity, []);

  const prove = await backend.send.canProve();
  assert.equal(prove.ok, false);
  assert.match(prove.reason, /5\.5 GB/);
  await assert.rejects(() => backend.send.send({ asset: 0, to: 'rand1x', amount: '1' }, () => {}), (err) => err.definite === true);
});

test('BUNDLE_INPUTS matches what the real core will actually select', { skip }, async () => {
  // `maxSendable` takes "the largest N spendable notes" from `BUNDLE_INPUTS`, which is a chain
  // rule written down in JavaScript. This is the cross-check that it is the *right* number: the
  // core is asked to select for a need that N notes can cover and for one that needs N + 1.
  const core = await realCore();
  const call = (m, p) => core.call(m, p);
  const note = (index, units) => ({
    index, note: '00'.repeat(112), cm: `${index}`.padStart(2, '0').repeat(32),
    nf: `${index + 50}`.padStart(2, '0').repeat(32), amount: String(units), asset: 0,
    time: 1, from: '00'.repeat(32), height: 1, spent: false, pending: null,
  });
  const ONE = 1_000_000_000;
  const notes = Array.from({ length: BUNDLE_INPUTS + 1 }, (_, i) => note(i, ONE));

  // Exactly BUNDLE_INPUTS notes' worth: selectable.
  const fits = await call('select_inputs', { notes, asset: 0, need: String(BUNDLE_INPUTS * ONE) });
  assert.equal(fits.chosen.length, BUNDLE_INPUTS, `the core chose ${fits.chosen.length}, not ${BUNDLE_INPUTS}`);

  // One unit more than BUNDLE_INPUTS notes hold, with a further note available: refused, which is
  // what proves the limit is BUNDLE_INPUTS and not something larger.
  await assert.rejects(
    () => call('select_inputs', { notes, asset: 0, need: String(BUNDLE_INPUTS * ONE + 1) }),
    /more than two notes|consolidate/i,
    `the core accepted a selection needing ${BUNDLE_INPUTS + 1} notes, so BUNDLE_INPUTS is wrong`,
  );

  // And the constant is not reported by the core today — if it ever is, maxSendable prefers it.
  const constants = await call('version', {});
  if (constants.bundle_inputs !== undefined) {
    assert.equal(constants.bundle_inputs, BUNDLE_INPUTS, 'the core now reports a different input count');
  }
});

test('the real core refuses a vault this build cannot understand, without a KDF', { skip }, async () => {
  const { backend, storage } = await build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  storage.local.set('vault', { ...storage.local.get('vault'), v: 2 });
  await assert.rejects(() => backend.wallet.unlock(PASSWORD), (err) => {
    assert.equal(err.code, 'VAULT_VERSION');
    return true;
  });
  assert.equal(storage.local.get('unlockFailures'), undefined);
});
