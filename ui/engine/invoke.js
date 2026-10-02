// RPL-2 `invoke` — what a site asks this wallet to do with a program, checked and read back before
// anything is proved. Pure: no node, no core, no storage.
//
// The request is the one durian.market sends through `window.rand.invoke` (its
// `web/lib/rand/types.ts`): `{program, inputs, reads, writes, inflow, pays, mints, summary}`, every
// amount a decimal string of base units. **It comes from a web page**, so nothing in it is believed
// beyond its shape: the core hashes the program's code against `program` and runs the transition
// before a proof is paid for, the chain re-checks every read, and what the approval window shows the
// user is this file's reading of the request (`invokeEffects`) — what leaves the wallet and what
// comes back — never the page's own `summary`, which is shown only as the site's title.
//
// Errors carry a string `code`, the contract the page branches on (`USER_REJECTED`, `STALE_READ`,
// …), and `definite: true` where nothing was sent.

/** The most private input words, cells and payouts a request may name before the chain's own
 *  limits (`rand_getLimits.program_state`) are even asked: a page cannot make the wallet hold
 *  megabytes of its JSON. The chain's caps (8 reads, 8 writes, 4 payouts on the devnet) are far
 *  below these and are applied by the core. */
import { t } from '../i18n.js';

export const INVOKE_LIMITS = Object.freeze({ inputs: 4096, cells: 64, payouts: 16, title: 120, summaryRows: 16 });

const WORD8_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const UNITS_RE = /^[0-9]{1,30}$/;
export const ZERO_WORD8 = '0'.repeat(64);

/** An Error with the page-facing `code`. `definite` (the default) means nothing left this device. */
export function invokeError(code, message, { definite = true } = {}) {
  const err = new Error(message);
  err.code = code;
  if (definite) err.definite = true;
  return err;
}

const bad = (what) => invokeError('BAD_REQUEST', t('The site sent an invoke this wallet cannot read: {reason}.', { reason: what }));

function word8(value, what) {
  if (typeof value !== 'string' || !WORD8_RE.test(value)) throw bad(t('{field} is not {n} hex characters', { field: what, n: 64 }));
  return value.replace(/^0x/, '').toLowerCase();
}

function u32(value, what) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw bad(t('{field} is not a 32-bit word', { field: what }));
  return value;
}

function units(value, what) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string' || !UNITS_RE.test(text)) throw bad(t('{field} is not a decimal amount', { field: what }));
  return text.replace(/^0+(?=\d)/, '');
}

function list(value, what, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad(t('{field} is not a list', { field: what }));
  if (value.length > max) throw bad(t('{field} has {n} entries, more than {max}', { field: what, n: value.length, max }));
  return value;
}

const cells = (value, what) => list(value, what, INVOKE_LIMITS.cells).map((c, i) => {
  if (!c || typeof c !== 'object') throw bad(t('{field} is not a cell', { field: `${what}[${i}]` }));
  return { key: word8(c.key, `${what}[${i}].key`), value: word8(c.value, `${what}[${i}].value`) };
});

const amounts = (value, what, max) => list(value, what, max).map((p, i) => {
  if (!p || typeof p !== 'object') throw bad(t('{field} is not an amount', { field: `${what}[${i}]` }));
  return { asset: u32(p.asset, `${what}[${i}].asset`), amount: units(p.amount, `${what}[${i}].amount`) };
});

function text(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters and bidi overrides out: the title goes into the approval window verbatim.
  const clean = value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The page's request, checked for shape and copied into plain data — nothing of the page's object
 * survives (no getters, no prototypes). Throws `BAD_REQUEST`. The rules the chain enforces on
 * meaning (keys ascending, inflow consistent with its amount, payout caps) are the core's, applied
 * by `dry_run_invoke` with the chain's own words; only what this file needs to read is held here.
 */
export function normalizeInvokeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(t('the request is not an object'));
  const inflowRaw = raw.inflow && typeof raw.inflow === 'object' ? raw.inflow : {};
  const kind = inflowRaw.kind === undefined ? 'none' : inflowRaw.kind;
  if (kind !== 'none' && kind !== 'deposit' && kind !== 'burn') throw bad(t('{field} is not none, deposit or burn', { field: 'inflow.kind' }));
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  return {
    program: word8(raw.program, 'program'),
    inputs: list(raw.inputs, 'inputs', INVOKE_LIMITS.inputs).map((w, i) => u32(w, `inputs[${i}]`)),
    reads: cells(raw.reads, 'reads'),
    writes: cells(raw.writes, 'writes'),
    inflow: {
      rand: units(inflowRaw.rand ?? '0', 'inflow.rand'),
      asset: u32(inflowRaw.asset ?? 0, 'inflow.asset'),
      amount: units(inflowRaw.amount ?? '0', 'inflow.amount'),
      kind,
    },
    pays: amounts(raw.pays, 'pays', INVOKE_LIMITS.payouts),
    mints: amounts(raw.mints, 'mints', INVOKE_LIMITS.payouts),
    // The site's words, for the window's heading only.
    title: text(summary.title, INVOKE_LIMITS.title),
  };
}

/** `[{asset, amount}]` summed per asset, ascending, zero rows dropped. */
function byAsset(rows) {
  const sum = new Map();
  for (const { asset, amount } of rows) sum.set(asset, (sum.get(asset) || 0n) + BigInt(amount));
  return [...sum.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => a[0] - b[0])
    .map(([asset, v]) => ({ asset, amount: v.toString() }));
}

/**
 * What this invoke takes out of the wallet and what it pays back in, read from the request itself
 * (never from the page's `summary`): RAND into the program's vault (`inflow.rand`) plus the network
 * `fee`, the one token the bundle burns into it (`inflow.amount` of `inflow.asset`), and every
 * `pays`/`mints` note — all of which the wallet addresses to itself.
 */
export function invokeEffects(req, fee = '0') {
  const spend = [{ asset: 0, amount: req.inflow.rand }];
  if (req.inflow.kind !== 'none') spend.push({ asset: req.inflow.asset, amount: req.inflow.amount });
  return {
    spend: byAsset(spend),
    fee: String(fee),
    receive: byAsset([...req.pays, ...req.mints]),
  };
}

/**
 * The cells a transition's writes would create — a non-zero value where the chain holds zeros —
 * which the fee pays `cell_fee` each for. `live(key)` answers the chain's current value; a read of
 * the same key has already answered it (`reads` carry the value the site saw, which the stale-read
 * check has just compared with the chain's).
 */
export async function createdCells(req, live) {
  let created = 0;
  for (const w of req.writes) {
    if (w.value === ZERO_WORD8) continue;
    const read = req.reads.find((r) => r.key === w.key);
    const now = read ? read.value : await live(w.key);
    if (now === ZERO_WORD8) created += 1;
  }
  return created;
}

/**
 * The vault must hold what the transition pays out of it, counting what this same transition
 * deposits (`inflow.rand`, and `inflow.amount` when the kind is `deposit`) — the CLI's check
 * (`rand program invoke`), so a swap the pool cannot cover costs no proof. `null` when it can.
 */
export function vaultShortfall(req, vault) {
  const held = new Map((vault || []).map((r) => [r.asset, BigInt(r.amount)]));
  for (const { asset, amount } of byAsset(req.pays)) {
    let have = held.get(asset) || 0n;
    if (asset === 0) have += BigInt(req.inflow.rand);
    else if (req.inflow.kind === 'deposit' && req.inflow.asset === asset) have += BigInt(req.inflow.amount);
    if (have < BigInt(amount)) return { asset, have: have.toString(), want: amount };
  }
  return null;
}

/** A refusal from the node at submit that is the chain saying a read was stale. */
export function isStaleRead(err) {
  const msg = String((err && err.message) || '');
  return /stale ?read/i.test(msg);
}
