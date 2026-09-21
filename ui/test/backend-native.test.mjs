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
  PASSWORD, ADDRESS, GENESIS,
  mapStorage, stubCore, stubFetch, stubPlatform, chainFetch, assertKeyNeverLeaked,
  tokenRegistry, zusd, backing, assetRows, USDT_ETH, USDC_ETH, USDT_BSC,
} from './backend-fixtures.mjs';

const TX_HASH = `0x${'7a'.repeat(32)}`;
/** The payment's disclosure key — `tx_keys[payment_slot]`, NOT `tx_keys[0]`. */
const TX_KEY = 'e5'.repeat(32);
/** What sits in slot 0 of a chain-14 RAND transfer: a dummy sealed to a throwaway key. */
const DUMMY_KEY = 'd0'.repeat(32);
const PAYMENT_CM = '0d'.repeat(32);
const DUMMY_CM = 'd1'.repeat(32);
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
    prove_transfer: (p) => {
      // Chain 14's bundle is FOUR slots, and index 0 is never the payment: for a RAND transfer
      // (asset 0) the payment is slot 2 and slot 0 is a zero-value dummy sealed to a throwaway
      // wallet; for a token it is slot 0 and the dummy is elsewhere. The arrays below are
      // deliberately shaped so that reading index 0 gives a DIFFERENT value from the payment —
      // which is exactly the silently-wrong receipt `payment_tx_key` exists to prevent.
      const asset = Number(p.asset) || 0;
      const slot = asset === 0 ? 2 : 0;
      const keys = ['k0', 'k1', 'k2', 'k3'].map((s) => `${s}`.padEnd(2, '0').repeat(32).slice(0, 64));
      const cms = ['c0', 'c1', 'c2', 'c3'].map((s) => `${s}`.padEnd(2, '0').repeat(32).slice(0, 64));
      keys[slot] = TX_KEY;
      cms[slot] = PAYMENT_CM;
      keys[0] = slot === 0 ? TX_KEY : DUMMY_KEY;
      cms[0] = slot === 0 ? PAYMENT_CM : DUMMY_CM;
      return {
        tx_hex: 'ab'.repeat(200), hash: TX_HASH,
        asset, amount: String(p.amount), change: '0', fee_change: '0',
        fee: String(p.fee), time: 7, tier: 14,
        proof_bytes: 1_429_764, tx_bytes: 1_435_625,
        nullifiers: ['n0', 'n1', 'n2', 'n3'].map((s) => s.padEnd(2, '0').repeat(32).slice(0, 64)),
        commitments: cms,
        tx_keys: keys,
        payment_slot: slot,
        payment_tx_key: keys[slot],
        payment_commitment: cms[slot],
        spent_indices: [...(p.inputs || []), ...(p.fee_inputs || [])].map((i) => i.note.index),
        proofs: 1,
      };
    },
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
 * The refusal the shared idle-lock cases need. This shell CAN prove, so it cannot refuse
 * structurally — on chain 14 a token transfer is a real transaction, so the old "RPL transfers are
 * not available" refusal is gone. What is left, and is still definite and still costs no proof, is
 * a wallet with no notes at all: `plan_transfer` refuses the selection at the `'select'` phase,
 * before a witness is fetched or anything leaves this device. It reaches `executeSend`, which is
 * the point — it exercises more of this shell's own path than a `canProve()` refusal would.
 */
const refusedSend = (backend) => backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});

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
  assert.match(answer.reason, /5.7 GB/);
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

/**
 * The chain-14 receipt. `tx_keys` and `commitments` are FOUR wide and in **slot** order, and slot
 * 0 of a RAND transfer is a zero-value dummy sealed to a throwaway wallet that was dropped inside
 * `build_bundle` — it opens for nobody, the sender included. A wallet that kept reading index 0
 * would hand its recipient a key that discloses nothing, and would do it silently.
 */
test('the stored submission carries the PAYMENT’s key and commitment, not slot 0', async () => {
  const env = await sendableWallet();
  const result = await env.backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {});

  const [, proved] = env.core.calls.find(([m]) => m === 'prove_transfer');
  assert.equal(Number(proved.asset) || 0, 0);

  const sub = env.storage.local.get('notes').submissions.find((s) => s.hash === result.hash);
  assert.ok(sub, 'the send recorded no submission');
  assert.equal(sub.tx_key, TX_KEY, 'the receipt carries a dummy slot’s key and discloses nothing');
  assert.equal(sub.commitment, PAYMENT_CM);
  assert.notEqual(sub.tx_key, DUMMY_KEY);
  assert.notEqual(sub.commitment, DUMMY_CM);
  assert.equal(result.txKey, TX_KEY);
});

/**
 * Chain 14 admits a shielded→shielded transfer of a token: a plain `Action::None` hidden bundle
 * with the asset in slots 0–1 and the RAND fee in slots 2–3 of the SAME proof. "RPL = withdraw
 * only" is no longer true, and the refusal that said so is gone from this file.
 */
test('a TOKEN transfer reaches the prover with its asset, its fee group and the verified chain', async () => {
  const env = await sendableWallet();
  const notes = env.storage.local.get('notes');
  notes.notes = [NOTE, RPL_NOTE];
  env.storage.local.set('notes', notes);

  const phases = [];
  const result = await env.backend.send.send({ asset: 1, to: ADDRESS, amount: '100' }, (p) => phases.push(p));
  assert.equal(result.hash, TX_HASH);
  assert.deepEqual(phases, ['selecting', 'witness', 'proving', 'submitting', 'confirming']);

  const [, proved] = env.core.calls.find(([m]) => m === 'prove_transfer');
  assert.equal(proved.asset, 1);
  assert.equal(String(proved.chain_id), '13', 'the chain the gate verified');
  assert.equal(proved.inputs.length, 1, 'the token group');
  assert.equal(Number(proved.inputs[0].note.asset), 1);
  assert.equal(proved.fee_inputs.length, 1, 'and the RAND group that pays the fee');
  assert.equal(Number(proved.fee_inputs[0].note.asset), 0);
  // ONE anchor for both groups, and a witness path per input of each.
  assert.equal(proved.anchor_root, ROOT);
  assert.equal(proved.inputs[0].path.length, 32);
  assert.equal(proved.fee_inputs[0].path.length, 32);

  // The payment is slot 0 for a token, so this is the case index-0 reading would have got right
  // by accident. It still has to come from the scalar.
  const sub = env.storage.local.get('notes').submissions.find((s) => s.hash === result.hash);
  assert.equal(sub.tx_key, TX_KEY);
  assert.equal(sub.asset, 1);
});

test('a TOKEN transfer with no RAND is refused before a single witness is fetched', async () => {
  const env = await sendableWallet();
  const notes = env.storage.local.get('notes');
  notes.notes = [RPL_NOTE]; // the token, and no RAND at all
  env.storage.local.set('notes', notes);
  const before = env.fetch.requests.filter((r) => r.body.method === 'rand_getWitness').length;

  await assert.rejects(
    () => env.backend.send.send({ asset: 1, to: ADDRESS, amount: '100' }, () => {}),
    (err) => {
      assert.match(err.message, /holds no spendable RAND/);
      assert.equal(err.definite, true, 'a refusal before the wire is not a maybe');
      return true;
    },
  );
  assert.equal(env.core.calls.some(([m]) => m === 'prove_transfer'), false);
  assert.equal(
    env.fetch.requests.filter((r) => r.body.method === 'rand_getWitness').length, before,
    'a transfer that could never be built still fetched witnesses',
  );
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
  // The per-transaction key is a secret exactly like the spend key: it may reach the caller and
  // the note store, and nothing else — never the network, never the clipboard.
  const onTheWire = JSON.stringify([env.fetch.requests, env.platform.copied || []]);
  assert.equal(onTheWire.includes(TX_KEY), false, 'the transaction key reached the network or the clipboard');
});


// ------------------------------------------------- the bridge: ONE proof, and still expensive --
//
// `wallet-core` does no I/O, so it cannot know whether the bridge is enabled, whether the asset is
// in the registry, whether the named coin backs it, or whether that coin is holding enough — and
// the chain refuses a burn for any of them. Chain 14 made a burn ONE bundle and one proof (it was
// two), which halves the cost of getting it wrong and changes nothing about the principle: every
// refusal that can be known is made before `plan_burn`, let alone `prove_burn`. Each case below
// asserts the refusal AND that the core was never asked to plan or prove.

const BURN_TX = `0x${'b4'.repeat(32)}`;

/** A chain-14 bridge state whose registry is built from a token's own backings. */
function bridgeOn(token = zusd()) {
  return {
    enabled: true,
    emitter: 'ab'.repeat(32),
    emitters: { 2: 'aa'.repeat(20), 3: 'bb'.repeat(20) },
    guardian_set_index: 0,
    guardians: [],
    mint_paused: false,
    burn_sequence: 0,
    assets: assetRows(token),
  };
}

const RPL_NOTE = {
  index: 1, note: '11'.repeat(112), cm: '1b'.repeat(32), nf: '1c'.repeat(32),
  amount: '500', asset: 1, time: 7, from: '00'.repeat(32), height: 7, spent: false, pending: null,
};

/** A core that can plan and prove a burn, recording what it was asked. */
function burningCore(overrides = {}) {
  return provingCore({
    plan_burn: (p) => ({
      inputs: (p.notes || []).filter((n) => Number(n.asset) === Number(p.asset)),
      fee_inputs: (p.notes || []).filter((n) => Number(n.asset) === 0),
      need: String(p.amount),
      change: '100', fee_change: '4990000000', fee: String(p.fee ?? '10000000'), proofs: 1,
    }),
    prove_burn: (p) => ({
      tx_hex: 'cd'.repeat(200), hash: BURN_TX, time: 7, asset: p.asset, amount: String(p.amount),
      relayer_fee: String(p.relayer_fee), to_chain: p.to_chain,
      token: String(p.token).toLowerCase(), to: String(p.to).toLowerCase(),
      change: '100', fee: String(p.fee), fee_change: '4990000000', tier: 14,
      proof_bytes: 1_425_958, tx_bytes: 1_431_905,
      nullifiers: ['a', 'b', 'c', 'd'], commitments: ['e', 'f', 'g', 'h'], tx_keys: ['i', 'j', 'k', 'l'],
      // A burn pays nobody inside the pool, so it has no payment note to disclose — present, and
      // always null, so a client reads ONE receipt shape off a transfer and a burn alike.
      payment_slot: null, payment_tx_key: null, payment_commitment: null,
      spent_indices: [1, 0], proofs: 1,
    }),
    ...overrides,
  });
}

async function burnableWallet(bridgeState, coreOverrides = {}) {
  const env = build({
    core: burningCore(coreOverrides),
    fetch: sendableFetch({
      rand_getBridgeState: () => bridgeState,
      rand_getTokens: () => tokenRegistry(),
      rand_sendTransaction: () => BURN_TX,
      // An enabled bridge makes a scan walk blocks looking for attestations; this node has none.
      rand_getBlockByHeight: () => ({ timestamp_ms: 1_700_000_000_000, transactions: [], actions: [] }),
    }),
  });
  await env.backend.wallet.create(PASSWORD);
  await env.backend.sync.scan(() => {});
  const notes = env.storage.local.get('notes');
  notes.notes = [NOTE, RPL_NOTE];
  env.storage.local.set('notes', notes);
  return env;
}

const plannedOrProved = (core) => core.calls.filter(([m]) => m === 'plan_burn' || m === 'prove_burn');

/** The whole request, as the withdraw flow builds it: a chosen BACKING, not just a chain. */
const burnReq = (over = {}) => ({
  asset: 1, amount: '400', relayerFee: '100', toChain: 2, token: USDT_ETH,
  to: '0'.repeat(24) + '11'.repeat(20), ...over,
});

test('BRIDGE: a disabled bridge refuses a withdrawal before anything is planned or proved', async () => {
  const env = await burnableWallet({ enabled: false });
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq(), () => {}),
    (err) => {
      assert.match(err.message, /no bridge/i);
      assert.equal(err.definite, true, 'a chain with no bridge is not a maybe');
      return true;
    },
  );
  assert.deepEqual(plannedOrProved(env.core), [], 'a proof was nearly spent on a chain with no bridge');
  assert.equal(env.fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'), false);
});

test('BRIDGE: an asset the registry does not list refuses the same way, and names what is listed', async () => {
  const env = await burnableWallet(bridgeOn({ ...zusd(), index: 4 }));
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq(), () => {}),
    (err) => {
      assert.match(err.message, /not in this chain's registry/);
      assert.match(err.message, /registered: 4/);
      assert.equal(err.definite, true);
      return true;
    },
  );
  assert.deepEqual(plannedOrProved(env.core), []);
});

/**
 * The zUSD case, and the reason `bridge.withdraw` takes a `token` at all. One token, several
 * coins: a burn names the coin it redeems, and a coin that does not back this asset — or is not
 * holding enough — is `NotABacking` / `InsufficientBacking`, learned after a proof unless it is
 * learned here.
 */
test('BRIDGE: a coin that does not back this asset is refused, and the real backings are named', async () => {
  const env = await burnableWallet(bridgeOn());
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq({ token: 'ff'.repeat(32) }), () => {}),
    (err) => {
      assert.match(err.message, /does not back asset 1/);
      assert.match(err.message, new RegExp(USDT_ETH), 'the user is not told which coins WOULD work');
      assert.equal(err.definite, true);
      return true;
    },
  );
  assert.deepEqual(plannedOrProved(env.core), []);
});

test('BRIDGE: more than one coin is holding is refused before the proof', async () => {
  // USDC on chain 2 backs zUSD, but has nothing locked in it: the token's supply is elsewhere.
  const env = await burnableWallet(bridgeOn());
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq({ token: USDC_ETH }), () => {}),
    (err) => {
      assert.match(err.message, /^Only 0 is locked in that coin on chain 2/, 'the chain-s own sentence, dressed for a banner');
      assert.equal(err.definite, true);
      return true;
    },
  );
  assert.deepEqual(plannedOrProved(env.core), []);
});

test('BRIDGE: an amount that is not a whole release unit is refused before the proof', async () => {
  // USDT on Ethereum has six decimals against Rand's eight, so the smallest thing the bridge can
  // release is 100 Rand units — `ledger::tokens::release_unit(6)`. A burn of 401 would round on
  // the way out, and the ledger refuses it (`NotReleasable`) rather than losing the remainder.
  const env = await burnableWallet(bridgeOn());
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq({ amount: '401', relayerFee: '0' }), () => {}),
    (err) => {
      assert.match(err.message, /must be multiples of 100/);
      return true;
    },
  );
  // …and the relayer fee is held to the same rule.
  await assert.rejects(
    () => env.backend.bridge.withdraw(burnReq({ amount: '400', relayerFee: '1' }), () => {}),
    /must be multiples of 100/,
  );
  // A coin with MORE decimals than Rand's eight releases whole units, so nothing is refused there
  // — `release_unit` is 1 above eight decimals, not `10^(8-18)`.
  await env.backend.bridge.estimate(burnReq({ toChain: 3, token: USDT_BSC, amount: '401', relayerFee: '1' }));
  assert.deepEqual(env.core.calls.filter(([m]) => m === 'prove_burn'), []);
});

test('BRIDGE: RAND is refused before the node is asked for anything at all', async () => {
  const env = await burnableWallet(bridgeOn());
  await assert.rejects(() => env.backend.bridge.withdraw(burnReq({ asset: 0 }), () => {}), /not a bridged asset/);
  assert.deepEqual(plannedOrProved(env.core), []);
});

test('BRIDGE: estimate is the core’s own plan, and reports ONE proof from the plan', async () => {
  const env = await burnableWallet(bridgeOn());
  const est = await env.backend.bridge.estimate(burnReq());
  assert.equal(est.fee, '10000000', 'gas::BRIDGE_BURN_FEE, from the core’s constants');
  assert.equal(est.receive, '300', 'the relayer fee comes out of the amount, on the other chain');
  assert.equal(est.relayerFee, '100');
  assert.equal(est.proofs, 1, 'chain 14 made a burn one bundle and one proof');
});

/**
 * The gates `estimate` applies and the gates `withdraw` applies are ONE list, in one helper.
 * They used to be two, and `withdraw`'s was the shorter: a zero amount and a relayer fee larger
 * than the amount were refused when the user pressed Review and NOT when they pressed Withdraw,
 * so a flow that reached the button another way paid for a proof the chain always refuses.
 */
test('BRIDGE: estimate and withdraw refuse exactly the same things, before the core is asked', async () => {
  const env = await burnableWallet(bridgeOn());
  for (const [what, over, pattern] of [
    ['a zero amount', { amount: '0' }, /zero/i],
    ['a relayer fee larger than the amount', { relayerFee: '401' }, /relayer fee/i],
    ['RAND', { asset: 0 }, /not a bridged asset/],
    ['a coin that backs nothing', { token: 'ff'.repeat(32) }, /does not back asset 1/],
  ]) {
    const before = env.core.calls.length;
    await assert.rejects(() => env.backend.bridge.estimate(burnReq(over)), pattern, `estimate: ${what}`);
    await assert.rejects(() => env.backend.bridge.withdraw(burnReq(over), () => {}), pattern, `withdraw: ${what}`);
    assert.deepEqual(
      env.core.calls.slice(before).filter(([m]) => m === 'plan_burn' || m === 'prove_burn'), [],
      `${what}: the core was asked to plan or prove something that could never work`,
    );
  }
});

test('BRIDGE: a real withdrawal proves against the VERIFIED chain, names its coin, and is ONE proof', async () => {
  const env = await burnableWallet(bridgeOn());
  const phases = [];
  const req = burnReq();
  const result = await env.backend.bridge.withdraw(req, (p) => phases.push(p));
  assert.equal(result.hash, BURN_TX);
  assert.equal(result.txKey, undefined, 'a burn addresses no note to anybody, so there is no key');
  // One bundle, one proof, so one proving phase. `'proving-asset'` named the first of two and has
  // left the vocabulary entirely.
  assert.deepEqual(phases, ['selecting', 'witness', 'proving', 'submitting', 'confirming']);
  assert.equal(phases.includes('proving-asset'), false);

  const [, proved] = env.core.calls.find(([m]) => m === 'prove_burn');
  assert.equal(proved.chain_id, 13, 'the chain that was checked, not the one in settings');
  assert.equal(proved.asset, 1);
  assert.equal(proved.token, USDT_ETH, 'the coin being redeemed never reached the proof');
  assert.equal(proved.to, req.to, 'the recipient’s bytes are carried through untouched');
  assert.equal(proved.fee, '10000000');
  assert.equal(proved.inputs.length, 1, 'the token group');
  assert.equal(proved.fee_inputs.length, 1, 'and the RAND group that pays the fee');
  assert.equal(Number(proved.inputs[0].note.asset), 1);
  assert.equal(Number(proved.fee_inputs[0].note.asset), 0);
  // ONE anchor for the whole bundle, and a witness path per input of each group.
  assert.equal(proved.anchor_root, ROOT);
  assert.equal(proved.inputs[0].path.length, 32);
  assert.equal(proved.fee_inputs[0].path.length, 32);

  // A burn's `payment_*` are all null; the submission must not invent a disclosure key from a
  // dummy slot's.
  const sub = env.storage.local.get('notes').submissions.find((s) => s.hash === BURN_TX);
  assert.ok(sub);
  assert.equal(sub.token, USDT_ETH);
  assert.equal(sub.tx_key, undefined, 'a burn discloses nothing, so it stores no key');

  assertKeyNeverLeaked(env);
});

/** Both groups' witnesses come from ONE anchor, fetched once. Two anchors is two trees. */
test('BRIDGE: both groups’ witnesses come from a single anchor fetch', async () => {
  const env = await burnableWallet(bridgeOn());
  const before = env.fetch.requests.filter((r) => r.body.method === 'rand_getAnchor').length;
  await env.backend.bridge.withdraw(burnReq(), () => {});
  const anchors = env.fetch.requests.filter((r) => r.body.method === 'rand_getAnchor').length - before;
  assert.equal(anchors, 1, `the burn fetched ${anchors} anchors; both groups must be folded against one root`);
});

// ---------------------------------------- what "the node never answered" is decided by ---------

/**
 * `classify` routes on `err.failure`, never on `err.code === -1`.
 *
 * `-1` is the code `engine/rpc.js` puts on a transport failure, but it is also a perfectly legal
 * application-defined JSON-RPC error code — the reserved range is −32768..−32000 — and a node is
 * entitled to answer `{"error":{"code":-1,…}}`. Read as "no answer came back", that refusal would
 * be reported to the user as an UNKNOWN outcome: the UI would refuse the retry it could safely
 * offer and send them to Activity to look for a transaction that was never accepted.
 */
test('a node that refuses the submit with its OWN code -1 is still a definite failure', async () => {
  const env = await sendableWallet();
  const realFetch = env.fetch;
  let answered = false;
  const picky = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'rand_sendTransaction') {
      answered = true;
      realFetch.requests.push({ url, body, raw: init.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'bundle rejected: bad proof' } }),
      };
    }
    return realFetch(url, init);
  };
  picky.requests = realFetch.requests;
  const backend = build({ core: env.core, storage: env.storage, fetch: picky }).backend;

  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1000000000' }, () => {}),
    (err) => {
      assert.equal(err.definite, true, 'the node ANSWERED and refused, and was read as "we never heard back"');
      return true;
    },
  );
  assert.equal(answered, true, 'the test never reached the submit at all');
});
