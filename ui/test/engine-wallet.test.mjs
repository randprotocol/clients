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
    treeInfo: () => ({ next_index: 0, root: HEX64('00'), nullifiers: 0 }),
    commitments: () => [],
    nullifiers: () => [],
    anchor: () => ({ height: 20, root: HEX64('ab') }),
    bridgeState: () => ({ enabled: false }),
    blockByHeight: (h) => ({ height: h, timestamp_ms: 1788000000000, transactions: [] }),
  };
  const impl = { ...d, ...table };
  const client = {};
  for (const name of Object.keys(impl)) {
    client[name] = async (...args) => { calls.push([name, ...args]); return impl[name](...args); };
  }
  client.calls = calls;
  return client;
}

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
