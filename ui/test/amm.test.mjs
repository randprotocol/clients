// ui/lib/amm.js — the durian.market AMM as the Swap screen reads it: the quote matches durian's own
// crate to the unit (its generated vectors), and the transition is exact — the write is the pool
// after the trade, the pay is the quote, and the program's inequality holds for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DURIAN_PROGRAM, NOTE_BOUND, buildSwap, compareKeys, decodePool, encodePool, findRoute, hexToWords,
  poolKey, poolSwapOut, poolsOf, spotRate, swapFee, swapOut, tradeable, wordsToHex,
} from '../lib/amm.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/amm-vectors.json', import.meta.url), 'utf8'));
const B = (s) => BigInt(s);

// The live chain-20 cell of the RAND/token-2 pool, as rand_getProgramCells answered (2026-10-01).
const LIVE = { key: '0100000000000000020000000000000000000000000000000000000000000000', value: '007e9420310000005f981f6a04000000338ebab90e0000000300000001000000' };

test('swapOut matches durian-core for every swap vector', () => {
  for (const v of vectors.swap) {
    const pool = { rr: B(v.rr), rt: B(v.rt) };
    assert.equal(poolSwapOut(pool, v.randIn, B(v.dx)).toString(), v.dy, JSON.stringify(v));
  }
});

test('a token → token swap through RAND matches durian-core for every vector', () => {
  for (const v of vectors.swapThrough) {
    const mid = swapOut(B(v.rtA), B(v.rrA), B(v.dx));
    const dz = mid > 0n ? swapOut(B(v.rrB), B(v.rtB), mid) : 0n;
    assert.equal(mid.toString(), v.mid, JSON.stringify(v));
    assert.equal(dz.toString(), v.dz, JSON.stringify(v));
  }
});

test('Word8 hex is eight little-endian u32 words, and keys order word by word', () => {
  assert.equal(wordsToHex([1]), `01000000${'0'.repeat(56)}`);
  assert.deepEqual(hexToWords(wordsToHex([1, 0, 2, 0xffffffff])), [1, 0, 2, 0xffffffff, 0, 0, 0, 0]);
  assert.equal(poolKey(2), LIVE.key);
  assert.equal(compareKeys(poolKey(2), poolKey(10)), -1);
  assert.equal(compareKeys(poolKey(256), poolKey(2)), 1, 'numeric, not lexicographic on the hex');
});

test('the live pool cell decodes, and encodes back byte for byte', () => {
  const p = decodePool(LIVE);
  assert.equal(p.token, 2);
  assert.equal(p.lpAsset, 3);
  assert.ok(p.rr > 0n && p.rt > 0n && p.supply > 0n);
  assert.equal(encodePool(p), LIVE.value);
  // Any other cell — the LP binding the program also keeps, a wrong version — is no pool.
  assert.equal(decodePool({ key: '0200000003000000000000000000000000000000000000000000000000000000', value: '0100000000000000020000000000000000000000000000000000000000000000' }), null);
  assert.equal(decodePool({ key: LIVE.key, value: `${LIVE.value.slice(0, 56)}02000000` }), null);
  assert.deepEqual(poolsOf([LIVE, { key: 'zz', value: 'zz' }]).map((x) => x.token), [2]);
  assert.deepEqual(tradeable(poolsOf([LIVE])), [0, 2]);
});

test('RAND → token: the write is the pool after the trade, the pay is the quote, and the program accepts it', () => {
  const pool = decodePool(LIVE);
  const route = findRoute([pool], 0, 2);
  const dx = 1_000_000_000n; // 1 RAND
  const s = buildSwap({ route, dx, rnd: [7, 8, 9], title: 'Swap 1 RAND' });
  assert.equal(s.ok, true);
  const r = s.request;
  assert.equal(r.program, DURIAN_PROGRAM);
  assert.deepEqual(r.inputs, [3, 7, 8, 9], 'METHOD_SWAP and the three random words');
  assert.deepEqual(r.reads, [LIVE]);
  assert.deepEqual(r.inflow, { rand: '1000000000', asset: 0, amount: '0', kind: 'none' }, 'RAND goes in as the bundle\'s RAND burn');
  assert.deepEqual(r.pays, [{ asset: 2, amount: s.amountOut.toString() }]);
  assert.deepEqual(r.mints, []);
  const after = decodePool({ key: r.writes[0].key, value: r.writes[0].value });
  assert.equal(after.rr, pool.rr + dx);
  assert.equal(after.rt, pool.rt - s.amountOut);
  assert.equal(after.supply, pool.supply);
  assert.equal(after.lpAsset, pool.lpAsset);
  // The program's own check: dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut, and one unit more fails it.
  const ok = (dy) => dy * (1000n * pool.rr + 997n * dx) <= 997n * dx * pool.rt;
  assert.ok(ok(s.amountOut));
  assert.ok(!ok(s.amountOut + 1n), 'the quote is the largest the program accepts');
  assert.equal(s.fee, swapFee(dx));
  assert.equal(s.feeAsset, 0);
});

test('token → RAND deposits the token, and pays RAND', () => {
  const pool = decodePool(LIVE);
  const s = buildSwap({ route: findRoute([pool], 2, 0), dx: 10_000_000_000n, rnd: [1, 2, 3] });
  assert.equal(s.ok, true);
  assert.deepEqual(s.request.inflow, { rand: '0', asset: 2, amount: '10000000000', kind: 'deposit' });
  assert.deepEqual(s.request.pays, [{ asset: 0, amount: s.amountOut.toString() }]);
  const after = decodePool(s.request.writes[0]);
  assert.equal(after.rt, pool.rt + 10_000_000_000n);
  assert.equal(after.rr, pool.rr - s.amountOut);
});

test('token → token runs through both pools, reads and writes in key order', () => {
  const a = { token: 5, rr: 9_000_000_000n, rt: 4_000_000_000n, supply: 6_000_000_000n, lpAsset: 6 };
  const b = { token: 2, rr: 8_000_000_000n, rt: 3_000_000_000n, supply: 5_000_000_000n, lpAsset: 3 };
  const cell = (p) => ({ key: poolKey(p.token), value: encodePool(p) });
  const pools = poolsOf([cell(a), cell(b)]);
  const s = buildSwap({ route: findRoute(pools, 5, 2), dx: 100_000_000n, rnd: [1, 1, 1] });
  assert.equal(s.ok, true);
  assert.equal(s.hops.length, 2);
  assert.deepEqual(s.request.reads.map((c) => c.key), [poolKey(2), poolKey(5)], 'ascending');
  assert.deepEqual(s.request.writes.map((c) => c.key), [poolKey(2), poolKey(5)]);
  assert.deepEqual(s.request.inflow, { rand: '0', asset: 5, amount: '100000000', kind: 'deposit' });
  const mid = swapOut(a.rt, a.rr, 100_000_000n);
  assert.equal(s.amountOut, swapOut(b.rr, b.rt, mid));
  assert.deepEqual(s.request.pays, [{ asset: 2, amount: s.amountOut.toString() }]);
});

test('what cannot be swapped is refused before anything is built', () => {
  const pool = decodePool(LIVE);
  assert.equal(findRoute([pool], 0, 0), null);
  assert.equal(findRoute([pool], 0, 9), null);
  assert.equal(buildSwap({ route: null, dx: 1n }).code, 'no-route');
  assert.equal(buildSwap({ route: findRoute([pool], 0, 2), dx: 0n }).code, 'no-amount');
  assert.equal(buildSwap({ route: findRoute([pool], 0, 2), dx: NOTE_BOUND }).code, 'over-bound');
  // The pool holds ~11× more RAND than token units, so one base unit of RAND buys no token unit.
  assert.equal(buildSwap({ route: findRoute([pool], 0, 2), dx: 1n }).code, 'dust', 'one unit buys nothing');
});

test('the spot rate is the reserves\' ratio in the bought asset\'s units', () => {
  const pool = decodePool(LIVE);
  assert.equal(spotRate(findRoute([pool], 0, 2), 9), (10n ** 9n * pool.rt) / pool.rr);
  assert.equal(spotRate(null, 9), null);
});
