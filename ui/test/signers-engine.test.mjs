// The engine's signer profiles (spec 2026-10-11-msauth-signing-design.md §3): kept in the vault,
// policies opened at unlock, seeds only under the password, nothing in plain storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend } from '../engine/backend-wasm.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, mapStorage, stubCore, stubFetch, stubPlatform, GENESIS } from './backend-fixtures.mjs';
import { encryptSecret, DEFAULT_RECORD_BYTES } from '../engine/crypto.js';
import { SIGNER_POLICIES_RECORD_BYTES, DEFAULT_MAX_FEE_UNITS } from '../engine/signers.js';

/** fullnode's own 2-of-3 policy vector: 8 029 characters, twice the spend-key vault's cap. */
const REAL_POLICY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'msauth', 'policy.json'), 'utf8');

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
  assert.deepEqual({ ...row, id: 'x' }, { id: 'x', label: 'treasury', index: 1, fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60), maxFee: '100000000' });
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

// ---- MSC-1: the profiles record was held to the spend-key vault's 4 096-byte cap on READ only, so a
// real policy saved fine and every profile was "unreadable" from the next lock on. The stub POLICY
// above is ~150 characters, which is why nothing here ever failed.
test('real 2-of-3 policies survive a lock: one, then three (the record is sized for policies, not a spend key)', async () => {
  const hashes = new Map();
  const core = msauthCore({ msauth_policy_info: ({ policy }) => {
    if (!hashes.has(policy)) hashes.set(policy, String(hashes.size + 1).padStart(64, '0'));
    return { fingerprint: 'NFYW-K8E9-E5K9-AAK3', threshold: 2, signers: 3, address: 'rand1' + 'm'.repeat(60), policy_hash: hashes.get(policy) };
  } });
  const storage = mapStorage();
  const backend = makeWasmBackend({ core, storage, platform: stubPlatform(), fetch: stubFetch(), locks: null, broadcast: null });
  await backend.wallet.create(PASSWORD);
  assert.ok(REAL_POLICY.length > DEFAULT_RECORD_BYTES, `the fixture policy is ${REAL_POLICY.length} characters`);
  await backend.signers.add({ label: 'one', policy: REAL_POLICY, key: KEY, password: PASSWORD });
  await backend.wallet.lock();
  await backend.wallet.unlock(PASSWORD);
  assert.deepEqual((await backend.signers.list()).map((r) => r.label), ['one']);
  const parsed = JSON.parse(REAL_POLICY);
  await backend.signers.add({ label: 'two', policy: JSON.stringify({ ...parsed, name: 'two' }, null, 2), key: KEY, password: PASSWORD });
  await backend.signers.add({ label: 'three', policy: JSON.stringify({ ...parsed, name: 'three' }, null, 2), key: KEY, password: PASSWORD });
  await backend.wallet.lock();
  await backend.wallet.unlock(PASSWORD);
  assert.deepEqual((await backend.signers.list()).map((r) => r.label), ['one', 'two', 'three']);
  assert.ok(SIGNER_POLICIES_RECORD_BYTES >= 32 * REAL_POLICY.length, 'headroom: dozens of real policies');
});

test('an unreadable profiles record names its cause: damaged, newer build, another password, oversize', async () => {
  const run = async (mutate, expect) => {
    const { backend, storage } = await unlockedWithSigner();
    await backend.wallet.lock();
    const rec = storage.local.get('signerPolicies');
    storage.local.set('signerPolicies', await mutate(rec));
    await backend.wallet.unlock(PASSWORD);
    await assert.rejects(backend.signers.list(), (e) => e.code === 'signers-unreadable' && expect.test(e.message) && /could not be opened/.test(e.message), String(expect));
    assert.deepEqual((await storage.session.get('unlocked')).signers, [], 'nothing opened');
  };
  await run((rec) => ({ ...rec, ct: 'AAAA' }), /damaged/);
  await run((rec) => ({ ...rec, v: 99 }), /newer version/);
  await run(() => encryptSecret('another-password-9', JSON.stringify([]), { maxBytes: SIGNER_POLICIES_RECORD_BYTES }), /does not open with this password/);
  await run((rec) => ({ ...rec, ct: 'A'.repeat(4 * (SIGNER_POLICIES_RECORD_BYTES / 3 + 64)) }), /larger than/);
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

import { verdict, EXPIRY_MARGIN, shareIndexOf } from '../engine/signers.js';

const SUMMARY = { expires_at: 200, chain_id: 13, genesis: GENESIS, binding_domain: 1, lines: ['x'], policy_fingerprint: 'NFYW-K8E9-E5K9-AAK3', recipients_checked: true,
  fee: '1', outputs: [{ to_account: false, amount: '5', needs_payee: true, matches: 'FP' }] };
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
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'unchecked-recipient');
  assert.deepEqual(seen, [['rand1payee:5']], 'the payees reach the core');
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
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'wrong-chain');
});

test('with no node the proposal is shown but not signed, naming the node', async () => {
  const dead = async () => { throw new TypeError('fetch failed'); };
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: dead });
  const r = await backend.signers.check(row.id, 'P', ['rand1payee:5']);
  assert.equal(r.signable, false);
  assert.equal(r.refusal.code, 'no-node');
  assert.match(r.refusal.message, /rpc\.randprotocol\.org/);
  assert.deepEqual(r.summary.lines, ['x'], 'the review still shows what was checked');
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'no-node');
});

test('a node that cannot give a head is no node', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: stubFetch({ rand_getHead: () => { throw new Error('busy'); } }) });
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1payee:5'])).refusal.code, 'no-node');
});

test('every signature asks for the password and caches nothing', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  const before = JSON.stringify([...storage.sessionMap.entries()]);
  assert.deepEqual(await backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), { share: '1:' + 'ab'.repeat(8), index: 1 });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], ''), /wrong password/, 'the second signature asks again');
  assert.equal(JSON.stringify([...storage.sessionMap.entries()]), before, 'the session gained nothing');
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes(SEED_HEX));
  assert.ok(!JSON.stringify([...storage.local.entries()]).includes('"P"'), 'the proposal is never stored');
});

test('a wrong password at signing is throttled like an unlock', async () => {
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], 'wrong-password-here'), /wrong password/);
  assert.equal(storage.local.get('unlockFailures').count, 1);
  await backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD);
  assert.equal(storage.local.get('unlockFailures'), undefined, 'a right password clears the count');
});

test('verifyShare names the position and trims a saved file\'s newline', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  assert.deepEqual(await backend.signers.verifyShare(row.id, 'P', '0:abcd\n'), { index: 0 });
  await assert.rejects(backend.signers.verifyShare(row.id, 'P', '1:abcd'), /does not verify/);
});

// Share-index validation: the index a share names is read strictly and inside the policy, before
// the core is asked; `Number()` used to read "", " ", "0x1" and "1e0" as signer indexes.
test('a share index is decimal, at most 255, and inside the policy; sign returns the profile\'s own index', async () => {
  assert.equal(shareIndexOf('2:ab'), 2);
  assert.equal(shareIndexOf(' 0 :ab'), 0, 'trimmed, as the core trims it');
  for (const bad of ['', 'ab', ':ab', ' :ab', '0x1:ab', '1e0:ab', '+1:ab', '-1:ab', '1.0:ab', '256:ab', '0001:ab', null, undefined]) {
    assert.throws(() => shareIndexOf(bad), /a share is index:hex/, JSON.stringify(bad));
  }
  assert.throws(() => shareIndexOf('3:ab', 3), /signer 3 is not in this policy \(it has 3 signers\)/);
  assert.equal(shareIndexOf('2:ab', 3), 2);

  let verified = 0;
  const core = signingCore({ msauth_verify_share: () => { verified += 1; return true; } });
  const { backend, row } = await unlockedWithSigner({ core, fetch: atHead(100) });
  for (const bad of [':abcd', '0x0:abcd', '1e0:abcd', '3:abcd', '9:abcd']) {
    await assert.rejects(backend.signers.verifyShare(row.id, 'P', bad), /index:hex|not in this policy/, bad);
  }
  assert.equal(verified, 0, 'the core was asked about a share whose index was refused');
  assert.deepEqual(await backend.signers.verifyShare(row.id, 'P', '2:abcd'), { index: 2 });

  // The profile is signer 1: a share the core returns under another index is not handed back.
  const odd = await unlockedWithSigner({ core: signingCore({ msauth_sign: () => '2:' + 'ab'.repeat(8) }), fetch: atHead(100) });
  await assert.rejects(odd.backend.signers.sign(odd.row.id, 'P', ['rand1payee:5'], PASSWORD), /signer 2; this profile is signer 1/);
  const ok = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100) });
  assert.deepEqual(await ok.backend.signers.sign(ok.row.id, 'P', ['rand1payee:5'], PASSWORD), { share: '1:' + 'ab'.repeat(8), index: 1 });
});

// ---- fix round 1: fail closed on malformed summaries, re-check after the backoff ----
const V = (summary) => verdict({ summary, head: 1, chainId: 13, genesis: GENESIS, url: 'u' });
test('a malformed summary field is refused, never signable', () => {
  for (const bad of [
    { expires_at: undefined }, { expires_at: 'soon' }, { expires_at: -1 }, { expires_at: 1.5 }, { expires_at: null },
    { chain_id: undefined }, { chain_id: 'x' },
    { binding_domain: undefined }, { binding_domain: 'x' }, { binding_domain: 1.5 },
    { genesis: undefined }, { genesis: '' }, { genesis: 'zz' },
    { outputs: undefined },
  ]) {
    const r = V({ ...SUMMARY, ...bad });
    assert.equal(r.signable, false, JSON.stringify(bad));
    assert.equal(r.refusal.code, 'malformed-summary', JSON.stringify(bad));
  }
  assert.equal(V({ ...SUMMARY }).signable, true);
});

test('an output that pays without a match is unchecked even when recipients_checked is true', () => {
  const o = (x) => V({ ...SUMMARY, recipients_checked: true, outputs: [x] });
  assert.equal(o({ to_account: false, amount: '5', needs_payee: true, matches: null }).refusal.code, 'unchecked-recipient');
  assert.equal(o({ to_account: false, amount: '5', needs_payee: true }).refusal.code, 'unchecked-recipient');
  assert.equal(o({ to_account: true, amount: '5', matches: null }).signable, true, 'change needs no payee');
  assert.equal(o({ to_account: false, amount: '0', matches: null }).signable, true, 'a zero amount pays nothing');
});

test('the rule is re-run after the password backoff, and a refusal there signs nothing', async () => {
  let heads = [100, 190]; let signed = 0;
  const fetch = stubFetch({ rand_getHead: () => ({ height: heads.length > 1 ? heads.shift() : heads[0], hash: 'ff'.repeat(32), view: 1 }) });
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore({ msauth_sign: () => { signed += 1; return '1:ab'; } }), fetch });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'expired');
  assert.equal(signed, 0);
  assert.equal(storage.local.get('unlockFailures'), undefined);
});

test('a node on another chain is no node, naming the URL', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore(), fetch: atHead(100, { rand_chainId: () => 21 }) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'no-node' && /rpc\.randprotocol\.org/.test(e.message));
});

test('a proposal bound to another genesis is refused through sign()', async () => {
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => ({ ...SUMMARY, genesis: 'bb'.repeat(32) }) }), fetch: atHead(100) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'wrong-genesis');
});

test('BOM-prefixed proposal and share reach the core trimmed', async () => {
  const seen = [];
  const core = signingCore({
    msauth_check: ({ proposal }) => { seen.push(['check', proposal]); return { ...SUMMARY }; },
    msauth_sign: ({ proposal }) => { seen.push(['sign', proposal]); return '1:ab'; },
    msauth_verify_share: ({ proposal, share }) => { seen.push(['verify', proposal, share]); return true; },
  });
  const { backend, row } = await unlockedWithSigner({ core, fetch: atHead(100) });
  await backend.signers.sign(row.id, '﻿PROP\n', ['rand1payee:5'], PASSWORD);
  assert.deepEqual(await backend.signers.verifyShare(row.id, '﻿PROP\n', '﻿0:abcd\n'), { index: 0 });
  assert.deepEqual(seen, [['check', 'PROP'], ['sign', 'PROP'], ['verify', 'PROP', '0:abcd']]);
});

test('a refused sign leaves the failure count alone and never calls msauth_sign', async () => {
  let signed = 0;
  const { backend, storage, row } = await unlockedWithSigner({ core: signingCore({ msauth_sign: () => { signed += 1; return '1:ab'; } }), fetch: atHead(190) });
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], 'wrong-password-here'), (e) => e.code === 'expired');
  assert.equal(signed, 0);
  assert.equal(storage.local.get('unlockFailures'), undefined);
});

// ---- fix round 2: outputs and the summary itself fail closed ----
test('a malformed output or summary is malformed-summary', () => {
  const code = (summary) => verdict({ summary, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code;
  const out = (o) => ({ ...SUMMARY, outputs: [o] });
  assert.equal(code(out(null)), 'malformed-summary');
  assert.equal(code(out({ to_account: false, matches: null })), 'malformed-summary', 'no amount');
  assert.equal(code(out({ to_account: false, amount: '', matches: null })), 'malformed-summary');
  assert.equal(code(out({ to_account: false, amount: 'abc', matches: null })), 'malformed-summary');
  assert.equal(code(out({ amount: '5', matches: null })), 'malformed-summary', 'to_account missing');
  assert.equal(code(null), 'malformed-summary');
  assert.equal(code(undefined), 'malformed-summary');
  for (const amount of ['0', '00', ' 0', 0]) {
    assert.equal(verdict({ summary: out({ to_account: false, amount, matches: null }), head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true, `${JSON.stringify(amount)} is zero`);
  }
});

test('only a non-empty string match counts as matched', () => {
  for (const matches of [false, '', '  ', 0, {}, null, undefined, true]) {
    const r = verdict({ summary: { ...SUMMARY, outputs: [{ to_account: false, amount: '5', matches }] }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' });
    assert.equal(r.refusal && r.refusal.code, 'unchecked-recipient', JSON.stringify(matches));
  }
});

test('a blank expected recipient is refused by check and sign, and never reaches the core', async () => {
  const seen = [];
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: ({ expected_recipients }) => { seen.push(expected_recipients); return { ...SUMMARY }; } }), fetch: atHead(100) });
  const r = await backend.signers.check(row.id, 'P', ['rand1a:1', '  ']);
  assert.equal(r.signable, false);
  assert.equal(r.refusal.code, 'unchecked-recipient');
  await assert.rejects(backend.signers.sign(row.id, 'P', ['', 'rand1b:1'], PASSWORD), (e) => e.code === 'unchecked-recipient');
  assert.deepEqual(seen, [], 'nothing was passed on with the blanks removed');
});

test('an empty intended-payments list with a paying output, or an entry without an amount, is refused', async () => {
  const paying = { ...SUMMARY, recipients_checked: true, outputs: [{ to_account: false, amount: '5', matches: 'ABCD' }] };
  const seen = [];
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: ({ expected_recipients }) => { seen.push(expected_recipients); return paying; } }), fetch: atHead(100) });
  const r = await backend.signers.check(row.id, 'P', []);
  assert.equal(r.refusal.code, 'unchecked-recipient', 'a matches string alone does not make an empty list pass');
  await assert.rejects(backend.signers.sign(row.id, 'P', [], PASSWORD), (e) => e.code === 'unchecked-recipient');
  const noAmount = await backend.signers.check(row.id, 'P', ['rand1a']);
  assert.equal(noAmount.refusal.code, 'unchecked-recipient', 'a RAND-only summary needs the amount on every entry');
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1a:'])).refusal.code, 'unchecked-recipient');
  assert.equal((await backend.signers.check(row.id, 'P', [':5'])).refusal.code, 'unchecked-recipient');
  assert.deepEqual(seen, [[], [], ['rand1a'], ['rand1a:']], 'an empty address never reaches the core');
  const ok = await backend.signers.check(row.id, 'P', [' rand1a:5 ']);
  assert.deepEqual(seen.at(-1), ['rand1a:5']);
});

test('an address-only entry is accepted when a paying output is not RAND', async () => {
  const token = { ...SUMMARY, recipients_checked: true, outputs: [{ to_account: false, amount: '5', asset: 7, owner_fingerprint: 'F', matches: 'ABCD' }], expected: [{ entry: 'rand1a', fingerprint: 'F' }] };
  const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => token }), fetch: atHead(100) });
  const r = await backend.signers.check(row.id, 'P', ['rand1a']);
  assert.equal(r.signable, true);
  const rand = { ...token, outputs: [{ ...token.outputs[0], asset: 0 }] };
  const b2 = await unlockedWithSigner({ core: signingCore({ msauth_check: () => rand }), fetch: atHead(100) });
  assert.equal((await b2.backend.signers.check(b2.row.id, 'P', ['rand1a'])).refusal.code, 'unchecked-recipient');
});

test('the amountless exception is per row: only the owner of a non-RAND output may leave the amount out', async () => {
  const mixed = (expected) => ({ ...SUMMARY, recipients_checked: true, ...(expected ? { expected } : {}),
    outputs: [{ to_account: false, amount: '5', asset: 7, owner_fingerprint: 'F', matches: 'ABCD' }, { to_account: false, amount: '9', asset: 0, owner_fingerprint: 'G', matches: 'EFGH' }] });
  const run = async (summary, entries) => {
    const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => summary }), fetch: atHead(100) });
    return backend.signers.check(row.id, 'P', entries);
  };
  const exp = [{ entry: 'rand1f', fingerprint: 'F' }, { entry: 'rand1g', fingerprint: 'G' }];
  assert.equal((await run(mixed(exp), ['rand1f', 'rand1g:9'])).signable, true, 'the non-RAND owner may go unpinned');
  assert.equal((await run(mixed(exp), ['rand1f:5', 'rand1g'])).refusal.code, 'unchecked-recipient', 'a RAND payee may not');
  assert.equal((await run(mixed(undefined), ['rand1f'])).refusal.code, 'unchecked-recipient', 'expected missing: fail closed');
  assert.equal((await run(mixed('nope'), ['rand1f'])).refusal.code, 'unchecked-recipient');
  assert.equal((await run(mixed([{ entry: 'rand1f' }]), ['rand1f'])).refusal.code, 'unchecked-recipient', 'no fingerprint: fail closed');
});

test('the core\'s payee sentences reach the caller verbatim', async () => {
  for (const msg of ['expected recipient AB12-CD34 is paid 3, not 5', 'expected recipient AB12-CD34 is not paid', 'output 2 pays AB12-CD34, not an expected recipient']) {
    const { backend, row } = await unlockedWithSigner({ core: signingCore({ msauth_check: () => { throw new Error(msg); } }), fetch: atHead(100) });
    await assert.rejects(backend.signers.check(row.id, 'P', ['rand1a:5']), (e) => e.message === msg);
  }
});

test('sign hands msauth_sign the same expected-recipient list the check used', async () => {
  const seen = [];
  const core = signingCore({
    msauth_check: ({ expected_recipients }) => { seen.push(['check', expected_recipients]); return { ...SUMMARY }; },
    msauth_sign: ({ expected_recipients }) => { seen.push(['sign', expected_recipients]); return '1:ab'; },
  });
  const { backend, row } = await unlockedWithSigner({ core, fetch: atHead(100) });
  await backend.signers.sign(row.id, 'P', [' rand1payee:5 ', 'rand1other:2\n'], PASSWORD);
  assert.deepEqual(seen, [['check', ['rand1payee:5', 'rand1other:2']], ['sign', ['rand1payee:5', 'rand1other:2']]]);
});

// ---- final fix wave ----
// The reviewer's probe: X is paid 900 RAND beside 1 unit of asset 5, and the signer names X with no
// amount. The token output must not unpin X's RAND, so the verdict refuses.
test('a dust token beside a RAND output to the same payee does not unpin that payee', () => {
  const G = '0'.repeat(64);
  const summary = {
    recipients_checked: true, expires_at: 1000, chain_id: 21, binding_domain: 1, genesis: G, lines: ['x'], fee: '1000000',
    outputs: [
      { to_account: false, amount: '900000000000', asset: 0, owner_fingerprint: 'X', matches: 'AAAA (900 RAND)' },
      { to_account: false, amount: '1', asset: 5, owner_fingerprint: 'X', matches: 'AAAA (0.000000001 RAND)' },
      { to_account: true, amount: '5', asset: 0, owner_fingerprint: 'self', matches: null },
    ],
    expected: [{ entry: 'rand1payee', fingerprint: 'X' }],
  };
  const r = verdict({ summary, head: 10, chainId: 21, genesis: G, url: 'u', recipients: ['rand1payee'] });
  assert.equal(r.signable, false);
  assert.equal(r.refusal.code, 'unchecked-recipient');
  // An output with no asset field counts as RAND too (fails closed).
  const noAsset = { ...summary, outputs: [{ ...summary.outputs[0], asset: undefined }, summary.outputs[1]] };
  assert.equal(verdict({ summary: noAsset, head: 10, chainId: 21, genesis: G, url: 'u', recipients: ['rand1payee'] }).refusal.code, 'unchecked-recipient');
  // The same payee paid the token alone may still go unpinned.
  const tokenOnly = { ...summary, outputs: [summary.outputs[1], summary.outputs[2]] };
  assert.equal(verdict({ summary: tokenOnly, head: 10, chainId: 21, genesis: G, url: 'u', recipients: ['rand1payee'] }).signable, true);
});

test('a summary whose lines are missing or not all strings is malformed-summary', () => {
  for (const lines of [undefined, null, 'x', {}, [1], ['x', null], ['x', ['y']]]) {
    const summary = { ...SUMMARY };
    if (lines === undefined) delete summary.lines; else summary.lines = lines;
    assert.equal(verdict({ summary, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'malformed-summary', JSON.stringify(lines));
  }
  assert.equal(verdict({ summary: { ...SUMMARY, lines: [] }, head: 1, chainId: 13, genesis: GENESIS, url: 'u' }).signable, true, 'an empty array of lines is well formed');
});

// ---- MSC-2: the binding a signer signs covers the fee (randprotocol-msig lib.rs), and no client
// rule ever read it — a signer who pinned the payee and the amount still signed a fee that took
// the rest of the account. Fees are base units (1 RAND = 10^9), as the core's summary writes them.
test('the fee rule: over the signer\'s limit, or over what the proposal pays out, is refused; a missing fee is malformed', () => {
  assert.equal(DEFAULT_MAX_FEE_UNITS, '100000000', '0.1 RAND');
  const paid = (fee, amount = '5000000000') => ({ ...SUMMARY, fee, outputs: [{ to_account: false, amount, matches: 'FP' }, { to_account: true, amount: '7', matches: null }] });
  assert.equal(V(paid('100000000')).signable, true, 'at the limit');
  const over = V(paid('100000001'));
  assert.equal(over.refusal.code, 'fee-too-high');
  assert.match(over.refusal.message, /0\.100000001 RAND/);
  assert.match(over.refusal.message, /0\.1 RAND/);
  assert.equal(verdict({ summary: paid('100000001'), head: 1, chainId: 13, genesis: GENESIS, url: 'u', maxFee: '200000000' }).signable, true, 'a profile may allow more');
  assert.equal(verdict({ summary: paid('200000001'), head: 1, chainId: 13, genesis: GENESIS, url: 'u', maxFee: '200000000' }).refusal.code, 'fee-too-high');
  assert.equal(verdict({ summary: paid('100000001'), head: 1, chainId: 13, genesis: GENESIS, url: 'u', maxFee: 'lots' }).refusal.code, 'fee-too-high', 'an unreadable limit is the default, not no limit');
  // The RAND the proposal pays out is 5 units here: a fee of 6 is more than the payment.
  const ratio = V({ ...SUMMARY, fee: '6' });
  assert.equal(ratio.refusal.code, 'fee-too-high');
  assert.match(ratio.refusal.message, /pays out/);
  assert.equal(V({ ...SUMMARY, fee: '5' }).signable, true, 'a fee equal to the payment is allowed');
  // Change is not a payment, and a token output is not RAND: a token-only proposal is bounded by the limit alone.
  const token = { ...SUMMARY, fee: '50000000', outputs: [{ to_account: false, amount: '1', asset: 7, owner_fingerprint: 'F', matches: 'X' }, { to_account: true, amount: '9', matches: null }] };
  assert.equal(V(token).signable, true);
  assert.equal(V({ ...token, fee: '100000001' }).refusal.code, 'fee-too-high');
  for (const fee of [undefined, null, '', 'abc', -1, 1.5, '1e3', true]) {
    const s = { ...SUMMARY };
    if (fee === undefined) delete s.fee; else s.fee = fee;
    assert.equal(V(s).refusal.code, 'malformed-summary', JSON.stringify(fee));
  }
  assert.equal(V(paid(1000000)).signable, true, 'fullnode\'s own vectors carry the fee as a number');
  assert.equal(verdict({ summary: paid('100000001'), head: null, chainId: 13, genesis: GENESIS, url: 'u' }).refusal.code, 'fee-too-high', 'needs no node');
  assert.equal(V({ ...paid('100000001'), recipients_checked: false }).refusal.code, 'unchecked-recipient', 'the payee check comes first');
});

test('a profile\'s fee limit is saved in the vault, shown in its row, applied by check and sign, and survives a lock', async () => {
  const big = { ...SUMMARY, fee: '150000000', outputs: [{ to_account: false, amount: '5000000000', matches: 'FP' }] }; // 0.15 RAND fee on a 5 RAND payment
  let signed = 0;
  const core = signingCore({ msauth_check: () => ({ ...big }), msauth_sign: () => { signed += 1; return '1:ab'; } });
  const { backend, row } = await unlockedWithSigner({ core, fetch: atHead(100) });
  assert.equal(row.maxFee, DEFAULT_MAX_FEE_UNITS);
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1payee:5'])).refusal.code, 'fee-too-high');
  await assert.rejects(backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD), (e) => e.code === 'fee-too-high');
  assert.equal(signed, 0);
  await assert.rejects(backend.signers.setMaxFee(row.id, '0.2', 'wrong-password-here'), /wrong password/);
  await assert.rejects(backend.signers.setMaxFee(row.id, 'lots', PASSWORD), /number of RAND/);
  await assert.rejects(backend.signers.setMaxFee(row.id, '0', PASSWORD), /number of RAND/);
  const [updated] = await backend.signers.setMaxFee(row.id, ' 0.2 ', PASSWORD);
  assert.equal(updated.maxFee, '200000000');
  assert.equal((await backend.signers.check(row.id, 'P', ['rand1payee:5'])).signable, true);
  await backend.signers.sign(row.id, 'P', ['rand1payee:5'], PASSWORD);
  assert.equal(signed, 1);
  await backend.wallet.lock();
  await backend.wallet.unlock(PASSWORD);
  assert.equal((await backend.signers.list())[0].maxFee, '200000000', 'the limit is in the profiles record');
  // A limit given when the signer is added, in RAND.
  const fresh = makeWasmBackend({ core: msauthCore(), storage: mapStorage(), platform: stubPlatform(), fetch: stubFetch(), locks: null, broadcast: null });
  await fresh.wallet.create(PASSWORD);
  await assert.rejects(fresh.signers.add({ label: 'x', policy: POLICY, key: KEY, password: PASSWORD, maxFee: '-1' }), /number of RAND/);
  const [added] = await fresh.signers.add({ label: 'x', policy: POLICY, key: KEY, password: PASSWORD, maxFee: '0.05' });
  assert.equal(added.maxFee, '50000000');
});
