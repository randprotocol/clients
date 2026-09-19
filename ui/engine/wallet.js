// Scan, send and faucet — the orchestration of design spec §3.2, mirroring the fullnode's
// `randprotocol_client::wallet`. Every cryptographic step is a core call; this file only moves
// JSON between the node and the note store.
//
// Storage- and platform-agnostic (task 1.6): where this used to import `./store.js` and
// `./core.js` it now takes them, so the browser extension and the local web wallet share one
// implementation of the chain protocol and differ only in where the bytes are kept.
//
//     makeWallet({ core, store, rpc, settings })
//       core     { call(method, params) -> Promise }   the wasm core, however it is reached
//       store    { getNoteStore(), setNoteStore(s) }   the note cache (rescannable from leaf 0)
//       rpc      (settings?) -> RpcClient | Promise    a client for the node in force right now
//       settings () -> Promise<{rpcUrl, chainId, …}>   the current settings
//
// Nothing in here persists a key: a spend key arrives as an argument and leaves with the call.

const PAGE = 500;
export const COMMIT_TIMEOUT_MS = 180_000;
/** How many block headers one scan will fetch to date the notes it found (see `datesFor`). */
const MAX_BLOCK_TIMES_PER_SCAN = 128;

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

export function makeWallet({ core, store, rpc, settings }) {
  if (!core || typeof core.call !== 'function') throw new Error('makeWallet needs a core with call()');
  if (!store || typeof store.getNoteStore !== 'function') throw new Error('makeWallet needs a note store');
  const c = coreApi(core);
  const currentSettings = typeof settings === 'function' ? settings : async () => ({});
  const rpcFor = async (s) => {
    const client = typeof rpc === 'function' ? rpc(s) : rpc;
    return client && typeof client.then === 'function' ? await client : client;
  };

  async function loadStore() {
    const s = { ...emptyNoteStore(), ...((await store.getNoteStore()) || {}) };
    if (!s.block_times || typeof s.block_times !== 'object') s.block_times = {};
    if (!s.note_tx || typeof s.note_tx !== 'object') s.note_tx = {};
    return s;
  }

  /** Bridge deposits this wallet can rebuild from committed blocks it has not read yet. */
  async function rebuildableDeposits(client, spendKey, st, head, signal) {
    const out = new Map();
    if (st.scanned_attest_height > head) return out;
    let enabled = false;
    try { enabled = !!(await client.bridgeState({ signal }))?.enabled; } catch { /* a node without the method */ }
    if (!enabled) { st.scanned_attest_height = head + 1; return out; }
    for (let h = st.scanned_attest_height; h <= head; h++) {
      throwIfAborted(signal);
      const block = await client.blockByHeight(h, { signal });
      for (const tx of block?.transactions || []) {
        if (tx?.action?.kind !== 'bridge_attest') continue;
        const note = await c.rebuiltDeposit(spendKey, tx.action);
        if (note) out.set(note.cm, note);
      }
    }
    st.scanned_attest_height = head + 1;
    return out;
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
   */
  async function annotateBlocks(client, st, signal) {
    const wanted = new Set();
    for (const n of st.notes) if (n.height && st.block_times[n.height] === undefined) wanted.add(n.height);
    for (const s of st.sent) if (s.height && st.block_times[s.height] === undefined) wanted.add(s.height);
    let budget = MAX_BLOCK_TIMES_PER_SCAN;
    for (const height of [...wanted].sort((a, b) => b - a)) {
      if (budget-- <= 0) break;
      throwIfAborted(signal);
      let block;
      try {
        block = await client.blockByHeight(height, { signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        break; // a node that cannot serve one header will not serve the rest either
      }
      const ms = Number(block && block.timestamp_ms);
      if (Number.isFinite(ms) && ms > 0) st.block_times[height] = ms;
      // `transactions` is `rand_getTransaction.tx`'s shape: `{hash, bundle: {commitments: […]}}`.
      // Everything here is node-controlled, so every step is guarded rather than assumed.
      for (const tx of (block && block.transactions) || []) {
        const hash = tx && typeof tx.hash === 'string' ? tx.hash : null;
        if (!hash) continue;
        for (const cm of (tx.bundle && tx.bundle.commitments) || []) {
          if (typeof cm === 'string') st.note_tx[cm] = hash;
        }
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
    const head0 = (await client.head({ signal })).height;
    const deposits = await rebuildableDeposits(client, spendKey, st, head0, signal);
    let total = 0;
    try { total = (await client.treeInfo({ signal })).next_index; } catch { /* a node without it */ }

    const placePage = async (rows) => {
      const res = await c.scanPage(spendKey, rows);
      // A rebuilt deposit takes precedence over whatever its envelope says.
      for (const r of rows) {
        const dep = deposits.get(r.cm);
        if (dep) { deposits.delete(r.cm); mergeNotes(st, [{ ...dep, index: r.index, height: r.height }]); }
      }
      mergeNotes(st, res.received);
      mergeSent(st, res.sent);
      return res.next_index;
    };

    for (;;) {
      throwIfAborted(signal);
      const rows = await client.commitments(st.scanned_index, PAGE, { signal });
      if (!rows || rows.length === 0) break;
      const before = st.scanned_index;
      const next = await placePage(rows);
      st.scanned_index = Math.max(st.scanned_index, next);
      if (st.scanned_index <= before) throw new Error(`rand_getCommitments returned ${rows.length} rows from ${before} without advancing`);
      onProgress?.({ phase: 'notes', scanned: st.scanned_index, total });
      await store.setNoteStore(st);
    }
    // A deposit whose leaf sits below the cursor: re-offer the leaves from the start, once.
    let from = 0;
    while (deposits.size > 0) {
      throwIfAborted(signal);
      const rows = await client.commitments(from, PAGE, { signal });
      if (!rows || rows.length === 0) throw new Error(`${deposits.size} rebuilt deposit(s) match no leaf of the tree`);
      const before = from;
      await placePage(rows);
      from = Math.max(from, rows[rows.length - 1].index + 1);
      if (from <= before) throw new Error('rand_getCommitments did not advance');
    }

    // Head read *before* paging nullifiers, so every block up to it is covered by the pages.
    const headBefore = (await client.head({ signal })).height;
    let cursor = st.scanned_height;
    for (;;) {
      throwIfAborted(signal);
      const rows = await client.nullifiers(cursor, PAGE, { signal });
      if (!rows || rows.length === 0) break;
      const maxHeight = Math.max(...rows.map((r) => r.height));
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
    await annotateBlocks(client, st, signal);
    st.head = headBefore;
    st.last_sync_ms = Date.now();
    throwIfAborted(signal);
    await store.setNoteStore(st);
    return st;
  }

  /** Fetch the anchor and one witness per input, refetching if the tree moved (3 attempts). */
  async function anchorAndWitnesses(client, chosen, signal) {
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      const anchor = await client.anchor({ signal });
      const paths = [];
      let moved = false;
      for (const n of chosen) {
        const w = await client.witness(n.index, { signal });
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
    const hash = await client.sendTransaction(res.tx_hex);
    const fresh = await loadStore();
    for (const n of fresh.notes) if (res.spent_indices.includes(n.index)) n.pending = res.time;
    const toInfo = await c.parseAddress(to);
    const submission = {
      hash, to, to_pk: toInfo.pk, amount: res.amount, change: res.change, fee: res.fee, time: res.time, tier: res.tier,
      proof_bytes: res.proof_bytes, tx_key: res.tx_keys[0], commitment: res.commitments[0],
      spent_indices: res.spent_indices, status: 'pending', created_ms: Date.now(),
    };
    fresh.submissions.unshift(submission);
    await store.setNoteStore(fresh);
    if (wait) {
      onPhase?.('wait');
      const committed = await waitForTransaction(client, hash, COMMIT_TIMEOUT_MS);
      if (committed) {
        const after = await loadStore();
        const sub = after.submissions.find((x) => x.hash === hash);
        if (sub) { sub.status = 'committed'; sub.height = committed.height; }
        await store.setNoteStore(after);
        await scan(spendKey, {}, s);
      }
    }
    return submission;
  }

  /** Testnet faucet: RAND into a note only this wallet can open. */
  async function faucet(spendKey, address, settingsOverride) {
    const s = settingsOverride || (await currentSettings());
    const client = await rpcFor(s);
    const hash = await client.mint(address);
    const st = await loadStore();
    st.submissions.unshift({ hash, kind: 'faucet', amount: '100000000000', status: 'pending', created_ms: Date.now(), time: st.head || 0 });
    await store.setNoteStore(st);
    const committed = await waitForTransaction(client, hash, COMMIT_TIMEOUT_MS);
    const after = await loadStore();
    const sub = after.submissions.find((x) => x.hash === hash);
    if (sub) sub.status = committed ? 'committed' : 'pending';
    await store.setNoteStore(after);
    if (committed) await scan(spendKey, {}, s);
    return hash;
  }

  return { scan, send, faucet, loadStore, core: c, rpcFor, activity, balanceOf, isSpendable };
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
