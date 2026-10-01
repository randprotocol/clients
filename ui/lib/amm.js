// The durian.market AMM, as the wallet's own Swap screen reads it: the pool cells, the quote, and
// the transition handed to `backend.program.invoke`. A port of durian.market's
// web/lib/amm/{math,transitions,route}.ts and web/lib/rand/{cells,words,abi}.ts (themselves twins
// of its Rust crate durian-core), checked against that crate's own vectors
// (ui/test/fixtures/amm-vectors.json). Everything is BigInt in base units.
//
// One program serves every pool, and every pool pairs RAND (asset 0) with one token:
//
//   pool        key [1, 0, token, 0,0,0,0,0]
//               value [rr_lo, rr_hi, rt_lo, rt_hi, s_lo, s_hi, lp_asset, 1]
//
// rr is the RAND reserve, rt the token reserve, s the share supply. The program never divides: it
// checks the amounts it is shown with multiplications, so a quote is the LARGEST output its
// inequality accepts, and the transition is exact — a read is the cell as read, a write the cell
// after, a pay the quoted amount to the unit. If the pool moves first, the read no longer matches
// and the chain refuses the transaction (a stale read, before any proof is wasted: the wallet's
// quote re-reads the cell); the screen then quotes again from the new reserves.

/** The AMM program durian.market runs (rand_getProgram: deployed at height 1947 on chain 20). */
export const DURIAN_PROGRAM = 'db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda';
export const DURIAN_URL = 'https://durian.market';

export const RAND_ASSET = 0;
/** The pool's fee: 997/1000 of the amount sold counts toward the price (0.30%). */
export const FEE_NUM = 997n;
export const FEE_DEN = 1000n;
export const FEE_BPS = 30;
/** Every amount, reserve and supply stays below 2^63, the chain's note bound. */
export const NOTE_BOUND = 1n << 63n;
const METHOD_SWAP = 3;
const TAG_POOL = 1;
const POOL_VERSION = 1;
const WORDS = 8;
const HEX64 = /^[0-9a-f]{64}$/;

// -- Word8: eight little-endian u32 words as 64 lowercase hex characters -----------------------

export function wordsToHex(words) {
  if (words.length > WORDS) throw new RangeError(`a Word8 has ${WORDS} words`);
  let out = '';
  for (let i = 0; i < WORDS; i += 1) {
    const w = words[i] ?? 0;
    if (!Number.isInteger(w) || w < 0 || w > 0xffff_ffff) throw new RangeError(`word ${i} is not a u32`);
    for (let b = 0; b < 4; b += 1) out += ((w >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToWords(hex) {
  if (!HEX64.test(hex)) throw new RangeError('a Word8 is 64 lowercase hex characters');
  const words = [];
  for (let i = 0; i < WORDS; i += 1) {
    let w = 0;
    for (let b = 3; b >= 0; b -= 1) w = w * 256 + parseInt(hex.slice(i * 8 + b * 2, i * 8 + b * 2 + 2), 16);
    words.push(w);
  }
  return words;
}

const u64Words = (v) => [Number(v & 0xffff_ffffn), Number(v >> 32n)];
const wordsU64 = (lo, hi) => (BigInt(hi) << 32n) | BigInt(lo);

/** Key order as the ledger keeps it: word by word, numerically. */
export function compareKeys(a, b) {
  const x = hexToWords(a);
  const y = hexToWords(b);
  for (let i = 0; i < WORDS; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// -- the pool cell ------------------------------------------------------------------------------

export function poolKey(token) {
  if (!(Number.isInteger(token) && token > RAND_ASSET)) throw new RangeError('a pool pairs RAND with a token');
  return wordsToHex([TAG_POOL, RAND_ASSET, token]);
}

export function encodePool({ rr, rt, supply, lpAsset }) {
  return wordsToHex([...u64Words(rr), ...u64Words(rt), ...u64Words(supply), lpAsset, POOL_VERSION]);
}

/** A pool cell `{token, rr, rt, supply, lpAsset, key, value}`, or null for any other cell. */
export function decodePool(cell) {
  if (!cell || !HEX64.test(cell.key) || !HEX64.test(cell.value)) return null;
  const k = hexToWords(cell.key);
  if (k[0] !== TAG_POOL || k[1] !== RAND_ASSET || k[2] === RAND_ASSET || k.slice(3).some((w) => w !== 0)) return null;
  const v = hexToWords(cell.value);
  if (v[7] !== POOL_VERSION) return null;
  const pool = {
    token: k[2], rr: wordsU64(v[0], v[1]), rt: wordsU64(v[2], v[3]), supply: wordsU64(v[4], v[5]),
    lpAsset: v[6], key: cell.key, value: cell.value,
  };
  // An empty side cannot price anything.
  return pool.rr > 0n && pool.rt > 0n ? pool : null;
}

/** Every live pool among a program's cells, by token. */
export function poolsOf(cells) {
  return (cells || []).map(decodePool).filter(Boolean).sort((a, b) => a.token - b.token);
}

// -- the quote ----------------------------------------------------------------------------------

const ltNote = (v) => v >= 0n && v < NOTE_BOUND;

/** What selling `dx` into the side holding `rIn` pays from the side holding `rOut`: the largest
 *  dy ≤ rOut with dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut. Zero when nothing can be bought. */
export function swapOut(rIn, rOut, dx) {
  if (dx <= 0n || !ltNote(dx) || !ltNote(rIn + dx)) return 0n;
  const dy = (FEE_NUM * dx * rOut) / (FEE_DEN * rIn + FEE_NUM * dx);
  return dy < rOut ? dy : rOut;
}

export function poolSwapOut(pool, randIn, dx) {
  return randIn ? swapOut(pool.rr, pool.rt, dx) : swapOut(pool.rt, pool.rr, dx);
}

/** The fee's share of an amount sold, rounded up so the fee plus the priced part is dx. */
export function swapFee(dx) {
  return dx <= 0n ? 0n : dx - (dx * FEE_NUM) / FEE_DEN;
}

/** How far a trade moves the price it gets, in parts per million, the fee excluded. */
export function priceImpactPpm(rIn, rOut, dx, dy) {
  if (dx <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const ideal = FEE_NUM * dx * rOut;
  const got = dy * FEE_DEN * rIn;
  return got >= ideal ? 0n : ((ideal - got) * 1_000_000n) / ideal;
}

function combinePpm(a, b) {
  const m = 1_000_000n;
  return m - ((m - a) * (m - b)) / m;
}

/** Every asset the pools can swap: RAND, and each pool's token. */
export function tradeable(pools) {
  return pools.length === 0 ? [] : [RAND_ASSET, ...pools.map((p) => p.token)];
}

/** The pools a swap of `sell` for `buy` runs through: one for RAND ↔ token, two (through RAND)
 *  for token → token. Null when there is no route. */
export function findRoute(pools, sell, buy) {
  if (sell === buy) return null;
  const of = (t) => pools.find((p) => p.token === t) || null;
  if (sell === RAND_ASSET) { const pool = of(buy); return pool ? { kind: 'direct', pool, randIn: true } : null; }
  if (buy === RAND_ASSET) { const pool = of(sell); return pool ? { kind: 'direct', pool, randIn: false } : null; }
  const [poolIn, poolOut] = [of(sell), of(buy)];
  return poolIn && poolOut ? { kind: 'through', poolIn, poolOut } : null;
}

const fail = (code, message) => ({ ok: false, code, message });
const TOO_SMALL = 'That amount is too small: it would buy nothing.';
const TOO_LARGE = 'That amount is more than the pool can hold.';

function hop(pool, randIn, amountIn) {
  const rIn = randIn ? pool.rr : pool.rt;
  if (rIn + amountIn >= NOTE_BOUND) return fail('over-bound', TOO_LARGE);
  const amountOut = poolSwapOut(pool, randIn, amountIn);
  if (amountOut <= 0n) return fail('dust', TOO_SMALL);
  const after = randIn
    ? { rr: pool.rr + amountIn, rt: pool.rt - amountOut }
    : { rr: pool.rr - amountOut, rt: pool.rt + amountIn };
  const rOut = randIn ? pool.rt : pool.rr;
  return { ok: true, pool, randIn, amountIn, amountOut, fee: swapFee(amountIn), impactPpm: priceImpactPpm(rIn, rOut, amountIn, amountOut), after };
}

const afterValue = (pool, next) => encodePool({ rr: next.rr, rt: next.rt, supply: pool.supply, lpAsset: pool.lpAsset });
const byKey = (cells) => [...cells].sort((a, b) => compareKeys(a.key, b.key));

/** Three random u32 words, so a call's input digest is never a guessable function of public data. */
export function randomWords() {
  const a = new Uint32Array(3);
  globalThis.crypto.getRandomValues(a);
  return [a[0], a[1], a[2]];
}

/**
 * The quote and the exact transition for selling `dx` of `sell` for `buy` along `route`:
 * `{ok: true, sell, buy, amountIn, amountOut, fee, feeAsset, impactPpm, hops, request}` — `request`
 * is what `backend.program.quote/invoke` take — or `{ok: false, code, message}`.
 */
export function buildSwap({ route, dx, rnd = randomWords(), title = '' }) {
  if (!route) return fail('no-route', 'There is no pool for that pair.');
  if (typeof dx !== 'bigint' || dx <= 0n) return fail('no-amount', 'Enter an amount.');
  if (dx >= NOTE_BOUND) return fail('over-bound', TOO_LARGE);
  const inputs = [METHOD_SWAP, rnd[0], rnd[1], rnd[2]];
  if (route.kind === 'direct') {
    const h = hop(route.pool, route.randIn, dx);
    if (!h.ok) return h;
    const [sell, buy] = route.randIn ? [RAND_ASSET, route.pool.token] : [route.pool.token, RAND_ASSET];
    return {
      ok: true, sell, buy, amountIn: dx, amountOut: h.amountOut, fee: h.fee, feeAsset: sell, impactPpm: h.impactPpm, hops: [h],
      request: {
        program: DURIAN_PROGRAM,
        inputs,
        reads: [{ key: route.pool.key, value: route.pool.value }],
        writes: [{ key: route.pool.key, value: afterValue(route.pool, h.after) }],
        inflow: route.randIn
          ? { rand: dx.toString(), asset: 0, amount: '0', kind: 'none' }
          : { rand: '0', asset: route.pool.token, amount: dx.toString(), kind: 'deposit' },
        pays: [{ asset: buy, amount: h.amountOut.toString() }],
        mints: [],
        summary: { title },
      },
    };
  }
  const { poolIn, poolOut } = route;
  const first = hop(poolIn, false, dx);
  if (!first.ok) return first;
  const second = hop(poolOut, true, first.amountOut);
  if (!second.ok) return second;
  return {
    ok: true, sell: poolIn.token, buy: poolOut.token, amountIn: dx, amountOut: second.amountOut,
    fee: first.fee, feeAsset: poolIn.token, impactPpm: combinePpm(first.impactPpm, second.impactPpm), hops: [first, second],
    request: {
      program: DURIAN_PROGRAM,
      inputs,
      reads: byKey([{ key: poolIn.key, value: poolIn.value }, { key: poolOut.key, value: poolOut.value }]),
      writes: byKey([
        { key: poolIn.key, value: afterValue(poolIn, first.after) },
        { key: poolOut.key, value: afterValue(poolOut, second.after) },
      ]),
      inflow: { rand: '0', asset: poolIn.token, amount: dx.toString(), kind: 'deposit' },
      pays: [{ asset: poolOut.token, amount: second.amountOut.toString() }],
      mints: [],
      summary: { title },
    },
  };
}

/** What one whole `sell` (10^sellDecimals base units) buys at the pools' current reserves, before
 *  the fee and the trade's own price impact, in `buy`'s base units. */
export function spotRate(route, sellDecimals) {
  if (!route) return null;
  const scale = (d) => 10n ** BigInt(d);
  // reserves of (sell, buy) along the route
  const ratio = (rIn, rOut) => ({ num: rOut, den: rIn });
  let r;
  if (route.kind === 'direct') r = route.randIn ? ratio(route.pool.rr, route.pool.rt) : ratio(route.pool.rt, route.pool.rr);
  else r = { num: route.poolIn.rr * route.poolOut.rt, den: route.poolIn.rt * route.poolOut.rr };
  // one whole `sell` in base units → `buy` base units
  return (scale(sellDecimals) * r.num) / r.den;
}
