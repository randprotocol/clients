// The stubs every Backend test drives a real backend with: a stub core, Map-backed storage, a
// stub `fetch` that answers JSON-RPC, and the probes that watch what they were handed.
//
// Extracted from `backend-wasm.test.mjs` for task 3.2, which adds a second real Backend
// (`ui/engine/backend-native.js`). Both are the SAME ~1100 lines of `backend-shared.js` wrapped in
// a different `canProve`/`executeSend`, so both are tested against the same fixtures and — see
// `./backend-cases.mjs` — the same inherited cases, rather than a copy of each that can drift.
//
// Nothing here touches a browser, IndexedDB, a node, or a Tauri command.
import assert from 'node:assert/strict';

export const SPEND_KEY = 'a1'.repeat(32);
export const VIEWING_KEY = 'b2'.repeat(32);
export const PK = 'c3'.repeat(32);
export const ADDRESS = 'rand1' + 'q'.repeat(60);
export const PASSWORD = 'correct-horse-battery-staple';
export const GENESIS = 'aa'.repeat(32);

// ------------------------------------------------------------------------------- stub storage --
/** The `storage` contract a backend factory takes, over two Maps. `session` is memory-only. */
export function mapStorage() {
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

/** A Map-backed storage with the optional conditional write, as web/wallet/idb.js provides it. */
export function casStorage() {
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

/**
 * Drains the microtask queue. Every assertion that follows a `t.mock.timers.tick()` needs this,
 * and so does every assertion *before* one: with `setTimeout` mocked, a `sleep()` deep inside an
 * async chain has not been scheduled yet when the chain's first `await` returns, so ticking before
 * the chain reaches it would advance a clock nothing is waiting on.
 */
export async function drain(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------------- stub core --
export function stubCore(overrides = {}) {
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
export function stubFetch(table = {}) {
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

/** A fetch whose genesis hash (and chain id) can be switched between calls. */
export function chainFetch(state, table = {}) {
  return stubFetch({
    rand_getGenesisHash: () => state.genesis,
    rand_chainId: () => state.chainId,
    ...table,
  });
}

/** A node that answers only the methods listed; anything else is an unknown-method RPC error. */
export function nodeWithout(missing, table = {}) {
  const gone = {};
  for (const method of missing) gone[method] = () => { throw new Error(`unknown method ${method}`); };
  return stubFetch({ ...gone, ...table });
}

export function stubPlatform() {
  const copied = [];
  return { name: 'test', copied, openExternal() {}, copy(text) { copied.push(text); } };
}

/**
 * Spies on WebCrypto for the duration of `fn`, recording when each PBKDF2 derivation *starts* and
 * *ends* — which is how "the attempts ran one at a time" is asserted, rather than by timing.
 */
export async function withKdfSpy(fn) {
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
export function everythingRecorded({ core, storage, fetch, platform }) {
  return JSON.stringify([
    core.calls.map(([m, p]) => [m, p]),
    storage.writes,
    [...storage.local.entries()],
    fetch.requests,
    platform.copied || [],
  ]);
}

export function assertKeyNeverLeaked(env, key = SPEND_KEY) {
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

// --------------------------------------------------------------------- several nodes at once ---
export const URL_A = 'http://127.0.0.1:7400';
export const URL_B = 'http://127.0.0.1:7401';
export const URL_C = 'http://127.0.0.1:7402';

/**
 * A fetch that serves several nodes, one per URL, and records every call as `port:method` in one
 * shared log — so a test can assert not only what was asked but *whom*.
 */
export function nodeFarm(nodes) {
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

/**
 * A `nodeFarm` with holes in the WIRE rather than in the node: `isDead(url, method)` decides which
 * requests never reach an endpoint at all.
 *
 * The difference matters and is the whole reason this exists (task 5.0). A `nodeFarm` handler that
 * throws produces a JSON-RPC *error reply* — the node answered, and a wallet must never repeat
 * that question elsewhere. What a proxy going away produces is a `fetch` that rejects before a
 * reply exists, which is the only failure a wallet may carry to another endpoint. Dead requests
 * are still logged (with a trailing `!`) so a test can assert they were attempted.
 */
export function unreachable(farm, isDead) {
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (isDead(url, body.method)) {
      farm.log.push(`${String(url).split(':').pop()}:${body.method}!`);
      throw new TypeError('fetch failed');
    }
    return farm(url, init);
  };
  fn.log = farm.log;
  fn.callsTo = farm.callsTo;
  return fn;
}

/** The methods an honest node of a given chain answers. `hold` gates one method open. */
export function node({ chainId, genesis, height = 100, hold }) {
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

/**
 * Records every `Map.prototype.set` made while `run()` is in flight.
 *
 * `chainState` (backend-shared.js) is a private closure variable with no getter in the Backend
 * contract, so the only way to see what a scan recorded against a URL without changing production
 * code is to watch the `Map.set` that writes it — the same kind of black-box probe as the fetch
 * log above, aimed at a different boundary. `mapStorage`'s own `local`/`sessionMap` are real
 * `Map`s too, so several other entries come through this same patch (the note store, the wallet
 * record, …); none of them is `{state: 'ok', …}` shaped, which is what the callers actually look
 * for, so they need no filtering by hand.
 */
export async function capturingMapWrites(run) {
  const captured = [];
  const original = Map.prototype.set;
  Map.prototype.set = function patched(key, value) { captured.push([key, value]); return original.call(this, key, value); };
  try {
    await run();
  } finally {
    Map.prototype.set = original;
  }
  return captured;
}
