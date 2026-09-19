// The real Backend: ui/engine/backend-wasm.js, driven by a stub core, a Map-backed storage and a
// stub fetch that answers JSON-RPC. Nothing here touches a browser, IndexedDB or a node.
//
// The one rule this file exists to pin down: the plaintext spend key may exist in exactly two
// places — the value the core handed back, and `storage.session`. Every stub records every
// argument it is ever given, and `assertKeyNeverLeaked` scans all of them for the key string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBackend } from '../backend.js';
import { makeWasmBackend, unlockDelayMs } from '../engine/backend-wasm.js';

const SPEND_KEY = 'a1'.repeat(32);
const VIEWING_KEY = 'b2'.repeat(32);
const PK = 'c3'.repeat(32);
const ADDRESS = 'rand1' + 'q'.repeat(60);
const PASSWORD = 'correct-horse-battery-staple';

// ------------------------------------------------------------------------------- stub storage --
/** The `storage` contract makeWasmBackend takes, over two Maps. `session` is memory-only. */
function mapStorage() {
  const local = new Map();
  const sessionMap = new Map();
  const writes = []; // every [key, value] ever written to the PERSISTENT half
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    local,
    sessionMap,
    writes,
    async get(key) { return clone(local.get(key)); },
    async set(key, value) { writes.push([key, value]); local.set(key, clone(value)); },
    async remove(key) { local.delete(key); },
    async clear() { local.clear(); sessionMap.clear(); },
    session: {
      async get(key) { return sessionMap.get(key); },
      async set(key, value) { sessionMap.set(key, value); },
      async remove(key) { sessionMap.delete(key); },
    },
  };
}

/**
 * Drains the microtask queue. Every assertion that follows a `t.mock.timers.tick()` needs this,
 * and so does every assertion *before* one: with `setTimeout` mocked, a `sleep()` deep inside an
 * async chain has not been scheduled yet when the chain's first `await` returns, so ticking before
 * the chain reaches it would advance a clock nothing is waiting on.
 */
async function drain(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------------- stub core --
function stubCore(overrides = {}) {
  const calls = [];
  const info = { spend_key: SPEND_KEY, viewing_key: VIEWING_KEY, pk: PK, address: ADDRESS, key_file: '{"version":2}' };
  const defaults = {
    version: () => ({
      version: '0.1.0', default_chain_id: 13, default_rpc_url: 'https://rpc.randprotocol.org',
      explorer_url: 'https://randscan.org', address_hrp: 'rand1', token_symbol: 'RAND',
      token_decimals: 9, units_per_rand: '1000000000', bundle_base_fee: '1000000',
      prover_peak_memory_bytes: 5600000000,
    }),
    keygen: () => ({ ...info }),
    wallet_info: () => ({ ...info }),
    import_key: () => ({ ...info }),
    parse_address: ({ address }) => (String(address).startsWith('rand1')
      ? { valid: true, pk: PK, error: null }
      : { valid: false, pk: null, error: 'not a shielded address' }),
    scan_page: ({ rows }) => ({ received: [], sent: [], next_index: rows.length ? rows[rows.length - 1].index + 1 : 0, rows: rows.length }),
    pending_cleared: () => false,
    select_inputs: ({ notes, need }) => {
      const spendable = notes.filter((n) => !n.spent && n.pending == null && BigInt(n.amount) > 0n);
      spendable.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      let sum = 0n;
      const chosen = [];
      for (const n of spendable.slice(0, 2)) {
        if (sum >= BigInt(need)) break;
        sum += BigInt(n.amount);
        chosen.push(n);
      }
      if (sum < BigInt(need)) throw new Error('insufficient balance');
      return { chosen, need: String(need), change: (sum - BigInt(need)).toString() };
    },
    prove_transfer: () => { throw new Error('prove_transfer must never run in wasm'); },
    format_amount: ({ units }) => String(units),
  };
  const impl = { ...defaults, ...overrides };
  return {
    calls,
    async call(method, params = {}) {
      calls.push([method, params]);
      const fn = impl[method];
      if (!fn) throw new Error(`unknown method ${method}`);
      return fn(params);
    },
  };
}

// --------------------------------------------------------------------------------- stub fetch --
/** A JSON-RPC endpoint over a table of `method -> (params) => result`. Records every request. */
function stubFetch(table = {}) {
  const requests = [];
  const defaults = {
    rand_getHead: () => ({ height: 100, hash: 'ff'.repeat(32), view: 120 }),
    rand_getTreeInfo: () => ({ next_index: 2, root: '0'.repeat(64), nullifiers: 0 }),
    rand_getCommitments: () => [],
    rand_getNullifiers: () => [],
    rand_getBridgeState: () => ({ enabled: false }),
    rand_getAssets: () => [],
    rand_estimateFee: () => '1000000',
    rand_status: () => ({ height: 100, peer_count: 3, syncing: false }),
    rand_chainId: () => 13,
  };
  const impl = { ...defaults, ...table };
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, raw: init.body });
    const handler = impl[body.method];
    if (!handler) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } }) };
    }
    let result;
    try { result = handler(body.params); } catch (err) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: err.message } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  fn.requests = requests;
  return fn;
}

function stubPlatform() {
  const copied = [];
  return { name: 'test', copied, openExternal() {}, copy(text) { copied.push(text); } };
}

function build(opts = {}) {
  const core = opts.core || stubCore();
  const storage = opts.storage || mapStorage();
  const platform = opts.platform || stubPlatform();
  const fetch = opts.fetch || stubFetch();
  const backend = makeWasmBackend({ core, storage, platform, fetch, ...(opts.extra || {}) });
  return { backend, core, storage, platform, fetch };
}

/** Everything any stub was ever handed, flattened to one searchable string. */
function everythingRecorded({ core, storage, fetch, platform }) {
  return JSON.stringify([
    core.calls.map(([m, p]) => [m, p]),
    storage.writes,
    [...storage.local.entries()],
    fetch.requests,
    platform.copied || [],
  ]);
}

function assertKeyNeverLeaked(env, key = SPEND_KEY) {
  const haystack = everythingRecorded(env);
  // The core is the one place the key legitimately goes (wallet_info/scan_page/select_inputs take
  // it as a parameter); everything else must never have seen it.
  const withoutCore = JSON.stringify([
    env.storage.writes,
    [...env.storage.local.entries()],
    env.fetch.requests,
    env.platform.copied || [],
  ]);
  assert.ok(haystack.length > 0);
  assert.ok(!withoutCore.includes(key), 'the plaintext spend key reached storage, the network or the clipboard');
}

// ------------------------------------------------------------------------------------- tests ---

test('the wasm backend satisfies the Backend contract', () => {
  const { backend } = build();
  assertBackend(backend);
});

test('create stores a vault and keeps the plaintext key only in session', async () => {
  const env = build();
  const { backend, storage } = env;
  assert.equal(await backend.wallet.exists(), false);
  const created = await backend.wallet.create(PASSWORD);
  assert.equal(created.address, ADDRESS);
  assert.equal(await backend.wallet.exists(), true);
  assert.equal(await backend.wallet.isUnlocked(), true);

  const vault = storage.local.get('vault');
  assert.equal(vault.kdf, 'pbkdf2-sha256');
  assert.equal(vault.iter, 600000);
  assert.ok(vault.ct && vault.iv && vault.salt);
  assert.equal(JSON.stringify(vault).includes(SPEND_KEY), false);

  // The plaintext lives in session, and only there.
  assert.equal((await storage.session.get('unlocked')).spend_key, SPEND_KEY);
  assertKeyNeverLeaked(env);

  // …and the public facts a screen reads are persisted.
  assert.deepEqual(await backend.wallet.info(), { address: ADDRESS, pk: PK });
});

test('create refuses a short password and refuses to overwrite an existing wallet', async () => {
  const { backend } = build();
  await assert.rejects(() => backend.wallet.create('short'), /at least 10/);
  await backend.wallet.create(PASSWORD);
  await assert.rejects(() => backend.wallet.create(PASSWORD), /already exists/);
});

test('unlock rejects a wrong password with a constant message, and the delay grows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();

  // The first two failures are not delayed at all.
  await assert.rejects(() => backend.wallet.unlock('nope-nope-nope'), /^Error: wrong password$/);
  await assert.rejects(() => backend.wallet.unlock('nope-nope-nope'), /^Error: wrong password$/);
  assert.equal(storage.local.get('unlockFailures').count, 2);

  // The third waits: the promise must not settle until the clock moves.
  let settled = false;
  const third = backend.wallet.unlock('nope-nope-nope').then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await drain();
  assert.equal(settled, false, 'the third attempt did not wait at all');
  t.mock.timers.tick(unlockDelayMs(2) - 1);
  await drain();
  assert.equal(settled, false, 'the third attempt stopped waiting early');
  t.mock.timers.tick(1);
  await third;
  assert.equal(settled, true);
  assert.equal(storage.local.get('unlockFailures').count, 3);

  // A success resets the counter — after serving the delay its own predecessors earned.
  const ok = backend.wallet.unlock(PASSWORD);
  await drain();
  t.mock.timers.tick(unlockDelayMs(3));
  await ok;
  assert.equal(await backend.wallet.isUnlocked(), true);
  assert.equal(storage.local.get('unlockFailures'), undefined);
});

test('the unlock delay schedule is 0, 0, 0.5s, 1s, 2s … capped at 30s', () => {
  assert.equal(unlockDelayMs(0), 0);
  assert.equal(unlockDelayMs(1), 0);
  assert.equal(unlockDelayMs(2), 500);
  assert.equal(unlockDelayMs(3), 1000);
  assert.equal(unlockDelayMs(4), 2000);
  assert.equal(unlockDelayMs(5), 4000);
  assert.equal(unlockDelayMs(20), 30000);
  assert.equal(unlockDelayMs(1000), 30000);
});

test('verifyPassword runs the full KDF over the real vault, and changes nothing', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);

  const real = globalThis.crypto;
  const derives = [];
  const decrypts = [];
  const spy = {
    getRandomValues: (a) => real.getRandomValues(a),
    randomUUID: () => real.randomUUID(),
    subtle: {
      importKey: (...a) => real.subtle.importKey(...a),
      deriveKey: (algo, ...rest) => { derives.push(algo); return real.subtle.deriveKey(algo, ...rest); },
      encrypt: (...a) => real.subtle.encrypt(...a),
      decrypt: (...a) => { decrypts.push(a[0]); return real.subtle.decrypt(...a); },
    },
  };
  Object.defineProperty(globalThis, 'crypto', { value: spy, configurable: true });
  try {
    assert.equal(await backend.wallet.verifyPassword(PASSWORD), true);
    assert.equal(derives.length, 1, 'verifyPassword must derive a key, not read a stored hash');
    assert.equal(derives[0].name, 'PBKDF2');
    assert.equal(derives[0].iterations, 600000);
    assert.equal(decrypts.length, 1, 'verifyPassword must actually decrypt the vault');

    assert.equal(await backend.wallet.verifyPassword('not-the-password'), false);
    assert.equal(derives.length, 2, 'a wrong password must cost the same KDF as a right one');
    assert.equal(derives[1].iterations, 600000);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }

  // It is re-authentication, not unlocking: nothing about the session changed.
  assert.equal(await backend.wallet.isUnlocked(), true);
  assert.equal((await storage.session.get('unlocked')).spend_key, SPEND_KEY);
});

test('lock clears the session; the vault and the public facts survive', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  assert.equal(await backend.wallet.isUnlocked(), false);
  assert.equal(await storage.session.get('unlocked'), undefined);
  assert.equal(await backend.wallet.exists(), true);
  await assert.rejects(() => backend.wallet.exportSpendKey(), /locked/);
  await assert.rejects(() => backend.wallet.viewingKey(), /locked/);
});

test('auto-lock fires after the configured idle time and notifies the shell', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend, storage } = build();
  await backend.settings.set({ autoLockMin: 1 });
  await backend.wallet.create(PASSWORD);
  assert.equal(await backend.wallet.isUnlocked(), true);

  const locked = [];
  const off = backend.wallet.onLocked(() => locked.push('locked'));

  t.mock.timers.tick(59_000);
  await drain();
  assert.equal(locked.length, 0, 'it locked before the idle time was up');
  t.mock.timers.tick(2_000);
  await drain();
  assert.deepEqual(locked, ['locked']);
  assert.equal(await backend.wallet.isUnlocked(), false);
  assert.equal(storage.sessionMap.get('unlocked'), undefined);
  off();
});

test('autoLockMin 0 never auto-locks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 0 });
  await backend.wallet.create(PASSWORD);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await drain();
  assert.equal(await backend.wallet.isUnlocked(), true);
});

test('wipe empties storage', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  assert.ok(storage.local.size > 0);
  await backend.wallet.wipe();
  assert.equal(storage.local.size, 0);
  assert.equal(storage.sessionMap.size, 0);
  assert.equal(await backend.wallet.exists(), false);
});

test('import takes a key or a key file through the core', async () => {
  const { backend, core } = build();
  await backend.wallet.import(SPEND_KEY, PASSWORD);
  assert.ok(core.calls.some(([m, p]) => m === 'import_key' && p.input === SPEND_KEY));
  assert.equal(await backend.wallet.isUnlocked(), true);
});

test('scan pages commitments, calls scan_page, persists, reports progress', async () => {
  const rows = [
    { index: 0, cm: '0a'.repeat(32), height: 5, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' } },
    { index: 1, cm: '0b'.repeat(32), height: 7, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' } },
  ];
  let served = false;
  const note = {
    index: 1, note: '00'.repeat(112), cm: '0b'.repeat(32), nf: '0c'.repeat(32),
    amount: '2500000000', asset: 0, time: 7, from: '00'.repeat(32), height: 7, spent: false, pending: null,
  };
  const core = stubCore({
    scan_page: ({ rows: page }) => ({
      received: page.some((r) => r.index === 1) ? [note] : [],
      sent: [], next_index: page[page.length - 1].index + 1, rows: page.length,
    }),
  });
  const fetch = stubFetch({
    rand_getCommitments: ([from]) => { if (from === 0 && !served) { served = true; return rows; } return []; },
    rand_getBlockByHeight: ([h]) => ({ height: h, timestamp_ms: 1788000000000 }),
  });
  const env = build({ core, fetch });
  const { backend, storage } = env;
  await backend.wallet.create(PASSWORD);

  const progress = [];
  const result = await backend.sync.scan((p) => progress.push(p));
  assert.ok(progress.length >= 1, 'scan reported no progress');
  assert.ok(progress.every((p) => typeof p.scanned === 'number' && typeof p.head === 'number'));
  assert.ok(core.calls.some(([m]) => m === 'scan_page'));

  assert.equal(result.notes.length, 1);
  assert.deepEqual(result.notes[0], {
    index: 1, asset: 0, amount: '2500000000', blockHeight: 7, spent: false, commitment: '0b'.repeat(32),
    time: 1788000000,
  });
  assert.equal(result.activity.length, 1);
  assert.equal(result.activity[0].kind, 'in');
  assert.equal(result.activity[0].amount, '2500000000');
  assert.equal(result.head, 100);

  // Persisted, and readable again without the node.
  assert.ok(storage.local.get('notes').notes.length === 1);
  const cached = await backend.sync.cached();
  assert.equal(cached.notes.length, 1);
  assert.equal(cached.head, 100);

  assertKeyNeverLeaked(env);
});

test('scan honours an AbortSignal and rejects with an AbortError', async () => {
  const controller = new AbortController();
  const page = (n) => Array.from({ length: 2 }, (_, i) => ({
    index: n + i, cm: '0a'.repeat(32), height: 1, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' },
  }));
  let from = 0;
  const fetch = stubFetch({
    rand_getCommitments: ([f]) => { from = f; controller.abort(); return page(f); },
  });
  const { backend } = build({ fetch });
  await backend.wallet.create(PASSWORD);
  await assert.rejects(
    () => backend.sync.scan(() => {}, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(from, 0);
});

test('scan rejects when the wallet is locked', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  await assert.rejects(() => backend.sync.scan(() => {}), /locked/);
});

test('assets.list puts RAND first and names registry assets RPL#n', async () => {
  const fetch = stubFetch({
    rand_getAssets: () => [{ index: 1, chain: 2, token: 'aa'.repeat(32), asset_id: 'dd'.repeat(32) }],
  });
  const { backend, storage } = build({ fetch });
  await backend.wallet.create(PASSWORD);
  const list = await backend.assets.list();
  assert.equal(list[0].index, 0);
  assert.equal(list[0].symbol, 'RAND');
  assert.equal(list[0].name, 'Rand');
  assert.equal(list[0].decimals, 9);
  assert.equal(list[0].id, 'rand');
  assert.equal(list[0].balance, '0');
  assert.equal(list[1].index, 1);
  assert.equal(list[1].symbol, 'RPL#1');
  assert.equal(list[1].decimals, 9);
  assert.equal(list[1].id, 'dd'.repeat(32));
  assert.equal('name' in list[1], false, 'an RPL asset has no display name until a token table exists');
  // Cached for an offline start.
  assert.ok(storage.local.get('assets'));
});

test('assets.list still answers when the registry RPC fails', async () => {
  const fetch = stubFetch({ rand_getAssets: () => { throw new Error('no bridge here'); } });
  const { backend } = build({ fetch });
  await backend.wallet.create(PASSWORD);
  const list = await backend.assets.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'RAND');
});

test('assets.list includes an asset the note store holds even without a registry', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  const notes = storage.local.get('notes');
  notes.notes = [{ index: 0, amount: '7', asset: 3, spent: false, pending: null, height: 1, cm: 'x', time: 1 }];
  storage.local.set('notes', notes);
  const list = await backend.assets.list();
  assert.deepEqual(list.map((a) => a.index), [0, 3]);
  assert.equal(list[1].symbol, 'RPL#3');
  assert.equal(list[1].balance, '7');
});

test('canProve explains the 5.5 GB wall', async () => {
  const { backend } = build();
  const answer = await backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /5\.5 GB/);
  assert.match(answer.reason, /desktop app/);
});

test('estimate asks the node for the fee and the core for the inputs', async () => {
  const { backend, storage, core, fetch } = build();
  await backend.wallet.create(PASSWORD);
  const notes = storage.local.get('notes');
  notes.notes = [{ index: 0, amount: '5000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'x', nf: 'y', time: 1 }];
  storage.local.set('notes', notes);

  const est = await backend.send.estimate({ asset: 0, to: ADDRESS, amount: '1000000000' });
  assert.equal(est.fee, '1000000');
  assert.equal(est.inputs, 1);
  assert.equal(est.change, '3999000000');
  assert.equal(est.proofs, 1);
  assert.ok(fetch.requests.some((r) => r.body.method === 'rand_estimateFee'));
  assert.ok(core.calls.some(([m]) => m === 'select_inputs'));
});

test('estimate refuses an RPL asset in the words the UI shows', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  await assert.rejects(
    () => backend.send.estimate({ asset: 1, to: ADDRESS, amount: '1' }),
    /RPL transfers are not available on this network\./,
  );
});

test('estimate surfaces the core-s own consolidate message', async () => {
  const core = stubCore({ select_inputs: () => { throw new Error('need more than two notes; the largest two hold 3 RAND — consolidate first by sending to your own address'); } });
  const { backend } = build({ core });
  await backend.wallet.create(PASSWORD);
  await assert.rejects(
    () => backend.send.estimate({ asset: 0, to: ADDRESS, amount: '9000000000' }),
    /consolidate first/,
  );
});

test('maxSendable is the balance less the fee, floored at zero', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  const notes = storage.local.get('notes');
  notes.notes = [
    { index: 0, amount: '3000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'x', nf: 'y', time: 1 },
    { index: 1, amount: '2000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'z', nf: 'w', time: 1 },
    { index: 2, amount: '9000000000', asset: 0, spent: true, pending: null, height: 1, cm: 'q', nf: 'e', time: 1 },
  ];
  storage.local.set('notes', notes);
  const max = await backend.send.maxSendable({ asset: 0 });
  assert.equal(max.fee, '1000000');
  assert.equal(max.amount, '4999000000'); // the two largest spendable notes, less the fee
});

test('maxSendable answers 0 for an empty wallet rather than throwing', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  assert.deepEqual(await backend.send.maxSendable({ asset: 0 }), { amount: '0', fee: '1000000' });
});

test('send rejects definitely, without ever reaching prove_transfer', async () => {
  const { backend, core, fetch } = build();
  await backend.wallet.create(PASSWORD);
  const phases = [];
  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, (p) => phases.push(p)),
    (err) => {
      assert.equal(err.definite, true);
      assert.match(err.message, /5\.5 GB/);
      return true;
    },
  );
  assert.deepEqual(phases, [], 'nothing was started, so no phase was reported');
  assert.equal(core.calls.some(([m]) => m === 'prove_transfer'), false);
  assert.equal(fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'), false);
});

test('rpc.call only allows rand_ and bridge_ methods', async () => {
  const { backend, fetch } = build();
  assert.deepEqual(await backend.rpc.call('rand_status'), { height: 100, peer_count: 3, syncing: false });
  assert.equal(await backend.rpc.call('rand_chainId'), 13);
  await assert.rejects(() => backend.rpc.call('eth_getBalance', []), /not allowed/);
  await assert.rejects(() => backend.rpc.call('__proto__'), /not allowed/);
  assert.equal(fetch.requests.some((r) => r.body.method === 'eth_getBalance'), false);
});

test('settings default to the core-s own constants and round-trip', async () => {
  const { backend } = build();
  const s = await backend.settings.get();
  assert.equal(s.chainId, 13); // from the core's `version`, never hard-coded here
  assert.equal(s.theme, 'system');
  assert.equal(s.autoLockMin, 15);
  assert.ok(s.rpcUrl);
  const next = await backend.settings.set({ theme: 'light' });
  assert.equal(next.theme, 'light');
  assert.equal((await backend.settings.get()).theme, 'light');
});

test('faucet mints to this wallet-s own address and records a pending item', async () => {
  const fetch = stubFetch({
    rand_mint: ([address]) => { assert.equal(address, ADDRESS); return '0x' + 'ab'.repeat(32); },
    rand_getTransaction: () => null,
  });
  const env = build({ fetch });
  const { backend } = env;
  await backend.wallet.create(PASSWORD);
  const res = await backend.faucet.request();
  assert.ok(res.hash);
  const cached = await backend.sync.cached();
  assert.ok(cached.activity.some((a) => a.kind === 'pending' || a.kind === 'faucet'));
  assertKeyNeverLeaked(env);
});

test('platform is passed through untouched, including optional members', () => {
  const platform = { name: 'web', version: '1.6.0', openExternal() {}, copy() {}, paste: async () => 'x' };
  const { backend } = build({ platform });
  assert.equal(backend.platform.name, 'web');
  assert.equal(backend.platform.version, '1.6.0');
  assert.equal(typeof backend.platform.paste, 'function');
});

test('nothing secret ever reaches the network, persistent storage or the clipboard', async () => {
  const env = build();
  const { backend, storage } = env;
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  await backend.assets.list();
  await backend.wallet.viewingKey();
  await backend.wallet.exportSpendKey();
  await backend.settings.set({ theme: 'dark' });
  await backend.wallet.lock();
  await backend.wallet.unlock(PASSWORD);

  assertKeyNeverLeaked(env);
  assertKeyNeverLeaked(env, PASSWORD);
  // The viewing key is a secret too: it discloses the whole history.
  assertKeyNeverLeaked(env, VIEWING_KEY);
  // And the session is the only home of the plaintext.
  assert.equal((await storage.session.get('unlocked')).spend_key, SPEND_KEY);
});
