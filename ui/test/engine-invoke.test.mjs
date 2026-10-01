// RPL-2 `invoke` in the engine: what is refused before any proof, what the fee is priced on, and the
// order of the reads — the anchor last. Driven directly against stub nodes and a stub core, as
// engine-wallet.test.mjs drives `send`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWallet, emptyNoteStore } from '../engine/wallet.js';
import { normalizeInvokeRequest, invokeEffects, createdCells, vaultShortfall, isStaleRead, ZERO_WORD8 } from '../engine/invoke.js';

const HEX64 = (b) => String(b).repeat(32);
const SPEND_KEY = 'a1'.repeat(32);
const GENESIS = 'aa'.repeat(32);
const PROGRAM = 'db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda';
const K1 = HEX64('01');
const K2 = HEX64('02');
const V7 = `${'07'.padEnd(8, '0')}${'0'.repeat(56)}`;

function memoryStore(initial = emptyNoteStore()) {
  let current = JSON.parse(JSON.stringify(initial));
  return {
    get current() { return current; },
    async getNoteStore() { return JSON.parse(JSON.stringify(current)); },
    async setNoteStore(s) { current = JSON.parse(JSON.stringify(s)); },
  };
}

const RAND_NOTE = {
  index: 0, note: '00'.repeat(112), cm: HEX64('0b'), nf: HEX64('0c'),
  amount: '50000000000', asset: 0, time: 4, from: '00'.repeat(32), height: 4, spent: false, pending: null,
};

/** A swap of 1 RAND into the pool for 100 DUR (asset 1) back: the AMM's shape. */
function swapRequest(over = {}) {
  return normalizeInvokeRequest({
    program: PROGRAM,
    inputs: [1, 0, 0],
    reads: [{ key: K1, value: V7 }],
    writes: [{ key: K1, value: HEX64('09') }, { key: K2, value: HEX64('03') }],
    inflow: { rand: '1000000000', asset: 0, amount: '0', kind: 'none' },
    pays: [{ asset: 1, amount: '100' }],
    mints: [],
    summary: { title: 'Swap 1 RAND for 100 DUR', spend: [], receive: [] },
    ...over,
  });
}

const DRY = { tier: 12, gas: 3000, gas_limit: 4096, gas_max: 1 << 20, keccak_log_height: 0, sha256_log_height: 0, context_words: 70 };
const PROVED = {
  tx_hex: 'ab', hash: HEX64('dd'), time: 20, program: PROGRAM, asset: 0, burn_r: '1000000000', burn_asset: 0, burn_a: '0',
  change: '48999000000', fee: '1000000', fee_change: '0', tier: 14, proof_bytes: 1, spent_indices: [0],
  payouts: [{ asset: 1, amount: '100' }],
};

function stubCore(calls, overrides = {}) {
  const impl = {
    scan_page: ({ rows }) => ({ received: [], sent: [], next_index: rows.length ? rows[rows.length - 1].index + 1 : 0 }),
    pending_cleared: () => false,
    rebuilt_deposit: () => null,
    dry_run_invoke: () => DRY,
    plan_invoke: ({ notes, fee }) => ({ inputs: notes.slice(0, 1), fee_inputs: [], fee, change: '0', proofs: 1 }),
    prove_invoke: () => PROVED,
    ...overrides,
  };
  return { async call(method, params = {}) { calls.push([method, params]); const fn = impl[method]; if (!fn) throw new Error(`unknown ${method}`); return fn(params); } };
}

function stubClient(calls, table = {}) {
  const cells = { [K1]: V7, [K2]: ZERO_WORD8 };
  const impl = {
    head: () => ({ height: 20, hash: HEX64('ab') }),
    treeInfo: () => ({ next_index: 1, root: HEX64('00'), nullifiers: 0 }),
    commitments: () => [],
    nullifiers: () => [],
    bridgeState: () => ({ enabled: false }),
    chainId: () => 1919,
    getTransaction: () => null,
    getLimits: () => ({
      envelope_bytes: null, max_proof_bytes: 4194304, bundle_gas_limit: 20479,
      program_state: { cell_fee: '10000000', max_reads: 8, max_writes: 8, max_payouts: 4 },
    }),
    status: () => ({ hc_bundle: HEX64('60'), hc_auth: HEX64('1e'), fri_profile: 'production' }),
    getProgramCode: () => ({ base_pc: 0, words: [19, 115] }),
    getProgramPublic: () => '',
    getProgramCell: (id, key) => ({ key, value: cells[key] ?? ZERO_WORD8 }),
    getProgramVault: () => [{ asset: 0, amount: '10000000000000' }, { asset: 1, amount: '1000000' }],
    estimateFee: () => '1000000',
    anchor: () => ({ height: 20, root: HEX64('ab') }),
    witness: (i) => ({ index: i, root: HEX64('ab'), path: Array.from({ length: 32 }, () => HEX64('00')) }),
    sendTransaction: () => HEX64('dd'),
    ...table,
  };
  const client = {};
  for (const name of Object.keys(impl)) {
    client[name] = async (...args) => { calls.push([name, ...args]); return impl[name](...args); };
  }
  client.rpc = async (method) => {
    calls.push(['rpc', method]);
    if (method === 'rand_getGenesisHash') return GENESIS;
    throw new Error(`stub node has no ${method}`);
  };
  return client;
}

function walletWith({ core = {}, node = {} } = {}) {
  const coreCalls = [];
  const nodeCalls = [];
  const store = memoryStore({ ...emptyNoteStore(), notes: [RAND_NOTE], chain_id: 1919, genesis: GENESIS, scanned_index: 1 });
  const client = stubClient(nodeCalls, node);
  const wallet = makeWallet({ core: stubCore(coreCalls, core), store, rpc: () => client, settings: async () => ({}), annotate: false });
  return { wallet, client, store, coreCalls, nodeCalls, identity: { chainId: 1919, genesis: GENESIS } };
}

const names = (calls) => calls.map((c) => c[0]);

test('the request is held to its shape, and the wallet reads its own summary from it', () => {
  const req = swapRequest();
  assert.equal(req.program, PROGRAM);
  assert.equal(req.title, 'Swap 1 RAND for 100 DUR');
  assert.deepEqual(invokeEffects(req, '1000000'), {
    spend: [{ asset: 0, amount: '1000000000' }], fee: '1000000', receive: [{ asset: 1, amount: '100' }],
  });
  const deposit = swapRequest({ inflow: { rand: '0', asset: 1, amount: '500', kind: 'deposit' }, pays: [{ asset: 0, amount: '7' }, { asset: 0, amount: '3' }] });
  assert.deepEqual(invokeEffects(deposit).spend, [{ asset: 1, amount: '500' }], 'a zero RAND row is not shown');
  assert.deepEqual(invokeEffects(deposit).receive, [{ asset: 0, amount: '10' }], 'payouts of one asset are summed');
  for (const [what, bad] of [
    ['program', { program: 'xyz' }],
    ['inputs', { inputs: [1.5] }],
    ['inputs', { inputs: [2 ** 32] }],
    ['reads', { reads: [{ key: 'ab', value: V7 }] }],
    ['inflow', { inflow: { rand: '-1', asset: 0, amount: '0', kind: 'none' } }],
    ['inflow', { inflow: { rand: '0', asset: 0, amount: '0', kind: 'steal' } }],
    ['pays', { pays: [{ asset: 1, amount: '1e9' }] }],
    ['pays', { pays: Array.from({ length: 17 }, () => ({ asset: 1, amount: '1' })) }],
  ]) {
    assert.throws(() => swapRequest(bad), (err) => err.code === 'BAD_REQUEST' && err.definite === true, `${what}: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeInvokeRequest(null), (err) => err.code === 'BAD_REQUEST');
  const shouty = swapRequest({ summary: { title: `‮evil\u0007 ${'x'.repeat(300)}` } });
  assert.ok(!/[‮\u0007]/.test(shouty.title), 'control and bidi characters are stripped');
  assert.ok(shouty.title.length <= 120);
});

test('created cells: a non-zero write where the chain holds zeros, and nothing else', async () => {
  const req = swapRequest({ writes: [{ key: K1, value: HEX64('09') }, { key: K2, value: HEX64('03') }, { key: HEX64('04'), value: ZERO_WORD8 }] });
  const asked = [];
  const n = await createdCells(req, async (key) => { asked.push(key); return ZERO_WORD8; });
  assert.equal(n, 1, 'K1 was read non-zero, K2 is new, a zero write creates nothing');
  assert.deepEqual(asked, [K2], 'a key the reads already answered is not asked again');
});

test('the vault check counts what the same transition deposits', () => {
  const req = swapRequest({ inflow: { rand: '0', asset: 1, amount: '50', kind: 'deposit' }, pays: [{ asset: 1, amount: '60' }] });
  assert.deepEqual(vaultShortfall(req, [{ asset: 1, amount: '9' }]), { asset: 1, have: '59', want: '60' });
  assert.equal(vaultShortfall(req, [{ asset: 1, amount: '10' }]), null);
  assert.equal(isStaleRead(new Error('transaction rejected: StaleRead { key: … }')), true);
  assert.equal(isStaleRead(new Error('Spent')), false);
});

test('a chain without program_state is refused before the program is even asked for', async () => {
  const t = walletWith({ node: { getLimits: () => ({ program_state: null }) } });
  await assert.rejects(
    () => t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity }),
    (err) => err.code === 'PROGRAMS_UNSUPPORTED' && err.definite === true,
  );
  assert.ok(!names(t.nodeCalls).includes('getProgramCode'));
  assert.deepEqual(names(t.coreCalls), [], 'the core did nothing');
});

test('a stale read is STALE_READ, before the dry run and long before a proof', async () => {
  const t = walletWith({ node: { getProgramCell: (id, key) => ({ key, value: HEX64('08') }) } });
  await assert.rejects(
    () => t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity }),
    (err) => err.code === 'STALE_READ' && err.definite === true,
  );
  assert.ok(!names(t.coreCalls).includes('dry_run_invoke'));
  assert.ok(!names(t.nodeCalls).includes('anchor'));
});

test('a node serving other code, or a transition the program refuses, is PROGRAM_REFUSED', async () => {
  const t = walletWith({ core: { dry_run_invoke: () => { throw new Error('the node served code (2 words) … that do not hash to program'); } } });
  await assert.rejects(
    () => t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity }),
    (err) => err.code === 'PROGRAM_REFUSED' && /do not hash/.test(err.message),
  );
  assert.ok(!names(t.coreCalls).includes('prove_invoke'));
});

test('a pool that cannot pay out is VAULT_SHORT; a wallet that cannot pay in is INSUFFICIENT_FUNDS', async () => {
  const short = walletWith({ node: { getProgramVault: () => [{ asset: 1, amount: '99' }] } });
  await assert.rejects(
    () => short.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: short.client, identity: short.identity }),
    (err) => err.code === 'VAULT_SHORT',
  );
  const poor = walletWith({ core: { plan_invoke: () => { throw new Error('no spendable RAND for the fee'); } } });
  await assert.rejects(
    () => poor.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: poor.client, identity: poor.identity }),
    (err) => err.code === 'INSUFFICIENT_FUNDS' && /no spendable RAND/.test(err.message),
  );
});

test('the fee is priced at the dry run’s tier and gas, the chain’s proof cap and the cells created', async () => {
  const t = walletWith();
  await t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity });
  const fee = t.nodeCalls.find((c) => c[0] === 'estimateFee');
  assert.deepEqual(fee[1], {
    kind: 'invoke', tier: 12, keccak_log_height: 0, sha256_log_height: 0, created_cells: 1, gas: 4096, bytes: 4194304,
  });
  const plan = t.coreCalls.find((c) => c[0] === 'plan_invoke')[1];
  assert.equal(plan.burn_r, '1000000000');
  assert.equal(plan.burn_asset, 0);
  assert.equal(plan.burn_a, '0');
  assert.equal(plan.fee, '1000000');
});

test('without a gas section the fee spec carries no gas and no bytes', async () => {
  const t = walletWith({ node: { getLimits: () => ({ program_state: { cell_fee: '1', max_reads: 8, max_writes: 8, max_payouts: 4 } }) } });
  await t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity });
  const spec = t.nodeCalls.find((c) => c[0] === 'estimateFee')[1];
  assert.equal('gas' in spec, false);
  assert.equal('bytes' in spec, false);
  const proved = t.coreCalls.find((c) => c[0] === 'prove_invoke')[1];
  assert.equal(proved.gas_limit, null, 'no gas section: the call declares the header ceiling');
});

test('the anchor is read after every other question, and the proof gets the whole transition', async () => {
  const t = walletWith();
  const phases = [];
  const sub = await t.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: t.client, identity: t.identity, onPhase: (p) => phases.push(p) });
  const order = names(t.nodeCalls);
  const anchorAt = order.indexOf('anchor');
  for (const before of ['getLimits', 'getProgramCode', 'getProgramCell', 'estimateFee', 'getProgramVault', 'status']) {
    assert.ok(order.lastIndexOf(before) < anchorAt, `${before} came after the anchor: ${order.join(',')}`);
  }
  const proved = t.coreCalls.find((c) => c[0] === 'prove_invoke')[1];
  assert.equal(proved.chain_id, 1919);
  assert.equal(proved.program, PROGRAM);
  assert.deepEqual(proved.program_code, { base_pc: 0, words: [19, 115] });
  assert.equal(proved.public_hex, '');
  assert.deepEqual(proved.private_inputs, [1, 0, 0]);
  assert.equal(proved.tier, 12);
  assert.equal(proved.gas_limit, 4096);
  assert.equal(proved.fee, '1000000');
  assert.equal(proved.bundle_gas_limit, 20479);
  assert.equal(proved.max_proof_bytes, 4194304);
  assert.equal(proved.hc_bundle, HEX64('60'));
  assert.equal(proved.hc_auth, HEX64('1e'));
  assert.equal(proved.inputs.length, 1);
  assert.equal(proved.inputs[0].path.length, 32);
  assert.deepEqual(phases, ['select', 'witness', 'prove', 'submit']);
  assert.equal(sub.kind, 'invoke');
  assert.equal(sub.program, PROGRAM);
  assert.deepEqual(sub.payouts, [{ asset: 1, amount: '100' }]);
  assert.equal(t.store.current.submissions[0].hash, HEX64('dd'));
  assert.equal(t.store.current.notes[0].pending, 20, 'the spent note is held back until the scan sees it go');
});

test('with a paired prover the hook is asked for an invoke, and the device does not prove', async () => {
  const t = walletWith();
  const jobs = [];
  await t.wallet.invoke(SPEND_KEY, {
    request: swapRequest(), wait: false, client: t.client, identity: t.identity,
    prove: async (job) => { jobs.push(job); return PROVED; },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'invoke');
  assert.equal(jobs[0].hcAuth, HEX64('1e'));
  assert.equal(jobs[0].maxProofBytes, 4194304);
  assert.ok(!names(t.coreCalls).includes('prove_invoke'));
});

test('a StaleRead refusal at submit is STALE_READ; any other refusal is passed through', async () => {
  const stale = walletWith({ node: { sendTransaction: () => { throw new Error('transaction rejected: StaleRead'); } } });
  await assert.rejects(
    () => stale.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: stale.client, identity: stale.identity }),
    (err) => err.code === 'STALE_READ',
  );
  assert.equal(stale.store.current.submissions.length, 0, 'nothing recorded for a refused transaction');
  const other = walletWith({ node: { sendTransaction: () => { throw new Error('Spent'); } } });
  await assert.rejects(
    () => other.wallet.invoke(SPEND_KEY, { request: swapRequest(), wait: false, client: other.client, identity: other.identity }),
    (err) => err.message === 'Spent' && err.code === undefined,
  );
});
