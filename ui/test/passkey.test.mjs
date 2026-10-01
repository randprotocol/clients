// "Unlock with Touch ID": the passkey seals the password (engine/crypto.js), the engine's
// `wallet.passkey` group sets it up only for the right password and gives the password back only
// for the passkey that sealed it, and the extension's WebAuthn half (extension/shared/lib/passkey.js)
// asks for exactly a platform credential, user verification, and the PRF extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend } from '../engine/backend-wasm.js';
import { sealWithPasskey, openWithPasskey } from '../engine/crypto.js';
import { makePasskey } from '../../extension/shared/lib/passkey.js';
import { PASSWORD, mapStorage, stubCore, stubFetch, stubPlatform } from './backend-fixtures.mjs';

const prfOf = (byte) => new Uint8Array(32).fill(byte);

test('the sealed password opens only with the PRF output that sealed it', async () => {
  const rec = await sealWithPasskey(prfOf(7), PASSWORD);
  assert.equal(await openWithPasskey(prfOf(7), rec), PASSWORD);
  await assert.rejects(() => openWithPasskey(prfOf(8), rec), /did not open/);
  await assert.rejects(() => openWithPasskey(prfOf(7), { ...rec, v: 2 }), /not one this build reads/);
  await assert.rejects(() => sealWithPasskey(new Uint8Array(16), PASSWORD), /too little key material/);
  assert.equal(JSON.stringify(rec).includes(PASSWORD), false);
});

/** A platform authenticator: one credential, a PRF that is a function of it and the salt. */
function fakeAuthenticator({ prfAtCreate = false, cancel = false } = {}) {
  const calls = [];
  const secret = 42;
  const prf = (salt) => prfOf((secret + salt.length) & 0xff);
  return {
    calls,
    available: async () => true,
    label: () => 'Touch ID',
    register: async () => { calls.push('register'); return { credentialId: 'cred-1', salt: 'c2FsdA', ...(prfAtCreate ? { prf: prf('c2FsdA') } : {}) }; },
    prf: async ({ credentialId, salt }) => {
      calls.push('prf');
      if (cancel) throw Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
      assert.equal(credentialId, 'cred-1');
      return prf(salt);
    },
  };
}

function build(passkey) {
  const storage = mapStorage();
  const platform = { ...stubPlatform(), passkey };
  const backend = makeWasmBackend({ core: stubCore(), storage, platform, fetch: stubFetch(), locks: null, broadcast: null });
  return { backend, storage };
}

test('a shell without platform.passkey has no wallet.passkey group', () => {
  const { backend } = build(undefined);
  assert.equal(backend.wallet.passkey, undefined);
});

test('turning it on needs the right password; then the passkey gives the password back and it unlocks', async () => {
  const auth = fakeAuthenticator();
  const { backend, storage } = build(auth);
  await backend.wallet.create(PASSWORD);
  const pk = backend.wallet.passkey;
  assert.equal(pk.label(), 'Touch ID');
  assert.equal(await pk.enabled(), false);
  await assert.rejects(() => pk.enable('not-the-password-at-all'), /wrong password/);
  assert.equal(await pk.enabled(), false, 'a wrong password sets nothing up');
  assert.deepEqual(auth.calls, [], 'and never reaches the authenticator');

  await pk.enable(PASSWORD);
  assert.equal(await pk.enabled(), true);
  assert.deepEqual(auth.calls, ['register', 'prf'], 'one credential, then the PRF asked once');
  assert.equal(JSON.stringify(await storage.get('passkeyUnlock')).includes(PASSWORD), false, 'the password is not stored in the clear');

  await backend.wallet.lock();
  const pw = await pk.recoverPassword();
  assert.equal(pw, PASSWORD);
  await backend.wallet.unlock(pw);
  assert.equal(await backend.wallet.isUnlocked(), true);

  await pk.disable();
  assert.equal(await pk.enabled(), false);
  await assert.rejects(() => pk.recoverPassword(), (e) => e.code === 'PASSKEY_FAILED');
});

test('a PRF answered at creation is used, and a dismissed prompt is CANCELLED', async () => {
  const atCreate = fakeAuthenticator({ prfAtCreate: true });
  const a = build(atCreate);
  await a.backend.wallet.create(PASSWORD);
  await a.backend.wallet.passkey.enable(PASSWORD);
  assert.deepEqual(atCreate.calls, ['register'], 'no second prompt when creation already gave the PRF');

  const cancelling = fakeAuthenticator({ cancel: true, prfAtCreate: true });
  const b = build(cancelling);
  await b.backend.wallet.create(PASSWORD);
  await b.backend.wallet.passkey.enable(PASSWORD);
  await assert.rejects(() => b.backend.wallet.passkey.recoverPassword(), (e) => e.code === 'CANCELLED');
});

test('a wipe forgets the passkey record with the wallet', async () => {
  const { backend, storage } = build(fakeAuthenticator());
  await backend.wallet.create(PASSWORD);
  await backend.wallet.passkey.enable(PASSWORD);
  await backend.wallet.wipe();
  assert.equal(await storage.get('passkeyUnlock'), undefined);
});

// ---- the extension's WebAuthn half ----

function fakeWebAuthn({ prf = true, prfAtCreate = false } = {}) {
  const seen = { create: null, get: null };
  const credential = (results) => ({ rawId: new Uint8Array([1, 2, 3]).buffer, getClientExtensionResults: () => results });
  const nav = {
    platform: 'MacIntel',
    credentials: {
      create: async ({ publicKey }) => { seen.create = publicKey; return credential(prf ? { prf: { enabled: true, ...(prfAtCreate ? { results: { first: new Uint8Array(32).fill(9).buffer } } : {}) } } : {}); },
      get: async ({ publicKey }) => { seen.get = publicKey; return credential({ prf: { results: { first: new Uint8Array(32).fill(5).buffer } } }); },
    },
  };
  const PKC = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true };
  return { nav, PKC, seen };
}
const chromeExt = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } };
const at = (protocol) => ({ protocol });

test('the extension asks for a platform passkey under its own id, with user verification and PRF', async () => {
  const w = fakeWebAuthn();
  const pk = makePasskey(chromeExt, { nav: w.nav, PKC: w.PKC, loc: at('chrome-extension:') });
  assert.equal(pk.label(), 'Touch ID');
  assert.equal(await pk.available(), true);
  const made = await pk.register();
  assert.equal(w.seen.create.rp.id, chromeExt.runtime.id, 'the relying party is the extension, which no web page can name');
  assert.equal(w.seen.create.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(w.seen.create.authenticatorSelection.userVerification, 'required');
  assert.ok(w.seen.create.extensions.prf, 'the PRF extension is asked for');
  assert.equal(made.credentialId, 'AQID');
  const out = await pk.prf(made);
  assert.equal(w.seen.get.rpId, chromeExt.runtime.id);
  assert.equal(w.seen.get.userVerification, 'required');
  assert.equal(out.length, 32);
  assert.ok(w.seen.get.extensions.prf.eval.first.length === 32, 'the stored salt goes back as the PRF input');
});

test('no PRF means no passkey unlock; Firefox and web pages get none at all', async () => {
  const noPrf = fakeWebAuthn({ prf: false });
  const pk = makePasskey(chromeExt, { nav: noPrf.nav, PKC: noPrf.PKC, loc: at('chrome-extension:') });
  await assert.rejects(() => pk.register(), /no PRF support/);
  const w = fakeWebAuthn();
  assert.equal(makePasskey(chromeExt, { nav: w.nav, PKC: w.PKC, loc: at('moz-extension:') }), null);
  assert.equal(makePasskey(chromeExt, { nav: w.nav, PKC: w.PKC, loc: at('https:') }), null);
  assert.equal(makePasskey({ runtime: {} }, { nav: w.nav, PKC: w.PKC, loc: at('chrome-extension:') }), null);
});
