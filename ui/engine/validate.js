// Every value this wallet takes from a node, checked before it is believed.
//
// A node is not trusted infrastructure: it is a remote server the user named in Settings, and on
// this chain it is also the only thing that can be wrong about the tree without the wallet
// noticing. The failure this file exists to prevent is not a crash — it is a *silently poisoned
// note store*. `Math.max(...rows.map(r => r.height))` over a row whose `height` is a string is
// `NaN`; `NaN` flows into the scan cursor, IndexedDB's structured clone stores `NaN` happily, and
// every later scan then pages from `NaN`, never clears a pending note and never advances. Only a
// wipe recovers. So: no value from a node reaches arithmetic, a cursor or the persisted store
// without passing through here first.
//
// The rules are deliberately strict and deliberately boring. Integers must be *safe* non-negative
// integers (a block height past 2^53 would already be a lie, and `Number` cannot hold it anyway);
// hex is matched by pattern and bounded by length; amounts are decimal digit strings, never
// `Number`; arrays may not be longer than the page that was asked for.
//
// Errors are `NodeReplyError`, whose message names the RPC method and what was wrong with it. It
// never contains more than a short excerpt of the payload: an error string ends up in a banner, a
// log and possibly a bug report, and a node controls every byte of what it sent.

export class NodeReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NodeReplyError';
  }
}

/** At most 80 characters of whatever the node sent, for an error message. */
function excerpt(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text ?? 'undefined').replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function fail(method, what, value) {
  throw new NodeReplyError(`${method}: ${what}${value === undefined ? '' : ` (${excerpt(value)})`}`);
}

// ------------------------------------------------------------------------------- primitives ---

/** A safe non-negative integer, accepted as a number only. */
export function intField(method, what, value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(method, `${what} is not a non-negative integer`, value);
  }
  return value;
}

/** Hex of an exact length (a commitment, a nullifier, a root: 64 characters). */
export function hexField(method, what, value, length) {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-fA-F]*$/.test(value)) {
    fail(method, `${what} is not ${length} hex characters`, value);
  }
  return value;
}

/**
 * What one note envelope may be, taken from the chain rather than guessed.
 *
 * `randprotocol-core`'s `MAX_ENVELOPE_BYTES` is 2048 for all four parts together, and its own
 * fixture is ML-KEM-768's 1088-byte ciphertext plus 60 + 60 + 140 bytes of sealed material
 * (`core/vendor/fullnode/crates/randprotocol-core/src/notes.rs`). Each field is bounded here at
 * roughly twice its real encoded length — hex, so two characters per byte — and the whole
 * envelope at twice the chain's own cap.
 *
 * The previous bound (65 536 characters per field) let a single 500-row page claim ~128 MB, which
 * a wallet would dutifully buffer and hand to `JSON.parse` before any of it was checked.
 */
export const ENVELOPE_LIMITS = Object.freeze({
  kem_ct: 2 * 2 * 1088,   // ML-KEM-768 ciphertext
  to_receiver: 2 * 2 * 256,
  to_sender: 2 * 2 * 256,
  body: 2 * 2 * 512,
  total: 2 * 2 * 2048,    // 2 × MAX_ENVELOPE_BYTES
});
/** No single page of leaves may be larger than this, in characters, however many rows it has. */
export const MAX_PAGE_CHARS = 8_000_000;

/** Hex of an unknown length (an envelope field), bounded so a reply cannot be a memory attack. */
export function hexBlob(method, what, value, { max = 65536 } = {}) {
  if (typeof value !== 'string' || value.length > max || !/^[0-9a-fA-F]*$/.test(value)) {
    fail(method, `${what} is not hex of at most ${max} characters`, value);
  }
  return value;
}

/** A decimal string of units. Never parsed as a `Number`; callers use `BigInt`. */
export function unitsField(method, what, value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,30}$/.test(text)) {
    fail(method, `${what} is not a decimal amount`, value);
  }
  return text;
}

/** A transaction hash: 32 bytes of hex, with or without the `0x` this chain writes them with. */
export function hashField(method, what, value) {
  if (typeof value !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    fail(method, `${what} is not a transaction hash`, value);
  }
  return value;
}

function objectReply(method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(method, 'the reply is not an object', value);
  return value;
}

function arrayReply(method, value, maxLength) {
  if (!Array.isArray(value)) fail(method, 'the reply is not an array', value);
  if (value.length > maxLength) fail(method, `the reply has ${value.length} rows, more than the ${maxLength} asked for`);
  return value;
}

// ---------------------------------------------------------------------------------- replies ---

/** `rand_getHead` → `{height, hash?, view?}`. */
export function checkHead(reply) {
  const m = 'rand_getHead';
  const head = objectReply(m, reply);
  return { ...head, height: intField(m, 'height', head.height) };
}

/** `rand_getTreeInfo` → `{next_index, root, nullifiers}`. */
export function checkTreeInfo(reply) {
  const m = 'rand_getTreeInfo';
  const info = objectReply(m, reply);
  return { ...info, next_index: intField(m, 'next_index', info.next_index) };
}

/** `rand_getCommitments` → the page of leaves, exactly as `scan_page` takes them. */
export function checkCommitments(reply, { from, limit, leafCount } = {}) {
  const m = 'rand_getCommitments';
  if (!Number.isSafeInteger(from) || from < 0) throw new NodeReplyError(`${m}: called without the index it was asked from`);
  const rows = arrayReply(m, reply, limit);
  // A page must be an answer to the REQUEST, not just well-formed rows. `notes_from(from, limit)`
  // iterates the leaf column family forward from `from`, and leaf indexes are dense, so an honest
  // non-empty reply starts exactly at `from` and is contiguous. Without this check a node could
  // answer a request from 0 with leaf 900, the cursor would move to 901, and leaves 0–899 would
  // never be trial-decrypted — received notes silently missing, with nothing to show for it.
  if (rows.length > 0) {
    const first = rows[0] && rows[0].index;
    if (first !== from) fail(m, `the page starts at leaf ${excerpt(first)}, not the ${from} it was asked for`);
  }
  let pageChars = 0;
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') fail(m, `row ${i} is not an object`, row);
    intField(m, `row ${i} index`, row.index);
    intField(m, `row ${i} height`, row.height);
    hexField(m, `row ${i} cm`, row.cm, 64);
    const env = row.envelope;
    if (!env || typeof env !== 'object') fail(m, `row ${i} envelope is not an object`, env);
    let envChars = 0;
    for (const part of ['kem_ct', 'to_receiver', 'to_sender', 'body']) {
      hexBlob(m, `row ${i} envelope.${part}`, env[part], { max: ENVELOPE_LIMITS[part] });
      envChars += env[part].length;
    }
    if (envChars > ENVELOPE_LIMITS.total) fail(m, `row ${i} envelope is ${envChars} characters, over the chain's own limit`);
    pageChars += envChars;
    if (pageChars > MAX_PAGE_CHARS) fail(m, `the page is over ${MAX_PAGE_CHARS} characters of envelope`);
    if (i > 0 && row.index !== rows[i - 1].index + 1) {
      fail(m, `row ${i} is leaf ${row.index}, not ${rows[i - 1].index + 1} — the page has a gap`);
    }
    // The tree cannot serve a leaf it has not grown. `leafCount` is `rand_getTreeInfo.next_index`
    // read in the same scan; where the node did not serve it, this check is simply skipped.
    if (Number.isSafeInteger(leafCount) && row.index >= leafCount) {
      fail(m, `row ${i} is leaf ${row.index}, past the ${leafCount} leaves the tree reports`);
    }
  });
  return rows;
}

/** `rand_getNullifiers` → `[{height, nullifier}]`. The row this file exists for. */
export function checkNullifiers(reply, { from, limit, tip } = {}) {
  const m = 'rand_getNullifiers';
  if (!Number.isSafeInteger(from) || from < 0) throw new NodeReplyError(`${m}: called without the height it was asked from`);
  const rows = arrayReply(m, reply, limit);
  // `nullifiers_from(from, limit)` collects every row with `height >= from`, sorts, and truncates
  // to `limit` — so an honest reply is a PREFIX of the ordered set: non-decreasing in height, none
  // below `from`, none above the chain's tip. Checking that is what makes the page's coverage
  // knowable (see the cursor rule in wallet.js); without it a node can hand back one page of rows
  // all claiming `tip - 1` and skip everything in between.
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') fail(m, `row ${i} is not an object`, row);
    intField(m, `row ${i} height`, row.height);
    hexField(m, `row ${i} nullifier`, row.nullifier, 64);
    if (row.height < from) fail(m, `row ${i} is at height ${row.height}, below the ${from} it was asked from`);
    if (Number.isSafeInteger(tip) && row.height > tip) {
      fail(m, `row ${i} is at height ${row.height}, above the tip ${tip} this node reported`);
    }
    if (i > 0 && row.height < rows[i - 1].height) {
      fail(m, `row ${i} is at height ${row.height}, below row ${i - 1}'s ${rows[i - 1].height} — the page is not sorted`);
    }
  });
  return rows;
}

/** `rand_getAnchor` → `{height, root}`. */
export function checkAnchor(reply) {
  const m = 'rand_getAnchor';
  const anchor = objectReply(m, reply);
  return { ...anchor, height: intField(m, 'height', anchor.height), root: hexField(m, 'root', anchor.root, 64) };
}

/** `rand_getWitness` → `null` past the end of the tree, else `{index, root, path}` (32 levels). */
export function checkWitness(reply, { depth = 32 } = {}) {
  const m = 'rand_getWitness';
  if (reply === null || reply === undefined) return null;
  const w = objectReply(m, reply);
  hexField(m, 'root', w.root, 64);
  if (!Array.isArray(w.path) || w.path.length !== depth) fail(m, `path is not ${depth} levels`, w.path && w.path.length);
  w.path.forEach((level, i) => hexField(m, `path[${i}]`, level, 64));
  return w;
}

/** `rand_estimateFee` → the minimum fee in units, as a decimal string. */
export function checkFee(reply) {
  return unitsField('rand_estimateFee', 'the fee', reply);
}

/** `rand_getAssets` → the bridge registry, ascending by index; `[]` on a chain without a bridge. */
export function checkAssets(reply, { max = 4096 } = {}) {
  const m = 'rand_getAssets';
  const rows = arrayReply(m, reply, max);
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') fail(m, `row ${i} is not an object`, row);
    intField(m, `row ${i} index`, row.index);
    if (row.asset_id !== undefined && row.asset_id !== null) hexField(m, `row ${i} asset_id`, row.asset_id, 64);
  });
  return rows;
}

/**
 * `rand_getBlockByHeight` → the header, for `annotateBlocks`. Deliberately the most forgiving
 * validator here, because this call is a best-effort enrichment (a timestamp and a transaction
 * hash) and not something a scan's correctness rests on: a header that does not check out yields
 * `null`, i.e. an undated, unlinked note, rather than an error that fails the whole scan. What it
 * must never do is let a bad `timestamp_ms` through into a stored value.
 */
export function checkBlockHeader(reply) {
  const m = 'rand_getBlockByHeight';
  if (reply === null || reply === undefined) return null;
  if (typeof reply !== 'object' || Array.isArray(reply)) return null;
  const out = {};
  if (typeof reply.timestamp_ms === 'number' && Number.isSafeInteger(reply.timestamp_ms) && reply.timestamp_ms > 0) {
    out.timestamp_ms = reply.timestamp_ms;
  }
  out.transactions = [];
  if (Array.isArray(reply.transactions)) {
    for (const tx of reply.transactions.slice(0, 4096)) {
      if (!tx || typeof tx !== 'object') continue;
      if (typeof tx.hash !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(tx.hash)) continue;
      const commitments = [];
      const list = tx.bundle && Array.isArray(tx.bundle.commitments) ? tx.bundle.commitments : [];
      for (const cm of list.slice(0, 64)) {
        if (typeof cm === 'string' && /^[0-9a-fA-F]{64}$/.test(cm)) commitments.push(cm);
      }
      out.transactions.push({ hash: tx.hash, commitments });
    }
  }
  // `fail` is never reached above; the method name is kept for symmetry with the others.
  void m;
  return out;
}

/**
 * `rand_getGenesisHash` → the chain's genesis hash, hex.
 *
 * Chain id alone is not enough on a project that cuts chains as often as this one (the node's own
 * docs say so): two chains can carry the same id on a misconfigured node. This is what tells a
 * wallet that the node it is now pointed at is not the chain its note store was built from.
 */
export function checkGenesisHash(reply) {
  const m = 'rand_getGenesisHash';
  if (typeof reply !== 'string') fail(m, 'the reply is not a string', reply);
  const value = reply.trim().replace(/^0x/i, '');
  if (value.length < 32 || value.length > 128 || !/^[0-9a-fA-F]+$/.test(value)) {
    fail(m, 'the genesis hash is not hex of a plausible length', reply);
  }
  return value.toLowerCase();
}

/**
 * `rand_getBlockByHeight`, as `rebuildableDeposits` needs it: the *actions* of the block's
 * transactions, each a plain object of bounded size, because every one of them is handed to the
 * wasm core (`rebuilt_deposit`). Nothing raw from a node reaches the core.
 */
export function checkBlockActions(reply, { maxTransactions = 4096, maxActionChars = 8192 } = {}) {
  const m = 'rand_getBlockByHeight';
  if (reply === null || reply === undefined) return [];
  if (typeof reply !== 'object' || Array.isArray(reply)) fail(m, 'the reply is not an object', reply);
  const list = Array.isArray(reply.transactions) ? reply.transactions : [];
  if (list.length > maxTransactions) fail(m, `the block has ${list.length} transactions`);
  const actions = [];
  for (const tx of list) {
    if (!tx || typeof tx !== 'object') continue;
    const action = tx.action;
    if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
    if (typeof action.kind !== 'string' || action.kind.length > 64) continue;
    let encoded;
    try { encoded = JSON.stringify(action); } catch { continue; } // a cycle, or something unserialisable
    if (typeof encoded !== 'string' || encoded.length > maxActionChars) {
      fail(m, `an action is ${encoded ? encoded.length : '?'} characters, more than ${maxActionChars}`);
    }
    // Re-parsed, so what reaches the core is a plain object with no prototype tricks or getters.
    actions.push(JSON.parse(encoded));
  }
  return actions;
}

/** `rand_getTransaction` → `null` until committed, else the record; only `height` is read. */
export function checkTransaction(reply) {
  const m = 'rand_getTransaction';
  if (reply === null || reply === undefined) return null;
  const record = objectReply(m, reply);
  return { height: intField(m, 'height', record.height) };
}

/** `rand_sendTransaction` / `rand_mint` → the transaction hash. */
export function checkSubmitted(method, reply) {
  return hashField(method, 'the transaction hash', reply);
}

/** `rand_getBridgeState` → `{enabled, …}`; only `enabled` is read. */
export function checkBridgeState(reply) {
  const m = 'rand_getBridgeState';
  const state = objectReply(m, reply);
  return { enabled: state.enabled === true };
}
