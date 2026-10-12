// The engine's signer profiles (spec 2026-10-11-msauth-signing-design.md §3): kept in the vault,
// policies opened at unlock, seeds only under the password, nothing in plain storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend } from '../engine/backend-wasm.js';
import { PASSWORD, mapStorage, stubCore, stubFetch, stubPlatform, GENESIS } from './backend-fixtures.mjs';

export const POLICY = '{"version":1,"threshold":2,"signers":["aa","bb","cc"],"msk":"' + '11'.repeat(32) + '"}';
export const KEY = '{"seed":"' + '22'.repeat(32) + '","address":"A","public_key":"bb"}';
export const SEED_HEX = '22'.repeat(32);
export function msauthCore(extra = {}) {
  return stubCore({
    msauth_policy_info: () => ({ fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60), policy_hash: '33'.repeat(32) }),
    msauth_signer_import: ({ input, policy }) => {
      if (!String(input).includes(SEED_HEX)) throw new Error('this key is not one of the policy\'s signers');
      return { seed: SEED_HEX, public_key: 'bb', address: 'A', index: policy ? 1 : null };
    },
    ...extra,
  });
}
export async function unlockedWithSigner(opts = {}) {
  const storage = opts.storage || mapStorage();
  const core = opts.core || msauthCore();
  const fetch = opts.fetch || stubFetch();
  const backend = makeWasmBackend({ core, storage, platform: stubPlatform(), fetch, locks: null, broadcast: null });
  await backend.wallet.create(PASSWORD);
  const [row] = await backend.signers.add({ label: 'treasury', policy: POLICY, key: KEY, password: PASSWORD });
  return { backend, storage, core, fetch, row };
}

test('adding a signer keeps policy and seed only in vault records', async () => {
  const { storage, row } = await unlockedWithSigner();
  assert.deepEqual({ ...row, id: 'x' }, { id: 'x', label: 'treasury', index: 1, fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60) });
  const everything = JSON.stringify([...storage.local.entries()]);
  assert.ok(!everything.includes(SEED_HEX), 'no seed in plain storage');
  assert.ok(!everything.includes('11'.repeat(32)), 'no msk in plain storage');
  assert.ok(!everything.includes('treasury'), 'no label in plain storage');
  assert.ok(storage.local.get('signerPolicies').ct && storage.local.get('signerSeeds')[row.id].ct);
  const session = JSON.stringify([...storage.sessionMap.entries()]);
  assert.ok(!session.includes(SEED_HEX), 'the seed is never in the session');
});

test('profiles survive a lock and come back with the normal unlock', async () => {
  const { backend, row } = await unlockedWithSigner();
  await backend.wallet.lock();
  await assert.rejects(backend.signers.list());
  await backend.wallet.unlock(PASSWORD);
  assert.deepEqual((await backend.signers.list()).map((r) => r.id), [row.id]);
});

test('add refuses a wrong password, a key outside the policy and a duplicate', async () => {
  const { backend } = await unlockedWithSigner();
  await assert.rejects(backend.signers.add({ label: 'x', policy: POLICY, key: KEY, password: 'wrong-password-here' }), /already saved as treasury/);
  await assert.rejects(backend.signers.add({ label: 'y', policy: POLICY, key: '{"seed":"' + '44'.repeat(32) + '"}', password: PASSWORD }), /not one of the policy's signers/);
  await assert.rejects(backend.signers.add({ label: '', policy: POLICY, key: KEY, password: PASSWORD }), /1-64 characters/);
  const fresh = await unlockedWithSigner({ core: msauthCore() }).then(async ({ backend: b, row }) => { await b.signers.remove(row.id, PASSWORD); return b; });
  await assert.rejects(fresh.signers.add({ label: 'z', policy: POLICY, key: KEY, password: 'wrong-password-here' }), /wrong password/);
});

test('remove deletes both halves, and only with the password', async () => {
  const { backend, storage, row } = await unlockedWithSigner();
  await assert.rejects(backend.signers.remove(row.id, 'wrong-password-here'), /wrong password/);
  assert.ok(storage.local.get('signerSeeds')[row.id].ct, 'the seed record survived the wrong password');
  assert.deepEqual(await backend.signers.remove(row.id, PASSWORD), []);
  assert.equal(storage.local.get('signerSeeds')[row.id], undefined);
});

test('a BOM-prefixed policy or key file is read like any other', async () => {
  const { backend } = await unlockedWithSigner();
  const p = await backend.signers.preview({ policy: `﻿${POLICY}\n`, key: `﻿${KEY}\r\n` });
  assert.equal(p.index, 1);
});

test('a wipe removes every profile', async () => {
  const { backend, storage } = await unlockedWithSigner();
  await backend.wallet.wipe();
  assert.equal(storage.local.get('signerPolicies'), undefined);
  assert.equal(storage.local.get('signerSeeds'), undefined);
});

test('a damaged policies record is never overwritten: unlock works, list/add/remove refuse', async () => {
  const { backend, storage, row } = await unlockedWithSigner();
  await backend.wallet.lock();
  const rec = storage.local.get('signerPolicies');
  storage.local.set('signerPolicies', { ...rec, ct: 'AAAA' });
  const before = JSON.stringify(storage.local.get('signerPolicies'));
  const seedsBefore = JSON.stringify(storage.local.get('signerSeeds'));
  await backend.wallet.unlock(PASSWORD); // unlock itself does not fail
  await assert.rejects(backend.signers.list(), /could not be opened/);
  await assert.rejects(backend.signers.add({ label: 'again', policy: POLICY, key: KEY, password: PASSWORD }), /could not be opened/);
  await assert.rejects(backend.signers.remove(row.id, PASSWORD), /could not be opened/);
  assert.equal(JSON.stringify(storage.local.get('signerPolicies')), before, 'record byte-identical');
  assert.equal(JSON.stringify(storage.local.get('signerSeeds')), seedsBefore, 'seeds untouched');
});
