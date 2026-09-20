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
import { NodeReplyError } from '../engine/validate.js';

const SPEND_KEY = 'a1'.repeat(32);
const VIEWING_KEY = 'b2'.repeat(32);
const PK = 'c3'.repeat(32);
const ADDRESS = 'rand1' + 'q'.repeat(60);
const PASSWORD = 'correct-horse-battery-staple';
const GENESIS = 'aa'.repeat(32);

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
    // An honest node names its chain. A node that serves neither this nor `rand_chainId` is
    // refused outright now (it could otherwise bypass the wrong-chain check by omitting two
    // methods), so the DEFAULT stub has to be an honest node — the anonymous one is a fixture
    // some tests build deliberately.
    rand_getGenesisHash: () => GENESIS,
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
  // `locks`/`broadcast` are explicitly off unless a test asks for them: the defaults would pick up
  // Node's own BroadcastChannel, and one left ref'd keeps the whole test process alive.
  const backend = makeWasmBackend({
    core, storage, platform, fetch,
    locks: opts.locks ?? null,
    broadcast: opts.broadcast ?? null,
    ...(opts.extra || {}),
  });
  return { backend, core, storage, platform, fetch };
}

/**
 * Spies on WebCrypto for the duration of `fn`, recording when each PBKDF2 derivation *starts* and
 * *ends* — which is how "the attempts ran one at a time" is asserted, rather than by timing.
 */
async function withKdfSpy(fn) {
  const real = globalThis.crypto;
  const order = [];
  const derives = [];
  let seq = 0;
  const spy = {
    getRandomValues: (a) => real.getRandomValues(a),
    randomUUID: () => real.randomUUID(),
    subtle: {
      importKey: (...a) => real.subtle.importKey(...a),
      encrypt: (...a) => real.subtle.encrypt(...a),
      decrypt: (...a) => real.subtle.decrypt(...a),
      deriveKey: async (algo, ...rest) => {
        const id = ++seq;
        derives.push(algo);
        order.push(`start:${id}`);
        try {
          return await real.subtle.deriveKey(algo, ...rest);
        } finally {
          order.push(`end:${id}`);
        }
      },
    },
  };
  Object.defineProperty(globalThis, 'crypto', { value: spy, configurable: true });
  try {
    return await fn({ order, derives });
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
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

// =============================================================== fix round 1 ====================

// ---- 1. every password attempt runs alone -------------------------------------------------- //

test('parallel wrong attempts run their KDFs one at a time, and each pays its own delay', async () => {
  const env = build();
  const { backend, storage } = env;
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();

  const spied = await withKdfSpy(async ({ order }) => {
    // Five at once — a scripted batch, which used to read the same failure count, wait the same
    // zero, and run five KDFs in parallel for the price of one delay.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => backend.wallet.unlock('nope-nope-nope').then(() => 'ok', (e) => e.message)),
    );
    assert.deepEqual(results, Array(5).fill('wrong password'));
    return order;
  });

  // Strictly sequential: every start is immediately followed by its own end.
  assert.equal(spied.length, 10, `expected 5 derivations, saw ${spied.length / 2}`);
  for (let i = 0; i < spied.length; i += 2) {
    const id = spied[i].split(':')[1];
    assert.equal(spied[i], `start:${id}`);
    assert.equal(spied[i + 1], `end:${id}`, `derivation ${id} overlapped another: ${spied.join(' ')}`);
  }
  // …and all five were counted, so the backoff is where five sequential attempts would leave it.
  assert.equal(storage.local.get('unlockFailures').count, 5);
});

test('the failure is persisted BEFORE the KDF, so an abandoned attempt still counts', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();

  // A reload mid-attempt is a second backend over the same storage. It must see the increment
  // that the attempt made on its way in, not a count that only lands if the KDF finishes.
  let seenDuringKdf;
  await withKdfSpy(async () => {
    const original = globalThis.crypto.subtle.deriveKey;
    globalThis.crypto.subtle.deriveKey = async (...args) => {
      if (seenDuringKdf === undefined) {
        const reloaded = build({ storage }).backend;
        seenDuringKdf = (await reloaded.settings.get()) && storage.local.get('unlockFailures');
      }
      return original(...args);
    };
    await assert.rejects(() => backend.wallet.unlock('wrong-wrong-wrong'), /wrong password/);
  });
  assert.equal(seenDuringKdf && seenDuringKdf.count, 1, 'the attempt was not counted before its KDF ran');
});

test('a flood of attempts is refused rather than queued without limit', async (t) => {
  // Mocked timers, because the accepted attempts serve a real, growing backoff: eight of them in a
  // row is half a minute of wall clock, and no test should ever wait on that.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  const many = Array.from({ length: 12 }, () => backend.wallet.unlock('nope-nope-nope').then(() => 'ok', (e) => e.message));
  // A *real* interval driving the *fake* clock: each accepted attempt runs a real 600 000-iteration
  // KDF, so a fixed number of ticks cannot know when the next delay has been scheduled. Only
  // `setTimeout` is mocked, so `setInterval` is still the host's.
  const pump = setInterval(() => { try { t.mock.timers.tick(60_000); } catch { /* disabled */ } }, 2);
  const results = await Promise.all(many);
  clearInterval(pump);
  const refused = results.filter((r) => r === 'too many attempts in progress');
  const tried = results.filter((r) => r === 'wrong password');
  assert.ok(refused.length > 0, 'nothing was refused, so the queue is unbounded');
  assert.ok(tried.length > 0, 'everything was refused, so the queue is useless');
  assert.equal(refused.length + tried.length, 12);
});

test('verifyPassword shares the one queue, and a success resets the count', async () => {
  const env = build();
  const { backend, storage } = env;
  await backend.wallet.create(PASSWORD);

  const order = await withKdfSpy(async ({ order: o }) => {
    const answers = await Promise.all([
      backend.wallet.verifyPassword('wrong-one-here'),
      backend.wallet.verifyPassword('wrong-two-here'),
    ]);
    assert.deepEqual(answers, [false, false]);
    return o;
  });
  assert.equal(order.length, 4);
  assert.deepEqual(order.slice(0, 2), ['start:1', 'end:1'], 'verifyPassword jumped the queue');
  assert.equal(storage.local.get('unlockFailures').count, 2);

  assert.equal(await backend.wallet.verifyPassword(PASSWORD), true);
  assert.equal(storage.local.get('unlockFailures'), undefined, 'a success did not reset the count');
});

// ---- 4 & 5. a vault that no password can open ---------------------------------------------- //

test('a vault from a newer build says so, and is not a password attempt', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  storage.local.set('vault', { ...storage.local.get('vault'), v: 99 });

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => backend.wallet.unlock(PASSWORD), (err) => {
      assert.equal(err.name, 'VaultVersionError');
      assert.equal(err.code, 'VAULT_VERSION');
      assert.equal(err.recoverable, true);
      assert.match(err.message, /newer version of Rand Wallet/);
      return true;
    });
  }
  assert.equal(storage.local.get('unlockFailures'), undefined, 'an unopenable vault grew the backoff');
});

test('a structurally damaged vault says so, and is not a password attempt', async () => {
  const cases = {
    'iter too low (the KDF turned off)': (v) => ({ ...v, iter: 1 }),
    'iter absurdly high (a KDF denial of service)': (v) => ({ ...v, iter: 500_000_000 }),
    'salt is not base64': (v) => ({ ...v, salt: 'not base64!!' }),
    'iv is the wrong size': (v) => ({ ...v, iv: 'AA' }),
    'ct is missing': (v) => ({ ...v, ct: undefined }),
    'kdf is something else': (v) => ({ ...v, kdf: 'scrypt' }),
    'not an object at all': () => 'rubbish',
  };
  for (const [what, damage] of Object.entries(cases)) {
    const { backend, storage } = build();
    await backend.wallet.create(PASSWORD);
    await backend.wallet.lock();
    storage.local.set('vault', damage(storage.local.get('vault')));
    await assert.rejects(() => backend.wallet.unlock(PASSWORD), (err) => {
      assert.equal(err.name, 'VaultDamagedError', what);
      assert.equal(err.code, 'VAULT_DAMAGED', what);
      assert.equal(err.recoverable, true, what);
      assert.equal(err.message, 'wallet data is damaged', what);
      return true;
    });
    assert.equal(storage.local.get('unlockFailures'), undefined, `${what}: counted as a password attempt`);
    // verifyPassword rejects too, rather than answering a plain `false`.
    await assert.rejects(() => backend.wallet.verifyPassword(PASSWORD), /damaged/);
  }
});

test('a sound vault with a wrong password is still, and only, `wrong password`', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  await assert.rejects(() => backend.wallet.unlock('not-the-password'), (err) => {
    assert.equal(err.message, 'wrong password');
    assert.equal(err.recoverable, undefined, 'a wrong password must not offer a wipe');
    return true;
  });
});

// ---- 2. the idle timer measures the user, not the traffic ---------------------------------- //

test('backend traffic does NOT restart the idle timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 15 });
  await backend.wallet.create(PASSWORD);
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));

  // A screen that re-scans every minute — exactly the thing that used to keep an abandoned,
  // unlocked wallet unlocked for ever.
  for (let minute = 1; minute <= 20; minute += 1) {
    t.mock.timers.tick(60_000);
    await drain();
    if (await backend.wallet.isUnlocked()) await backend.sync.scan(() => {}).catch(() => {});
    await drain();
    if (minute === 14) assert.equal(locked.length, 0, 'it locked early');
  }
  assert.deepEqual(locked, ['locked'], 'the wallet never locked despite 20 idle minutes');
});

test('noteActivity restarts the idle timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 15 });
  await backend.wallet.create(PASSWORD);
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));

  for (let minute = 1; minute <= 20; minute += 1) {
    t.mock.timers.tick(60_000);
    await drain();
    backend.wallet.noteActivity(); // the user is still here
    await drain();
  }
  assert.deepEqual(locked, [], 'activity did not hold the lock off');
  assert.equal(await backend.wallet.isUnlocked(), true);

  // …and once they stop, it locks on schedule.
  t.mock.timers.tick(15 * 60_000 + 1000);
  await drain();
  assert.deepEqual(locked, ['locked']);
});

test('noteActivity on a locked wallet does not arm a timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 1 });
  await backend.wallet.create(PASSWORD);
  await backend.wallet.lock();
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));
  backend.wallet.noteActivity();
  t.mock.timers.tick(10 * 60_000);
  await drain();
  assert.deepEqual(locked, [], 'a locked wallet armed an idle timer');
});

test('a lock that comes due during a send waits for the send, then happens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 1 });
  await backend.wallet.create(PASSWORD);
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));

  // The send is in flight the instant this returns its promise: `send.send` takes the hold and
  // then awaits. Firing the idle timer now is the race the hold exists for.
  const inFlight = backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, () => {});
  t.mock.timers.tick(61_000);
  assert.deepEqual(locked, [], 'the wallet locked in the middle of a transfer');
  assert.equal(await backend.wallet.isUnlocked(), true, 'the spend key was dropped mid-transfer');

  await assert.rejects(() => inFlight, (err) => err.definite === true);
  await drain();

  // …and the moment the transfer settled, the lock that was due happened.
  assert.deepEqual(locked, ['locked'], 'the deferred lock never happened');
  assert.equal(await backend.wallet.isUnlocked(), false);
});

// ---- 3. a node reply never poisons the store ----------------------------------------------- //

test('a malformed node reply is a typed error, and nothing is persisted', async () => {
  const bad = {
    'a nullifier row whose height is a string': {
      rand_getNullifiers: () => [{ height: '9', nullifier: 'ab'.repeat(32) }],
    },
    'a head that is null': { rand_getHead: () => null },
    'a head whose height is NaN-ish': { rand_getHead: () => ({ height: 'soon' }) },
    'a commitment row with no envelope': {
      rand_getCommitments: ([from]) => (from === 0 ? [{ index: 0, cm: 'ab'.repeat(32), height: 1 }] : []),
    },
    'a commitment row whose cm is not hex': {
      rand_getCommitments: ([from]) => (from === 0 ? [{ index: 0, cm: 'zz', height: 1, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' } }] : []),
    },
    'a page longer than the one asked for': {
      rand_getCommitments: () => Array.from({ length: 501 }, (_, i) => ({ index: i, cm: 'ab'.repeat(32), height: 1, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' } })),
    },
  };
  for (const [what, table] of Object.entries(bad)) {
    const { backend, storage } = build({ fetch: stubFetch(table) });
    await backend.wallet.create(PASSWORD);
    const before = JSON.stringify(storage.local.get('notes'));
    await assert.rejects(() => backend.sync.scan(() => {}), (err) => {
      assert.equal(err.name, 'NodeReplyError', `${what}: got ${err.name}: ${err.message}`);
      assert.ok(err instanceof NodeReplyError, what);
      assert.match(err.message, /^rand_/, what);
      return true;
    });
    assert.equal(JSON.stringify(storage.local.get('notes')), before, `${what}: the store was written anyway`);
  }
});

test('a bad fee or asset registry is refused rather than believed', async () => {
  const feeEnv = build({ fetch: stubFetch({ rand_estimateFee: () => '1.5' }) });
  await feeEnv.backend.wallet.create(PASSWORD);
  await assert.rejects(
    () => feeEnv.backend.send.estimate({ asset: 0, to: ADDRESS, amount: '1' }),
    (err) => err.name === 'NodeReplyError',
  );

  // The registry is best-effort, so a bad one falls back to the cache and RAND still answers.
  const assetEnv = build({ fetch: stubFetch({ rand_getAssets: () => [{ index: 'one' }] }) });
  await assetEnv.backend.wallet.create(PASSWORD);
  const list = await assetEnv.backend.assets.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'RAND');
  assert.equal(assetEnv.storage.local.get('assets'), undefined, 'a malformed registry was cached');
});

test('a note store poisoned with NaN cursors self-heals, keeps its notes, and says so once', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  const note = {
    index: 4, note: '00'.repeat(112), cm: '0b'.repeat(32), nf: '0c'.repeat(32),
    amount: '2500000000', asset: 0, time: 7, from: '00'.repeat(32), height: 7, spent: false, pending: null,
  };
  // Exactly what the old nullifier loop used to leave behind.
  storage.local.set('notes', {
    ...storage.local.get('notes'), notes: [note],
    scanned_index: Number.NaN, scanned_height: Number.NaN, scanned_attest_height: 0, head: 0,
  });

  const result = await backend.sync.scan(() => {});
  assert.equal(result.recovered, true, 'the UI was not told the store had been reset');
  assert.equal(result.notes.length, 1, 'the notes were thrown away with the cursors');
  const saved = storage.local.get('notes');
  for (const key of ['scanned_index', 'scanned_height', 'scanned_attest_height', 'head']) {
    assert.ok(Number.isSafeInteger(saved[key]), `${key} is still ${String(saved[key])}`);
  }
  // Said once: the next scan is an ordinary one.
  const again = await backend.sync.scan(() => {});
  assert.equal(again.recovered, undefined);
});

test('the store writer refuses a cursor that is not a block height, or one that went backwards', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  const good = storage.local.get('notes');
  assert.ok(Number.isSafeInteger(good.scanned_height));

  // A store writer is the last line of defence, so it is asserted directly rather than through a
  // node reply that (now) can no longer produce this.
  const engine = makeWasmBackend({
    core: stubCore(), storage, platform: stubPlatform(), fetch: stubFetch(), locks: null, broadcast: null,
  });
  void engine;
  const { makeWallet } = await import('../engine/wallet.js');
  const wallet = makeWallet({
    core: stubCore(),
    store: {
      async getNoteStore() { return storage.local.get('notes'); },
      async setNoteStore(s) { storage.local.set('notes', s); },
    },
    rpc: () => ({}),
    settings: async () => ({}),
  });
  const st = await wallet.loadStore();
  await assert.rejects(
    () => wallet.persist({ ...st, scanned_height: Number.NaN }, st),
    /refusing to save the note store: scanned_height is not a block cursor/,
  );
  await assert.rejects(
    () => wallet.persist({ ...st, scanned_index: 0 }, { ...st, scanned_index: 50 }),
    /moved backwards, 50 → 0/,
  );
  assert.deepEqual(storage.local.get('notes'), good, 'a refused write changed the store anyway');
});

// ---- 6. two tabs ---------------------------------------------------------------------------- //

/** A Map-backed storage with the optional conditional write, as web/wallet/idb.js provides it. */
function casStorage() {
  const s = mapStorage();
  s.compareAndSet = async (key, expectedRev, value) => {
    const current = s.local.get(key);
    const found = current && typeof current === 'object' ? current.rev : undefined;
    if (found !== expectedRev) {
      const err = new Error(`${key} changed underneath this write`);
      err.name = 'StaleStoreError';
      throw err;
    }
    const rev = Number.isSafeInteger(found) ? found + 1 : 1;
    s.writes.push([key, value]);
    s.local.set(key, JSON.parse(JSON.stringify({ ...value, rev })));
    return rev;
  };
  return s;
}

test('the note store is written conditionally when storage can, and a lost race is merged', async () => {
  const storage = casStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  const afterFirst = storage.local.get('notes');
  assert.ok(Number.isSafeInteger(afterFirst.rev) && afterFirst.rev >= 1, 'the conditional write did not stamp a revision');

  // Another tab writes between this scan's load and its save: the note it added must survive.
  const otherNote = {
    index: 99, note: '00'.repeat(112), cm: '0e'.repeat(32), nf: '0f'.repeat(32),
    amount: '7000000000', asset: 0, time: 3, from: '00'.repeat(32), height: 3, spent: false, pending: null,
  };
  const realGet = storage.get;
  let interfered = false;
  storage.get = async (key) => {
    const value = await realGet.call(storage, key);
    if (key === 'notes' && !interfered) {
      interfered = true;
      const current = storage.local.get('notes');
      storage.local.set('notes', { ...current, notes: [...current.notes, otherNote], rev: current.rev + 1 });
    }
    return value;
  };
  const result = await backend.sync.scan(() => {});
  storage.get = realGet;

  assert.ok(result.notes.some((n) => n.index === 99), "the other tab's note was overwritten");
  assert.ok(storage.local.get('notes').rev > afterFirst.rev);
});

test('only one tab scans: the other waits for the announcement and reads what it wrote', async () => {
  // A fake Web Locks API and a fake BroadcastChannel — the two things the browser provides.
  const held = new Set();
  const locks = {
    async request(name, opts, cb) {
      if (held.has(name)) return cb(null); // `ifAvailable` hands back null
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
  const listeners = new Set();
  const channel = {
    postMessage(data) { for (const fn of [...listeners]) fn({ data }); },
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
  };
  const storage = casStorage();
  const one = makeWasmBackend({ core: stubCore(), storage, platform: stubPlatform(), fetch: stubFetch(), locks, broadcast: channel });
  await one.wallet.create(PASSWORD);

  // Tab one holds the lock and is mid-scan; tab two asks at the same moment.
  let releaseScan;
  const scanGate = new Promise((r) => { releaseScan = r; });
  const slowFetch = stubFetch({ rand_getHead: () => ({ height: 42, hash: 'ab'.repeat(32) }) });
  const slow = async (...args) => { await scanGate; return slowFetch(...args); };
  slow.requests = slowFetch.requests;
  const two = makeWasmBackend({ core: stubCore(), storage, platform: stubPlatform(), fetch: slow, locks, broadcast: channel });

  const first = two.sync.scan(() => {});
  await drain();
  const second = one.sync.scan(() => {}); // the lock is taken — this one must not hit the node
  await drain();
  releaseScan();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.head, 42);
  assert.equal(b.head, 42, 'the waiting tab did not pick up what the scanning tab wrote');
  assert.equal(one.platform.name, 'test');
});

// ---- 8. the two-note rule belongs to the chain --------------------------------------------- //

test('maxSendable follows the core when it reports how many notes a bundle spends', async () => {
  const notes = [
    { index: 0, amount: '3000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'a', nf: 'b', time: 1 },
    { index: 1, amount: '2000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'c', nf: 'd', time: 1 },
    { index: 2, amount: '1000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'e', nf: 'f', time: 1 },
  ];
  const seed = async (backend, storage) => {
    await backend.wallet.create(PASSWORD);
    storage.local.set('notes', { ...storage.local.get('notes'), notes });
  };

  // Default: the engine's BUNDLE_INPUTS of two — the largest two, less the fee.
  const plain = build();
  await seed(plain.backend, plain.storage);
  assert.equal((await plain.backend.send.maxSendable({ asset: 0 })).amount, '4999000000');

  // A core that says three takes precedence over anything this JavaScript believes.
  const three = build({ core: stubCore({ version: () => ({ ...stubCore().callDefaults, default_chain_id: 13, token_symbol: 'RAND', token_decimals: 9, bundle_inputs: 3 }) }) });
  await seed(three.backend, three.storage);
  assert.equal((await three.backend.send.maxSendable({ asset: 0 })).amount, '5999000000');
});

// =============================================================== fix round 2 ====================

test('wipe forgets a deferred lock, so releasing a hold afterwards is silent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 1 });
  await backend.wallet.create(PASSWORD);
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));

  // A send in flight, the idle timer comes due (deferred), then the wallet is wiped.
  const inFlight = backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, () => {});
  t.mock.timers.tick(61_000);
  await backend.wallet.wipe();
  await assert.rejects(() => inFlight, (err) => err.definite === true);
  await drain();

  assert.deepEqual(locked, [], 'a wiped wallet fired onLocked at a shell that had moved on');
});

test('noteActivity never rejects, even when storage is broken', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.settings.set({ autoLockMin: 5 });
  await backend.wallet.create(PASSWORD);

  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  storage.get = async () => { throw new Error('the database is gone'); };
  try {
    assert.doesNotThrow(() => backend.wallet.noteActivity(), 'it threw on the keystroke path');
    await drain(50);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(rejections, [], 'a keystroke produced an unhandled rejection');
});

test('user activity during a hold cancels the deferred lock and restarts the clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { backend } = build();
  await backend.settings.set({ autoLockMin: 1 });
  await backend.wallet.create(PASSWORD);
  const locked = [];
  backend.wallet.onLocked(() => locked.push('locked'));

  const inFlight = backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, () => {});
  t.mock.timers.tick(61_000);            // the lock comes due, and waits for the send
  backend.wallet.noteActivity();          // …but the user is right here, typing
  await drain();
  await assert.rejects(() => inFlight, (err) => err.definite === true);
  await drain();

  assert.deepEqual(locked, [], 'it locked the moment the send settled, despite the user being active');
  assert.equal(await backend.wallet.isUnlocked(), true);

  // …and the clock restarted from the activity, so it still locks once they really do stop.
  t.mock.timers.tick(61_000);
  await drain();
  assert.deepEqual(locked, ['locked'], 'the idle timer never came back');
});

test('the failure counter survives two tabs counting at once', async () => {
  // One shared number. Without a conditional write both tabs read n, both write n + 1, and two
  // wrong guesses cost one step of backoff between them.
  const storage = casStorage();
  const one = build({ storage }).backend;
  await one.wallet.create(PASSWORD);
  await one.wallet.lock();
  const two = build({ storage }).backend;

  await Promise.all([
    one.wallet.unlock('nope-nope-nope').catch(() => {}),
    two.wallet.unlock('nope-nope-nope').catch(() => {}),
  ]);
  assert.equal(storage.local.get('unlockFailures').count, 2, 'one tab’s attempt was lost');
});

test('dispose closes the broadcast channel and is idempotent', async () => {
  let closed = 0;
  const channel = {
    postMessage() {}, addEventListener() {}, removeEventListener() {},
    close() { closed += 1; },
  };
  const { backend } = build({ broadcast: channel });
  await backend.wallet.create(PASSWORD);
  backend.dispose();
  backend.dispose();
  assert.equal(closed, 1, 'the channel was left open, or closed twice');

  // …and a wipe closes it too.
  const second = build({ broadcast: { ...channel, close() { closed += 1; } } }).backend;
  await second.wallet.create(PASSWORD);
  await second.wallet.wipe();
  assert.equal(closed, 2);
});

test('the wait for another tab is short, and says so rather than hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const locks = { async request(_name, _opts, cb) { return cb(null); } }; // always taken
  const listeners = new Set();
  const channel = {
    postMessage() {}, close() {},
    addEventListener(_t, fn) { listeners.add(fn); },
    removeEventListener(_t, fn) { listeners.delete(fn); },
  };
  const { backend } = build({ locks, broadcast: channel });
  await backend.wallet.create(PASSWORD);

  const p = backend.sync.scan(() => {});
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await drain(); // let the scan reach the wait, so there is a timer to advance
  t.mock.timers.tick(7_000);
  await drain();
  assert.equal(settled, false, 'it gave up before the wait was over');
  t.mock.timers.tick(2_000);
  const answer = await p;
  assert.equal(answer.otherTab, true, 'the UI was not told why this is cached data');
});

test('sync.rescan needs an unlocked wallet and re-reads from zero', async () => {
  const { backend, storage } = build();
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  storage.local.set('notes', { ...storage.local.get('notes'), scanned_index: 900, scanned_height: 900 });

  const after = await backend.sync.rescan();
  // Reset, then re-established from the node — so it is the node's height, never the 900 that was
  // there before (which is the whole point: the wallet no longer claims to have read that far).
  assert.ok(after.scannedHeight < 900, `the cursors were not reset: ${after.scannedHeight}`);
  assert.ok(storage.local.get('notes').scanned_index < 900);
  assert.ok(await backend.wallet.exists(), 'a rescan wiped the wallet');
  assert.equal((await backend.wallet.exportSpendKey()), SPEND_KEY, 'a rescan touched the keys');

  await backend.wallet.lock();
  await assert.rejects(() => backend.sync.rescan(), /locked/);
});

test('a scan against a node on another chain reports it without scanning', async () => {
  const fetch = stubFetch({ rand_getGenesisHash: () => 'aa'.repeat(32) });
  const { backend, storage } = build({ fetch });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  assert.equal(storage.local.get('notes').genesis, 'aa'.repeat(32));

  const moved = build({
    storage,
    fetch: stubFetch({ rand_getGenesisHash: () => 'bb'.repeat(32), rand_chainId: () => 14 }),
  }).backend;
  const answer = await moved.sync.scan(() => {});
  assert.ok(answer.wrongChain, 'the chain change went unnoticed');
  assert.equal(answer.wrongChain.got.chainId, 14);
});

test('a node older than rand_getGenesisHash is refused, not trusted', async () => {
  // It used to be accepted on `settings.chainId` alone — which the backend always supplies, so a
  // node bypassed the entire wrong-chain check by not implementing two methods.
  const fetch = stubFetch({ rand_getGenesisHash: () => { throw new Error('unknown method'); } });
  const { backend, storage } = build({ fetch });
  await backend.wallet.create(PASSWORD);
  const answer = await backend.sync.scan(() => {});
  assert.equal(answer.identityUnknown, true, 'a wallet pinned itself to a chain nobody named');
  assert.equal(storage.local.get('notes').chain_id, null, 'it recorded an identity anyway');
  assert.equal(storage.local.get('notes').scanned_index, 0, 'it scanned an unidentified chain');
});

// =============================================================== fix round 3 ====================

/** A fetch whose genesis hash (and chain id) can be switched between calls. */
function chainFetch(state, table = {}) {
  return stubFetch({
    rand_getGenesisHash: () => state.genesis,
    rand_chainId: () => state.chainId,
    ...table,
  });
}

test('while the node is on another chain, nothing acts on the notes', async () => {
  const state = { genesis: 'aa'.repeat(32), chainId: 13 };
  const storage = mapStorage();
  const fetch = chainFetch(state, { rand_mint: () => `0x${'ab'.repeat(32)}` });
  const { backend } = build({ storage, fetch });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});

  // Give it something to be tempted by, then move the node to another chain.
  storage.local.set('notes', {
    ...storage.local.get('notes'),
    notes: [{ index: 0, amount: '5000000000', asset: 0, spent: false, pending: null, height: 1, cm: 'x', nf: 'y', time: 1 }],
  });
  state.genesis = 'bb'.repeat(32);
  state.chainId = 14;
  const answer = await backend.sync.scan(() => {});
  assert.ok(answer.wrongChain);

  // Every route that would mix chain A's notes with chain B's node is refused, definitely.
  const refusals = [
    () => backend.send.estimate({ asset: 0, to: ADDRESS, amount: '1' }),
    () => backend.send.maxSendable({ asset: 0 }),
    () => backend.faucet.request(),
  ];
  for (const call of refusals) {
    await assert.rejects(call, (err) => {
      assert.match(err.message, /different chain/);
      assert.equal(err.definite, true, 'the UI must be able to offer a retry');
      return true;
    });
  }
  // …and the faucet did not mint on the way to being refused.
  assert.equal(fetch.requests.some((r) => r.body.method === 'rand_mint'), false, 'it minted against an unchecked chain');

  // `send.send` answers with what can never be wrong first: this shell cannot prove at all, so it
  // says so rather than asking the network about a transfer it could not make either way. A shell
  // that CAN prove reaches the chain gate (see the ordering comment in backend-wasm.js).
  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, () => {}),
    (err) => { assert.match(err.message, /5\.5 GB/); assert.equal(err.definite, true); return true; },
  );

  // …and every screen can see it, not just the one that happened to scan.
  assert.ok((await backend.sync.cached()).wrongChain, 'sync.cached() hid the state from the other screens');
});

test('the wrong-chain refusal is cleared by a good scan, by a rescan, and by changing the node', async () => {
  const state = { genesis: 'aa'.repeat(32), chainId: 13 };
  const storage = mapStorage();
  const { backend } = build({ storage, fetch: chainFetch(state) });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  state.genesis = 'bb'.repeat(32);
  await backend.sync.scan(() => {});
  await assert.rejects(() => backend.send.maxSendable({ asset: 0 }), /different chain/);

  // Back to the right node.
  state.genesis = 'aa'.repeat(32);
  await backend.sync.scan(() => {});
  await assert.doesNotReject(() => backend.send.maxSendable({ asset: 0 }));

  // A settings change re-opens the question for the NEW url — it does not bless it. The verdict
  // is per URL, and an unverified node is checked on the spot rather than assumed good.
  state.genesis = 'cc'.repeat(32);
  await backend.sync.scan(() => {});
  await assert.rejects(() => backend.send.maxSendable({ asset: 0 }), /different chain/);
  await backend.settings.set({ rpcUrl: 'http://127.0.0.1:9999' });
  await assert.rejects(
    () => backend.send.maxSendable({ asset: 0 }),
    /different chain/,
    'a new URL was taken on trust; the node behind it is still on the wrong chain',
  );

  // …and a rescan adopts whatever chain the node is on.
  await backend.sync.scan(() => {});
  await assert.rejects(() => backend.send.maxSendable({ asset: 0 }), /different chain/);
  await backend.sync.rescan({ forChain: true });
  await assert.doesNotReject(() => backend.send.maxSendable({ asset: 0 }));
});

test('behind: a second node saying the same thing is what flags the wallet, across URL changes', async () => {
  // The journey the old rule could not see: the tally was cleared on every `rpcUrl` change, i.e.
  // on exactly the action that would fill it, so `walletAhead` was unreachable.
  const storage = mapStorage();
  const ahead = { rand_getHead: () => ({ height: 100, hash: 'ab'.repeat(32) }) };
  const { backend } = build({ storage, fetch: stubFetch(ahead) });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});

  const lagging = stubFetch({ rand_getHead: () => ({ height: 60, hash: 'ab'.repeat(32) }) });
  const one = build({ storage, fetch: lagging }).backend;
  await one.settings.set({ rpcUrl: 'http://127.0.0.1:7001' });
  const first = await one.sync.scan(() => {});
  assert.ok(first.behind, 'no behind marker');
  assert.equal(first.behind.walletAhead, undefined, 'one lagging node is just one lagging node');

  await one.settings.set({ rpcUrl: 'http://127.0.0.1:7002' });
  const second = await one.sync.scan(() => {});
  assert.ok(second.behind);
  assert.equal(second.behind.walletAhead, true, 'two different nodes agreeing did not flag the wallet');

  // A clean scan puts it away again.
  const caughtUp = build({ storage, fetch: stubFetch(ahead) }).backend;
  await caughtUp.settings.set({ rpcUrl: 'http://127.0.0.1:7002' });
  const clean = await caughtUp.sync.scan(() => {});
  assert.equal(clean.behind, undefined);
});

test('behind: a large gap flags the wallet on its own', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage, fetch: stubFetch({ rand_getHead: () => ({ height: 40_000, hash: 'ab'.repeat(32) }) }) });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  const lagging = build({ storage, fetch: stubFetch({ rand_getHead: () => ({ height: 40, hash: 'ab'.repeat(32) }) }) }).backend;
  const answer = await lagging.sync.scan(() => {});
  assert.ok(answer.behind);
  assert.equal(answer.behind.walletAhead, true, `a gap of ${answer.behind.wallet - answer.behind.tip} did not flag it`);
});

test('onChanged fires for another tab’s scan and reset, for as long as the backend lives', async () => {
  const listeners = new Set();
  const channel = {
    postMessage() {}, close() {},
    addEventListener(_t, fn) { listeners.add(fn); },
    removeEventListener(_t, fn) { listeners.delete(fn); },
  };
  const { backend } = build({ broadcast: channel });
  await backend.wallet.create(PASSWORD);

  const seen = [];
  const off = backend.sync.onChanged((e) => seen.push(e.reason));
  assert.equal(typeof off, 'function');

  const fire = (type) => { for (const fn of [...listeners]) fn({ data: { type } }); };
  fire('scan-done');
  fire('store-reset');
  fire('something-else');
  assert.deepEqual(seen, ['scan', 'reset']);

  // The old code installed the only listener inside `waitForOtherTab` and removed it on resolve,
  // so the "this will refresh when that finishes" banner was a promise nothing could keep.
  await backend.sync.scan(() => {}).catch(() => {});
  fire('scan-done');
  assert.deepEqual(seen, ['scan', 'reset', 'scan'], 'the listener did not survive a scan');

  off();
  fire('scan-done');
  assert.deepEqual(seen, ['scan', 'reset', 'scan']);
});

test('a rescan takes the scan lock, and says so rather than no-opping when it cannot', async () => {
  const held = new Set();
  const locks = {
    async request(name, opts, cb) {
      if (held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
  const storage = casStorage();
  const { backend } = build({ storage, locks, broadcast: null });
  await backend.wallet.create(PASSWORD);
  await assert.doesNotReject(() => backend.sync.rescan(), 'a free lock should just work');

  // Now pretend another tab holds it for good.
  const busy = { async request(_n, _o, cb) { return cb(null); } };
  const blocked = build({ storage, locks: busy, broadcast: null }).backend;
  await assert.rejects(() => blocked.sync.rescan(), (err) => {
    assert.match(err.message, /Another tab is syncing/);
    assert.equal(err.retryable, true);
    return true;
  });
});

test('a wallet created again after a wipe still coordinates with other tabs', async () => {
  // `wipe()` closed the channel for the life of the page, so a fresh wallet in the same mount had
  // no multi-tab coordination at all until a reload.
  let opened = 0;
  const makeFake = () => {
    opened += 1;
    const listeners = new Set();
    return {
      posted: [], closed: false,
      postMessage(m) { this.posted.push(m); },
      close() { this.closed = true; },
      addEventListener(_t, fn) { listeners.add(fn); },
      removeEventListener(_t, fn) { listeners.delete(fn); },
      fire(type) { for (const fn of [...listeners]) fn({ data: { type } }); },
    };
  };
  const channel = makeFake();
  const { backend } = build({ broadcast: channel });
  await backend.wallet.create(PASSWORD);
  await backend.wallet.wipe();
  assert.equal(channel.closed, true, 'the channel was left open by a wipe');

  await backend.wallet.create(PASSWORD);
  const seen = [];
  backend.sync.onChanged(() => seen.push('changed'));
  channel.fire('scan-done');
  assert.deepEqual(seen, ['changed'], 'a wallet created after a wipe never hears from another tab again');
  assert.equal(opened, 1, 'the injected channel is reused; a real one would be re-opened');
});

// =============================================================== fix round 4 ====================
// Every test here drives the REAL makeWasmBackend. The round-3 versions used `makeWallet` with
// `settings: async () => ({})` — a configuration the shell never produces — and passed while the
// behaviour through the backend was different.

/** A node that answers only the methods listed; anything else is an unknown-method RPC error. */
function nodeWithout(missing, table = {}) {
  const gone = {};
  for (const method of missing) gone[method] = () => { throw new Error(`unknown method ${method}`); };
  return stubFetch({ ...gone, ...table });
}

test('IDENTITY: a node that names neither its chain nor its genesis is refused on a first scan', async () => {
  const { backend, storage } = build({ fetch: nodeWithout(['rand_chainId', 'rand_getGenesisHash']) });
  await backend.wallet.create(PASSWORD);
  const answer = await backend.sync.scan(() => {});
  assert.equal(answer.identityUnknown, true, 'a wallet pinned itself to a chain nobody named');
  assert.equal(answer.wrongChain, undefined);
  assert.equal(storage.local.get('notes').scanned_index, 0, 'it scanned an unidentified chain');
  assert.equal(storage.local.get('notes').chain_id, null);
  assert.equal(storage.local.get('notes').genesis, null);
});

test('IDENTITY: half an identity is not an identity', async () => {
  for (const missing of [['rand_chainId'], ['rand_getGenesisHash']]) {
    const { backend, storage } = build({ fetch: nodeWithout(missing) });
    await backend.wallet.create(PASSWORD);
    const answer = await backend.sync.scan(() => {});
    assert.equal(answer.identityUnknown, true, `a node without ${missing[0]} was adopted`);
    assert.equal(storage.local.get('notes').chain_id, null);
  }
});

test('IDENTITY: a node with both is adopted, and then has to keep matching both', async () => {
  const state = { genesis: GENESIS, chainId: 13 };
  const storage = mapStorage();
  const { backend } = build({ storage, fetch: chainFetch(state) });
  await backend.wallet.create(PASSWORD);
  assert.equal((await backend.sync.scan(() => {})).wrongChain, undefined);
  assert.equal(storage.local.get('notes').genesis, GENESIS);
  assert.equal(storage.local.get('notes').chain_id, 13);

  // Same id, different genesis — the case chain id alone cannot see.
  state.genesis = 'cc'.repeat(32);
  const differs = await backend.sync.scan(() => {});
  assert.ok(differs.wrongChain, 'two chains sharing an id were treated as one');
  assert.equal(differs.wrongChain.got.genesis, 'cc'.repeat(32));
});

test('IDENTITY: a node that stops naming its chain is a wrong chain, not a free pass', async () => {
  // THE PROBE: store knows chain 13 / aa…, node answers neither method. It used to scan happily,
  // because `chainIdentity` fell back to `settings.chainId`, which the backend always supplies.
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  const height = storage.local.get('notes').scanned_height;
  assert.ok(height > 0);

  const mute = build({ storage, fetch: nodeWithout(['rand_chainId', 'rand_getGenesisHash']) }).backend;
  const answer = await mute.sync.scan(() => {});
  assert.ok(answer.wrongChain, 'omitting two methods bypassed the whole wrong-chain refusal');
  assert.equal(answer.wrongChain.got.unknown, true);
  assert.equal(storage.local.get('notes').scanned_height, height, 'it scanned anyway');

  // Losing only one of the two it knows is enough.
  const half = build({ storage, fetch: nodeWithout(['rand_getGenesisHash']) }).backend;
  assert.ok((await half.sync.scan(() => {})).wrongChain, 'a node that dropped its genesis was accepted');
});

test('IDENTITY: a new wallet cannot be pinned to a chain it was not configured for', async () => {
  // The configured chain id is used for exactly one thing: catching this.
  const { backend, storage } = build({ fetch: chainFetch({ genesis: 'dd'.repeat(32), chainId: 14 }) });
  await backend.wallet.create(PASSWORD);
  const answer = await backend.sync.scan(() => {});
  assert.ok(answer.wrongChain, 'a brand-new wallet adopted an attacker’s chain');
  assert.equal(answer.wrongChain.expected.chainId, 13, 'the chain this wallet was built for');
  assert.equal(answer.wrongChain.got.chainId, 14);
  assert.equal(storage.local.get('notes').chain_id, null, 'it recorded the wrong chain anyway');
});

test('GATE: a URL change then an immediate faucet does not mint against an unchecked chain', async () => {
  // The un-named window: right after a URL change `wrongChain` was null, which read as "fine".
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});

  const wrongNode = chainFetch({ genesis: 'ee'.repeat(32), chainId: 14 }, { rand_mint: () => `0x${'ab'.repeat(32)}` });
  const moved = build({ storage, fetch: wrongNode }).backend;
  await moved.settings.set({ rpcUrl: 'http://127.0.0.1:7100' });
  await assert.rejects(() => moved.faucet.request(), (err) => {
    assert.match(err.message, /different chain/);
    assert.equal(err.definite, true);
    return true;
  });
  assert.equal(wrongNode.requests.some((r) => r.body.method === 'rand_mint'), false, 'it minted before checking');
  // The check is cheap and cached: two calls, not a scan.
  assert.equal(wrongNode.requests.some((r) => r.body.method === 'rand_getCommitments'), false);
});

test('GATE: a fresh session before any scan checks the chain before minting', async () => {
  const storage = mapStorage();
  const first = build({ storage }).backend;
  await first.wallet.create(PASSWORD);
  await first.sync.scan(() => {});

  // A new backend over the same storage: a reload. Nothing has been verified in THIS session.
  const rightNode = chainFetch({ genesis: GENESIS, chainId: 13 }, { rand_mint: () => `0x${'ab'.repeat(32)}` });
  const fresh = build({ storage, fetch: rightNode }).backend;
  await fresh.wallet.unlock(PASSWORD);
  const res = await fresh.faucet.request();
  assert.ok(res.hash);
  const identityCalls = rightNode.requests.filter((r) => r.body.method === 'rand_getGenesisHash').length;
  assert.equal(identityCalls, 1, `the chain was checked ${identityCalls} times, not once`);
  assert.ok(rightNode.requests.some((r) => r.body.method === 'rand_mint'));

  // …and cached for the session: a second faucet does not re-check.
  await fresh.faucet.request();
  assert.equal(rightNode.requests.filter((r) => r.body.method === 'rand_getGenesisHash').length, 1);
});

test('GATE: a node that cannot be reached is a retryable refusal, not a silent pass', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});

  const dead = async () => { throw new Error('connection refused'); };
  dead.requests = [];
  const offline = build({ storage, fetch: dead }).backend;
  await offline.settings.set({ rpcUrl: 'http://127.0.0.1:7200' });
  await assert.rejects(() => offline.faucet.request(), (err) => {
    assert.match(err.message, /Could not verify this node's chain/);
    assert.equal(err.retryable, true);
    assert.notEqual(err.definite, true, 'an unreachable node is not proof of anything');
    return true;
  });
  await assert.rejects(() => offline.send.maxSendable({ asset: 0 }), /Could not verify/);
});

test('GATE: an anonymous node cannot be acted on either', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  const mute = build({ storage, fetch: nodeWithout(['rand_chainId', 'rand_getGenesisHash'], { rand_mint: () => `0x${'ab'.repeat(32)}` }) }).backend;
  await mute.settings.set({ rpcUrl: 'http://127.0.0.1:7300' });
  await assert.rejects(() => mute.faucet.request(), /different chain|Could not verify/);
});

test('a block at the page limit is a typed error naming the limit', async () => {
  const rows = Array.from({ length: 500 }, () => ({ height: 0, nullifier: 'ab'.repeat(32) }));
  const { backend } = build({ fetch: stubFetch({ rand_getNullifiers: () => rows }) });
  await backend.wallet.create(PASSWORD);
  await assert.rejects(() => backend.sync.scan(() => {}), (err) => {
    assert.equal(err.name, 'NodeLimitError');
    assert.equal(err.code, 'too_many_nullifiers_in_block');
    assert.match(err.message, /500 or more nullifiers/);
    return true;
  });
});

test('the core’s next_index cannot carry the leaf cursor past the page it was given', async () => {
  const core = stubCore({
    scan_page: () => ({ received: [], sent: [], next_index: 9_000_000, rows: 1 }),
  });
  const fetch = stubFetch({
    rand_getTreeInfo: () => ({ next_index: 50, root: '0'.repeat(64), nullifiers: 0 }),
    rand_getCommitments: ([from]) => (from === 0
      ? [{ index: 0, cm: '0a'.repeat(32), height: 1, envelope: { kem_ct: '', to_receiver: '', to_sender: '', body: '' } }]
      : []),
  });
  const { backend, storage } = build({ core, fetch });
  await backend.wallet.create(PASSWORD);
  await backend.sync.scan(() => {});
  assert.equal(storage.local.get('notes').scanned_index, 1, 'the cursor took the core’s word over the page');
});

// =============================================================== fix round 5 ====================
// The reviewer's probes, as tests. Two scripted nodes on DISTINCT URLs, a reply held open and
// released by hand, and the per-URL RPC log asserted line by line — because the defect is not
// "the wrong answer" but "the right answer recorded against the wrong node".

const URL_A = 'http://127.0.0.1:7400';
const URL_B = 'http://127.0.0.1:7401';

/**
 * A fetch that serves several nodes, one per URL, and records every call as `port:method` in one
 * shared log — so a test can assert not only what was asked but *whom*.
 */
function nodeFarm(nodes) {
  const log = [];
  const held = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const port = String(url).split(':').pop();
    log.push(`${port}:${body.method}`);
    const node = nodes[url];
    if (!node) throw new Error(`no node at ${url}`);
    const answer = node[body.method];
    if (answer === undefined) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } }) };
    }
    let result;
    try { result = typeof answer === 'function' ? await answer(body.params) : answer; } catch (err) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: err.message } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  fn.log = log;
  fn.held = held;
  fn.callsTo = (port) => log.filter((line) => line.startsWith(`${port}:`));
  return fn;
}

/** The methods an honest node of a given chain answers. `hold` gates one method open. */
function node({ chainId, genesis, height = 100, hold }) {
  const base = {
    rand_getHead: { height, hash: 'ff'.repeat(32) },
    rand_getTreeInfo: { next_index: 0, root: '0'.repeat(64), nullifiers: 0 },
    rand_getCommitments: [],
    rand_getNullifiers: [],
    rand_getBridgeState: { enabled: false },
    rand_getAssets: [],
    rand_estimateFee: '1000000',
    rand_status: { height, peer_count: 1, syncing: false },
    rand_chainId: chainId,
    rand_getGenesisHash: genesis,
    rand_mint: `0x${'ab'.repeat(32)}`,
  };
  if (hold) base[hold.method] = async () => { await hold.gate; return hold.value; };
  return base;
}

test('PROBE: a scan of node A must not mark node B verified when B was saved mid-scan', async () => {
  // The scan runs on the SESSION signal, so it keeps going while the user is on Settings — an
  // ordinary journey. The verdict used to be stamped on whatever URL was current when the scan
  // RETURNED, so B was recorded `ok` without ever being asked an identity question.
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = nodeFarm({
    [URL_A]: node({ chainId: 13, genesis: GENESIS, hold: { method: 'rand_getCommitments', gate, value: [] } }),
    [URL_B]: node({ chainId: 14, genesis: 'cc'.repeat(32) }),
  });
  const storage = mapStorage();
  const { backend } = build({ storage, fetch });
  await backend.settings.set({ rpcUrl: URL_A });
  await backend.wallet.create(PASSWORD);

  const scanning = backend.sync.scan(() => {});
  await drain();
  await backend.settings.set({ rpcUrl: URL_B }); // the user saves a new node mid-scan
  release();
  const result = await scanning;

  // The scan of A is still a valid scan of A…
  assert.equal(result.head, 100);
  // …but it says so, so the UI can re-scan against B rather than show A's tip as B's.
  assert.equal(result.staleNode, true, 'the result did not say it came from the node that is no longer current');

  // …and B has been told nothing about itself.
  assert.deepEqual(fetch.callsTo('7401'), [], 'the scan talked to B at all');

  // The probe's payload: the faucet must now ask B who it is, and refuse.
  await assert.rejects(() => backend.faucet.request(), /different chain/);
  assert.deepEqual(
    fetch.callsTo('7401'),
    ['7401:rand_getGenesisHash', '7401:rand_chainId'],
    'the faucet acted on B without asking it anything',
  );
  assert.equal(fetch.log.includes('7401:rand_mint'), false, 'it minted on the chain-14 node');
});

test('PROBE: the same for rescan', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = nodeFarm({
    [URL_A]: node({ chainId: 13, genesis: GENESIS, hold: { method: 'rand_getCommitments', gate, value: [] } }),
    [URL_B]: node({ chainId: 14, genesis: 'cc'.repeat(32) }),
  });
  const storage = mapStorage();
  const { backend } = build({ storage, fetch });
  await backend.settings.set({ rpcUrl: URL_A });
  await backend.wallet.create(PASSWORD);

  const rescanning = backend.sync.rescan();
  await drain();
  await backend.settings.set({ rpcUrl: URL_B });
  release();
  await rescanning;

  await assert.rejects(() => backend.faucet.request(), /different chain/);
  assert.equal(fetch.log.includes('7401:rand_mint'), false, 'a rescan of A blessed B');
});

test('PROBE: a URL change DURING the identity check does not send the mint to the new node', async () => {
  // The gate captured one client at entry; the caller then did its own `await rpcClient()`, which
  // after a URL change returns a different node. Log ended `7400:…, 7400:…, 7401:rand_mint`.
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = nodeFarm({
    [URL_A]: node({ chainId: 13, genesis: GENESIS, hold: { method: 'rand_chainId', gate, value: 13 } }),
    [URL_B]: node({ chainId: 14, genesis: 'cc'.repeat(32) }),
  });
  // No prior scan: A is unverified, so the faucet's own gate does the identity round trip — which
  // is exactly the window this probe opens.
  const storage = mapStorage();
  const { backend } = build({ storage, fetch });
  await backend.settings.set({ rpcUrl: URL_A });
  await backend.wallet.create(PASSWORD);

  const minting = backend.faucet.request();
  await drain();
  await backend.settings.set({ rpcUrl: URL_B }); // changes while the identity round trip is open
  release();
  await minting.catch(() => {});

  assert.equal(fetch.log.includes('7401:rand_mint'), false, 'it minted on the node it never verified');
  assert.ok(fetch.log.includes('7400:rand_mint'), 'the mint did not go to the node the gate verified');
});

test('PROBE: a URL change during the identity check does not price the fee on the new node', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = nodeFarm({
    [URL_A]: node({ chainId: 13, genesis: GENESIS, hold: { method: 'rand_chainId', gate, value: 13 } }),
    [URL_B]: node({ chainId: 14, genesis: 'cc'.repeat(32) }),
  });
  const storage = mapStorage();
  const { backend } = build({ storage, fetch });
  await backend.settings.set({ rpcUrl: URL_A });
  await backend.wallet.create(PASSWORD);

  const pricing = backend.send.maxSendable({ asset: 0 });
  await drain();
  await backend.settings.set({ rpcUrl: URL_B });
  release();
  await pricing.catch(() => {});

  assert.equal(fetch.log.includes('7401:rand_estimateFee'), false,
    'a chain-14 fee was fetched for chain-13 notes');
  assert.ok(fetch.log.includes('7400:rand_estimateFee'), 'the fee did not come from the verified node');
});

test('a store that knows only its chain id learns its genesis from a node whose id matches', async () => {
  // What round 3's code persisted. Without this it accepts chain 13 with ANY genesis for ever —
  // and this replaces the coverage deleted in round 4.
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  storage.local.set('notes', { ...storage.local.get('notes'), chain_id: 13, genesis: null });

  const answer = await backend.sync.scan(() => {});
  assert.equal(answer.wrongChain, undefined, 'a matching chain id was called a mismatch');
  assert.equal(storage.local.get('notes').genesis, GENESIS, 'the missing half was never learned');

  // …and from then on a different genesis on the same id is caught.
  const other = build({ storage, fetch: chainFetch({ genesis: 'cc'.repeat(32), chainId: 13 }) }).backend;
  assert.ok((await other.sync.scan(() => {})).wrongChain, 'chain 13 with any genesis was accepted');
});

test('a store that knows only its chain id refuses a node with a different one', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  storage.local.set('notes', { ...storage.local.get('notes'), chain_id: 13, genesis: null });

  const moved = build({ storage, fetch: chainFetch({ genesis: GENESIS, chainId: 14 }) }).backend;
  const answer = await moved.sync.scan(() => {});
  assert.ok(answer.wrongChain, 'a chain-id-only store accepted another chain');
  assert.equal(answer.wrongChain.got.chainId, 14);
  assert.equal(storage.local.get('notes').genesis, null, 'it adopted the wrong chain’s genesis');
});

test('a store that knows only its genesis learns its chain id the same way', async () => {
  const storage = mapStorage();
  const { backend } = build({ storage });
  await backend.wallet.create(PASSWORD);
  storage.local.set('notes', { ...storage.local.get('notes'), chain_id: null, genesis: GENESIS });
  await backend.sync.scan(() => {});
  assert.equal(storage.local.get('notes').chain_id, 13);
});

test('send.send declares the contract signature the desktop backend will copy', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  assert.equal(backend.send.send.length, 2, '(req, onPhase, options = {}) — options has a default');
  // …and it still refuses, taking its arguments without using them.
  const phases = [];
  const ac = new AbortController();
  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, (p) => phases.push(p), { signal: ac.signal }),
    (err) => { assert.equal(err.definite, true); return true; },
  );
  assert.deepEqual(phases, []);
});
