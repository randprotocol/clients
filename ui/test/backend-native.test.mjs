// The real Backend for the desktop shell: ui/engine/backend-native.js, driven by the same stubs
// `backend-wasm.test.mjs` uses. Nothing here touches Tauri, a real node or a real prover — the
// stub core stands in for `wallet-core` compiled natively, which is the only thing that changes.
//
// Everything this backend inherits is asserted by `./backend-cases.mjs`, against BOTH factories,
// so this file is about the two things that are genuinely different on the desktop:
//
//   1. `canProve()` is a real question — how much memory this computer has — instead of the
//      structural `{ok: false}` wasm32's 4 GiB address space forces;
//   2. `send.send()` actually sends: it calls `ui/engine/wallet.js`'s `send()`, with the client
//      and the identity the chain gate verified, and maps what comes back to the contract.
//
// This is the first point in the whole wallet at which a transfer can complete, so the cases
// below are about the things that are only wrong once real money has moved: proving against the
// VERIFIED chain rather than the configured one, and never claiming a failure is definite when
// the transaction may already be in a mempool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNativeBackend, MIN_PROVE_GIB } from '../engine/backend-native.js';
import { sharedBackendCases } from './backend-cases.mjs';
import {
  SPEND_KEY, PASSWORD, ADDRESS, GENESIS,
  mapStorage, stubCore, stubFetch, stubPlatform, chainFetch, assertKeyNeverLeaked,
} from './backend-fixtures.mjs';

const TX_HASH = `0x${'7a'.repeat(32)}`;
const TX_KEY = 'e5'.repeat(32);
const ROOT = '1b'.repeat(32);

/** A machine with plenty of memory: what the shared cases run on, so they can reach `send.send`. */
const BIG_MACHINE_GIB = 16;

/**
 * A core that can prove — the whole point of this shell. `prove_transfer` is the one method the
 * wasm stub deliberately throws from; here it answers the way the real one does, and records what
 * it was asked to prove so a test can check WHICH chain the proof committed to.
 */
function provingCore(overrides = {}) {
  return stubCore({
    prove_transfer: (p) => ({
      tx_hex: 'ab'.repeat(200),
      amount: String(p.amount), change: '0', fee: String(p.fee), time: 7, tier: 14,
      proof_bytes: 1_200_000,
      tx_keys: [TX_KEY],
      commitments: ['0d'.repeat(32)],
      spent_indices: (p.inputs || []).map((i) => i.note.index),
    }),
    ...overrides,
  });
}

/** A node that can be sent to: the three methods a transfer needs on top of a scan's. */
function sendableFetch(table = {}) {
  return stubFetch({
    rand_getAnchor: () => ({ height: 100, root: ROOT }),
    rand_getWitness: () => ({ index: 0, root: ROOT, path: Array.from({ length: 32 }, () => '00'.repeat(32)) }),
    rand_sendTransaction: () => TX_HASH,
    rand_getTransaction: () => ({ height: 101 }),
    ...table,
  });
}

const NOTE = {
  index: 0, note: '00'.repeat(112), cm: '0b'.repeat(32), nf: '0c'.repeat(32),
  amount: '5000000000', asset: 0, time: 7, from: '00'.repeat(32), height: 7, spent: false, pending: null,
};

function build(opts = {}) {
  const core = opts.core || stubCore();
  const storage = opts.storage || mapStorage();
  const platform = opts.platform || stubPlatform();
  const fetch = opts.fetch || stubFetch();
  const backend = makeNativeBackend({
    core, storage, platform, fetch,
    // Same reason as the wasm build(): Node's own BroadcastChannel, left ref'd, keeps the test
    // process alive for ever.
    locks: opts.locks ?? null,
    broadcast: opts.broadcast ?? null,
    systemMemoryGiB: opts.systemMemoryGiB ?? (() => BIG_MACHINE_GIB),
    ...(opts.extra || {}),
  });
  return { backend, core, storage, platform, fetch };
}

/** A wallet with one spendable note, on a node that will take a transfer. */
async function sendableWallet(opts = {}) {
  const env = build({ core: provingCore(opts.core), fetch: sendableFetch(opts.fetch), ...opts.rest });
  await env.backend.wallet.create(PASSWORD);
  await env.backend.sync.scan(() => {});
  const notes = env.storage.local.get('notes');
  notes.notes = [NOTE];
  env.storage.local.set('notes', notes);
  return env;
}

/**
 * The refusal the shared idle-lock cases need. This shell CAN prove, so it refuses the one thing
 * no shell can do: a transfer of a registry asset. It is definite, it costs no proof, and it
 * reaches `executeSend` — i.e. it exercises more of this shell's own path than a `canProve()`
 * refusal would.
 */
const refusedSend = (backend) => backend.send.send({ asset: 1, to: ADDRESS, amount: '1' }, () => {});

sharedBackendCases({ label: 'native', build, refusedSend });

// --------------------------------------------------------------- canProve asks the machine -----

test('canProve says yes on a machine with enough memory', async () => {
  const { backend } = build({ systemMemoryGiB: () => MIN_PROVE_GIB });
  assert.deepEqual(await backend.send.canProve(), { ok: true });
});

test('canProve says no below the threshold, and reports the real number', async () => {
  const { backend } = build({ systemMemoryGiB: () => 4 });
  const answer = await backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /5\.5 GB/);
  assert.match(answer.reason, /this computer reports 4 GB\./, `the real number is missing: ${answer.reason}`);
  // Not the browser shells' answer: there is no "use the desktop app" to offer here.
  assert.equal(/desktop app/.test(answer.reason), false);
});

test('canProve rounds the number it shows rather than printing float noise', async () => {
  const { backend } = build({ systemMemoryGiB: () => 7.999999046325684 });
  assert.match((await backend.send.canProve()).reason, /reports 8 GB\./);
  const almost = build({ systemMemoryGiB: () => 6.4831 }).backend;
  assert.match((await almost.send.canProve()).reason, /reports 6\.5 GB\./);
});

test('a memory probe that fails, or is missing, is "we do not know" — never "yes"', async () => {
  for (const [what, probe] of Object.entries({
    'the command threw': () => { throw new Error('no such command'); },
    'the command rejected': async () => { throw new Error('ipc closed'); },
    'it answered nonsense': () => 'lots',
    'it answered zero': () => 0,
  })) {
    const { backend } = build({ systemMemoryGiB: probe });
    const answer = await backend.send.canProve();
    assert.equal(answer.ok, false, what);
    assert.match(answer.reason, /did not report how much it has/, what);
  }

  // …and a shell that forgot to inject one at all. `build()` supplies a default, so this one has
  // to go through the factory directly — which is the point: the default is the TEST's, never the
  // backend's. A backend with no way to ask the machine must not assume the answer is yes.
  const bare = makeNativeBackend({
    core: stubCore(), storage: mapStorage(), platform: stubPlatform(), fetch: stubFetch(),
    locks: null, broadcast: null,
  });
  const answer = await bare.send.canProve();
  assert.equal(answer.ok, false, 'a backend with no memory probe claimed it could prove');
  assert.match(answer.reason, /did not report how much it has/);
});

test('send refuses before touching the node when the machine is too small', async () => {
  const env = await sendableWallet();
  const small = build({
    core: env.core, storage: env.storage, fetch: env.fetch, systemMemoryGiB: () => 4,
  }).backend;
  const before = env.fetch.requests.length;
  const phases = [];
  await assert.rejects(
    () => small.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, (p) => phases.push(p)),
    (err) => { assert.equal(err.definite, true); assert.match(err.message, /4 GB/); return true; },
  );
  assert.deepEqual(phases, [], 'a refusal that costs nothing still reported a phase');
  assert.equal(env.core.calls.some(([m]) => m === 'prove_transfer'), false);
  assert.equal(env.fetch.requests.length, before, 'it asked the node about a transfer it could not make');
});

// ------------------------------------------------------------------ send actually sends --------

test('send proves, submits, waits and answers with the hash and the transaction key', async () => {
  const env = await sendableWallet();
  const phases = [];
  const result = await env.backend.send.send(
    { asset: 0, to: ADDRESS, amount: '1000000000' },
    (p) => phases.push(p),
  );

  assert.equal(result.hash, TX_HASH);
  assert.equal(result.txKey, TX_KEY);
  // The contract's phase names (ui/backend.js), in order — not the engine's own vocabulary.
  assert.deepEqual(phases, ['selecting', 'witness', 'proving', 'submitting', 'confirming']);

  const proved = env.core.calls.find(([m]) => m === 'prove_transfer');
  assert.ok(proved, 'nothing was ever proved: this shell did not reach wallet.js send()');
  assert.equal(proved[1].to, ADDRESS);
  assert.equal(proved[1].amount, '1000000000');
  assert.equal(proved[1].profile, 'production');
  assert.ok(env.fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'));
});

test('the proof commits to the chain the gate VERIFIED, not the one in settings', async () => {
  // The two can diverge silently: a store that already knows chain 13 scans happily whatever
  // `settings.chainId` says, because the configured id is only compared when an identity is first
  // adopted. A proof bound to the wrong chain id is refused by the chain at best.
  const env = await sendableWallet({ fetch: {} });
  await env.backend.settings.set({ chainId: 99 });
  await env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});
  const proved = env.core.calls.find(([m]) => m === 'prove_transfer');
  assert.equal(String(proved[1].chain_id), '13', 'the proof took the setting over the verified identity');
});

test('the verified identity is what the proof uses when the store has not adopted one', async () => {
  // The case the `identity` hand-off exists for (task 1.8). The gate verified this node — two RPC
  // calls, which is all it takes — but the scan inside the transfer read nothing, because the
  // node's tip is below what this wallet has already read, so the note store still names no chain.
  // Without the verified identity riding along there is nothing left to prove against, and the
  // transfer dies on a wallet whose chain was in fact established a moment earlier.
  const env = await sendableWallet({ fetch: { rand_getHead: () => ({ height: 5, hash: 'ff'.repeat(32) }) } });
  const notes = env.storage.local.get('notes');
  env.storage.local.set('notes', {
    ...notes, notes: [NOTE], chain_id: null, genesis: null, scanned_height: 5_000, scanned_index: 1,
  });

  await env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});
  const proved = env.core.calls.find(([m]) => m === 'prove_transfer');
  assert.ok(proved, 'the transfer never reached the prover');
  assert.equal(String(proved[1].chain_id), '13', 'the proof did not use the identity the gate verified');
});

test('the send runs on the client the gate verified, and the fee comes from that node', async () => {
  const env = await sendableWallet();
  const urls = new Set(env.fetch.requests.map((r) => r.url));
  await env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});
  const after = new Set(env.fetch.requests.map((r) => r.url));
  assert.deepEqual([...after], [...urls], 'the transfer reached a node the gate never verified');
  assert.ok(env.fetch.requests.some((r) => r.body.method === 'rand_estimateFee'));
});

test('a locked wallet cannot send, however much memory the machine has', async () => {
  const env = await sendableWallet();
  await env.backend.wallet.lock();
  await assert.rejects(
    () => env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
    /locked/,
  );
  assert.equal(env.core.calls.some(([m]) => m === 'prove_transfer'), false);
});

test('an RPL transfer is refused in the words the UI shows, without proving anything', async () => {
  const env = await sendableWallet();
  await assert.rejects(
    () => env.backend.send.send({ asset: 1, to: ADDRESS, amount: '1' }, () => {}),
    (err) => {
      assert.match(err.message, /RPL transfers are not available on this network\./);
      assert.equal(err.definite, true);
      return true;
    },
  );
  assert.equal(env.core.calls.some(([m]) => m === 'prove_transfer'), false);
});

test('a send against a node on another chain is refused by the gate, before any proof', async () => {
  const state = { genesis: GENESIS, chainId: 13 };
  const env = await sendableWallet({ rest: { fetch: chainFetch(state, {
    rand_getAnchor: () => ({ height: 100, root: ROOT }),
    rand_getWitness: () => ({ index: 0, root: ROOT, path: Array.from({ length: 32 }, () => '00'.repeat(32)) }),
    rand_sendTransaction: () => TX_HASH,
    rand_getTransaction: () => ({ height: 101 }),
  }) } });
  state.genesis = 'cc'.repeat(32);
  state.chainId = 14;
  await env.backend.sync.scan(() => {});
  await assert.rejects(
    () => env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
    /different chain/,
  );
  assert.equal(env.core.calls.some(([m]) => m === 'prove_transfer'), false);
  assert.equal(env.fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'), false);
});

// ----------------------------------------- what a failure means, which is the dangerous part ---

test('a failure before the transaction leaves this device is definite', async () => {
  for (const [what, table] of Object.entries({
    'the prover refused': { core: { prove_transfer: () => { throw new Error('the prover ran out of memory'); } } },
    'the anchor was unreadable': { fetch: { rand_getAnchor: () => ({ height: 'soon', root: ROOT }) } },
    'the tree moved under the witness': { fetch: { rand_getWitness: () => ({ index: 0, root: 'ff'.repeat(32), path: Array.from({ length: 32 }, () => '00'.repeat(32)) }) } },
  })) {
    const env = await sendableWallet(table);
    await assert.rejects(
      () => env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
      (err) => { assert.equal(err.definite, true, `${what}: the UI was denied a retry it could safely offer`); return true; },
    );
    assert.equal(env.fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'), false, what);
  }
});

test('a node that ANSWERS and refuses the submit is definite; one that never answers is not', async () => {
  // The node replying `-32000 nonce too low` is proof the transfer did not happen.
  const refused = await sendableWallet({ fetch: { rand_sendTransaction: () => { throw new Error('bundle rejected: bad proof'); } } });
  await assert.rejects(
    () => refused.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
    (err) => { assert.equal(err.definite, true, 'a node that refused the bundle was treated as an unknown outcome'); return true; },
  );

  // A transport failure at the same moment is NOT: the transaction may be in a mempool, and
  // offering a retry would invite the user to pay twice.
  const env = await sendableWallet();
  const realFetch = env.fetch;
  let broke = false;
  const flaky = async (url, init) => {
    if (JSON.parse(init.body).method === 'rand_sendTransaction') { broke = true; throw new Error('connection reset'); }
    return realFetch(url, init);
  };
  flaky.requests = realFetch.requests;
  const unlucky = build({ core: env.core, storage: env.storage, fetch: flaky }).backend;
  await assert.rejects(
    () => unlucky.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
    (err) => {
      assert.notEqual(err.definite, true, 'a transfer whose fate is unknown was reported as "not sent"');
      return true;
    },
  );
  assert.equal(broke, true, 'the test never reached the submit at all');
});

test('a cancelled send is an AbortError, not a failed transfer', async () => {
  const env = await sendableWallet();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}, { signal: ac.signal }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      assert.notEqual(err.definite, true, 'a cancellation was dressed up as a definite failure');
      return true;
    },
  );
});

test('a real send leaks neither the spend key nor the transaction key', async () => {
  const env = await sendableWallet();
  const result = await env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});
  assert.equal(result.txKey, TX_KEY);
  assertKeyNeverLeaked(env);
  assertKeyNeverLeaked(env, SPEND_KEY);
  // The per-transaction key is a secret exactly like the spend key: it may reach the caller and
  // the note store, and nothing else — never the network, never the clipboard.
  const onTheWire = JSON.stringify([env.fetch.requests, env.platform.copied || []]);
  assert.equal(onTheWire.includes(TX_KEY), false, 'the transaction key reached the network or the clipboard');
});
