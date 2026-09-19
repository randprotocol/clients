// The scan engine's own invariants, driven directly rather than through the Backend: a cursor and
// the data it covers move together, and a store whose cursors are unusable is never persisted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWallet, emptyNoteStore, BUNDLE_INPUTS } from '../engine/wallet.js';

const HEX64 = (b) => String(b).repeat(32);
const SPEND_KEY = 'a1'.repeat(32);

function envelope() {
  return { kem_ct: '', to_receiver: '', to_sender: '', body: '' };
}

/** A note store in a Map, with the shape `makeWallet` expects. */
function memoryStore(initial = emptyNoteStore()) {
  let current = JSON.parse(JSON.stringify(initial));
  const writes = [];
  return {
    get current() { return current; },
    writes,
    async getNoteStore() { return JSON.parse(JSON.stringify(current)); },
    async setNoteStore(s) { writes.push(JSON.parse(JSON.stringify(s))); current = JSON.parse(JSON.stringify(s)); },
  };
}

function stubCore(overrides = {}) {
  const defaults = {
    scan_page: ({ rows }) => ({
      received: [], sent: [],
      next_index: rows.length ? rows[rows.length - 1].index + 1 : 0,
      rows: rows.length,
    }),
    pending_cleared: () => false,
    rebuilt_deposit: () => null,
  };
  const impl = { ...defaults, ...overrides };
  return { async call(method, params = {}) { const fn = impl[method]; if (!fn) throw new Error(`unknown ${method}`); return fn(params); } };
}

/** A node built from a table of `method -> (args) => result`, in `makeRpc`'s client shape. */
function stubClient(table = {}) {
  const calls = [];
  const d = {
    head: () => ({ height: 20, hash: HEX64('ab') }),
    // `next_index` must be consistent with what `commitments` serves: the engine cross-checks a
    // page against the leaf count, so a stub that serves leaf 0 while claiming 0 leaves is a
    // hostile node, not a fixture.
    treeInfo: () => ({ next_index: 64, root: HEX64('00'), nullifiers: 0 }),
    commitments: () => [],
    nullifiers: () => [],
    anchor: () => ({ height: 20, root: HEX64('ab') }),
    bridgeState: () => ({ enabled: false }),
    blockByHeight: (h) => ({ height: h, timestamp_ms: 1788000000000, transactions: [] }),
    chainId: () => 13,
    getTransaction: () => null,
    genesis: () => GENESIS_A,
  };
  const impl = { ...d, ...table };
  const client = {};
  for (const name of Object.keys(impl)) {
    if (name === 'genesis') continue;
    client[name] = async (...args) => { calls.push([name, ...args]); return impl[name](...args); };
  }
  // The engine asks for the genesis hash through the raw `rpc(method, params)` escape hatch.
  client.rpc = async (method, params) => {
    calls.push(['rpc', method, params]);
    if (method === 'rand_getGenesisHash') return impl.genesis();
    throw new Error(`stub node has no ${method}`);
  };
  client.calls = calls;
  return client;
}

const GENESIS_A = 'aa'.repeat(32);
const GENESIS_B = 'bb'.repeat(32);

test('BUNDLE_INPUTS is the chain rule, written down once', () => {
  assert.equal(BUNDLE_INPUTS, 2);
});

test('the attest cursor does not advance when the scan that covered it was aborted', async () => {
  // A bridge deposit lives in a committed block, and the wallet learns of it by reading those
  // blocks once. If the cursor past them is persisted while the deposits gathered for that range
  // are dropped — which an abort between commitment pages used to do — the deposit is missed for
  // ever, because the range is never read again.
  const deposit = {
    index: 18446744073709551615, note: '00'.repeat(112), cm: HEX64('de'), nf: HEX64('df'),
    amount: '4000000000', asset: 0, time: 3, from: '00'.repeat(32), height: 0, spent: false, pending: null,
  };
  const store = memoryStore();
  const controller = new AbortController();

  let pages = 0;
  const client = stubClient({
    bridgeState: () => ({ enabled: true }),
    blockByHeight: (h) => ({
      height: h,
      timestamp_ms: 1788000000000,
      transactions: h === 5 ? [{ action: { kind: 'bridge_attest' } }] : [],
    }),
    commitments: (from) => {
      pages += 1;
      // The first page arrives, then the session ends — exactly the abort the user causes by
      // locking, or the shell causes on teardown.
      if (pages === 1) { controller.abort(); return [{ index: from, cm: HEX64('11'), height: 4, envelope: envelope() }]; }
      return [];
    },
  });

  const core = stubCore({ rebuilt_deposit: () => deposit });
  const wallet = makeWallet({ core, store, rpc: () => client, settings: async () => ({}) });

  await assert.rejects(
    () => wallet.scan(SPEND_KEY, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(store.current.scanned_attest_height, 0, 'the attest cursor moved past a range whose deposits were discarded');

  // The rescan reads the same blocks, finds the deposit again, and this time places it.
  const client2 = stubClient({
    bridgeState: () => ({ enabled: true }),
    blockByHeight: (h) => ({ height: h, timestamp_ms: 1788000000000, transactions: h === 5 ? [{ action: { kind: 'bridge_attest' } }] : [] }),
    commitments: (from) => (from === 0 ? [{ index: 0, cm: HEX64('de'), height: 6, envelope: envelope() }] : []),
  });
  const wallet2 = makeWallet({ core, store, rpc: () => client2, settings: async () => ({}) });
  const after = await wallet2.scan(SPEND_KEY, {});
  assert.ok(after.notes.some((n) => n.cm === HEX64('de')), 'the bridge deposit was lost for good');
  assert.equal(after.scanned_attest_height, 21, 'and only now does the cursor move');
});

test('a successful scan does advance the attest cursor', async () => {
  const store = memoryStore();
  const client = stubClient({ bridgeState: () => ({ enabled: true }) });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}) });
  const st = await wallet.scan(SPEND_KEY, {});
  assert.equal(st.scanned_attest_height, 21);
});

test('annotate:false skips the block-header pass entirely', async () => {
  const withAnnotation = memoryStore();
  const note = {
    index: 0, note: '00'.repeat(112), cm: HEX64('0b'), nf: HEX64('0c'),
    amount: '5', asset: 0, time: 4, from: '00'.repeat(32), height: 4, spent: false, pending: null,
  };
  const core = stubCore({
    scan_page: ({ rows }) => ({ received: rows.length ? [note] : [], sent: [], next_index: rows.length ? 1 : 0, rows: rows.length }),
  });
  const page = (from) => (from === 0 ? [{ index: 0, cm: HEX64('0b'), height: 4, envelope: envelope() }] : []);

  const onClient = stubClient({ commitments: page });
  await makeWallet({ core, store: withAnnotation, rpc: () => onClient, settings: async () => ({}) }).scan(SPEND_KEY, {});
  assert.ok(onClient.calls.some(([name]) => name === 'blockByHeight'), 'the default did not date the note');
  assert.ok(withAnnotation.current.block_times[4], 'no timestamp was cached');

  const offStore = memoryStore();
  const offClient = stubClient({ commitments: page });
  await makeWallet({ core, store: offStore, rpc: () => offClient, settings: async () => ({}), annotate: false }).scan(SPEND_KEY, {});
  assert.equal(offClient.calls.some(([name]) => name === 'blockByHeight'), false,
    'annotate:false still read block headers — the old extension pays for a feature it cannot show');
  assert.deepEqual(offStore.current.block_times, {});
});

test('persist refuses a broken or regressing cursor and leaves the store alone', async () => {
  const store = memoryStore();
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({}) });
  await wallet.scan(SPEND_KEY, {});
  const good = JSON.parse(JSON.stringify(store.current));

  const st = await wallet.loadStore();
  for (const broken of [Number.NaN, null, '12', Infinity, -1, 1.5]) {
    await assert.rejects(
      () => wallet.persist({ ...st, scanned_index: broken }, st),
      /refusing to save the note store: scanned_index is not a block cursor/,
      `a cursor of ${String(broken)} was accepted`,
    );
  }
  await assert.rejects(
    () => wallet.persist({ ...st, scanned_height: 1 }, { ...st, scanned_height: 9 }),
    /scanned_height moved backwards, 9 → 1/,
  );
  assert.deepEqual(store.current, good, 'a refused write changed the store');
});

test('a store with unusable cursors is reset for a full rescan, keeping its notes', async () => {
  const note = {
    index: 3, note: '00'.repeat(112), cm: HEX64('0b'), nf: HEX64('0c'),
    amount: '5', asset: 0, time: 4, from: '00'.repeat(32), height: 4, spent: false, pending: null,
  };
  const store = memoryStore({
    ...emptyNoteStore(), notes: [note],
    scanned_index: Number.NaN, scanned_height: '900', scanned_attest_height: 0, head: 0,
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({}) });

  const loaded = await wallet.loadStore();
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.scanned_index, 0);
  assert.equal(loaded.scanned_height, 0);
  assert.equal(loaded.notes.length, 1, 'the notes went with the cursors');

  const st = await wallet.scan(SPEND_KEY, {});
  assert.equal(st.recovered, true, 'the caller was not told');
  assert.equal(JSON.stringify(store.current).includes('null'), true); // `pending: null` — sanity
  assert.equal(store.current.recovered, undefined, 'a transient flag was persisted');
  assert.equal(store.current.rev, undefined, 'a transient revision was persisted');
  for (const key of ['scanned_index', 'scanned_height', 'scanned_attest_height', 'head']) {
    assert.ok(Number.isSafeInteger(store.current[key]), `${key} is ${String(store.current[key])}`);
  }
});

test('a lost conditional write is merged with the other writer, and a second loss is retryable', async () => {
  const backing = memoryStore();
  let rev = 0;
  let stealNext = true;
  const otherNote = {
    index: 77, note: '00'.repeat(112), cm: HEX64('ee'), nf: HEX64('ef'),
    amount: '9', asset: 0, time: 1, from: '00'.repeat(32), height: 1, spent: false, pending: null,
  };
  const store = {
    async getNoteStore() { return { ...(await backing.getNoteStore()), rev }; },
    async setNoteStore(s) { await backing.setNoteStore(s); },
    async compareAndSet(value, expectedRev) {
      if (stealNext) {
        // Another tab wrote between this scan's load and its save.
        stealNext = false;
        const current = await backing.getNoteStore();
        await backing.setNoteStore({ ...current, notes: [...current.notes, otherNote] });
        rev += 1;
        const err = new Error('stale');
        err.name = 'StaleStoreError';
        throw err;
      }
      if (expectedRev !== rev) { const err = new Error('stale'); err.name = 'StaleStoreError'; throw err; }
      rev += 1;
      await backing.setNoteStore(value);
      return rev;
    },
  };
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({}) });
  const st = await wallet.scan(SPEND_KEY, {});
  assert.ok(st.notes.some((n) => n.index === 77), "the other tab's note was overwritten");
  assert.ok(backing.current.notes.some((n) => n.index === 77));

  // A store that loses every race gives up with something the UI can offer a retry for.
  const always = {
    async getNoteStore() { return emptyNoteStore(); },
    async setNoteStore() {},
    async compareAndSet() { const err = new Error('stale'); err.name = 'StaleStoreError'; throw err; },
  };
  const loser = makeWallet({ core: stubCore(), store: always, rpc: () => stubClient(), settings: async () => ({}) });
  await assert.rejects(() => loser.scan(SPEND_KEY, {}), (err) => {
    assert.equal(err.retryable, true);
    assert.match(err.message, /another tab changed this wallet/);
    return true;
  });
});

// =============================================================== fix round 2 ====================

test('persist accepts a tip that went down, and still refuses a work cursor that did', async () => {
  // `head` is the node's REPORTED tip — a mirror of something a remote server said, not work this
  // wallet did. Enforcing it as monotone bricked the wallet: one lagging replica, or one node
  // restored from a snapshot, and every later save threw for ever with no way out but a wipe.
  const store = memoryStore();
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({}) });
  const st = await wallet.loadStore();
  const high = { ...st, head: 5000, scanned_height: 100 };

  await assert.doesNotReject(
    () => wallet.persist({ ...high, head: 10 }, high),
    'a tip that moved down was refused — this is the bricking regression',
  );
  await assert.rejects(
    () => wallet.persist({ ...high, scanned_height: 1 }, high),
    /scanned_height moved backwards/,
    'a WORK cursor going backwards must still be refused',
  );
});

test('a node whose tip is behind the wallet yields `behind`, changes nothing, and recovers', async () => {
  const store = memoryStore();
  const settings = async () => ({ chainId: 13 });

  // First scan against a healthy node at height 20.
  const healthy = stubClient();
  await makeWallet({ core: stubCore(), store, rpc: () => healthy, settings }).scan(SPEND_KEY, {});
  const afterFirst = JSON.parse(JSON.stringify(store.current));
  assert.ok(afterFirst.scanned_height > 0);

  // Now the same wallet against a replica that has only reached height 4.
  const lagging = stubClient({ head: () => ({ height: 4, hash: HEX64('ab') }) });
  const laggingWallet = makeWallet({ core: stubCore(), store, rpc: () => lagging, settings });
  const answer = await laggingWallet.scan(SPEND_KEY, {});
  assert.deepEqual(answer.behind, { tip: 4, wallet: afterFirst.scanned_height - 1 });
  assert.deepEqual(store.current, afterFirst, 'a node that is behind changed the store');
  assert.equal(lagging.calls.some(([name]) => name === 'nullifiers'), false, 'it scanned anyway');

  // And when the node catches up, scanning simply resumes — no rescan, no wipe.
  const caughtUp = stubClient({ head: () => ({ height: 30, hash: HEX64('ab') }) });
  const after = await makeWallet({ core: stubCore(), store, rpc: () => caughtUp, settings }).scan(SPEND_KEY, {});
  assert.equal(after.behind, undefined);
  assert.equal(store.current.head, 30);
  assert.ok(store.current.scanned_height >= afterFirst.scanned_height);
});

test('a hostile tip near 2^53 advances a cursor by at most one page span, and the honest node still works', async () => {
  // The other half of the regression: one `rand_getHead` of 9_007_199_254_000_000 passes
  // `intField`, and the old code wrote it straight into `scanned_height`/`scanned_attest_height`,
  // after which every honest node was "behind" for ever.
  const HOSTILE = 9_007_199_254_000_000;
  const store = memoryStore();
  const settings = async () => ({ chainId: 13 });
  const hostile = stubClient({ head: () => ({ height: HOSTILE, hash: HEX64('ab') }) });
  await makeWallet({ core: stubCore(), store, rpc: () => hostile, settings }).scan(SPEND_KEY, {});

  assert.equal(store.current.head, HOSTILE, 'the tip is recorded for display…');
  // One scan advances a height cursor by at most one page span per reply, capped per scan — so
  // the claim costs a bounded amount of re-reading instead of jumping the cursor to 2^53.
  const CAP = 500 * 512;
  assert.ok(store.current.scanned_height <= CAP + 1,
    `…but a work cursor took the claim whole: scanned_height is ${store.current.scanned_height}`);
  assert.ok(store.current.scanned_attest_height <= 512,
    `the attest cursor took the claim whole: ${store.current.scanned_attest_height}`);

  // And the honest node is *recoverable*, not locked out for ever: it reports `behind` — a
  // non-destructive state with a one-click cure — rather than throwing on every future save.
  const honest = stubClient({ head: () => ({ height: 20, hash: HEX64('ab') }) });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => honest, settings });
  const answer = await wallet.scan(SPEND_KEY, {});
  assert.equal(answer.wrongChain, undefined);
  assert.ok(answer.behind, 'a wallet ahead of an honest node should say so');
  await assert.doesNotReject(() => wallet.rescan(SPEND_KEY, {}), 'and rescan must be the way out');
  assert.equal(store.current.head, 20, 'after the rescan the honest tip is what is recorded');
  assert.ok(store.current.scanned_height <= 21);
});

test('a node on another chain yields `wrongChain` and touches nothing', async () => {
  const store = memoryStore();
  const settings = async () => ({ chainId: 13 });
  await makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings }).scan(SPEND_KEY, {});
  const before = JSON.parse(JSON.stringify(store.current));
  assert.equal(before.genesis, GENESIS_A, 'the first scan did not record the chain identity');

  const other = stubClient({ genesis: () => GENESIS_B, chainId: () => 14 });
  const answer = await makeWallet({ core: stubCore(), store, rpc: () => other, settings }).scan(SPEND_KEY, {});
  assert.deepEqual(answer.wrongChain, {
    expected: { chainId: 13, genesis: GENESIS_A },
    got: { chainId: 14, genesis: GENESIS_B },
  });
  assert.deepEqual(store.current, before, 'a wrong-chain node changed the store');
  assert.equal(other.calls.some(([name]) => name === 'commitments'), false, 'it scanned the wrong chain anyway');
});

test('a chain id that differs is caught even when the node serves no genesis hash', async () => {
  const store = memoryStore();
  const older = (id) => stubClient({ chainId: () => id, genesis: () => { throw new Error('no such method'); } });
  await makeWallet({ core: stubCore(), store, rpc: () => older(13), settings: async () => ({}) }).scan(SPEND_KEY, {});
  assert.equal(store.current.genesis, null);
  assert.equal(store.current.chain_id, 13);

  const answer = await makeWallet({ core: stubCore(), store, rpc: () => older(14), settings: async () => ({}) }).scan(SPEND_KEY, {});
  assert.equal(answer.wrongChain.got.chainId, 14);
});

test('rescan re-reads from the start, and for a chain change drops the old chain history', async () => {
  const note = {
    index: 3, note: '00'.repeat(112), cm: HEX64('0b'), nf: HEX64('0c'),
    amount: '5', asset: 0, time: 4, from: '00'.repeat(32), height: 4, spent: false, pending: null,
  };
  const core = stubCore({
    scan_page: ({ rows }) => ({ received: rows.length ? [note] : [], sent: [], next_index: rows.length ? 1 : 0, rows: rows.length }),
  });
  const page = (from) => (from === 0 ? [{ index: 0, cm: HEX64('0b'), height: 4, envelope: envelope() }] : []);
  const store = memoryStore();
  const client = stubClient({ commitments: page });
  const wallet = makeWallet({ core, store, rpc: () => client, settings: async () => ({ chainId: 13 }) });
  await wallet.scan(SPEND_KEY, {});
  assert.equal(store.current.notes.length, 1);
  assert.equal(store.current.scanned_index, 1);

  // A plain rescan: cursors reset, the chain read again, the note found again.
  const plain = await wallet.rescan(SPEND_KEY, {});
  assert.equal(plain.notes.length, 1);
  assert.equal(plain.scanned_index, 1);

  // A chain rescan against the other chain: the old chain's history goes, the identity is renewed.
  const other = stubClient({ commitments: () => [], genesis: () => GENESIS_B, chainId: () => 14 });
  const moved = makeWallet({ core, store, rpc: () => other, settings: async () => ({ chainId: 14 }) });
  const fresh = await moved.rescan(SPEND_KEY, { forChain: true });
  assert.equal(fresh.notes.length, 0, "the old chain's notes survived a chain rescan");
  assert.equal(store.current.genesis, GENESIS_B);
  assert.equal(store.current.chain_id, 14);
  assert.equal(fresh.wrongChain, undefined, 'the rescan did not adopt the new chain');
});

test('the attest scan is capped per scan and advances only as far as it examined', async () => {
  const store = memoryStore();
  const seen = [];
  const client = stubClient({
    head: () => ({ height: 5000, hash: HEX64('ab') }),
    bridgeState: () => ({ enabled: true }),
    blockByHeight: (h) => { seen.push(h); return { height: h, timestamp_ms: 1788000000000, transactions: [] }; },
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
  await wallet.scan(SPEND_KEY, {});

  assert.ok(seen.length <= 512, `${seen.length} block headers in one scan — the loop is uncapped`);
  assert.equal(store.current.scanned_attest_height, 512, 'the cursor ran past the blocks examined');

  // The next scan carries on from there rather than starting again.
  seen.length = 0;
  await wallet.scan(SPEND_KEY, {});
  assert.equal(seen[0], 512);
  assert.equal(store.current.scanned_attest_height, 1024);
});

test('a block action is size-bounded and re-parsed before it reaches the core', async () => {
  const given = [];
  const core = stubCore({ rebuilt_deposit: ({ action }) => { given.push(action); return null; } });
  const store = memoryStore();

  // A getter that would run inside the core binding, and a prototype trick, are both gone by the
  // time the action is handed over — it is JSON that came back through `JSON.parse`.
  const nasty = { kind: 'bridge_attest', get trap() { throw new Error('a getter ran'); } };
  const client = stubClient({
    head: () => ({ height: 1, hash: HEX64('ab') }),
    bridgeState: () => ({ enabled: true }),
    blockByHeight: () => ({ height: 0, transactions: [{ action: { kind: 'bridge_attest', amount: 5 } }, { action: nasty }] }),
  });
  await makeWallet({ core, store, rpc: () => client, settings: async () => ({}), annotate: false }).scan(SPEND_KEY, {});
  assert.ok(given.length >= 1);
  for (const action of given) {
    assert.equal(Object.getPrototypeOf(action), Object.prototype, 'the core was handed a non-plain object');
  }

  // An action larger than the cap fails the scan rather than being passed on.
  const huge = { kind: 'bridge_attest', blob: 'x'.repeat(20000) };
  const big = stubClient({
    head: () => ({ height: 1, hash: HEX64('ab') }),
    bridgeState: () => ({ enabled: true }),
    blockByHeight: () => ({ height: 0, transactions: [{ action: huge }] }),
  });
  await assert.rejects(
    () => makeWallet({ core, store: memoryStore(), rpc: () => big, settings: async () => ({}) }).scan(SPEND_KEY, {}),
    (err) => err.name === 'NodeReplyError',
  );
});

// =============================================================== fix round 3 ====================
// The probes the round-2 re-review ran against the real engine, as tests.

const nf = (height) => ({ height, nullifier: `${(height % 100).toString().padStart(2, '0')}`.repeat(32) });

test('PROBE: a full nullifier page all claiming tip-1 cannot carry the cursor over the heights between', async () => {
  // One full page from 0 whose 500 rows all claim height 3999 against tip 4000, then an empty
  // page → `scanned_height = 4001` in two replies, and heights 1…3998 were never read. Any
  // nullifier there is missed for ever: a spent note stays spendable.
  const store = memoryStore();
  let served = 0;
  const client = stubClient({
    head: () => ({ height: 4000, hash: HEX64('ab') }),
    nullifiers: (from) => {
      served += 1;
      if (from === 0) return Array.from({ length: 500 }, () => nf(3999));
      return [];
    },
  });
  const asked = [];
  const spy = stubClient({
    head: () => ({ height: 4000, hash: HEX64('ab') }),
    nullifiers: (from) => {
      asked.push(from);
      served += 1;
      if (from === 0) return Array.from({ length: 500 }, () => nf(3999));
      return [];
    },
  });
  void client;
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => spy, settings: async () => ({}), annotate: false });
  await wallet.scan(SPEND_KEY, {});

  // The page claimed to answer "everything from 0" with 500 rows that are all at 3999. It is a
  // legitimate prefix only if nothing exists in 0…3998 — which it did not demonstrate, so the
  // cursor takes one span, not 4000 heights.
  assert.equal(asked[1], 500, `the second request was from ${asked[1]}: the page carried the cursor over 1…3998`);
  assert.ok(served >= 8, `the whole range was covered in ${served} replies, so most of it was never asked about`);
  // It does end up caught up — over many replies, each of which asked about its own span.
  assert.equal(store.current.scanned_height, 4001);
});

test('a full page moves the cursor to its last height, and no further than one span', async () => {
  const store = memoryStore();
  const asked = [];
  const client = stubClient({
    head: () => ({ height: 10_000, hash: HEX64('ab') }),
    nullifiers: (from) => {
      asked.push(from);
      // A dense chain: a full page whose last row is 100 heights up.
      if (from < 300) return Array.from({ length: 500 }, (_, i) => nf(from + Math.floor(i / 5)));
      return [];
    },
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
  await wallet.scan(SPEND_KEY, {});
  // Each full page stopped AT its last height (that height may have been truncated mid-way), so
  // the next request re-reads it rather than stepping over it.
  assert.deepEqual(asked.slice(0, 3), [0, 99, 198]);
});

test('a nullifier page that does not answer the request is refused, and nothing is persisted', async () => {
  const cases = {
    'a row below the height asked for': (from) => (from === 0 ? [] : [nf(0)]),
    'a row above the tip this node reported': () => [nf(9_000)],
    'rows out of order': () => [nf(9), nf(4)],
  };
  for (const [what, rows] of Object.entries(cases)) {
    const store = memoryStore();
    // A tip well past one span, so the loop really does make a second request.
    const client = stubClient({ head: () => ({ height: 3_000, hash: HEX64('ab') }), nullifiers: rows });
    const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
    const before = JSON.stringify(store.current);
    await assert.rejects(() => wallet.scan(SPEND_KEY, {}), (err) => {
      assert.equal(err.name, 'NodeReplyError', `${what}: got ${err.name}`);
      return true;
    });
    assert.equal(JSON.stringify(store.current), before, `${what}: the store was written`);
  }
});

test('PROBE: a commitment page that starts somewhere else is refused', async () => {
  // A node serving leaf 900 for a request from 0 used to move `scanned_index` to 901, leaving
  // 0–899 never trial-decrypted — received notes silently missing.
  const store = memoryStore();
  const client = stubClient({
    commitments: (from) => (from === 0 ? [{ index: 900, cm: HEX64('0b'), height: 4, envelope: envelope() }] : []),
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
  await assert.rejects(() => wallet.scan(SPEND_KEY, {}), (err) => err.name === 'NodeReplyError');
  assert.equal(store.current.scanned_index, 0, 'the cursor moved over leaves that were never read');
});

test('a commitment page may not claim leaves the tree says do not exist', async () => {
  const store = memoryStore();
  const client = stubClient({
    treeInfo: () => ({ next_index: 1, root: HEX64('00'), nullifiers: 0 }),
    commitments: (from) => (from === 0
      ? [{ index: 0, cm: HEX64('0b'), height: 4, envelope: envelope() }, { index: 1, cm: HEX64('0c'), height: 4, envelope: envelope() }]
      : []),
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
  await assert.rejects(() => wallet.scan(SPEND_KEY, {}), /past the 1 leaves/);
  assert.equal(store.current.scanned_index, 0);
});

test('a bridge state that could not be read does not advance the attest cursor', async () => {
  const store = memoryStore();
  const client = stubClient({
    head: () => ({ height: 900, hash: HEX64('ab') }),
    bridgeState: () => { throw new Error('the node is having a moment'); },
  });
  const wallet = makeWallet({ core: stubCore(), store, rpc: () => client, settings: async () => ({}), annotate: false });
  const st = await wallet.scan(SPEND_KEY, {});
  assert.equal(st.bridgeUnknown, true, 'the caller was not told the bridge could not be asked');
  assert.equal(store.current.scanned_attest_height, 0,
    'the cursor advanced over blocks that were never examined, so a deposit there is lost for ever');

  // A node that answers "the bridge is off" IS an answer: reading nothing covers the range.
  const honest = stubClient({ head: () => ({ height: 900, hash: HEX64('ab') }) });
  const ok = await makeWallet({ core: stubCore(), store, rpc: () => honest, settings: async () => ({}), annotate: false }).scan(SPEND_KEY, {});
  assert.equal(ok.bridgeUnknown, undefined);
  assert.equal(store.current.scanned_attest_height, 512);
});

test('a node that will not say which chain it is, to a wallet that knows, is a wrong chain', async () => {
  const store = memoryStore();
  await makeWallet({ core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({ chainId: 13 }) }).scan(SPEND_KEY, {});
  assert.equal(store.current.genesis, GENESIS_A);

  const mute = stubClient({
    chainId: () => { throw new Error('no such method'); },
    genesis: () => { throw new Error('no such method'); },
  });
  const answer = await makeWallet({ core: stubCore(), store, rpc: () => mute, settings: async () => ({}) }).scan(SPEND_KEY, {});
  assert.ok(answer.wrongChain, '"I cannot prove which chain I am" read as "carry on"');
  assert.equal(answer.wrongChain.got.unknown, true);
});

test('a first scan against a node with no identity says so instead of pretending', async () => {
  const store = memoryStore();
  const mute = stubClient({
    chainId: () => { throw new Error('no such method'); },
    genesis: () => { throw new Error('no such method'); },
  });
  const st = await makeWallet({ core: stubCore(), store, rpc: () => mute, settings: async () => ({}) }).scan(SPEND_KEY, {});
  assert.equal(st.wrongChain, undefined, 'a store with no identity may still proceed');
  assert.equal(st.identityUnknown, true, 'but the caller must know there is nothing to check against');
  assert.equal(store.current.chain_id, null);
  assert.equal(store.current.identityUnknown, undefined, 'a transient marker was persisted');
});

test('PROBE: a rescan racing a scan really resets, and the losing scan is discarded', async () => {
  // The probe: `rescan()` ran outside the scan lock and its plain write lost the compare-and-set,
  // after which the stale-merge path re-maxed the cursors and re-merged the other tab's notes —
  // the reset silently no-opped while Settings said "Rescanned".
  const backing = memoryStore();
  let rev = 0;
  const shared = {
    async getNoteStore() { return { ...(await backing.getNoteStore()), rev }; },
    async setNoteStore(s) { await backing.setNoteStore(s); },
    async compareAndSet(value, expectedRev) {
      if (expectedRev !== rev) { const e = new Error('stale'); e.name = 'StaleStoreError'; throw e; }
      rev += 1;
      await backing.setNoteStore(value);
      return rev;
    },
  };
  const note = {
    index: 0, note: '00'.repeat(112), cm: HEX64('0b'), nf: HEX64('0c'),
    amount: '5', asset: 0, time: 4, from: '00'.repeat(32), height: 4, spent: false, pending: null,
  };
  const core = stubCore({
    scan_page: ({ rows }) => ({ received: rows.length ? [note] : [], sent: [], next_index: rows.length ? 1 : 0, rows: rows.length }),
  });
  const page = (from) => (from === 0 ? [{ index: 0, cm: HEX64('0b'), height: 4, envelope: envelope() }] : []);
  const deps = { core, store: shared, rpc: () => stubClient({ commitments: page }), settings: async () => ({ chainId: 13 }), annotate: false };

  // Tab one scans and records a note, so there is something for the reset to remove.
  await makeWallet(deps).scan(SPEND_KEY, {});
  assert.equal(backing.current.notes.length, 1);
  const epochBefore = backing.current.reset_epoch;

  // Tab two loads the store, tab one rescans for a chain change, tab two then tries to save.
  const tabTwo = makeWallet(deps);
  const loadedBefore = await tabTwo.loadStore();
  await makeWallet(deps).rescan(SPEND_KEY, { forChain: true });
  assert.ok(backing.current.reset_epoch > epochBefore, 'the reset did not bump the epoch');

  await assert.rejects(
    () => tabTwo.persist({ ...loadedBefore, scanned_index: 50 }),
    (err) => { assert.equal(err.name, 'StoreResetError'); assert.equal(err.retryable, true); return true; },
    'a scan that predates the reset wrote its page back over it',
  );
});

test('a rescan reports success only when the reset is really on disk', async () => {
  const always = {
    async getNoteStore() { return emptyNoteStore(); },
    async setNoteStore() {},
    async compareAndSet() { const e = new Error('stale'); e.name = 'StaleStoreError'; throw e; },
  };
  const wallet = makeWallet({ core: stubCore(), store: always, rpc: () => stubClient(), settings: async () => ({}) });
  await assert.rejects(() => wallet.rescan(SPEND_KEY, {}), (err) => {
    assert.match(err.message, /another tab kept changing this wallet/);
    assert.equal(err.retryable, true);
    return true;
  });
});

test('a rescan tells whoever is listening that the store was reset', async () => {
  const resets = [];
  const store = memoryStore();
  const wallet = makeWallet({
    core: stubCore(), store, rpc: () => stubClient(), settings: async () => ({}),
    onReset: (epoch) => resets.push(epoch),
  });
  await wallet.scan(SPEND_KEY, {});
  await wallet.rescan(SPEND_KEY, {});
  assert.deepEqual(resets, [1], 'other tabs were never told to drop their view');
});
