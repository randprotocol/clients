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
  checkBlockHeader, checkBridgeState, checkSubmitted, checkGenesisHash, checkBlockActions,
  checkTransaction, intField,
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

/**
 * Every numeric field of the store that must be a safe non-negative integer, and the subset that
 * is a **work cursor**.
 *
 * The distinction is the whole of fix round 2's headline. `head` is the node's *reported* tip — a
 * mirror of something a remote server said, not a record of work this wallet did — and enforcing
 * it as monotone bricked the wallet: a lagging replica, a node restored from a snapshot, a
 * younger chain, or one hostile-but-valid `rand_getHead` near 2^53, and every later scan threw
 * "head moved backwards" for ever, with no way out but a wipe. A tip that goes down is a fact
 * about the node, not a corruption of the store.
 *
 * A **work cursor** is different: it says "this wallet has read the chain up to here", and it can
 * only go backwards if something overwrote it. Those stay monotone.
 */
const NUMERIC_FIELDS = ['scanned_index', 'scanned_height', 'scanned_attest_height', 'head'];
const WORK_CURSORS = ['scanned_index', 'scanned_height', 'scanned_attest_height'];
/** Keys held on the in-memory store that must never be written to storage. */
const TRANSIENT = ['recovered', 'rev', 'behind', 'wrongChain', 'bridgeUnknown', 'identityUnknown'];

/**
 * ---------------------------------------------------------------------------------------------
 * THE CURSOR RULE — how far one nullifier reply may move `scanned_height`, and why.
 * ---------------------------------------------------------------------------------------------
 *
 * The principle: **a work cursor may only move over data this wallet requested, received and
 * validated as being the data it asked for.** "The node said so" never moves a cursor.
 *
 * What the RPC actually is (`randprotocol-node`'s `storage.rs::nullifiers_from`, via
 * `rand_getNullifiers(from_height, limit)`, `limit` capped at 1000):
 *
 *     collect every (height, nullifier) with height >= from_height; sort(); truncate(limit)
 *
 * so an honest reply is a **prefix of the ordered set** — sorted by height, nothing below
 * `from_height`, and one height's rows *can* be split across pages by the truncation.
 * `checkNullifiers` rejects anything that is not such a prefix (out of order, below `from`, above
 * the tip the node reported this scan).
 *
 * Coverage of one validated reply requested at `f`, with the tip `T` this node reported:
 *
 *   FULL page (`rows.length === limit`), last row height `L`:
 *       every row with height in [f, L) sorts before the truncation point, so the page contains
 *       ALL of them. Height `L` itself may be cut in half. → fully covered: [f, L-1].
 *       Cursor → `L` (so `L` is read again next time), clamped: `min(L, f + HEIGHT_SPAN)`.
 *       Clamping DOWN is always sound: the rows above the clamp were still processed (marking a
 *       nullifier spent is idempotent), and the next request simply re-reads them.
 *       `L === f` means one height holds more than `limit` nullifiers — see "Known limitations".
 *
 *   SHORT or EMPTY page (`rows.length < limit`):
 *       the node asserts there is nothing else at or after `f` — at all, up to its own tip. That
 *       assertion is the only evidence, and `T` is a number this wallet must not trust, so the
 *       cursor takes it one span at a time. Cursor → `min(f + HEIGHT_SPAN, T + 1)`.
 *
 * Invariant (induction over replies): each reply's coverage begins exactly at the previous
 * cursor, so after any sequence the union of coverage is contiguous from where the store started,
 * and every height below `scanned_height` was covered by a reply that was consistent with its own
 * request. No reply moves the cursor past `T + 1`, and one scan moves it by at most
 * `MAX_HEIGHTS_PER_SCAN` however large `T` is.
 *
 * WHAT A HOSTILE NODE CAN STILL DO, and this is not fixable here: answer "no nullifiers" for a
 * range that has some. A short page is a claim of absence, and this protocol has no proof of
 * absence — a light client cannot tell a quiet chain from a lying node. The consequence is a
 * spent note still shown as spendable; a transfer built on it is refused by the chain as a
 * double-spend rather than losing anything. Rescanning against a node you trust re-reads every
 * height and repairs the view. The same is true of withheld *leaves*: a node that omits notes
 * makes them invisible, not lost. See web/wallet/README.md.
 */
export const HEIGHT_SPAN = PAGE;
/**
 * …and how many such replies one scan will take. Without it the loop is `tip / HEIGHT_SPAN`
 * iterations, which for a hostile tip near 2^53 is not a slow scan but an infinite one (the first
 * version of this fix exhausted the heap). With it, one scan advances a height cursor by at most
 * `HEIGHT_SPAN * MAX_HEIGHT_PAGES_PER_SCAN` and the next scan carries on from there; a tip that is
 * a lie costs re-reading that much, and `sync.rescan()` is the one-click cure if a wallet ever
 * does end up ahead of an honest node.
 */
const MAX_HEIGHT_PAGES_PER_SCAN = 512;
/** …and the total a single scan may advance `scanned_height`, whatever the replies look like. */
export const MAX_HEIGHTS_PER_SCAN = HEIGHT_SPAN * MAX_HEIGHT_PAGES_PER_SCAN;
/** How many block headers `rebuildableDeposits` may examine in one scan (it is one call each). */
const MAX_ATTEST_HEIGHTS_PER_SCAN = 512;

export function emptyNoteStore() {
  return {
    scanned_index: 0, scanned_height: 0, scanned_attest_height: 0,
    notes: [], sent: [], submissions: [],
    // height -> unix milliseconds, filled in as notes are found. The chain's own `time` word is a
    // block number, not a clock, so this is the only place a wallet can learn when a note landed.
    block_times: {},
    // Which chain this store was built from, recorded on the first scan and checked on every one
    // after: a note store is meaningless against a different chain, and merging one into the
    // other silently invents history. `null` until the first scan learns them.
    chain_id: null,
    genesis: null,
    // Bumped by every `rescan()`. A scan that loaded the store before a reset must not write its
    // page back over it — that is how a reset silently no-opped while the UI said "Rescanned".
    reset_epoch: 0,
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
    // A bridge burn's two halves. `plan_burn` selects BOTH bundles' notes (the asset to burn and
    // the RAND to pay with) and costs nothing; `prove_burn` proves both, sequentially, and costs
    // about 3.5 minutes. `fee` is optional on the plan (it defaults to the chain's
    // `BRIDGE_BURN_FEE`) and **required** on the proof — see core/crates/wallet-core.
    planBurn: (req) => call('plan_burn', req),
    proveBurn: (req) => call('prove_burn', req),
    openWithTxKey: (cm, envelope, tx_key) => call('open_with_tx_key', { cm, envelope, tx_key }),
    formatAmount: (units) => call('format_amount', { units: String(units) }),
    parseAmount: (text) => call('parse_amount', { text }),
  };
}

/**
 * The chain id a proof commits to: the chain that was **verified**, not the one in settings.
 *
 * They can diverge silently — a store that knows chain 13 scans happily whatever
 * `settings.chainId` says, because the configured id is only compared when an identity is first
 * adopted — and a proof bound to the wrong chain id is refused by the chain at best. Shared by
 * `send` and `burn` so the two cannot drift; a burn costs two proofs, so getting this wrong there
 * is twice as expensive.
 */
function provenChainIdOf(st, identity) {
  const proven = identity && identity.chainId !== null && identity.chainId !== undefined
    ? identity.chainId
    : st.chain_id;
  if (proven === null || proven === undefined) {
    throw new Error('this wallet has no verified chain to prove against');
  }
  if (st.chain_id !== null && String(st.chain_id) !== String(proven)) {
    const err = new Error('This node is on a different chain — switch node or rescan.');
    err.definite = true;
    throw err;
  }
  return proven;
}

export function makeWallet({ core, store, rpc, settings, annotate = true, onReset }) {
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
    const broken = NUMERIC_FIELDS.filter((key) => !isCursor(s[key]));
    if (broken.length) {
      for (const key of NUMERIC_FIELDS) s[key] = 0;
      s.recovered = true;
    }
    if (!isCursor(s.reset_epoch)) s.reset_epoch = 0;
    if (typeof s.genesis !== 'string' || s.genesis === '') s.genesis = null;
    if (!isCursor(s.chain_id) && typeof s.chain_id !== 'string') s.chain_id = null;
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
  async function persist(st, previous, { reset = false } = {}) {
    // A reset that happened underneath this scan wins. Without this the losing writer's merge path
    // re-maxes the cursors and re-merges the notes, and the rescan the user asked for evaporates.
    if (!reset) {
      const current = (await store.getNoteStore()) || {};
      const epoch = isCursor(current.reset_epoch) ? current.reset_epoch : 0;
      if (epoch > (isCursor(st.reset_epoch) ? st.reset_epoch : 0)) {
        const err = new Error('this wallet was rescanned while the scan was running; the scan was discarded');
        err.name = 'StoreResetError';
        err.retryable = true;
        throw err;
      }
    }
    for (const key of NUMERIC_FIELDS) {
      if (!isCursor(st[key])) throw new Error(`refusing to save the note store: ${key} is not a block cursor (${String(st[key])})`);
    }
    // Monotonicity is asserted for work cursors only. `head` is the node's reported tip, and a tip
    // that goes down is an ordinary fact about a node (a lagging replica, a restore from snapshot,
    // a different node in Settings) — not a reason to refuse every future write for ever.
    for (const key of WORK_CURSORS) {
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
      // A RESET is never merged. Merging a reset into the winner's store is exactly how a rescan
      // silently no-ops: the cursors get re-maxed and the notes re-added. `rescan` catches this,
      // re-reads and applies the reset to the new store instead.
      if (reset) throw err;
      // Another tab wrote while this scan was running. Take its store, re-apply this scan's own
      // findings onto it (every merge here is by index, so doing it twice is a no-op) and try
      // once more. A second loss means the tabs are fighting; that is the user's to retry.
      const fresh = await loadStore();
      if (!reset && (fresh.reset_epoch || 0) > (st.reset_epoch || 0)) {
        const stop = new Error('this wallet was rescanned while the scan was running; the scan was discarded');
        stop.name = 'StoreResetError';
        stop.retryable = true;
        throw stop;
      }
      mergeNotes(fresh, st.notes);
      mergeSent(fresh, st.sent);
      for (const sub of st.submissions) if (!fresh.submissions.some((x) => x.hash === sub.hash)) fresh.submissions.push(sub);
      Object.assign(fresh.block_times, st.block_times);
      Object.assign(fresh.note_tx, st.note_tx);
      for (const key of WORK_CURSORS) fresh[key] = Math.max(isCursor(fresh[key]) ? fresh[key] : 0, st[key]);
      fresh.reset_epoch = Math.max(fresh.reset_epoch || 0, st.reset_epoch || 0);
      fresh.head = isCursor(st.head) ? st.head : (isCursor(fresh.head) ? fresh.head : 0);
      fresh.chain_id = st.chain_id ?? fresh.chain_id ?? null;
      fresh.genesis = st.genesis ?? fresh.genesis ?? null;
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
  async function rebuildableDeposits(client, spendKey, st, head, signal, onProgress) {
    const out = new Map();
    const start = st.scanned_attest_height;
    if (start > head) return { deposits: out, through: start - 1 };
    // Three outcomes, not two. "The bridge is off" is an answer — there are no attestations to
    // find, so reading nothing really does cover the range. "I could not tell you" is not: the
    // old code swallowed the error into `enabled = false` and then advanced the cursor 512 heights
    // per scan over blocks it never looked at, so a node that was merely down for that one call
    // could hide a bridge deposit for ever.
    let enabled = false;
    let known = false;
    try {
      enabled = checkBridgeState(await client.bridgeState({ signal })).enabled;
      known = true;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
    }
    if (!known) return { deposits: out, through: start - 1, unknown: true };
    // A chain with no bridge has no attestations, so the range is read by reading nothing — but
    // the cursor still moves only as far as one scan's worth, for the same reason every other
    // cursor does: `head` is the node's claim, and a claim near 2^53 must not become a cursor.
    if (!enabled) return { deposits: out, through: Math.min(head, start + MAX_ATTEST_HEIGHTS_PER_SCAN - 1) };
    // One `rand_getBlockByHeight` per height, so this is capped: a wallet that has been away for
    // 50 000 blocks catches up over several scans instead of making 50 000 calls in one, and the
    // cursor advances only as far as the blocks actually examined (the same rule as every other
    // cursor here).
    const last = Math.min(head, start + MAX_ATTEST_HEIGHTS_PER_SCAN - 1);
    let examined = start - 1;
    for (let h = start; h <= last; h++) {
      throwIfAborted(signal);
      // Every action is re-parsed into a plain, size-bounded object before it reaches the core.
      for (const action of checkBlockActions(await client.blockByHeight(h, { signal }))) {
        if (action.kind !== 'bridge_attest') continue;
        const note = await c.rebuiltDeposit(spendKey, action);
        if (note) out.set(note.cm, note);
      }
      examined = h;
      if ((h - start) % 64 === 63) onProgress?.({ phase: 'deposits', scanned: h, total: head });
    }
    return { deposits: out, through: examined };
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
   * Which chain is at the other end of this RPC URL: the chain id and the genesis hash.
   *
   * Both, because id alone is not enough — "chain 11 and chain 12 could carry the same id on a
   * misconfigured node". This function reports exactly what the node said and nothing else: a
   * missing method yields `chainId: null` or `genesis: null` for that field alone, with
   * `reachable` saying whether the node answered anything at all. There is no fallback to
   * `settings.chainId` here or anywhere below it — a node that omits a field is judged on that
   * omission by `chainVerdict`, never quietly waved through on the id alone.
   */
  async function chainIdentity(client, signal) {
    // "The node said no" and "there was no node" are different facts, and the caller needs both:
    // a node that answers `unknown method` has identified itself as anonymous, while one that
    // cannot be reached has identified itself as nothing at all. `makeRpc` gives transport
    // failures the code -1 and passes a node's own JSON-RPC error code through.
    let reachable = false;
    const attempt = async (run) => {
      try {
        const value = await run();
        reachable = true;
        return value;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!err || err.code !== -1) reachable = true; // the node answered, even if with a refusal
        return null;
      }
    };
    const genesis = await attempt(async () => checkGenesisHash(await client.rpc('rand_getGenesisHash', [], { signal })));
    const raw = await attempt(async () => client.chainId({ signal }));
    const chainId = raw === undefined || raw === null || raw === '' ? null : raw;
    return { chainId, genesis, reachable };
  }

  /**
   * Which chain is at the other end, and what to do about it.
   *
   * **The node's identity is the node's own word, and nothing else** — `chainIdentity` asks the
   * node and reports exactly what it said, with no fallback to anything this wallet already
   * believes. Omitting two methods is not a proof of anything.
   *
   *   store knows   node supplies              verdict
   *   ───────────   ───────────────────────    ──────────────────────────────────────────────────
   *   nothing       both id and genesis        adopt them — unless the id differs from the one
   *                                            this wallet was configured for, which is
   *                                            `wrongChain` (a new wallet built for chain 13 must
   *                                            not be pinned to an attacker's chain 14)
   *   nothing       one, or neither            `identityUnknown` — do not scan. A wallet must not
   *                                            pin itself to a chain nobody named.
   *   an identity   not every field it knows   `wrongChain`, `got` marked `unknown`
   *   an identity   every field it knows       must match all of them, else `wrongChain`
   */
  function chainVerdict(st, identity, configuredChainId) {
    const knows = { chainId: st.chain_id !== null, genesis: st.genesis !== null };
    const has = { chainId: identity.chainId !== null, genesis: identity.genesis !== null };
    const wrong = (got) => ({ kind: 'wrongChain', expected: { chainId: st.chain_id, genesis: st.genesis }, got });

    if (!knows.chainId && !knows.genesis) {
      if (!has.chainId || !has.genesis) return { kind: 'identityUnknown' };
      const configured = configuredChainId === undefined || configuredChainId === null || configuredChainId === ''
        ? null
        : configuredChainId;
      if (configured !== null && String(configured) !== String(identity.chainId)) {
        return {
          kind: 'wrongChain',
          expected: { chainId: configured, genesis: null },
          got: { chainId: identity.chainId, genesis: identity.genesis },
        };
      }
      // A first scan adopts what the node supplied, in full.
      return { kind: 'adopt' };
    }

    // `got` is built field by field on purpose: `identity` carries `reachable`, which is this
    // file's business and not something a banner should ever be handed.
    const got = { chainId: identity.chainId, genesis: identity.genesis };
    const missing = (knows.chainId && !has.chainId) || (knows.genesis && !has.genesis);
    if (missing) return wrong({ ...got, unknown: true });
    if (knows.chainId && String(st.chain_id) !== String(identity.chainId)) return wrong(got);
    if (knows.genesis && st.genesis !== identity.genesis) return wrong(got);
    // item 7: a store that knows only one half learns the other from a node whose known half
    // matches — otherwise a chain-id-only store accepts chain 13 with ANY genesis for ever.
    if (knows.chainId !== knows.genesis && (has.chainId && has.genesis)) {
      return { kind: 'ok', adoptMissing: { chainId: identity.chainId, genesis: identity.genesis } };
    }
    return { kind: 'ok' };
  }

  /**
   * The cached store, plus one transient marker for the caller. Used for the two outcomes that are
   * neither a successful scan nor an error — a node on another chain, and a node that is behind.
   * Nothing is persisted and nothing is merged: the marker is stripped before any write (TRANSIENT).
   */
  function withMarker(st, key, value) {
    const out = { ...st };
    out[key] = value;
    return out;
  }

  /**
   * The way out that is not a wipe. Clears the work cursors so the chain is re-read from the
   * start; with `{ forChain: true }` (a chain change) it also drops the notes, the sent rows, the
   * submissions and the block annotations, because they describe a chain this wallet is no longer
   * on. The vault, the settings and the keys are untouched — this is a cache reset, not a wipe.
   */
  async function rescan(spendKey, { forChain = false, onProgress, signal, client } = {}, settingsOverride) {
    // Written as a RESET, never merged: on a lost compare-and-set race the reset is re-applied to
    // whatever the winner wrote, not folded into it. Merging a reset is how it silently no-ops.
    let written = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      const st = await loadStore();
      for (const key of WORK_CURSORS) st[key] = 0;
      st.head = 0;
      st.chain_id = null;
      st.genesis = null;
      if (forChain) {
        st.notes = [];
        st.sent = [];
        st.submissions = [];
        st.block_times = {};
        st.note_tx = {};
      }
      st.last_sync_ms = 0;
      // Every scan that loaded the store before this point must now abandon its page.
      st.reset_epoch = (st.reset_epoch || 0) + 1;
      try {
        // `previous` omitted and `reset` set: resetting the cursors IS the point, so neither the
        // monotonicity check nor the epoch check applies to this write.
        await persist(st, undefined, { reset: true });
        written = st;
        break;
      } catch (err) {
        if (!isStaleStoreError(err)) throw err;
        // Someone else wrote first; read their store and reset that one instead.
      }
    }
    if (!written) {
      const err = new Error('another tab kept changing this wallet; try the rescan again');
      err.retryable = true;
      throw err;
    }
    onReset?.(written.reset_epoch);
    return scan(spendKey, { onProgress, signal, client }, settingsOverride);
  }

  /**
   * Trial-decrypt every new leaf, then mark spent notes from the nullifier set. `onProgress`
   * receives `{phase, scanned, total}`. Saves the store and returns it. `signal` aborts the paging
   * and rejects with an AbortError.
   */
  async function scan(spendKey, { onProgress, signal, client: given } = {}, settingsOverride) {
    throwIfAborted(signal);
    const s = settingsOverride || (await currentSettings());
    // One client for the whole scan. The caller may hand in the one it verified — and should:
    // resolving a fresh one here would let a node saved mid-scan collect a verdict it never
    // earned (see backend-wasm.js's `runScan`).
    const client = given || (await rpcFor(s));
    const st = await loadStore();
    const before = { ...st };
    const head0 = checkHead(await client.head({ signal })).height;

    // ---- is this the chain this store was built from? ----
    // A note store is a cache of ONE chain's tree. Merged into another chain's it invents history
    // — leaf indexes mean something else, heights mean something else, and nothing says so. The
    // identity is read on the first scan and checked on every one after; a mismatch scans nothing,
    // persists nothing, and hands the caller something the UI can act on.
    const identity = await chainIdentity(client, signal);
    const verdict = chainVerdict(st, identity, s && s.chainId);
    if (verdict.kind === 'wrongChain') {
      return withMarker(st, 'wrongChain', { expected: verdict.expected, got: verdict.got });
    }
    if (verdict.kind === 'identityUnknown') {
      // Blocking, not informational: a wallet that adopts an unnamed chain can never afterwards
      // tell that it has been moved to a different one.
      return withMarker(st, 'identityUnknown', true);
    }

    // ---- is this node behind this wallet? ----
    // Not an error and not a reason to move anything: a replica that has not caught up, or a node
    // restored from a snapshot. Scanning resumes by itself once its tip passes what we have read.
    if (st.scanned_height > 0 && head0 < st.scanned_height - 1) {
      return withMarker(st, 'behind', { tip: head0, wallet: st.scanned_height - 1 });
    }

    // A first scan adopts the identity the node gave in full; `chainVerdict` has already refused
    // anything less than that.
    if (verdict.kind === 'adopt') { st.chain_id = identity.chainId; st.genesis = identity.genesis; }
    // A store that knew only one half now learns the other, persisted with this scan's page.
    if (verdict.adoptMissing) {
      st.chain_id = verdict.adoptMissing.chainId;
      st.genesis = verdict.adoptMissing.genesis;
    }

    const { deposits, through: attestThrough, unknown: bridgeUnknown } = await rebuildableDeposits(client, spendKey, st, head0, signal, onProgress);
    // The tree's leaf count, when the node serves it: a page may never claim a leaf beyond it.
    let total = 0;
    let leafCount;
    try {
      total = checkTreeInfo(await client.treeInfo({ signal })).next_index;
      leafCount = total;
    } catch { /* a node without it: the continuity checks still apply, this one is skipped */ }

    const placePage = async (rows) => {
      const res = await c.scanPage(spendKey, rows);
      // A rebuilt deposit takes precedence over whatever its envelope says.
      for (const r of rows) {
        const dep = deposits.get(r.cm);
        if (dep) { deposits.delete(r.cm); mergeNotes(st, [{ ...dep, index: r.index, height: r.height }]); }
      }
      mergeNotes(st, res.received);
      mergeSent(st, res.sent);
      const next = intField('scan_page', 'next_index', res.next_index);
      // Our own trust boundary, so it costs nothing to close: the core cannot have seen a leaf
      // past the page it was handed, and one before `from` would move the cursor backwards.
      const from = rows[0].index;
      if (next < from) throw new Error(`the core reported next_index ${next} for a page starting at ${from}`);
      return Math.min(next, from + rows.length);
    };

    for (;;) {
      throwIfAborted(signal);
      const cursorBefore = st.scanned_index;
      const rows = checkCommitments(
        await client.commitments(cursorBefore, PAGE, { signal }),
        { from: cursorBefore, limit: PAGE, leafCount },
      );
      if (rows.length === 0) break;
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
      const cursorBefore = from;
      const rows = checkCommitments(
        await client.commitments(cursorBefore, PAGE, { signal }),
        { from: cursorBefore, limit: PAGE, leafCount },
      );
      if (rows.length === 0) throw new Error(`${deposits.size} rebuilt deposit(s) match no leaf of the tree`);
      await placePage(rows);
      from = Math.max(from, rows[rows.length - 1].index + 1);
      if (from <= cursorBefore) throw new Error('rand_getCommitments did not advance');
    }
    // Every deposit found for [scanned_attest_height, attestThrough] is now in `st.notes`, so the
    // cursor may move — and it is written in the same save as the notes it covers, below.
    // `attestThrough` is the last height actually EXAMINED, never the node's claimed tip.
    st.scanned_attest_height = Math.max(st.scanned_attest_height, attestThrough + 1);

    // Head read *before* paging nullifiers, so every block up to it is covered by the pages.
    const headBefore = checkHead(await client.head({ signal })).height;
    const startedAt = st.scanned_height;
    let cursor = st.scanned_height;
    for (let page = 0; ; page += 1) {
      throwIfAborted(signal);
      if (cursor > headBefore) break; // caught up with what this node claims to have
      if (page >= MAX_HEIGHT_PAGES_PER_SCAN) break; // enough for one scan; the next one continues
      if (cursor - startedAt >= MAX_HEIGHTS_PER_SCAN) break; // …and enough ground, however it moved
      const from = cursor;
      // Validated against the request: a prefix of the ordered set, sorted, nothing below `from`,
      // nothing above the tip this node reported. See THE CURSOR RULE above.
      const rows = checkNullifiers(
        await client.nullifiers(from, PAGE, { signal }),
        { from, limit: PAGE, tip: headBefore },
      );
      const set = new Set(rows.map((r) => r.nullifier));
      for (const n of st.notes) if (set.has(n.nf)) n.spent = true;

      if (rows.length < PAGE) {
        // A claim of absence from `from` onwards. Evidence for the rows (there are none); the
        // reach of the claim is the node's tip, taken one span at a time.
        const next = Math.min(from + HEIGHT_SPAN, headBefore + 1);
        cursor = Math.max(cursor + 1, next); // always progress, so the loop cannot spin
        if (cursor > headBefore) { cursor = headBefore + 1; break; }
        onProgress?.({ phase: 'spends', scanned: cursor, total: headBefore });
        continue;
      }

      // A full page is a prefix: [from, last) is complete, `last` itself may be truncated, so the
      // cursor stops AT `last` and reads it again. Clamped to one span — clamping down only costs
      // a re-read, and it is what stops a page of rows all claiming `tip - 1` from carrying the
      // cursor over every height in between.
      const last = rows[rows.length - 1].height;
      if (last === from) {
        // The condition fires at exactly PAGE too: a full page that never left `from` means the
        // block holds at least that many, and this wallet cannot page inside one height.
        const err = new Error(`block ${from} has ${PAGE} or more nullifiers; this wallet cannot page inside one block`);
        err.name = 'NodeLimitError';
        err.code = 'too_many_nullifiers_in_block';
        throw err;
      }
      cursor = Math.min(last, from + HEIGHT_SPAN);
      onProgress?.({ phase: 'spends', scanned: cursor, total: headBefore });
    }
    // Only as far as the pages actually covered. Never `headBefore + 1` on the node's say-so.
    st.scanned_height = Math.max(st.scanned_height, Math.min(cursor, headBefore + 1));
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
    // Transient, never persisted: things the caller should know about THIS scan.
    if (bridgeUnknown) st.bridgeUnknown = true;
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
  async function send(spendKey, { to, amountUnits, feeUnits, wait = true, onPhase, signal, client: given, identity }, settingsOverride) {
    const s = settingsOverride || (await currentSettings());
    // The client the caller verified, for every step: the fee, the anchor, the witnesses, the
    // broadcast and every retry. A transfer assembled from two nodes is not a transfer.
    const client = given || (await rpcFor(s));
    onPhase?.('select');
    const st = await scan(spendKey, { signal, client }, s);
    const need = toUnits(amountUnits) + toUnits(feeUnits);
    const sel = await c.selectInputs(st.notes, need.toString(), 0);
    onPhase?.('witness');
    const { anchor, paths } = await anchorAndWitnesses(client, sel.chosen, signal);
    onPhase?.('prove');
    const provenChainId = provenChainIdOf(st, identity);
    const res = await c.proveTransfer({
      spend_key: spendKey,
      chain_id: provenChainId,
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
        // The SAME client the gate verified for this send — not a fresh one. Calling `scan` with
        // no client here would let it resolve its own via `rpcFor(s)`, which reads whatever
        // `settings.rpcUrl` says *now*; a node saved between 'submit' and here would collect a
        // verdict it never earned, exactly the bug `requireVerifiedChain()` exists to prevent.
        await scan(spendKey, { client }, s);
      }
    }
    return submission;
  }

  /**
   * Plan, prove and submit a **bridge burn**: `amount` of a registry (RPL) asset leaves the
   * shielded pool for `to` on `to_chain`, paid for out of a second bundle of RAND notes.
   * `onPhase` receives 'select' | 'witness' | 'prove-asset' | 'submit' | 'wait'.
   *
   * This is `send()`'s shape with three differences, all of them the chain's:
   *
   *   1. **Two bundles, one anchor.** `plan_burn` selects the asset notes and the RAND fee notes
   *      separately, and `prove_burn` takes ONE `anchor_height`/`anchor_root` for both — so the
   *      witnesses for both lists are fetched in a single `anchorAndWitnesses` call, which is
   *      also the only way to be sure the two halves agree about the tree.
   *   2. **Two proofs, ~3.5 minutes, one opaque call.** `prove_burn` proves the asset bundle and
   *      then the fee bundle, sequentially (proving them at once would need ~11 GB and OOM the
   *      machines that only just clear the gate). The core reports nothing in between, so the
   *      phase stays `'prove-asset'` — named for the bundle that is proved first — for the whole
   *      of it, rather than this file inventing progress it cannot observe.
   *   3. **Nothing is addressed to anybody inside the pool.** Every output of both bundles comes
   *      back to this wallet; the recipient lives in the action's `to_chain`/`to`. So there is no
   *      `to_pk`, no per-recipient transaction key to hand over, and the submission record is
   *      what Activity shows.
   *
   * The two facts only the chain knows — the bridge is enabled, and this asset is in the registry
   * — are NOT checked here. `wallet-core` does no I/O and neither does this function's plan step;
   * `bridge.withdraw` (backend-shared.js) checks them off `rand_getBridgeState` before any of this
   * runs, because getting them wrong costs the user both proofs for a transaction the chain was
   * always going to refuse.
   */
  async function burn(spendKey, {
    asset, amountUnits, relayerFeeUnits = '0', toChain, to, feeUnits,
    wait = true, onPhase, signal, client: given, identity,
  }, settingsOverride) {
    const s = settingsOverride || (await currentSettings());
    const client = given || (await rpcFor(s));
    onPhase?.('select');
    const st = await scan(spendKey, { signal, client }, s);
    const plan = await c.planBurn({
      notes: st.notes,
      asset: Number(asset),
      amount: String(amountUnits),
      // Always explicit: the UI has already shown this number to the user as part of an estimate,
      // and `prove_burn` has no default of its own, so the plan and the proof must agree.
      ...(feeUnits === undefined || feeUnits === null ? {} : { fee: String(feeUnits) }),
    });
    const assetInputs = plan.inputs || [];
    const feeInputs = plan.fee_inputs || [];
    onPhase?.('witness');
    // One fetch for both lists, so both bundles are folded against the same root — `prove_burn`
    // takes a single anchor and the ledger checks both bundles against it.
    const { anchor, paths } = await anchorAndWitnesses(client, [...assetInputs, ...feeInputs], signal);
    onPhase?.('prove-asset');
    const provenChainId = provenChainIdOf(st, identity);
    const res = await c.proveBurn({
      spend_key: spendKey,
      chain_id: provenChainId,
      asset: Number(asset),
      amount: String(amountUnits),
      relayer_fee: String(relayerFeeUnits ?? '0'),
      to_chain: Number(toChain),
      to: String(to),
      fee: String(plan.fee),
      anchor_height: anchor.height,
      anchor_root: anchor.root,
      inputs: assetInputs.map((note, i) => ({ note, path: paths[i] })),
      fee_inputs: feeInputs.map((note, i) => ({ note, path: paths[assetInputs.length + i] })),
      profile: 'production',
    });
    // The last point at which nothing has left this device.
    throwIfAborted(signal);
    onPhase?.('submit');
    const hash = checkSubmitted('rand_sendTransaction', await client.sendTransaction(res.tx_hex));
    const fresh = await loadStore();
    // Both bundles' inputs, asset notes first then RAND — `spent_indices`' documented order.
    for (const n of fresh.notes) if (res.spent_indices.includes(n.index)) n.pending = res.time;
    const submission = {
      hash, kind: 'burn', asset: res.asset, amount: res.amount, relayer_fee: res.relayer_fee,
      // `to` comes back normalized (lower-cased, `0x` stripped); the bytes are unchanged.
      to_chain: res.to_chain, to: res.to,
      change: res.change, fee: res.fee, fee_change: res.fee_change, time: res.time, tier: res.tier,
      proof_bytes: res.proof_bytes, spent_indices: res.spent_indices,
      status: 'pending', created_ms: Date.now(),
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
        // The SAME client the gate verified, for the same reason `send` does it.
        await scan(spendKey, { client }, s);
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

  return {
    scan, rescan, send, burn, faucet, loadStore, persist, core: c, rpcFor, activity, balanceOf, isSpendable,
    // Exposed so a backend can prove the chain WITHOUT scanning — the gate in front of send and
    // faucet is two RPC calls, not a page of leaves.
    chainIdentity, chainVerdict,
  };
}

export async function waitForTransaction(client, hash, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Validated: its `height` ends up on a submission record, and from there in the UI.
    const r = checkTransaction(await client.getTransaction(hash));
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
