// Scan, send and faucet — the orchestration of design spec §3.2, mirroring the fullnode's
// `randprotocol_client::wallet`. Every cryptographic step is a core call; this file only moves
// JSON between the node and the note store.
//
// Storage- and platform-agnostic (task 1.6): where this used to import `./store.js` and
// `./core.js` it now takes them, so the browser extension and the local web wallet share one
// implementation of the chain protocol and differ only in where the bytes are kept.
//
//     makeWallet({ core, store, rpc, settings, annotate })
//       core     { call(method, params) -> Promise }   the wasm core, however it is reached
//       store    { getNoteStore(), setNoteStore(s), compareAndSet?(value, expectedRev) }
//       rpc      (settings?) -> RpcClient | Promise    a client for the node in force right now
//       settings () -> Promise<{rpcUrl, chainId, …}>   the current settings
//       annotate  default true — read block headers to date notes and link them to transactions
//
// Nothing in here persists a key: a spend key arrives as an argument and leaves with the call.
//
// Two invariants this file is responsible for, both learned the hard way (task 1.6 review):
//
//   * **Nothing a node said reaches arithmetic, a cursor or the store unchecked.** Every reply
//     goes through `./validate.js` first. One row with a string `height` used to make the scan
//     cursor `NaN`, and `NaN` persists perfectly well through IndexedDB's structured clone, so
//     every later scan paged from `NaN` for ever. See `persist()` for the last line of defence.
//   * **A cursor and the data it covers move together.** A cursor persisted for work that was
//     then thrown away (an abort, a failed page) silently skips that range for ever. The
//     bridge-attest cursor in particular now advances only in the same write as the deposits it
//     covers.
import {
  checkHead, checkTreeInfo, checkCommitments, checkNullifiers, checkAnchor, checkWitness,
  checkBlockHeader, checkBridgeState, checkSubmitted, intField,
} from './validate.js';

const PAGE = 500;
export const COMMIT_TIMEOUT_MS = 180_000;
/** How many block headers one scan will fetch to date the notes it found (see `annotateBlocks`). */
const MAX_BLOCK_TIMES_PER_SCAN = 128;

/**
 * How many notes one bundle can spend. It is the chain's rule, not this file's: the zkVM's bundle
 * shape is 2-in-2-out, and the core's `select_inputs` refuses a `need` that would take a third
 * note ("need more than two notes; …consolidate first"). It is a named constant here, and only
 * here, so that the one place JavaScript has to know it is greppable — and
 * `web/wallet/test/core.integration.test.mjs` cross-checks it against the real wasm core rather
 * than trusting this line. A core that ever reports `bundle_inputs` in its `version` constants
 * wins over it (see `backend-wasm.js`'s `maxSendable`).
 */
export const BUNDLE_INPUTS = 2;

/** The numeric cursors that must never be anything but safe non-negative integers. */
const CURSORS = ['scanned_index', 'scanned_height', 'scanned_attest_height', 'head'];
/** Keys held on the in-memory store that must never be written to storage. */
const TRANSIENT = ['recovered', 'rev'];

export function emptyNoteStore() {
  return {
    scanned_index: 0, scanned_height: 0, scanned_attest_height: 0,
    notes: [], sent: [], submissions: [],
    // height -> unix milliseconds, filled in as notes are found. The chain's own `time` word is a
    // block number, not a clock, so this is the only place a wallet can learn when a note landed.
    block_times: {},
    // note commitment -> the hash of the transaction that created it, learned from the same block
    // headers. `rand_getCommitments` serves leaves, not transactions, so without this a received
    // note has no hash and no transaction page to open.
    note_tx: {},
    last_sync_ms: 0, head: 0,
  };
}

export function toUnits(v) {
  try { return BigInt(String(v ?? '0')); } catch { return 0n; }
}

export function balanceOf(store, asset = 0) {
  return (store.notes || []).filter((n) => isSpendable(n) && n.asset === asset).reduce((a, n) => a + toUnits(n.amount), 0n);
}
export function isSpendable(n) { return !n.spent && n.pending == null && toUnits(n.amount) > 0n; }

/** The asset indexes this store holds any note of, spendable or not. */
export function assetIndexes(store) {
  return [...new Set((store.notes || []).map((n) => Number(n.asset) || 0))].sort((a, b) => a - b);
}

function mergeNotes(store, received) {
  for (const n of received) {
    const i = store.notes.findIndex((x) => x.index === n.index);
    if (i < 0) store.notes.push(n);
  }
}
function mergeSent(store, sent) {
  for (const s of sent) if (!store.sent.some((x) => x.index === s.index)) store.sent.push(s);
}

/** The shape ui/ recognises as "this was cancelled", not "the node failed" (ui/backend.js). */
export function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/**
 * A write that lost a race with another tab. `storage.compareAndSet` raises it (by `name`, not by
 * class, so `web/wallet/idb.js` does not have to import from `ui/engine/`); the scan catches it,
 * merges what the other tab wrote and retries once.
 */
export function isStaleStoreError(err) {
  return !!err && err.name === 'StaleStoreError';
}

function staleAfterRetry() {
  const err = new Error('another tab changed this wallet while it was syncing; try again');
  err.retryable = true;
  return err;
}

/** True only for a safe non-negative integer. */
function isCursor(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The core's methods by name, over the one `call(method, params)` entry point every binding has. */
export function coreApi(core) {
  const call = (method, params) => core.call(method, params || {});
  return {
    call,
    version: () => call('version'),
    keygen: () => call('keygen'),
    walletInfo: (spend_key) => call('wallet_info', { spend_key }),
    importKey: (input) => call('import_key', { input }),
    parseAddress: (address) => call('parse_address', { address }),
    scanPage: (spend_key, rows) => call('scan_page', { spend_key, rows }),
    rebuiltDeposit: (spend_key, action) => call('rebuilt_deposit', { spend_key, action }),
    pendingCleared: (note, read_through) => call('pending_cleared', { note, read_through }),
    selectInputs: (notes, need, asset = 0) => call('select_inputs', { notes, need: String(need), asset }),
    proveTransfer: (req) => call('prove_transfer', req),
    openWithTxKey: (cm, envelope, tx_key) => call('open_with_tx_key', { cm, envelope, tx_key }),
    formatAmount: (units) => call('format_amount', { units: String(units) }),
    parseAmount: (text) => call('parse_amount', { text }),
  };
}

export function makeWallet({ core, store, rpc, settings, annotate = true }) {
  if (!core || typeof core.call !== 'function') throw new Error('makeWallet needs a core with call()');
  if (!store || typeof store.getNoteStore !== 'function') throw new Error('makeWallet needs a note store');
  const c = coreApi(core);
  const currentSettings = typeof settings === 'function' ? settings : async () => ({});
  const rpcFor = async (s) => {
    const client = typeof rpc === 'function' ? rpc(s) : rpc;
    return client && typeof client.then === 'function' ? await client : client;
  };

  /**
   * Reads the note store, and **self-heals a poisoned one**. A cursor that is not a safe
   * non-negative integer — `NaN`, `null`, a string, `Infinity` — can only have come from a bug or
   * from a node reply that got through before `validate.js` existed, and there is no way to reason
   * about how far such a store has read. The notes are kept (they are real, and re-deriving them
   * costs a full scan) and every cursor is reset to 0, so the next scan re-reads the tree from
   * leaf 0 and re-establishes them. `recovered` rides back on the scan result exactly once, for
   * the UI to say so (ui/backend.js).
   */
  async function loadStore() {
    const raw = (await store.getNoteStore()) || {};
    const s = { ...emptyNoteStore(), ...raw };
    if (!s.block_times || typeof s.block_times !== 'object') s.block_times = {};
    if (!s.note_tx || typeof s.note_tx !== 'object') s.note_tx = {};
    if (!Array.isArray(s.notes)) s.notes = [];
    if (!Array.isArray(s.sent)) s.sent = [];
    if (!Array.isArray(s.submissions)) s.submissions = [];
    const broken = CURSORS.filter((key) => !isCursor(s[key]));
    if (broken.length) {
      for (const key of CURSORS) s[key] = 0;
      s.recovered = true;
    }
    return s;
  }

  /**
   * The last line of defence in front of storage. Refuses to write a store whose cursors are not
   * safe non-negative integers, or that has moved **backwards** — a cursor only ever advances, so
   * a regression means something overwrote it with stale or corrupt data, and persisting that
   * would lose every leaf in between. Throwing keeps whatever is already there.
   *
   * With `store.compareAndSet` (a shell whose storage can do it — see web/wallet/idb.js) the write
   * is conditional on the revision this store was loaded at, so two tabs cannot silently overwrite
   * each other. On a lost race the other tab's store is merged in and the write retried once.
   */
  async function persist(st, previous) {
    for (const key of CURSORS) {
      if (!isCursor(st[key])) throw new Error(`refusing to save the note store: ${key} is not a block cursor (${String(st[key])})`);
      if (previous && isCursor(previous[key]) && st[key] < previous[key]) {
        throw new Error(`refusing to save the note store: ${key} moved backwards, ${previous[key]} → ${st[key]}`);
      }
    }
    const clean = {};
    for (const [key, value] of Object.entries(st)) if (!TRANSIENT.includes(key)) clean[key] = value;

    if (typeof store.compareAndSet !== 'function') {
      await store.setNoteStore(clean);
      return st;
    }
    try {
      st.rev = await store.compareAndSet(clean, st.rev);
      return st;
    } catch (err) {
      if (!isStaleStoreError(err)) throw err;
      // Another tab wrote while this scan was running. Take its store, re-apply this scan's own
      // findings onto it (every merge here is by index, so doing it twice is a no-op) and try
      // once more. A second loss means the tabs are fighting; that is the user's to retry.
      const fresh = await loadStore();
      mergeNotes(fresh, st.notes);
      mergeSent(fresh, st.sent);
      for (const sub of st.submissions) if (!fresh.submissions.some((x) => x.hash === sub.hash)) fresh.submissions.push(sub);
      Object.assign(fresh.block_times, st.block_times);
      Object.assign(fresh.note_tx, st.note_tx);
      for (const key of CURSORS) fresh[key] = Math.max(isCursor(fresh[key]) ? fresh[key] : 0, st[key]);
      fresh.last_sync_ms = Math.max(Number(fresh.last_sync_ms) || 0, Number(st.last_sync_ms) || 0);
      const merged = {};
      for (const [key, value] of Object.entries(fresh)) if (!TRANSIENT.includes(key)) merged[key] = value;
      try {
        const rev = await store.compareAndSet(merged, fresh.rev);
        Object.assign(st, fresh, { rev });
        return st;
      } catch (again) {
        if (isStaleStoreError(again)) throw staleAfterRetry();
        throw again;
      }
    }
  }

  /**
   * Bridge deposits this wallet can rebuild from committed blocks it has not read yet.
   *
   * It deliberately does **not** move `st.scanned_attest_height`: the caller advances it only once
   * the deposits it found have actually been placed and persisted. Advancing it here meant an
   * abort between commitment pages persisted the cursor while the deposits gathered for that
   * range were dropped on the floor, and a bridge deposit could be missed permanently.
   */
  async function rebuildableDeposits(client, spendKey, st, head, signal) {
    const out = new Map();
    if (st.scanned_attest_height > head) return { deposits: out, through: st.scanned_attest_height - 1 };
    let enabled = false;
    try { enabled = checkBridgeState(await client.bridgeState({ signal })).enabled; } catch { /* a node without the method */ }
    if (!enabled) return { deposits: out, through: head };
    for (let h = st.scanned_attest_height; h <= head; h++) {
      throwIfAborted(signal);
      const block = await client.blockByHeight(h, { signal });
      for (const tx of (block && Array.isArray(block.transactions) ? block.transactions : [])) {
        if (tx?.action?.kind !== 'bridge_attest') continue;
        const note = await c.rebuiltDeposit(spendKey, tx.action);
        if (note) out.set(note.cm, note);
      }
    }
    return { deposits: out, through: head };
  }

  /**
   * Fills in the two things a leaf does not carry: **when** it landed and **which transaction**
   * created it. Both come from the header of the block it is in.
   *
   * A note carries the chain's `time` word, which is a *block number* (see `pending_cleared`'s
   * 256-block window), not a clock, so `timestamp_ms` from the block header is the only honest
   * answer to "when did this happen"; and `rand_getCommitments` serves leaves, not transactions,
   * so a received note has no hash until one of the block's transactions is found to have created
   * its commitment.
   *
   * Bounded and best-effort: at most `MAX_BLOCK_TIMES_PER_SCAN` headers per scan, newest blocks
   * first, and a node that will not answer simply leaves those notes undated and unlinked — the
   * UI renders an activity item with no time and no transaction page rather than a wrong one.
   * Off (`annotate: false`) for the old extension UI, which shows block heights and never asked
   * for this.
   */
  async function annotateBlocks(client, st, signal) {
    const wanted = new Set();
    for (const n of st.notes) if (isCursor(n.height) && st.block_times[n.height] === undefined) wanted.add(n.height);
    for (const s of st.sent) if (isCursor(s.height) && st.block_times[s.height] === undefined) wanted.add(s.height);
    let budget = MAX_BLOCK_TIMES_PER_SCAN;
    for (const height of [...wanted].sort((a, b) => b - a)) {
      if (budget-- <= 0) break;
      throwIfAborted(signal);
      let header;
      try {
        header = checkBlockHeader(await client.blockByHeight(height, { signal }));
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        break; // a node that cannot serve one header will not serve the rest either
      }
      if (!header) continue;
      if (header.timestamp_ms !== undefined) st.block_times[height] = header.timestamp_ms;
      for (const tx of header.transactions) {
        for (const cm of tx.commitments) st.note_tx[cm] = tx.hash;
      }
    }
  }

  /**
   * Trial-decrypt every new leaf, then mark spent notes from the nullifier set. `onProgress`
   * receives `{phase, scanned, total}`. Saves the store and returns it. `signal` aborts the paging
   * and rejects with an AbortError.
   */
  async function scan(spendKey, { onProgress, signal } = {}, settingsOverride) {
    throwIfAborted(signal);
    const s = settingsOverride || (await currentSettings());
    const client = await rpcFor(s);
    const st = await loadStore();
    const before = { ...st };
    const head0 = checkHead(await client.head({ signal })).height;
    const { deposits, through: attestThrough } = await rebuildableDeposits(client, spendKey, st, head0, signal);
    let total = 0;
    try { total = checkTreeInfo(await client.treeInfo({ signal })).next_index; } catch { /* a node without it */ }

    const placePage = async (rows) => {
      const res = await c.scanPage(spendKey, rows);
      // A rebuilt deposit takes precedence over whatever its envelope says.
      for (const r of rows) {
        const dep = deposits.get(r.cm);
        if (dep) { deposits.delete(r.cm); mergeNotes(st, [{ ...dep, index: r.index, height: r.height }]); }
      }
      mergeNotes(st, res.received);
      mergeSent(st, res.sent);
      return intField('scan_page', 'next_index', res.next_index);
    };

    for (;;) {
      throwIfAborted(signal);
      const rows = checkCommitments(await client.commitments(st.scanned_index, PAGE, { signal }), PAGE);
      if (rows.length === 0) break;
      const cursorBefore = st.scanned_index;
      const next = await placePage(rows);
      st.scanned_index = Math.max(st.scanned_index, next);
      if (st.scanned_index <= cursorBefore) throw new Error(`rand_getCommitments returned ${rows.length} rows from ${cursorBefore} without advancing`);
      onProgress?.({ phase: 'notes', scanned: st.scanned_index, total });
      await persist(st, before);
    }
    // A deposit whose leaf sits below the cursor: re-offer the leaves from the start, once.
    let from = 0;
    while (deposits.size > 0) {
      throwIfAborted(signal);
      const rows = checkCommitments(await client.commitments(from, PAGE, { signal }), PAGE);
      if (rows.length === 0) throw new Error(`${deposits.size} rebuilt deposit(s) match no leaf of the tree`);
      const cursorBefore = from;
      await placePage(rows);
      from = Math.max(from, rows[rows.length - 1].index + 1);
      if (from <= cursorBefore) throw new Error('rand_getCommitments did not advance');
    }
    // Every deposit found for [scanned_attest_height, attestThrough] is now in `st.notes`, so the
    // cursor may move — and it is written in the same save as the notes it covers, below.
    st.scanned_attest_height = Math.max(st.scanned_attest_height, attestThrough + 1);

    // Head read *before* paging nullifiers, so every block up to it is covered by the pages.
    const headBefore = checkHead(await client.head({ signal })).height;
    let cursor = st.scanned_height;
    for (;;) {
      throwIfAborted(signal);
      const rows = checkNullifiers(await client.nullifiers(cursor, PAGE, { signal }), PAGE);
      if (rows.length === 0) break;
      const maxHeight = Math.max(...rows.map((r) => r.height)); // every height validated above
      const set = new Set(rows.map((r) => r.nullifier));
      for (const n of st.notes) if (set.has(n.nf)) n.spent = true;
      if (rows.length < PAGE) { cursor = maxHeight + 1; break; }
      if (maxHeight === cursor) throw new Error(`block ${cursor} published more than ${PAGE} nullifiers`);
      cursor = maxHeight;
      onProgress?.({ phase: 'spends', scanned: cursor, total: headBefore });
    }
    st.scanned_height = Math.max(st.scanned_height, cursor, headBefore + 1);
    const readThrough = st.scanned_height - 1;
    for (const n of st.notes) {
      if (n.pending != null && (await c.pendingCleared(n, readThrough))) n.pending = null;
    }
    // Submissions: resolved when their nullifiers are spent or their window has passed.
    for (const sub of st.submissions) {
      if (sub.status !== 'pending') continue;
      const spent = st.notes.filter((n) => sub.spent_indices?.includes(n.index));
      if (spent.length && spent.every((n) => n.spent)) sub.status = 'committed';
      else if (readThrough > sub.time + 256) sub.status = 'expired';
    }
    if (annotate) await annotateBlocks(client, st, signal);
    st.head = headBefore;
    st.last_sync_ms = Date.now();
    throwIfAborted(signal);
    await persist(st, before);
    return st;
  }

  /** Fetch the anchor and one witness per input, refetching if the tree moved (3 attempts). */
  async function anchorAndWitnesses(client, chosen, signal) {
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      const anchor = checkAnchor(await client.anchor({ signal }));
      const paths = [];
      let moved = false;
      for (const n of chosen) {
        const w = checkWitness(await client.witness(n.index, { signal }));
        if (!w) throw new Error(`no leaf at index ${n.index}`);
        if (w.root !== anchor.root) { moved = true; break; }
        paths.push(w.path);
      }
      if (!moved) return { anchor, paths };
      if (attempt >= 3) throw new Error('the tree moved while fetching witnesses; retry');
    }
  }

  /**
   * Select, prove and submit a transfer. `onPhase` receives 'select' | 'witness' | 'prove' |
   * 'submit' | 'wait'. Resolves with the submission record; the proof runs in the core worker.
   *
   * Not reachable from the wasm shells: a bundle proof peaks at ~5.6 GB and wasm32 stops at
   * 4 GiB, so `backend-wasm.js` refuses before it ever gets here (see `send.canProve`).
   */
  async function send(spendKey, { to, amountUnits, feeUnits, wait = true, onPhase, signal }, settingsOverride) {
    const s = settingsOverride || (await currentSettings());
    const client = await rpcFor(s);
    onPhase?.('select');
    const st = await scan(spendKey, { signal }, s);
    const need = toUnits(amountUnits) + toUnits(feeUnits);
    const sel = await c.selectInputs(st.notes, need.toString(), 0);
    onPhase?.('witness');
    const { anchor, paths } = await anchorAndWitnesses(client, sel.chosen, signal);
    onPhase?.('prove');
    const res = await c.proveTransfer({
      spend_key: spendKey,
      chain_id: s.chainId,
      to,
      amount: String(amountUnits),
      fee: String(feeUnits),
      anchor_height: anchor.height,
      anchor_root: anchor.root,
      inputs: sel.chosen.map((note, i) => ({ note, path: paths[i] })),
      profile: 'production',
    });
    // The last point at which nothing has left this device. Past it a failure means the outcome is
    // unknown, not "not sent" (see ui/backend.js on `send.send`'s rejection fields).
    throwIfAborted(signal);
    onPhase?.('submit');
    const hash = checkSubmitted('rand_sendTransaction', await client.sendTransaction(res.tx_hex));
    const fresh = await loadStore();
    for (const n of fresh.notes) if (res.spent_indices.includes(n.index)) n.pending = res.time;
    const toInfo = await c.parseAddress(to);
    const submission = {
      hash, to, to_pk: toInfo.pk, amount: res.amount, change: res.change, fee: res.fee, time: res.time, tier: res.tier,
      proof_bytes: res.proof_bytes, tx_key: res.tx_keys[0], commitment: res.commitments[0],
      spent_indices: res.spent_indices, status: 'pending', created_ms: Date.now(),
    };
    fresh.submissions.unshift(submission);
    await persist(fresh);
    if (wait) {
      onPhase?.('wait');
      const committed = await waitForTransaction(client, hash, COMMIT_TIMEOUT_MS);
      if (committed) {
        const after = await loadStore();
        const sub = after.submissions.find((x) => x.hash === hash);
        if (sub) { sub.status = 'committed'; sub.height = committed.height; }
        await persist(after);
        await scan(spendKey, {}, s);
      }
    }
    return submission;
  }

  /** Testnet faucet: RAND into a note only this wallet can open. */
  async function faucet(spendKey, address, settingsOverride) {
    const s = settingsOverride || (await currentSettings());
    const client = await rpcFor(s);
    const hash = checkSubmitted('rand_mint', await client.mint(address));
    const st = await loadStore();
    st.submissions.unshift({ hash, kind: 'faucet', amount: '100000000000', status: 'pending', created_ms: Date.now(), time: st.head || 0 });
    await persist(st);
    const committed = await waitForTransaction(client, hash, COMMIT_TIMEOUT_MS);
    const after = await loadStore();
    const sub = after.submissions.find((x) => x.hash === hash);
    if (sub) sub.status = committed ? 'committed' : 'pending';
    await persist(after);
    if (committed) await scan(spendKey, {}, s);
    return hash;
  }

  return { scan, send, faucet, loadStore, persist, core: c, rpcFor, activity, balanceOf, isSpendable };
}

export async function waitForTransaction(client, hash, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await client.getTransaction(hash);
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  return null;
}

/** Everything the Activity list shows, newest first. A committed payment appears once: the
 * submission record (which carries the hash and the transaction key) wins over the `sent` row
 * the scan later finds for the same note. */
export function activity(store) {
  const rows = [];
  for (const n of store.notes) {
    if (toUnits(n.amount) === 0n) continue; // zero-value change notes are real leaves that buy nothing
    rows.push({ kind: 'received', index: n.index, amount: n.amount, asset: n.asset, height: n.height, from: n.from, spent: n.spent, pending: n.pending != null, note: n, sort: n.height });
  }
  const subs = store.submissions || [];
  for (const s of store.sent) {
    const sub = subs.find((x) => x.to_pk === s.to_pk && x.amount === s.amount && x.time === s.time);
    if (sub) { if (!sub.height) sub.height = s.height; continue; }
    rows.push({ kind: 'sent', index: s.index, amount: s.amount, asset: s.asset, height: s.height, to_pk: s.to_pk, sort: s.height });
  }
  for (const s of subs) rows.push({ kind: s.kind === 'faucet' ? 'faucet' : 'submission', hash: s.hash, amount: s.amount, status: s.status, created_ms: s.created_ms, sub: s, height: s.height || 0, sort: s.height || Number.MAX_SAFE_INTEGER });
  return rows.sort((a, b) => (b.sort || 0) - (a.sort || 0) || (b.created_ms || 0) - (a.created_ms || 0) || (b.index || 0) - (a.index || 0));
}
