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

import { verdict, EXPIRY_MARGIN } from '../engine/signers.js';

const SUMMARY = { expires_at: 200, chain_id: 13, genesis: GENESIS, binding_domain: 1, lines: ['x'], policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', recipients_checked: true,
  outputs: [{ to_account: false, amount: '5', needs_payee: true, matches: 'FP' }] };
const signingCore = (extra = {}) => msauthCore({
  msauth_check: () => ({ ...SUMMARY }),
  msauth_sign: ({ seed }) => { if (seed !== SEED_HEX) throw new Error('bad seed'); return '1:' + 'ab'.repeat(8); },
  msauth_verify_share: ({ share }) => { if (!share.startsWith('0:')) throw new Error('signer 1\'s signature does not verify over this proposal'); return true; },
  ...extra,
});
const atHead = (height, table = {}) => stubFetch({ rand_getHead: () => ({ height, hash: 'ff'.repeat(32), view: 1 }), ...table });

test('an unmatched or unchecked payee refuses signing, before anything else', async () => {
  const unchecked = { ...SUMMARY, recipients_checked: false, outputs: [{ to_account: false, amount: '5', needs_payee: true, matches: null }] };
  assert.equal(verdict({ summary: unchecked, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'unchecked-recipient');
  assert.equal(verdict({ summary: unchecked, head: null, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'unchecked-recipient');
  const seen = [];
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: ({ expected_recipients }) => { seen.push(expected_recipients); return unchecked; } }), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'unchecked-recipient');
  assert.deepEqual(seen, [['rand1payee']], 'the payees reach the core');
});

test('the expiry rule is the CLI\'s: refuse at head + 16 >= expires_at', () => {
  assert.equal(EXPIRY_MARGIN, 16);
  assert.equal(verdict({ summary: SUMMARY, head: 183, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true);
  assert.equal(verdict({ summary: SUMMARY, head: 184, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'expired');
});

test('a proposal for another chain or genesis is refused', async () => {
  assert.equal(verdict({ summary: { ...SUMMARY, chain_id: 21 }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'wrong-chain');
  assert.equal(verdict({ summary: { ...SUMMARY, genesis: 'bb'.repeat(32) }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'wrong-genesis');
  assert.equal(verdict({ summary: { ...SUMMARY, binding_domain: 0, genesis: 'bb'.repeat(32) }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true, 'a chain-id-bound proposal binds no genesis');
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => ({ ...SUMMARY, chain_id: 21 }) }), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'wrong-chain');
});

test('with no node the proposal is shown but not signed, naming the node', async () => {
  const dead = async () => { throw new TypeError('fetch failed'); };
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: dead });
  const r = await backend.signers.check(row.id, 'P', ['rand1payee']);
  assert.equal(r.signable, false);
  assert.equal(r.refusal.code, 'no-node');
  assert.match(r.refusal.message, /rpc\.randprotocol\.org/);
  assert.deepEqual(r.summary.lines, ['x'], 'the review still shows what was checked');
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), (e) => e.code === 'no-node');
});

test('a node that cannot give a head is no node', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: stubFetch({ rand_getHead: () => { throw new Error('busy'); } }) });
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1payee'])).refusal.code, 'no-node');
});

test('every signature asks for the password and caches nothing', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  const before = JSON.stringify([...storage.sessionMap.entries()]);
  assert.deepEqual(await backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD), { share: '1:' + 'ab'.repeat(8), index: 1 });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], ''), /wrong password/, 'the second signature asks again');
  assert.equal(JSON.stringify([...storage.sessionMap.entries()]), before, 'the session gained nothing');
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes(SEED_HEX));
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes('"P"'), 'the proposal is never stored');
});

test('a wrong password at signing is throttled like an unlock', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee'], 'wrong-password-here'), /wrong password/);
  assert.equal(storage.local.get('unlockFailures').count, 1);
  await backend.signers.sign(row.id, 'P', ['rand1payee'], PASSWORD);
  assert.equal(storage.local.get('unlockFailures'), undefined, 'a right password clears the count');
});

test('verifyShare names the position and trims a saved file\'s newline', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  assert.deepEqual(await backend.signers.verifyShare(row.id, 'P', '0:abcd\n'), { index: 0 });
  await assert.rejects(backend.signers.verifyShare(row.id, 'P', '1:abcd'), /does not verify/);
});
