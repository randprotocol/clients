// Delegated proving, Phase 1 (plan docs/superpowers/plans/2026-09-28-delegated-proving-phase1.md,
// Task 3): the engine's `prover` group, the pairing token in the vault, a send proved by a paired
// prover, and a popup closed mid-proof resuming the same job — against the real shared backend
// (`makeWasmBackend`, whose device can never prove) with the stub core and a stub fetch that plays
// both the node and the prover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend, CANNOT_PROVE_REASON } from '../engine/backend-wasm.js';
import { makeNativeBackend } from '../engine/backend-native.js';
import { decryptSecret } from '../engine/crypto.js';
import {
  stubCore, stubFetch, mapStorage, stubPlatform, assertKeyNeverLeaked,
  PASSWORD, ADDRESS, SPEND_KEY, PROVER_URL, PROVER_TOKEN, PROVER_REPLY, PROVED_TX_HASH, SEALED_JOB,
  proverLink, proverInfo, proverEk, proverFingerprint,
} from './backend-fixtures.mjs';

const ROOT = '1b'.repeat(32);
const HC_V2 = 'f0'.repeat(32);
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
    rand_status: () => ({ height: 100, peer_count: 3, syncing: false, hc_bundle: HC_V2 }),
    rand_getLimits: () => ({ envelope_bytes: null, max_proof_bytes: 2097152 }),
    ...table,
  });
}

function build({ core, storage, fetch, native, systemMemoryGiB, locks = null } = {}) {
  const env = {
    core: core || stubCore(),
    storage: storage || mapStorage(),
    fetch: fetch || sendableFetch(),
    platform: stubPlatform(),
  };
  const make = native ? makeNativeBackend : makeWasmBackend;
  env.backend = make({
    ...env, locks, broadcast: null,
    proverOptions: { poll: 1, maxWait: 5000 },
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
  assert.equal(await decryptSecret(PASSWORD, vault), PROVER_TOKEN);
  assert.equal(env.storage.sessionMap.get('unlocked').prover_token, PROVER_TOKEN, 'the unlocked session carries the token');

  // Only the prover's info was asked, and neither secret went anywhere but the core.
  assert.deepEqual(methodsOf(env.fetch).filter((m) => m.startsWith('prover_')), ['prover_info']);
  assertKeyNeverLeaked(env);
  assertKeyNeverLeaked(env, PROVER_TOKEN);

  // A lock drops it with the spend key; an unlock opens it again with the same password (R2).
  await env.backend.wallet.lock();
  assert.equal(env.storage.sessionMap.get('unlocked'), undefined);
  await env.backend.wallet.unlock(PASSWORD);
  assert.equal(env.storage.sessionMap.get('unlocked').prover_token, PROVER_TOKEN);

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
  assert.deepEqual((await env.backend.settings.get()).prover, { mode: 'device' });
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

  assert.equal(await decryptSecret(PASSWORD, env.storage.local.get('proverToken')), second);
  assert.equal(env.storage.sessionMap.get('unlocked').prover_token, second);
  assert.equal((await env.backend.settings.get()).prover.url, 'https://prover.example');
  await env.backend.wallet.lock();
  await env.backend.wallet.unlock(PASSWORD);
  assert.equal(env.storage.sessionMap.get('unlocked').prover_token, second);

  // The next send seals to the new prover's key with the new token.
  await env.backend.send.send(SEND, () => {});
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.equal(prepared.prover.token, second);
  assert.equal(prepared.prover.kem_ek, proverEk('NEXT'));
  assert.equal(JSON.stringify([...env.storage.sessionMap.entries(), ...env.storage.local.entries()]).includes(PROVER_TOKEN), false);
  assertKeyNeverLeaked(env, second);
});

test('forget_removes_settings_vault_and_session_copies', async () => {
  const env = build();
  await env.backend.wallet.create(PASSWORD);
  await env.backend.prover.pair(proverLink(), PASSWORD);
  await env.backend.prover.forget();
  assert.deepEqual((await env.backend.settings.get()).prover, { mode: 'device' });
  assert.equal(env.storage.local.has('proverToken'), false);
  assert.equal('prover_token' in env.storage.sessionMap.get('unlocked'), false);
  assert.equal(env.storage.sessionMap.get('unlocked').spend_key, SPEND_KEY, 'forgetting the prover kept the wallet unlocked');
  assert.deepEqual(await env.backend.send.canProve(), { ok: false, reason: CANNOT_PROVE_REASON });
  assert.equal((await env.backend.prover.probe()).ok, false);
});

// ------------------------------------------------------------------------------ canProve -------

test('the_wasm_reason_names_the_prover_option', async () => {
  const env = build({ fetch: sendableFetch({ rand_getBridgeState: () => ({ enabled: true, emitters: {}, assets: [] }) }) });
  const answer = await env.backend.send.canProve();
  assert.deepEqual(answer, { ok: false, reason: CANNOT_PROVE_REASON });
  assert.match(answer.reason, /Pair your own prover in Settings/);
  assert.match(answer.reason, /desktop app/);
  assert.match(answer.reason, /5\.7 GB/);
  assert.deepEqual(await env.backend.bridge.canWithdraw(), { ok: false, reason: CANNOT_PROVE_REASON });
});

test('a_spend_key_job_is_built_only_for_an_own_prover', async () => {
  const env = await sendableWallet();
  await env.backend.prover.pair(proverLink({ own: false }), PASSWORD);
  assert.equal((await env.backend.settings.get()).prover.own, false);
  assert.deepEqual(await env.backend.send.canProve(), { ok: false, reason: CANNOT_PROVE_REASON });
  await assert.rejects(() => env.backend.send.send(SEND, () => {}), (err) => {
    assert.equal(err.definite, true);
    assert.equal(err.message, CANNOT_PROVE_REASON);
    return true;
  });
  assert.equal(coreCalled(env, 'prepare_transfer').length, 0);
  assert.equal(count(env.fetch, 'prover_submit'), 0);
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

  // A prover that does not answer is not a way to prove, and the reason says so.
  const silent = build({ storage: env.storage, core: env.core, fetch: sendableFetch({ prover_info: () => { throw Object.assign(new Error('down'), { code: -32000 }); } }) });
  const answer = await silent.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /Pair your own prover/);
  assert.match(answer.reason, /prover is not available/);
});

// ------------------------------------------------------------------------------ sending --------

test('a_send_through_the_prover_seals_submits_polls_and_submits_the_finished_tx', async () => {
  const script = [{ state: 'queued', position: 2 }, { state: 'queued', position: 2 }, { state: 'proving' }, { state: 'done', reply: PROVER_REPLY }];
  const env = await sendableWallet({ fetch: sendableFetch({ prover_status: () => script.shift() }) });
  await env.backend.prover.pair(proverLink(), PASSWORD);
  const phases = [];
  const out = await env.backend.send.send(SEND, (p, detail) => phases.push(detail === undefined ? [p] : [p, detail]));

  assert.deepEqual(phases, [
    ['selecting'], ['witness'],
    ['proving', { prover: '127.0.0.1:8546' }],
    ['proving', { position: 2, prover: '127.0.0.1:8546' }],
    ['proving', { prover: '127.0.0.1:8546' }],
    ['submitting'], ['confirming'],
  ]);
  assert.equal(out.hash, PROVED_TX_HASH);
  assert.equal(out.txKey, '72'.repeat(32), 'the payment slot\'s key, from finish_proof');

  // The core sealed it to the paired prover, for the chain's guest and proof cap.
  const [[, prepared]] = coreCalled(env, 'prepare_transfer');
  assert.deepEqual(prepared.prover, { kem_ek: proverEk(), token: PROVER_TOKEN, witness_kind: 'spend_key', hc_bundle: HC_V2 });
  assert.equal(prepared.hc_bundle, HC_V2);
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
  assert.equal(proved.hc_bundle, HC_V2);
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
    assert.match(err.message, /locked while your prover was working, so nothing was sent/);
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
