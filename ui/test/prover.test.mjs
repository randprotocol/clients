// Delegated proving (plan docs/superpowers/plans/2026-09-28-delegated-proving-phase1.md, Task 3,
// and Phase 2 — split authorisation): the engine's `prover` group, the pairing token in the vault,
// a send proved by a paired prover, and a popup closed mid-proof resuming the same job — against
// the real shared backend (`makeWasmBackend`, whose device can never prove) with the stub core and
// a stub fetch that plays both the node and the prover.
//
// The stub chain is a split-authorisation chain, as every live chain is (`rand_status` names
// bundle guest v3 and the auth guest), and the stub prover is a v0.6.7 one started without
// `--accept-spend-key`: the job is a viewing-key job, and any paired prover may have it. The older
// chain — a spend-key job, to a prover paired as the user's own and no other — has its own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend, CANNOT_PROVE_REASON } from '../engine/backend-wasm.js';
import { makeNativeBackend } from '../engine/backend-native.js';
import { decryptSecret } from '../engine/crypto.js';
import {
  pollRemoteProof, startRemoteProof, ProverError, PENDING_PROOF_KEY, CLAIMED_PROOF_KEY, MAX_QUEUE_WAIT_MS, MAX_PROVING_MS,
  SUBMIT_TRIES, SUBMIT_BACKOFF_MS,
} from '../engine/prover.js';
import {
  stubCore, stubFetch, mapStorage, stubPlatform, assertKeyNeverLeaked,
  PASSWORD, ADDRESS, SPEND_KEY, PROVER_URL, PROVER_TOKEN, PROVER_REPLY, PROVED_TX_HASH, SEALED_JOB,
  proverLink, proverInfo, proverEk, proverFingerprint, HC_V2, HC_V3, HC_AUTH, CORE_VERSION, TRUSTED_POOL, poolMember, GENESIS,
} from './backend-fixtures.mjs';

const ROOT = '1b'.repeat(32);
/** `rand_status` of a split-authorisation chain, and of a chain that predates it. */
const STATUS_V3 = { height: 100, peer_count: 3, syncing: false, hc_bundle: HC_V3, hc_auth: HC_AUTH };
const STATUS_OLD = { height: 100, peer_count: 3, syncing: false, hc_bundle: HC_V2, hc_auth: null };
/** A prover that also takes spend-key jobs (`rand-prover run --accept-spend-key`). */
const OWN_PROVER_INFO = () => proverInfo('KEY', { witnessKinds: ['viewing_key', 'spend_key'] });
const NOTE = {
  index: 0, note: '00'.repeat(112), cm: '0b'.repeat(32), nf: '0c'.repeat(32),
  amount: '5000000000', asset: 0, time: 7, from: '00'.repeat(32), height: 7, spent: false, pending: null,
};

/** A node that takes a transfer, and a prover, on one stub fetch. */
function sendableFetch(table = {}) {
  return stubFetch({
    rand_getAnchor: () => ({ height: 100, root: ROOT }),
    rand_getWitness: () => ({ index: 0, root: ROOT, path: Array.from({ length: 32 }, () => '00'.repeat(32)) }),
    rand_sendTransaction: () => PROVED_TX_HASH,
    rand_getTransaction: () => ({ height: 101 }),
    rand_status: () => ({ ...STATUS_V3 }),
    rand_getLimits: () => ({ envelope_bytes: null, max_proof_bytes: 2097152 }),
    ...table,
  });
}

function build({ core, storage, fetch, native, systemMemoryGiB, locks = null, memberOrder } = {}) {
  const env = {
    core: core || stubCore(),
    storage: storage || mapStorage(),
    fetch: fetch || sendableFetch(),
    platform: stubPlatform(),
  };
  const make = native ? makeNativeBackend : makeWasmBackend;
  env.backend = make({
    ...env, locks, broadcast: null,
    proverOptions: { poll: 1, maxWait: 5000, ...(memberOrder ? { memberOrder } : {}) },
    ...(native ? { systemMemoryGiB: systemMemoryGiB ?? (() => 4) } : {}),
  });
  return env;
}

/** A wallet with one spendable note. */
async function sendableWallet(opts = {}) {
  const env = build(opts);
  await env.backend.wallet.create(PASSWORD);
  await env.backend.sync.scan(() => {});
  const notes = env.storage.local.get('notes');
  notes.notes = [NOTE];
  env.storage.local.set('notes', notes);
  return env;
}

const methodsOf = (fetch) => fetch.requests.map((r) => r.body.method);
const count = (fetch, method) => methodsOf(fetch).filter((m) => m === method).length;
const coreCalled = (env, method) => env.core.calls.filter(([m]) => m === method);
const SEND = { asset: 0, to: ADDRESS, amount: '1000000000' };
/** `settings.prover` with nothing chosen (wallet 0.6.9): the RandProtocol provers the build ships. */
const DEFAULT_SETTING = Object.freeze({
  mode: 'default', name: 'RandProtocol',
  members: TRUSTED_POOL.members.map(({ name, url, fingerprint }) => ({ name, url, fingerprint })),
});
/** The order the pool's members are asked in, fixed for a test (the engine's is random per job). */
const inOrder = (...names) => (members) => names.map((n) => members.find((m) => m.member === n)).filter(Boolean);

async function until(check, what) {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------------------- pairing -------

test('pairing_stores_the_token_in_the_vault_not_in_settings', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  const paired = await env.backend.prover.pair(proverLink(), PASSWORD);
  assert.deepEqual(paired, {
    mode: 'remote', name: '127.0.0.1:8546', url: PROVER_URL, kemEk: proverEk(), fingerprint: proverFingerprint(), own: true,
  });

  const settings = await env.backend.settings.get();
  assert.deepEqual(settings.prover, paired);
  assert.equal('token' in settings.prover, false);
  assert.equal(JSON.stringify(settings).includes(PROVER_TOKEN), false, 'the token is in settings');

  const vault = env.storage.local.get('proverToken');
  assert.equal(vault.kdf, 'pbkdf2-sha256');
  assert.equal(vault.iter, 600000);
  assert.deepEqual(JSON.parse(await decryptSecret(PASSWORD, vault)), {
    token: PROVER_TOKEN, kemEk: proverEk(), url: PROVER_URL, fingerprint: proverFingerprint(), own: true,
  }, 'the vault record holds the token, the key, the URL and whether the link said own, together');
  assert.equal(env.storage.sessionMap.get('unlocked').prover.token, PROVER_TOKEN, 'the unlocked session carries the token');

  // Only the prover's info was asked, and neither secret went anywhere but the core.
  assert.deepEqual(methodsOf(env.fetch).filter((m) => m.startsWith('prover_')), ['prover_info']);
  assertKeyNeverLeaked(env);
  assertKeyNeverLeaked(env, PROVER_TOKEN);

  // A lock drops it with the spend key; an unlock opens it again with the same password (R2).
  await env.backend.wallet.lock();
  assert.equal(env.storage.sessionMap.get('unlocked'), undefined);
  await env.backend.wallet.unlock(PASSWORD);
  assert.equal(env.storage.sessionMap.get('unlocked').prover.token, PROVER_TOKEN);

  // `settings.set` cannot write a prover past the pairing's checks.
  await env.backend.settings.set({ prover: { mode: 'remote', url: 'https://evil.example', own: true }, theme: 'dark' });
  assert.deepEqual((await env.backend.settings.get()).prover, paired);
});

test('pairing refuses a wrong password, a prover with another key, and plain http off this machine', async () => {
  const env = build({ fetch: sendableFetch({ prover_info: () => proverInfo('OTHER') }) });
  await env.backend.wallet.create(PASSWORD);
  await assert.rejects(() => env.backend.prover.pair(proverLink(), 'not-the-password!'), /wrong password/);
  assert.equal(count(env.fetch, 'prover_info'), 0, 'the network was asked before the password was checked');
  await assert.rejects(() => env.backend.prover.pair(proverLink(), PASSWORD), /different key/);
  await assert.rejects(() => env.backend.prover.pair(proverLink({ url: 'http://192.168.1.9:8546' }), PASSWORD), /https/);
  assert.equal(env.storage.local.get('proverToken'), undefined);
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
});

test('preview reads a link without saving, asking, or needing the password', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  const seen = await env.backend.prover.preview(proverLink());
  assert.deepEqual(seen, { url: PROVER_URL, fingerprint: proverFingerprint(), own: true });
  assert.equal(JSON.stringify(seen).includes(PROVER_TOKEN), false, 'the token came back from preview');

  // Not own: the pairing is described, with what such a prover learns — the core's sentence.
  const other = await env.backend.prover.preview(proverLink({ own: false }));
  assert.equal(other.own, false);
  assert.equal(other.warning, CORE_VERSION.prover_history_warning);
  assert.match(other.warning, /whole history/);
  assert.match(other.warning, /It cannot spend/);

  // The core's refusal and the URL rule are the engine's sentences.
  await assert.rejects(() => env.backend.prover.preview('randpay:nope'), /randprover/);
  await assert.rejects(() => env.backend.prover.preview(proverLink({ url: 'http://192.168.1.9:8546' })), /https/);

  // Nothing was stored and no prover was asked.
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
  assert.equal(env.storage.local.get('proverToken'), undefined);
  assert.equal(count(env.fetch, 'prover_info'), 0);
});

test('re_pairing_replaces_the_token_everywhere', async () => {
  const second = '4b'.repeat(32);
  const env = await sendableWallet({
    fetch: sendableFetch({ prover_info: () => proverInfo(env.infoKey) }),
  });
  env.infoKey = 'KEY';
  await env.backend.prover.pair(proverLink(), PASSWORD);
  env.infoKey = 'NEXT';
  await env.backend.prover.pair(proverLink({ key: 'NEXT', url: 'https://prover.example', token: second }), PASSWORD);

  assert.equal(JSON.parse(await decryptSecret(PASSWORD, env.storage.local.get('proverToken'))).token, second);
  assert.equal(env.storage.sessionMap.get('unlocked').prover.token, second);
  assert.equal((await env.backend.settings.get()).prover.url, 'https://prover.example');
  await env.backend.wallet.lock();
  await env.backend.wallet.unlock(PASSWORD);
  assert.equal(env.storage.sessionMap.get('unlocked').prover.token, second);

  // The next send seals to the new prover's key with the new token.
  await env.backend.send.send(SEND, () => {});
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.equal(prepared.prover.token, second);
  assert.equal(prepared.prover.kem_ek, proverEk('NEXT'));
  assert.equal(JSON.stringify([...env.storage.sessionMap.entries(), ...env.storage.local.entries()]).includes(PROVER_TOKEN), false);
  assertKeyNeverLeaked(env, second);
});

test('a_tampered_settings_kem_ek_does_not_move_the_seal_target', async () => {
  // `settings.prover` is plaintext: anything that can write local storage can rewrite it. The
  // seal target is the vault's pairing (copied into the session on unlock), so the job still goes
  // to the key the user paired, at the URL the user paired — not to the tampered copy's.
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => ({ state: 'done', reply: PROVER_REPLY }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const settings = env.storage.local.get('settings');
  settings.prover = { ...settings.prover, kemEk: proverEk('EVIL'), url: 'https://evil.example' };
  env.storage.local.set('settings', settings);
  // Across a lock too: the unlock re-reads the vault, never the settings.
  await env.backend.wallet.lock();
  await env.backend.wallet.unlock(PASSWORD);

  await env.backend.send.send(SEND, () => {});
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.equal(prepared.prover.kem_ek, proverEk(), 'the job was sealed to the tampered key');
  assert.notEqual(prepared.prover.kem_ek, proverEk('EVIL'));
  const urls = env.fetch.requests.filter((r) => String(r.body.method).startsWith('prover_')).map((r) => r.url);
  assert.ok(urls.length > 0);
  assert.equal(urls.some((u) => String(u).includes('evil.example')), false, 'a prover request went to the tampered URL');
});

test('forget_removes_settings_vault_and_session_copies', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await env.backend.prover.forget();
  // Forgetting a paired prover falls back to the default (wallet 0.6.8), not to nothing.
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
  assert.equal(env.storage.local.has('proverToken'), false);
  assert.equal('prover' in env.storage.sessionMap.get('unlocked'), false);
  assert.equal(env.storage.sessionMap.get('unlocked').spend_key, SPEND_KEY, 'forgetting the prover kept the wallet unlocked');
  // The stub's prover answers with key KEY, not the pinned TRUST: the default is not there.
  const answer = await env.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.equal(answer.unreachable, true);
  assert.equal((await env.backend.prover.probe()).ok, false);
});

// ------------------------------------------------- the RandProtocol provers (wallet 0.6.9) ---

/**
 * One stub fetch for the node, a paired prover (any other URL, key KEY) and the pool's members —
 * each at its own URL, answering with ITS key unless `members[name]` says otherwise: `info()`
 * (throw = not answering) and `submit()` (throw = a JSON-RPC refusal, e.g. busy).
 */
function poolFetch(table = {}, members = {}) {
  const inner = sendableFetch(table);
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const m = TRUSTED_POOL.members.find((x) => String(url) === x.url);
    if (m) {
      inner.requests.push({ url, body, raw: init.body });
      const spec = members[m.name] || {};
      const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
      const refuse = (err) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: err.code ?? -32000, message: err.message, ...(err.data ? { data: err.data } : {}) } }) });
      try {
        if (body.method === 'prover_info') return reply(spec.info ? await spec.info() : proverInfo(poolMember(m.name).key));
        if (body.method === 'prover_submit') return reply(spec.submit ? await spec.submit() : { job: `job-${m.name}` });
        if (body.method === 'prover_status') return reply({ state: 'done', reply: PROVER_REPLY });
        if (body.method === 'prover_cancel') return reply({ cancelled: true });
      } catch (err) {
        if (err.transport) throw new TypeError('fetch failed');
        return refuse(err);
      }
    }
    return inner(url, init);
  };
  fn.requests = inner.requests;
  return fn;
}
const busyRefusal = () => { throw Object.assign(new Error('busy'), { code: -32005, data: { depth: 1 } }); };
const down = () => { throw Object.assign(new Error('down'), { transport: true }); };
const submittedTo = (env) => env.fetch.requests.filter((r) => r.body.method === 'prover_submit').map((r) => r.url);

test('the pool is reported member by member, without links, and the 0.6.8 shared prover is gone', async () => {
  const env = build({ fetch: poolFetch() });
  await env.backend.wallet.create(PASSWORD);
  const t = await env.backend.prover.trusted();
  assert.deepEqual(t, { name: DEFAULT_SETTING.name, members: DEFAULT_SETTING.members, warning: CORE_VERSION.prover_history_warning });
  assert.equal(JSON.stringify(t).includes('randprover:'), false, 'a link (with its token) is handed to screens');
  assert.equal(typeof env.backend.prover.pairTrusted, 'undefined', 'the one-step pairing of the shared key is still there');
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
  assert.equal(count(env.fetch, 'prover_info'), 0, 'asking pairs or probes nothing');
  const none = build({ core: stubCore({ version: () => ({ ...CORE_VERSION, trusted_prover_pool: null }) }) });
  await none.backend.wallet.create(PASSWORD);
  assert.equal(await none.backend.prover.trusted(), null);
});

test('a fresh wallet proves through one pool member, sealed to THAT member\'s key, after the one-time notice', async () => {
  const env = await sendableWallet({ fetch: poolFetch() });
  assert.equal((env.storage.local.get('settings') || {}).prover, undefined, 'the default was written down as a choice');
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover', prover: 'default', provers: 3, notice: true });
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => err.needsNotice === true && /viewing key/.test(err.message));
  assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
  assert.equal(count(env.fetch, 'prover_submit'), 0);
  const notice = await env.backend.prover.defaultNotice();
  assert.equal(notice.read, false);
  assert.equal(notice.members.length, 3);
  await env.backend.prover.acknowledgeDefault();
  const phases = [];
  const out = await env.backend.send.send(SEND, (p, d) => phases.push(d === undefined ? [p] : [p, d]));
  assert.equal(out.hash, PROVED_TX_HASH);
  // Whichever member the random order chose: the job was sealed to its key with its token,
  // submitted to its URL, and polled there — one member, start to end.
  const [url] = submittedTo(env);
  const m = TRUSTED_POOL.members.find((x) => x.url === url);
  assert.ok(m, `submitted to ${url}, no pool member`);
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.deepEqual(prepared.prover, { kem_ek: proverEk(poolMember(m.name).key), token: poolMember(m.name).token, own: false, fee: null, hc_bundle: HC_V3 });
  assert.ok(env.fetch.requests.filter((r) => r.body.method === 'prover_status').every((r) => r.url === url), 'polled another member mid-job');
  assert.ok(phases.some(([p, d]) => p === 'proving' && d && d.prover === `RandProtocol (${m.name})`));
  assert.equal(env.storage.local.get('proverToken'), undefined, 'the default needs no vault record');
  assertKeyNeverLeaked(env);
});

test('members are tried in turn: another key, no answer, a full queue and a busy submit are skipped', async () => {
  // a: another key; b: not answering; c: answers, but its submit is busy — then nobody is left.
  const env = await sendableWallet({
    fetch: poolFetch({}, { a: { info: () => proverInfo('OTHER') }, b: { info: down }, c: { submit: busyRefusal } }),
    memberOrder: inOrder('a', 'b', 'c'),
  });
  await env.backend.prover.acknowledgeDefault();
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover', prover: 'default', provers: 3 });
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /The RandProtocol provers cannot be reached right now/);
    assert.match(err.message, /a answered with another key than the one this wallet pins/);
    assert.match(err.message, /pair your own prover in Settings/);
    return true;
  });
  assert.deepEqual(submittedTo(env), [poolMember('c').url], 'a member was sent a job it should not have been');
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);

  // c busy at submit, b free: the job goes to b — sealed again, to b's key.
  const env2 = await sendableWallet({
    fetch: poolFetch({}, { c: { submit: busyRefusal } }),
    memberOrder: inOrder('c', 'b', 'a'),
  });
  await env2.backend.prover.acknowledgeDefault();
  const out = await env2.backend.send.send(SEND, () => {});
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.deepEqual(submittedTo(env2), [poolMember('c').url, poolMember('b').url]);
  const sealed = coreCalled(env2, 'prepare_transfer').map(([, p]) => p.prover.kem_ek);
  assert.deepEqual(sealed, [proverEk('POOLC'), proverEk('POOLB')]);

  // A full queue (depth >= max) is skipped before anything is sealed for it.
  const env3 = await sendableWallet({
    fetch: poolFetch({}, { a: { info: () => ({ ...proverInfo('POOLA'), queue: { depth: 1, max: 1, proving: 1 } }) } }),
    memberOrder: inOrder('a', 'b'),
  });
  await env3.backend.prover.acknowledgeDefault();
  await env3.backend.send.send(SEND, () => {});
  assert.deepEqual(submittedTo(env3), [poolMember('b').url]);
  assert.deepEqual(coreCalled(env3, 'prepare_transfer').map(([, p]) => p.prover.kem_ek), [proverEk('POOLB')]);
});

test('the notice names the whole pool, whichever members a job asks', async () => {
  const env = await sendableWallet({ fetch: poolFetch(), memberOrder: inOrder('b') });
  assert.equal((await env.backend.send.canProve()).provers, 3);
});

test('every member busy is said plainly, once each, with the way to pair your own', async () => {
  const full = () => ({ queue: { depth: 1, max: 1, proving: 1 } });
  const env = await sendableWallet({
    fetch: poolFetch({}, Object.fromEntries(['a', 'b', 'c'].map((n) => [n, { info: () => ({ ...proverInfo(poolMember(n).key), ...full() }) }]))),
  });
  await env.backend.prover.acknowledgeDefault();
  const answer = await env.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.equal(answer.busy, true);
  assert.match(answer.reason, /The RandProtocol provers are all busy right now; try again in a minute, or pair your own prover in Settings\./);
  // Busy at submit on every member: one submit each, never a loop.
  const env2 = await sendableWallet({ fetch: poolFetch({}, { a: { submit: busyRefusal }, b: { submit: busyRefusal }, c: { submit: busyRefusal } }) });
  await env2.backend.prover.acknowledgeDefault();
  await assert.rejects(() => env2.backend.send.send(SEND, () => {}), (err) => err.busy === true && /all busy/.test(err.message));
  assert.equal(count(env2.fetch, 'prover_submit'), 3);
});

test('a member whose pinned fingerprint does not match its link is never asked; the others still are', async () => {
  const bad = { ...TRUSTED_POOL, members: TRUSTED_POOL.members.map((m) => (m.name === 'a' ? { ...m, fingerprint: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' } : m)) };
  const env = await sendableWallet({
    core: stubCore({ version: () => ({ ...CORE_VERSION, trusted_prover_pool: bad }) }),
    fetch: poolFetch(), memberOrder: inOrder('a', 'b', 'c'),
  });
  await env.backend.prover.acknowledgeDefault();
  await env.backend.send.send(SEND, () => {});
  assert.equal(env.fetch.requests.some((r) => r.url === poolMember('a').url), false, 'the mis-pinned member was asked');
  assert.deepEqual(submittedTo(env), [poolMember('b').url]);
});

test('Firefox: no job goes to a RandProtocol prover without its data-collection consent', async () => {
  let consent = false;
  const env = await sendableWallet({ fetch: poolFetch() });
  const platform = { ...stubPlatform(), hasDataCollectionConsent: async () => consent };
  const backend = makeWasmBackend({
    core: env.core, storage: env.storage, fetch: env.fetch, platform, locks: null, broadcast: null,
    proverOptions: { poll: 1, maxWait: 5000 },
  });
  await backend.wallet.unlock(PASSWORD);
  await backend.prover.acknowledgeDefault();
  assert.deepEqual(await backend.send.canProve(), { ok: true, via: 'prover', prover: 'default', provers: 3, notice: true });
  await assert.rejects(() => backend.send.send(SEND, () => {}), (err) => err.needsNotice === true);
  assert.equal(count(env.fetch, 'prover_submit'), 0);
  consent = true;
  const out = await backend.send.send(SEND, () => {});
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.equal(count(env.fetch, 'prover_submit'), 1);
});

test('your own prover is preferred over the pool, forget falls back to it, and none turns it off', async () => {
  const env = await sendableWallet({ fetch: poolFetch() });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover' });
  await env.backend.send.send(SEND, () => {});
  assert.deepEqual(submittedTo(env), [PROVER_URL]);
  await env.backend.prover.forget();
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
  assert.equal((await env.backend.send.canProve()).prover, 'default');
  await env.backend.prover.useNone();
  assert.deepEqual((await env.backend.settings.get()).prover, { mode: 'device' });
  assert.deepEqual(await env.backend.send.canProve(), { ok: false, reason: CANNOT_PROVE_REASON });
  await env.backend.settings.set({ theme: 'dark' });
  assert.deepEqual((await env.backend.settings.get()).prover, { mode: 'device' });
  await env.backend.prover.useDefault();
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
});

test('a wallet that stored the old "device" setting reads the default; a build without a pool stays on the device', async () => {
  const env = build({ fetch: poolFetch() });
  await env.backend.wallet.create(PASSWORD);
  env.storage.local.set('settings', { ...(env.storage.local.get('settings') || {}), prover: { mode: 'device' } });
  assert.deepEqual((await env.backend.settings.get()).prover, DEFAULT_SETTING);
  const none = build({ core: stubCore({ version: () => ({ ...CORE_VERSION, trusted_prover_pool: null }) }) });
  await none.backend.wallet.create(PASSWORD);
  assert.deepEqual((await none.backend.settings.get()).prover, { mode: 'device' });
  assert.deepEqual(await none.backend.send.canProve(), { ok: false, reason: CANNOT_PROVE_REASON });
  assert.equal(await none.backend.prover.defaultNotice(), null);
});

test('a desktop that can prove keeps proving on the device, default or not', async () => {
  const env = await sendableWallet({ fetch: poolFetch(), native: true, systemMemoryGiB: () => 32 });
  assert.deepEqual(await env.backend.send.canProve(), { ok: true });
  assert.equal(count(env.fetch, 'prover_info'), 0, 'a pool member was asked although this machine can prove');
  const small = await sendableWallet({ fetch: poolFetch(), native: true, systemMemoryGiB: () => 4 });
  assert.deepEqual(await small.backend.send.canProve(), { ok: true, via: 'prover', prover: 'default', provers: 3, notice: true });
});

test('the_wasm_reason_names_the_prover_option', async () => {
  const env = build({ fetch: sendableFetch({ rand_getBridgeState: () => ({ enabled: true, emitters: {}, assets: [] }) }) });
  await env.backend.wallet.create(PASSWORD);
  // With no prover at all — the user turned the default off — the device's own sentence.
  await env.backend.prover.useNone();
  const answer = await env.backend.send.canProve();
  assert.deepEqual(answer, { ok: false, reason: CANNOT_PROVE_REASON });
  assert.match(answer.reason, /Pair a prover in Settings/);
  assert.match(answer.reason, /desktop app/);
  assert.match(answer.reason, /6\.2 GB/);
  assert.deepEqual(await env.backend.bridge.canWithdraw(), { ok: false, reason: CANNOT_PROVE_REASON });
});

test('a_viewing_key_job_goes_to_a_prover_that_is_not_the_users_own', async () => {
  // Split authorisation: the job carries the viewing key, so a prover paired from a link without
  // own=1 — somebody else's machine — may make the proof. The pairing says so in the vault, and
  // the core is told, so it could never be handed a spend-key witness by mistake.
  const env = await sendableWallet();
  await env.backend.prover.pair(proverLink({ own: false }), PASSWORD);
  assert.equal((await env.backend.settings.get()).prover.own, false);
  assert.equal(JSON.parse(await decryptSecret(PASSWORD, env.storage.local.get('proverToken'))).own, false);
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover' });
  const out = await env.backend.send.send(SEND, () => {});
  assert.equal(out.hash, PROVED_TX_HASH);
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.deepEqual(prepared.prover, { kem_ek: proverEk(), token: PROVER_TOKEN, own: false, fee: null, hc_bundle: HC_V3 });
  assert.equal(prepared.hc_auth, HC_AUTH);
  assert.equal('witness_kind' in prepared.prover, false, 'the witness kind is the core\'s decision, not a request field');
  // The core was asked what this chain's guest takes before anything was built.
  assert.deepEqual(coreCalled(env, 'chain_guests')[0][1], { hc_bundle: HC_V3, hc_auth: HC_AUTH });
  assert.equal(count(env.fetch, 'prover_submit'), 1);
  assertKeyNeverLeaked(env);
});

test('an invoke through the RandProtocol prover waits for its one-time notice too', async () => {
  const env = await sendableWallet({ fetch: poolFetch() });
  const raw = { program: 'ab'.repeat(32), inputs: [], reads: [], writes: [], pays: [], mints: [] };
  await assert.rejects(() => env.backend.program.invoke(raw, () => {}), (err) => {
    assert.equal(err.code, 'PROVER_NOTICE');
    assert.match(err.message, /viewing key/);
    return true;
  });
  assert.equal(coreCalled(env, 'prepare_invoke').length, 0);
  assert.equal(count(env.fetch, 'prover_submit'), 0);
});

test('a delegated job carries the chain\'s genesis, as a local proof does (BIND-1)', async () => {
  // Through a paired prover and through the default alike: the sealed job is made over the same
  // binding the device's own proof would be — a chain after 19 binds its genesis hash.
  for (const via of ['paired', 'default']) {
    const env = await sendableWallet({ fetch: poolFetch() });
    if (via === 'paired') await env.backend.prover.pair(proverLink(), PASSWORD);
    else await env.backend.prover.acknowledgeDefault();
    await env.backend.send.send(SEND, () => {});
    const [[, prepared]] = coreCalled(env, 'prepare_transfer');
    assert.equal(prepared.genesis, GENESIS, `the ${via} job carries no genesis`);
  }
});

test('a_spend_key_job_is_built_only_for_an_own_prover', async () => {
  // A chain WITHOUT split authorisation: its witness carries the spend key. A prover that is not
  // the user's own is refused before the prover is asked anything and before the core builds.
  const oldChain = { rand_status: () => ({ ...STATUS_OLD }), prover_info: OWN_PROVER_INFO };
  const env = await sendableWallet({ fetch: sendableFetch(oldChain) });
  await env.backend.prover.pair(proverLink({ own: false }), PASSWORD);
  const asked = count(env.fetch, 'prover_info');
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /needs the spend key, which goes only to a prover paired as your own/);
    return true;
  });
  assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
  assert.equal(count(env.fetch, 'prover_info'), asked + 1, 'only canProve\'s probe asked the prover');
  assert.equal(count(env.fetch, 'prover_submit'), 0);
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);

  // The user's own prover, on the same chain: the spend-key job, as Phase 1 built it.
  const mine = await sendableWallet({ fetch: sendableFetch(oldChain) });
  await mine.backend.prover.pair(proverLink({ own: true }), PASSWORD);
  await mine.backend.send.send(SEND, () => {});
  const [[, prepared]] = coreCalled(mine, 'prepare_transfer');
  assert.deepEqual(prepared.prover, { kem_ek: proverEk(), token: PROVER_TOKEN, own: true, fee: null, hc_bundle: HC_V2 });
  assert.equal(prepared.hc_auth, null, 'the node named no auth guest, and the core is told so');

  // An own prover that does not take spend-key jobs (a v0.6.7 one without --accept-spend-key).
  const plain = await sendableWallet({ fetch: sendableFetch({ rand_status: () => ({ ...STATUS_OLD }) }) });
  await plain.backend.prover.pair(proverLink({ own: true }), PASSWORD);
  await assert.rejects(() => plain.backend.send.send(SEND, () => {}), /does not take spend-key jobs/);
  assert.equal(coreCalled(plain, 'prepare_transfer').length, 0);
});

test('a pairing made before the vault kept own is never sent a spend-key job', async () => {
  // Phase 1 stored `{token, kemEk, url, fingerprint}`; whether the link said own lived only in the
  // plaintext settings, which anything that can write local storage can rewrite. The sealed record
  // is what decides, and one without the field reads "not own".
  const env = await sendableWallet({ fetch: sendableFetch({ rand_status: () => ({ ...STATUS_OLD }), prover_info: OWN_PROVER_INFO }) });
  await env.backend.prover.pair(proverLink({ own: false }), PASSWORD);
  const settings = env.storage.local.get('settings');
  settings.prover = { ...settings.prover, own: true };
  env.storage.local.set('settings', settings);
  await env.backend.wallet.lock();
  await env.backend.wallet.unlock(PASSWORD);
  assert.equal((await env.backend.settings.get()).prover.own, true, 'the display copy was tampered');
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), /only to a prover paired as your own/);
  assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
  assert.equal(count(env.fetch, 'prover_submit'), 0);
});

test('a chain whose guests this wallet cannot prove for is refused before the prover is asked', async () => {
  // Bundle guest v3 with no auth guest named, a foreign auth guest, and an auth guest beside an
  // older bundle guest: the core's refusals, surfaced as a definite error, nothing built.
  for (const [status, want] of [
    [{ ...STATUS_V3, hc_auth: null }, /names no auth guest/],
    [{ ...STATUS_V3, hc_auth: '99'.repeat(32) }, /update the wallet/],
    [{ ...STATUS_OLD, hc_auth: HC_AUTH }, /misconfigured or lying/],
  ]) {
    const env = await sendableWallet({ fetch: sendableFetch({ rand_status: () => ({ ...status }) }) });
    await env.backend.prover.pair(proverLink(), PASSWORD);
    const asked = count(env.fetch, 'prover_info');
    await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
      assert.equal(err.definite, true);
      assert.match(err.message, want);
      return true;
    });
    assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
    assert.equal(count(env.fetch, 'prover_info'), asked + 1, 'only canProve\'s probe asked the prover');
    assert.equal(count(env.fetch, 'prover_submit'), 0);
  }
  // A malformed hc_auth is the node's reply this wallet cannot read.
  const env = await sendableWallet({ fetch: sendableFetch({ rand_status: () => ({ ...STATUS_V3, hc_auth: 'zz' }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), /rand_status: hc_auth is not 64 hex/);
});

test('a prover that charges a fee is not a way to prove, and is never sent a job', async () => {
  const fee = { amount: '250000000', address: ADDRESS };
  let quoted = null;
  const env = await sendableWallet({ fetch: sendableFetch({ prover_info: () => proverInfo('KEY', { fee: quoted }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover' });
  // It starts charging: canProve says why it is no longer a route…
  quoted = fee;
  const answer = await env.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /charges a fee of 250000000 RAND per proof, which this version of the wallet does not pay/);
  // …and a prover that raised its price between the probe and the job is refused by the core,
  // which is handed the fee the prover quoted at the moment the job was made.
  let calls = 0;
  const late = await sendableWallet({
    fetch: sendableFetch({ prover_info: () => { calls += 1; return proverInfo('KEY', { fee: calls > 2 ? fee : null }); } }),
  });
  await late.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => late.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /does not pay a prover's fee/);
    return true;
  });
  assert.deepEqual(coreCalled(late, 'prepare_transfer')[0][1].prover.fee, fee);
  assert.equal(count(late.fetch, 'prover_submit'), 0);
  // A zero fee is no fee.
  const free = await sendableWallet({ fetch: sendableFetch({ prover_info: () => proverInfo('KEY', { fee: { amount: '0', address: ADDRESS } }) }) });
  await free.backend.prover.pair(proverLink(), PASSWORD);
  assert.deepEqual(await free.backend.send.canProve(), { ok: true, via: 'prover' });
  // And the prover's own refusal of an unpaid job (-32006) is a definite error in words.
  const refused = await sendableWallet({
    fetch: sendableFetch({ prover_submit: () => { throw Object.assign(new Error('the prover fee is not paid'), { code: -32006, data: { reason: 'no output pays this prover\'s fee address' } }); } }),
  });
  await refused.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => refused.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /charges a fee, which this version of the wallet does not pay/);
    return true;
  });
});

test('a prover whose key changed since the pairing is not sent a job', async () => {
  let key = 'KEY';
  const env = await sendableWallet({ fetch: sendableFetch({ prover_info: () => proverInfo(key) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  // The route is decided on the paired key; the prover is then swapped before the job is made.
  let calls = 0;
  const swapped = build({
    storage: env.storage, core: env.core,
    fetch: sendableFetch({ prover_info: () => { calls += 1; return proverInfo(calls > 1 ? 'OTHER' : 'KEY'); } }),
  });
  await assert.rejects(() => swapped.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /different key/);
    return true;
  });
  assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
  assert.equal(count(swapped.fetch, 'prover_submit'), 0);
  key = 'KEY';
});

test('an own prover that answers makes canProve say yes, via the prover — on the desktop too', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  await env.backend.prover.pair(proverLink(), PASSWORD);
  assert.deepEqual(await env.backend.send.canProve(), { ok: true, via: 'prover' });

  // A desktop without the memory falls back to the same prover; one with it proves itself.
  const small = build({ native: true, storage: env.storage, core: env.core });
  assert.deepEqual(await small.backend.send.canProve(), { ok: true, via: 'prover' });
  const big = build({ native: true, storage: env.storage, core: env.core, systemMemoryGiB: () => 16 });
  assert.deepEqual(await big.backend.send.canProve(), { ok: true });

  // A withdrawal is the same proof, so `canWithdraw` carries the same `via` — and only when the
  // bridge is on: the prover route alone is not a yes.
  const bridged = build({ storage: env.storage, core: env.core, fetch: sendableFetch({ rand_getBridgeState: () => ({ enabled: true, emitters: {}, assets: [] }) }) });
  assert.deepEqual(await bridged.backend.bridge.canWithdraw(), { ok: true, via: 'prover' });
  const unbridged = build({ storage: env.storage, core: env.core, fetch: sendableFetch({ rand_getBridgeState: () => ({ enabled: false, emitters: {}, assets: [] }) }) });
  assert.equal((await unbridged.backend.bridge.canWithdraw()).ok, false);

  // A prover that does not answer is not a way to prove, and the reason says so.
  const silent = build({ storage: env.storage, core: env.core, fetch: sendableFetch({ prover_info: () => { throw Object.assign(new Error('down'), { code: -32000 }); } }) });
  const answer = await silent.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /Pair a prover/);
  assert.match(answer.reason, /prover is not available/);
});

// ------------------------------------------------------------------------------ sending --------

test('a_proof_is_made_on_the_chains_fri_profile', async () => {
  // The chain says which FRI profile its validators verify (`rand_status.fri_profile`); a proof on
  // any other is refused at the node after the whole proof was paid for. Only the two names the
  // core knows are taken; anything else — absent, or a value no chain serves — is production.
  for (const [served, want] of [['test', 'test'], ['production', 'production'], [undefined, 'production'], ['weird', 'production']]) {
    const env = await sendableWallet({
      fetch: sendableFetch({
        rand_status: () => ({ ...STATUS_V3, ...(served === undefined ? {} : { fri_profile: served }) }),
        prover_status: () => ({ state: 'done', reply: PROVER_REPLY }),
      }),
    });
    await env.backend.prover.pair(proverLink(), PASSWORD);
    await env.backend.send.send(SEND, () => {});
    const [[, prepared]] = coreCalled(env, 'prepare_transfer');
    assert.equal(prepared.profile, want, `rand_status.fri_profile ${served} → ${prepared.profile}`);
  }
});


test('a_send_through_the_prover_seals_submits_polls_and_submits_the_finished_tx', async () => {
  const script = [{ state: 'queued', position: 2 }, { state: 'queued', position: 2 }, { state: 'proving' }, { state: 'done', reply: PROVER_REPLY }];
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => script.shift() }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const phases = [];
  const out = await env.backend.send.send(SEND, (p, detail) => phases.push(detail === undefined ? [p] : [p, detail]));

  // 'proving' begins ON THIS DEVICE: the auth proof, made from the spend key inside the core's
  // `prepare_transfer`, before the job exists. Then the prover's own phases.
  assert.deepEqual(phases, [
    ['selecting'], ['witness'],
    ['proving', { prover: '127.0.0.1:8546', authorising: true }],
    ['proving', { prover: '127.0.0.1:8546' }],
    ['proving', { position: 2, prover: '127.0.0.1:8546' }],
    ['proving', { prover: '127.0.0.1:8546' }],
    ['submitting'], ['confirming'],
  ]);
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.equal(out.txKey, '72'.repeat(32), 'the payment slot\'s key, from finish_proof');

  // The core sealed it to the paired prover, for the chain's guest and proof cap.
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.deepEqual(prepared.prover, { kem_ek: proverEk(), token: PROVER_TOKEN, own: true, fee: null, hc_bundle: HC_V3 });
  assert.equal(prepared.hc_bundle, HC_V3);
  assert.equal(prepared.hc_auth, HC_AUTH);
  assert.equal(prepared.max_proof_bytes, 2097152);
  assert.equal(coreCalled(env, 'prove_transfer').length, 0, 'the browser tried to prove');

  // The prover got the sealed job and was polled for that job; the node got the finished tx.
  const submit = env.fetch.requests.find((r) => r.body.method === 'prover_submit');
  assert.equal(submit.url, PROVER_URL);
  assert.deepEqual(submit.body.params, [SEALED_JOB]);
  assert.ok(env.fetch.requests.filter((r) => r.body.method === 'prover_status').every((r) => r.body.params[0] === 'job-1'));
  const sent = env.fetch.requests.filter((r) => r.body.method === 'rand_sendTransaction');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.params, ['ab'.repeat(200)]);
  const [[, finished]] = coreCalled(env, 'finish_proof');
  assert.equal(finished.reply_hex, PROVER_REPLY);

  assert.equal(env.storage.sessionMap.has('pendingProof'), false, 'the pending record outlived the send');
  assert.equal(await env.backend.send.pending(), null);
  assertKeyNeverLeaked(env);
  assertKeyNeverLeaked(env, PROVER_TOKEN);
});

test('a_closed_popup_resumes_the_same_job_and_submits_once', async () => {
  // Popup A: the prover says "proving" once, then A's window is gone — its next poll never returns.
  let polls = 0;
  let wakeA;
  const fetchA = sendableFetch({
    prover_status: () => {
      polls += 1;
      return polls === 1 ? { state: 'proving' } : new Promise((resolve) => { wakeA = resolve; });
    },
  });
  const a = await sendableWallet({ fetch: fetchA });
  await a.backend.prover.pair(proverLink(), PASSWORD);
  const abandoned = a.backend.send.send(SEND, () => {});
  abandoned.catch(() => {});
  await until(() => polls >= 2, 'popup A to be polling');
  const record = a.storage.sessionMap.get('pendingProof');
  assert.equal(record.job, 'job-1');
  assert.equal(record.kind, 'transfer');
  assert.equal(record.to, ADDRESS);
  assert.equal(JSON.stringify(record).includes(SPEND_KEY), false, 'the pending record carries the spend key');
  assert.equal(JSON.stringify(record).includes(PROVER_TOKEN), false, 'the pending record carries the token');

  // Popup B: a new backend over the same storage (the session survives the popup).
  const fetchB = sendableFetch();
  const b = build({ storage: a.storage, core: a.core, fetch: fetchB });
  assert.deepEqual(await b.backend.send.pending(), { job: 'job-1', name: '127.0.0.1:8546', kind: 'transfer', startedAt: record.startedAt });
  await assert.rejects(() => b.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /still pending — resume or cancel it/);
    return true;
  });
  const phases = [];
  const out = await b.backend.send.resume((p, detail) => phases.push(detail === undefined ? [p] : [p, detail]));
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.equal(out.txKey, '72'.repeat(32));
  // One 'proving' (reported before the first poll, not repeated when the prover says the same).
  assert.deepEqual(phases, [['proving', { prover: '127.0.0.1:8546' }], ['submitting'], ['confirming']]);

  // The same job, submitted to the prover once and to the node once.
  assert.equal(count(fetchA, 'prover_submit') + count(fetchB, 'prover_submit'), 1);
  assert.ok(fetchB.requests.filter((r) => r.body.method === 'prover_status').every((r) => r.body.params[0] === 'job-1'));
  assert.equal(count(fetchA, 'rand_sendTransaction') + count(fetchB, 'rand_sendTransaction'), 1);
  assert.equal(await b.backend.send.pending(), null);
  await assert.rejects(() => b.backend.send.resume(() => {}), /No proof is pending/);
  // The submission is recorded like any other send's.
  assert.equal(a.storage.local.get('notes').submissions[0].hash, PROVED_TX_HASH);

  // And if popup A was only asleep, not gone: its poll comes back "done" after B submitted. It
  // opens the same reply, finds the job no longer its to claim, and does not submit a second time.
  wakeA({ state: 'done', reply: PROVER_REPLY });
  await assert.rejects(abandoned, (err) => {
    assert.match(err.message, /already submitted from another window/);
    // Never "retry is safe": the other window's transaction may be on the wire already.
    assert.equal(err.definite, false);
    assert.equal(err.alreadySubmitted, true);
    return true;
  });
  assert.equal(count(fetchA, 'rand_sendTransaction') + count(fetchB, 'rand_sendTransaction'), 1);
  assertKeyNeverLeaked({ ...b, fetch: fetchB });
  assertKeyNeverLeaked({ ...a, fetch: fetchA }, PROVER_TOKEN);
});

test('busy_is_a_definite_error_with_the_depth', async () => {
  const env = await sendableWallet({
    fetch: sendableFetch({ prover_submit: () => { throw Object.assign(new Error('busy'), { code: -32005, data: { depth: 3, max: 3 } }); } }),
  });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /prover is full \(3 waiting\)/);
    return true;
  });
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);
  assert.equal(count(env.fetch, 'prover_status'), 0, 'it spun on a prover that refused the job');
  assert.equal(await env.backend.send.pending(), null);
});

test('an unpaired token is a definite error that says to pair again', async () => {
  const env = await sendableWallet({
    fetch: sendableFetch({ prover_submit: () => { throw Object.assign(new Error('unpaired'), { code: -32003 }); } }),
  });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /does not know this pairing/);
    return true;
  });
});

test('a_wrong_digest_never_reaches_send_transaction', async () => {
  const core = stubCore({ finish_proof: () => { throw new Error('the proof published a digest this wallet did not build'); } });
  const env = await sendableWallet({ core });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /digest/);
    return true;
  });
  assert.equal(count(env.fetch, 'prover_submit'), 1);
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);
  assert.equal(await env.backend.send.pending(), null, 'a refused proof is not resumable');
});

test('cancelling mid-proof cancels the job on the prover and forgets it', async () => {
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => ({ state: 'proving' }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const ctl = new AbortController();
  const sending = env.backend.send.send(SEND, () => {}, { signal: ctl.signal });
  await until(() => count(env.fetch, 'prover_status') >= 2, 'the send to be polling');
  ctl.abort();
  await assert.rejects(sending, (err) => err.name === 'AbortError');
  const cancel = env.fetch.requests.find((r) => r.body.method === 'prover_cancel');
  assert.deepEqual(cancel && cancel.body.params, ['job-1']);
  assert.equal(await env.backend.send.pending(), null);
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);
});

test('a lock forgets a pending proof with the spend key (R1)', async () => {
  let hold = true;
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => (hold ? new Promise(() => {}) : { state: 'proving' }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  env.backend.send.send(SEND, () => {}).catch(() => {});
  await until(() => env.storage.sessionMap.has('pendingProof'), 'the job to be recorded');
  hold = false;
  await env.backend.wallet.lock();
  assert.equal(env.storage.sessionMap.has('pendingProof'), false);
});

test('the device path proves with the chain\'s bundle guest', async () => {
  const core = stubCore({
    prove_transfer: (p) => {
      const prepared = stubCore().call('prepare_transfer', { ...p, prover: { kem_ek: proverEk(), token: PROVER_TOKEN } });
      return prepared.then((r) => stubCore().call('finish_proof', { pending: r.pending, reply_hex: PROVER_REPLY }));
    },
  });
  const env = await sendableWallet({ core, native: true, systemMemoryGiB: () => 16 });
  await env.backend.send.send(SEND, () => {});
  const [[, proved]] = coreCalled(env, 'prove_transfer');
  assert.equal(proved.hc_bundle, HC_V3);
  assert.equal(proved.hc_auth, HC_AUTH, 'the device\'s own proof is told the chain\'s auth guest too');
  assert.equal(count(env.fetch, 'prover_submit'), 0);
});

test('two windows resuming the same finished job submit it exactly once', async () => {
  const a = await sendableWallet({ fetch: sendableFetch({ prover_status: () => new Promise(() => {}) }) });
  await a.backend.prover.pair(proverLink(), PASSWORD);
  a.backend.send.send(SEND, () => {}).catch(() => {});
  await until(() => a.storage.sessionMap.has('pendingProof'), 'the job to be recorded');

  const fetchB = sendableFetch();
  const fetchC = sendableFetch();
  const b = build({ storage: a.storage, core: a.core, fetch: fetchB });
  const c = build({ storage: a.storage, core: a.core, fetch: fetchC });
  const results = await Promise.allSettled([b.backend.send.resume(() => {}), c.backend.send.resume(() => {})]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'both windows submitted, or neither did');
  assert.equal(won[0].value.hash, PROVED_TX_HASH);
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason.message, /already submitted from another window/);
  assert.equal(lost[0].reason.definite, false);
  assert.equal(count(fetchB, 'rand_sendTransaction') + count(fetchC, 'rand_sendTransaction'), 1);
  assert.equal(await b.backend.send.pending(), null);
});

test('a pending record removed by a lock under a live poll says nothing was sent', async () => {
  let wake;
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => new Promise((r) => { wake = r; }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const sending = env.backend.send.send(SEND, () => {});
  await until(() => wake !== undefined, 'the send to be polling');
  await env.backend.wallet.lock();
  wake({ state: 'done', reply: PROVER_REPLY });
  await assert.rejects(sending, (err) => {
    assert.match(err.message, /pending proof was cleared \(the wallet locked, or it was cancelled elsewhere\), so nothing was sent/);
    assert.equal(err.definite, true);
    return true;
  });
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0);
});

test('pairing recomputes the fingerprint in the core rather than trusting the prover\'s own', async () => {
  // A prover that reports the link's fingerprint but serves another key.
  const env = build({ fetch: sendableFetch({ prover_info: () => ({ ...proverInfo('OTHER'), kem_fingerprint: proverFingerprint('KEY') }) }) });
  await env.backend.wallet.create(PASSWORD);
  await assert.rejects(() => env.backend.prover.pair(proverLink(), PASSWORD), /different key/);
  // And one that serves the right key but claims any fingerprint it likes still pairs: the core's word counts.
  const ok = build({ fetch: sendableFetch({ prover_info: () => ({ ...proverInfo('KEY'), kem_fingerprint: 'LIES-LIES-LIES-LIES' }) }) });
  await ok.backend.wallet.create(PASSWORD);
  assert.equal((await ok.backend.prover.pair(proverLink(), PASSWORD)).fingerprint, proverFingerprint('KEY'));
  assert.ok(ok.core.calls.some(([m, p]) => m === 'prover_fingerprint' && p.kem_ek === proverEk('KEY')));
});

test('settings.prover is read back as the six pairing fields and nothing else', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const stored = env.storage.local.get('settings');
  stored.prover.token = PROVER_TOKEN;
  stored.prover.extra = 'x';
  env.storage.local.set('settings', stored);
  const { prover } = await env.backend.settings.get();
  assert.deepEqual(Object.keys(prover).sort(), ['fingerprint', 'kemEk', 'mode', 'name', 'own', 'url']);
});

test('the claim is taken under the Web Lock the backend was given', async () => {
  const taken = [];
  const locks = { async request(name, options, fn) { taken.push([name, options && options.mode]); return fn({ name }); } };
  const env = await sendableWallet({ locks });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await env.backend.send.send(SEND, () => {});
  assert.deepEqual(taken.filter(([n]) => n === 'rand-pending-proof'), [['rand-pending-proof', 'exclusive']]);
});

// ------------------------------------------------------------- final review: claim and clocks --

test('a_claim_whose_marker_did_not_persist_fails_not_definite_and_keeps_the_record', async () => {
  // If the claim marker cannot be written, removing the record anyway would let a second window
  // read "gone" — "nothing was sent" — while this one submits. The claim fails instead, not
  // definite, and the record stays so Resume can try again.
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => ({ state: 'done', reply: PROVER_REPLY }) }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const set = env.storage.session.set;
  let thrown = 0;
  env.storage.session.set = async (key, value) => {
    if (key === CLAIMED_PROOF_KEY && thrown === 0) { thrown += 1; throw new Error('quota'); }
    return set.call(env.storage.session, key, value);
  };
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.match(err.message, /could not claim the proof; check Activity before sending again/i);
    assert.equal(err.definite, false);
    return true;
  });
  assert.equal(thrown, 1);
  assert.equal(count(env.fetch, 'rand_sendTransaction'), 0, 'an unclaimed proof was submitted');
  assert.ok(env.storage.sessionMap.has(PENDING_PROOF_KEY), 'the pending record was removed without a claim');
});

/** A prover client scripted by the fake clock, and the clock. */
function clocked(script) {
  let t = 0;
  const calls = [];
  const client = {
    url: PROVER_URL,
    status: async () => { calls.push('status'); return script(t); },
    cancel: async () => { calls.push('cancel'); },
  };
  return { client, calls, now: () => t, sleep: async (ms) => { t += ms; } };
}

async function pendingStore(job = 'job-1') {
  const storage = mapStorage();
  await storage.session.set(PENDING_PROOF_KEY, { job, pending: { p: 1 }, url: PROVER_URL, name: 'mine', startedAt: 0 });
  return storage;
}

test('a_job_queued_25_minutes_then_proved_is_accepted', async () => {
  const MIN = 60_000;
  const { client, now, sleep } = clocked((t) => (t < 25 * MIN ? { state: 'queued', position: 8 } : t < 40 * MIN ? { state: 'proving' } : { state: 'done', reply: 'aa' }));
  const storage = await pendingStore();
  const core = { call: async (m) => (m === 'finish_proof' ? 'PROVED' : null) };
  const record = await storage.session.get(PENDING_PROOF_KEY);
  const res = await pollRemoteProof({ client, core, record, storage, poll: MIN, now, sleep });
  assert.equal(res, 'PROVED');
  assert.ok(MAX_QUEUE_WAIT_MS >= 25 * MIN && MAX_PROVING_MS >= 15 * MIN);
});

test('each_state_has_its_own_bound_and_running_out_keeps_the_record', async () => {
  const MIN = 60_000;
  // Proving for ever: stopped MAX_PROVING_MS after it LEFT the queue, not after the submit.
  const a = clocked((t) => (t < 10 * MIN ? { state: 'queued', position: 1 } : { state: 'proving' }));
  const sa = await pendingStore();
  await assert.rejects(
    () => pollRemoteProof({ client: a.client, core: {}, record: { job: 'job-1', name: 'mine' }, storage: sa, poll: MIN, now: a.now, sleep: a.sleep }),
    (err) => { assert.equal(err.proverSilent, true); assert.equal(err.definite, true); assert.match(err.message, /20 minutes of proving/); return true; },
  );
  assert.equal(a.now(), 10 * MIN + MAX_PROVING_MS);
  assert.ok(sa.sessionMap.has(PENDING_PROOF_KEY));
  // Queued for ever: stopped at MAX_QUEUE_WAIT_MS.
  const b = clocked(() => ({ state: 'queued', position: 3 }));
  const sb = await pendingStore();
  await assert.rejects(
    () => pollRemoteProof({ client: b.client, core: {}, record: { job: 'job-1', name: 'mine' }, storage: sb, poll: MIN, now: b.now, sleep: b.sleep }),
    (err) => { assert.equal(err.proverSilent, true); assert.match(err.message, /30 minutes in its queue/); return true; },
  );
  assert.equal(b.now(), MAX_QUEUE_WAIT_MS);
  assert.ok(sb.sessionMap.has(PENDING_PROOF_KEY));
});

// ------------------------------------------------------- submit: a transport failure is retried --

/** A client whose `submit` plays `script` (an Error is thrown, anything else is the job id). */
function scriptedSubmit(script) {
  const calls = [];
  return {
    calls,
    client: {
      url: 'https://prover.randprotocol.org',
      async submit(sealed) {
        calls.push(sealed);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}
const PREPARED = { sealed_hex: 'aa'.repeat(8), pending: { kind: 'transfer' } };
const connectFailure = () => new ProverError('cannot reach the prover at https://prover.randprotocol.org: fetch failed', { failure: 'connect' });

test('a submit that never reached the prover is offered again, a bounded number of times, with backoff', async () => {
  assert.equal(SUBMIT_TRIES, 3);
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const { client, calls } = scriptedSubmit([connectFailure(), new ProverError('HTTP 502', { failure: 'http' }), 'job-7']);
  const storage = mapStorage();
  const rec = await startRemoteProof({ client, prepared: PREPARED, storage, sleep });
  assert.equal(rec.job, 'job-7');
  assert.deepEqual(calls, [PREPARED.sealed_hex, PREPARED.sealed_hex, PREPARED.sealed_hex], 'the same sealed job, three times');
  assert.deepEqual(waits, [...SUBMIT_BACKOFF_MS]);
  assert.equal(storage.sessionMap.get(PENDING_PROOF_KEY).job, 'job-7');

  // Three failures: given up, definite, nothing remembered.
  const down = scriptedSubmit([connectFailure(), connectFailure(), connectFailure(), 'never']);
  const empty = mapStorage();
  await assert.rejects(() => startRemoteProof({ client: down.client, prepared: PREPARED, storage: empty, sleep }), (err) => {
    assert.equal(err.definite, true);
    assert.match(err.message, /Could not hand the proof to the prover/);
    return true;
  });
  assert.equal(down.calls.length, SUBMIT_TRIES);
  assert.equal(empty.sessionMap.has(PENDING_PROOF_KEY), false);
});

test('a JSON-RPC refusal, a timeout or a reply without a job id is never resubmitted', async () => {
  const sleep = async () => {};
  for (const failure of [
    new ProverError('busy', { code: -32005, data: { depth: 5 } }),
    new ProverError('cannot reach the prover: timed out', { failure: 'timeout' }),
    new ProverError('the prover accepted the job but named no job id', { failure: 'body' }),
  ]) {
    const { client, calls } = scriptedSubmit([failure, 'job-2']);
    await assert.rejects(() => startRemoteProof({ client, prepared: PREPARED, storage: mapStorage(), sleep }));
    assert.equal(calls.length, 1, `resubmitted after: ${failure.message}`);
  }
});

test('a send through the prover survives one failed connection to it', async () => {
  let fail = 1;
  const inner = sendableFetch();
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'prover_submit' && fail > 0) { fail -= 1; throw new TypeError('fetch failed'); }
    return inner(url, init);
  };
  fetch.requests = inner.requests;
  const env = await sendableWallet({ fetch });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const out = await env.backend.send.send(SEND, () => {});
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.equal(count(env.fetch, 'prover_submit'), 1, 'the retried submit reached the prover once');
});
