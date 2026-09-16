// Scan, send and faucet — the orchestration of design spec §3.2, mirroring the fullnode's
// `randprotocol_client::wallet`. Every cryptographic step is a core call; this file only moves JSON
// between the node and the note store.
import { core } from './core.js';
import { makeRpc } from './rpc.js';
import { getNoteStore, setNoteStore, getSettings } from './store.js';
import { toBig } from './format.js';

const PAGE = 500;
export const COMMIT_TIMEOUT_MS = 180_000;

export async function rpcFor(settings) {
  const s = settings || (await getSettings());
  return makeRpc(s.rpcUrl);
}

export function balanceOf(store, asset = 0) {
  return store.notes.filter((n) => isSpendable(n) && n.asset === asset).reduce((a, n) => a + toBig(n.amount), 0n);
}
export function isSpendable(n) { return !n.spent && n.pending == null && toBig(n.amount) > 0n; }

function mergeNotes(store, received) {
  for (const n of received) {
    const i = store.notes.findIndex((x) => x.index === n.index);
    if (i < 0) store.notes.push(n);
  }
}
function mergeSent(store, sent) {
  for (const s of sent) if (!store.sent.some((x) => x.index === s.index)) store.sent.push(s);
}

/** Bridge deposits this wallet can rebuild from committed blocks it has not read yet. */
async function rebuildableDeposits(rpc, spendKey, store, head) {
  const out = new Map();
  if (store.scanned_attest_height > head) return out;
  let enabled = false;
  try { enabled = !!(await rpc.bridgeState())?.enabled; } catch { /* a node without the method */ }
  if (!enabled) { store.scanned_attest_height = head + 1; return out; }
  for (let h = store.scanned_attest_height; h <= head; h++) {
    const block = await rpc.blockByHeight(h);
    for (const tx of block?.transactions || []) {
      if (tx?.action?.kind !== 'bridge_attest') continue;
      const note = await core.rebuiltDeposit(spendKey, tx.action);
      if (note) out.set(note.cm, note);
    }
  }
  store.scanned_attest_height = head + 1;
  return out;
}

/**
 * Trial-decrypt every new leaf, then mark spent notes from the nullifier set. `onProgress`
 * receives {phase, scanned, total}. Saves the store and returns it.
 */
export async function scan(spendKey, { onProgress } = {}, settings) {
  const rpc = await rpcFor(settings);
  const store = await getNoteStore();
  const head0 = (await rpc.head()).height;
  const deposits = await rebuildableDeposits(rpc, spendKey, store, head0);
  let total = 0;
  try { total = (await rpc.treeInfo()).next_index; } catch {}

  const placePage = async (rows) => {
    const res = await core.scanPage(spendKey, rows);
    // A rebuilt deposit takes precedence over whatever its envelope says.
    for (const r of rows) {
      const dep = deposits.get(r.cm);
      if (dep) { deposits.delete(r.cm); mergeNotes(store, [{ ...dep, index: r.index, height: r.height }]); }
    }
    mergeNotes(store, res.received);
    mergeSent(store, res.sent);
    return res.next_index;
  };

  for (;;) {
    const rows = await rpc.commitments(store.scanned_index, PAGE);
    if (!rows || rows.length === 0) break;
    const before = store.scanned_index;
    const next = await placePage(rows);
    store.scanned_index = Math.max(store.scanned_index, next);
    if (store.scanned_index <= before) throw new Error(`getCommitments returned ${rows.length} rows from ${before} without advancing`);
    onProgress?.({ phase: 'notes', scanned: store.scanned_index, total });
    await setNoteStore(store);
  }
  // A deposit whose leaf sits below the cursor: re-offer the leaves from the start, once.
  let from = 0;
  while (deposits.size > 0) {
    const rows = await rpc.commitments(from, PAGE);
    if (!rows || rows.length === 0) throw new Error(`${deposits.size} rebuilt deposit(s) match no leaf of the tree`);
    const before = from;
    await placePage(rows);
    from = Math.max(from, rows[rows.length - 1].index + 1);
    if (from <= before) throw new Error('getCommitments did not advance');
  }

  // Head read *before* paging nullifiers, so every block up to it is covered by the pages.
  const headBefore = (await rpc.head()).height;
  let cursor = store.scanned_height;
  for (;;) {
    const rows = await rpc.nullifiers(cursor, PAGE);
    if (!rows || rows.length === 0) break;
    const maxHeight = Math.max(...rows.map((r) => r.height));
    const set = new Set(rows.map((r) => r.nullifier));
    for (const n of store.notes) if (set.has(n.nf)) n.spent = true;
    if (rows.length < PAGE) { cursor = maxHeight + 1; break; }
    if (maxHeight === cursor) throw new Error(`block ${cursor} published more than ${PAGE} nullifiers`);
    cursor = maxHeight;
    onProgress?.({ phase: 'spends', scanned: cursor, total: headBefore });
  }
  store.scanned_height = Math.max(store.scanned_height, cursor, headBefore + 1);
  const readThrough = store.scanned_height - 1;
  for (const n of store.notes) {
    if (n.pending != null && (await core.pendingCleared(n, readThrough))) n.pending = null;
  }
  // Submissions: resolved when their nullifiers are spent or their window has passed.
  for (const s of store.submissions) {
    if (s.status !== 'pending') continue;
    const spent = store.notes.filter((n) => s.spent_indices?.includes(n.index));
    if (spent.length && spent.every((n) => n.spent)) s.status = 'committed';
    else if (readThrough > s.time + 256) s.status = 'expired';
  }
  store.head = headBefore;
  store.last_sync_ms = Date.now();
  await setNoteStore(store);
  return store;
}

/** Fetch the anchor and one witness per input, refetching if the tree moved (3 attempts). */
async function anchorAndWitnesses(rpc, chosen) {
  for (let attempt = 1; ; attempt++) {
    const anchor = await rpc.anchor();
    const paths = [];
    let moved = false;
    for (const n of chosen) {
      const w = await rpc.witness(n.index);
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
 */
export async function send(spendKey, { to, amountUnits, feeUnits, wait = true, onPhase }, settings) {
  const s = settings || (await getSettings());
  const rpc = await rpcFor(s);
  onPhase?.('select');
  const store = await scan(spendKey, {}, s);
  const need = toBig(amountUnits) + toBig(feeUnits);
  const sel = await core.selectInputs(store.notes, need.toString(), 0);
  onPhase?.('witness');
  const { anchor, paths } = await anchorAndWitnesses(rpc, sel.chosen);
  onPhase?.('prove');
  const res = await core.proveTransfer({
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
  onPhase?.('submit');
  const hash = await rpc.sendTransaction(res.tx_hex);
  const fresh = await getNoteStore();
  for (const n of fresh.notes) if (res.spent_indices.includes(n.index)) n.pending = res.time;
  const toInfo = await core.parseAddress(to);
  const submission = {
    hash, to, to_pk: toInfo.pk, amount: res.amount, change: res.change, fee: res.fee, time: res.time, tier: res.tier,
    proof_bytes: res.proof_bytes, tx_key: res.tx_keys[0], commitment: res.commitments[0],
    spent_indices: res.spent_indices, status: 'pending', created_ms: Date.now(),
  };
  fresh.submissions.unshift(submission);
  await setNoteStore(fresh);
  if (wait) {
    onPhase?.('wait');
    const committed = await waitForTransaction(rpc, hash, COMMIT_TIMEOUT_MS);
    if (committed) {
      const st = await getNoteStore();
      const sub = st.submissions.find((x) => x.hash === hash);
      if (sub) { sub.status = 'committed'; sub.height = committed.height; }
      await setNoteStore(st);
      await scan(spendKey, {}, s);
    }
  }
  return submission;
}

export async function waitForTransaction(rpc, hash, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await rpc.getTransaction(hash);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Testnet faucet: 100 RAND into a note only this wallet can open. */
export async function faucet(spendKey, address, settings) {
  const s = settings || (await getSettings());
  const rpc = await rpcFor(s);
  const hash = await rpc.mint(address);
  const store = await getNoteStore();
  store.submissions.unshift({ hash, kind: 'faucet', amount: '100000000000', status: 'pending', created_ms: Date.now(), time: store.head || 0 });
  await setNoteStore(store);
  const committed = await waitForTransaction(rpc, hash, COMMIT_TIMEOUT_MS);
  const st = await getNoteStore();
  const sub = st.submissions.find((x) => x.hash === hash);
  if (sub) sub.status = committed ? 'committed' : 'pending';
  await setNoteStore(st);
  if (committed) await scan(spendKey, {}, s);
  return hash;
}

/** Everything the Activity list shows, newest first. A committed payment appears once: the
 * submission record (which carries the hash and the transaction key) wins over the `sent` row
 * the scan later finds for the same note. */
export function activity(store) {
  const rows = [];
  for (const n of store.notes) {
    if (toBig(n.amount) === 0n) continue; // zero-value change notes are real leaves that buy nothing
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
