package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * The durian.market AMM, as the wallet's own Swap screen reads it: the pool cells, the quote, and
 * the transition handed to {@link WalletService#invoke}. A port of {@code ui/lib/amm.js} (itself a
 * port of durian.market's planner, a twin of its Rust crate durian-core), checked against that
 * crate's own vectors ({@code src/test/resources/amm-vectors.json}). Every amount is a BigInteger
 * in base units.
 *
 * <p>One program serves every pool, and every pool pairs RAND (asset 0) with one token:
 *
 * <pre>
 *   pool        key [1, 0, token, 0,0,0,0,0]
 *               value [rr_lo, rr_hi, rt_lo, rt_hi, s_lo, s_hi, lp_asset, 1]
 * </pre>
 *
 * rr is the RAND reserve, rt the token reserve, s the share supply. The program never divides: it
 * checks the amounts it is shown with multiplications, so a quote is the LARGEST output its
 * inequality accepts, and the transition is exact — a read is the cell as read, a write the cell
 * after, a pay the quoted amount to the unit. If the pool moves first, the read no longer matches
 * and the chain refuses the transaction (a stale read, caught before any proof by the quote, which
 * re-reads the cell); the screen then quotes again from the new reserves.
 */
public final class Amm {
    private Amm() {}

    /** The AMM program durian.market runs (rand_getProgram: deployed at height 1947 on chain 20). */
    public static final String DURIAN_PROGRAM = "db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda";
    public static final String DURIAN_URL = "https://durian.market";

    public static final int RAND_ASSET = 0;
    /** The pool's fee: 997/1000 of the amount sold counts toward the price (0.30%). */
    public static final BigInteger FEE_NUM = BigInteger.valueOf(997);
    public static final BigInteger FEE_DEN = BigInteger.valueOf(1000);
    public static final int FEE_BPS = 30;
    /** Every amount, reserve and supply stays below 2^63, the chain's note bound. */
    public static final BigInteger NOTE_BOUND = BigInteger.ONE.shiftLeft(63);
    static final int METHOD_SWAP = 3;
    private static final long TAG_POOL = 1;
    private static final long POOL_VERSION = 1;
    private static final int WORDS = 8;
    private static final BigInteger MILLION = BigInteger.valueOf(1_000_000);
    private static final BigInteger U32_MASK = BigInteger.valueOf(0xffff_ffffL);

    // ------------------------------------------------------------------ Word8

    /** Eight little-endian u32 words as 64 lowercase hex characters; missing words are zero. */
    public static String wordsToHex(long... words) {
        if (words.length > WORDS) throw new IllegalArgumentException("a Word8 has " + WORDS + " words");
        StringBuilder out = new StringBuilder(64);
        for (int i = 0; i < WORDS; i++) {
            long w = i < words.length ? words[i] : 0;
            if (w < 0 || w > 0xffff_ffffL) throw new IllegalArgumentException("word " + i + " is not a u32");
            for (int b = 0; b < 4; b++) out.append(String.format(Locale.ROOT, "%02x", (w >>> (8 * b)) & 0xff));
        }
        return out.toString();
    }

    public static long[] hexToWords(String hex) {
        if (hex == null || !hex.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("a Word8 is 64 lowercase hex characters");
        long[] words = new long[WORDS];
        for (int i = 0; i < WORDS; i++) {
            long w = 0;
            for (int b = 3; b >= 0; b--) w = w * 256 + Integer.parseInt(hex.substring(i * 8 + b * 2, i * 8 + b * 2 + 2), 16);
            words[i] = w;
        }
        return words;
    }

    /** Key order as the ledger keeps it: word by word, numerically. */
    public static int compareKeys(String a, String b) {
        long[] x = hexToWords(a);
        long[] y = hexToWords(b);
        for (int i = 0; i < WORDS; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
        return 0;
    }

    private static long lo(BigInteger v) {
        return v.and(U32_MASK).longValue();
    }

    private static long hi(BigInteger v) {
        return v.shiftRight(32).longValue();
    }

    private static BigInteger u64(long lo, long hi) {
        return BigInteger.valueOf(hi).shiftLeft(32).or(BigInteger.valueOf(lo));
    }

    // ------------------------------------------------------------------ the pool cell

    /** A live pool: RAND against {@code token}. */
    public static final class Pool {
        public final int token;
        public final BigInteger rr;
        public final BigInteger rt;
        public final BigInteger supply;
        public final long lpAsset;
        public final String key;
        public final String value;

        public Pool(int token, BigInteger rr, BigInteger rt, BigInteger supply, long lpAsset, String key, String value) {
            this.token = token;
            this.rr = rr;
            this.rt = rt;
            this.supply = supply;
            this.lpAsset = lpAsset;
            this.key = key;
            this.value = value;
        }
    }

    public static String poolKey(int token) {
        if (token <= RAND_ASSET) throw new IllegalArgumentException("a pool pairs RAND with a token");
        return wordsToHex(TAG_POOL, RAND_ASSET, token);
    }

    public static String encodePool(BigInteger rr, BigInteger rt, BigInteger supply, long lpAsset) {
        return wordsToHex(lo(rr), hi(rr), lo(rt), hi(rt), lo(supply), hi(supply), lpAsset, POOL_VERSION);
    }

    /** A pool cell, or null for any other cell (the LP binding the program also keeps, a wrong version, an empty side). */
    public static Pool decodePool(String key, String value) {
        if (key == null || value == null || !key.matches("[0-9a-f]{64}") || !value.matches("[0-9a-f]{64}")) return null;
        long[] k = hexToWords(key);
        if (k[0] != TAG_POOL || k[1] != RAND_ASSET || k[2] == RAND_ASSET) return null;
        for (int i = 3; i < WORDS; i++) if (k[i] != 0) return null;
        if (k[2] > Integer.MAX_VALUE) return null;
        long[] v = hexToWords(value);
        if (v[7] != POOL_VERSION) return null;
        Pool p = new Pool((int) k[2], u64(v[0], v[1]), u64(v[2], v[3]), u64(v[4], v[5]), v[6], key, value);
        // An empty side cannot price anything.
        return p.rr.signum() > 0 && p.rt.signum() > 0 ? p : null;
    }

    /** Every live pool among a program's cells ({@code [{key, value}]}), by token. */
    public static List<Pool> poolsOf(JSONArray cells) {
        List<Pool> out = new ArrayList<>();
        if (cells == null) return out;
        for (int i = 0; i < cells.length(); i++) {
            JSONObject c = cells.optJSONObject(i);
            if (c == null) continue;
            Pool p = decodePool(c.optString("key", null), c.optString("value", null));
            if (p != null) out.add(p);
        }
        Collections.sort(out, (a, b) -> Integer.compare(a.token, b.token));
        return out;
    }

    // ------------------------------------------------------------------ the quote

    private static boolean ltNote(BigInteger v) {
        return v.signum() >= 0 && v.compareTo(NOTE_BOUND) < 0;
    }

    /**
     * What selling {@code dx} into the side holding {@code rIn} pays from the side holding
     * {@code rOut}: the largest dy ≤ rOut with dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut. Zero when
     * nothing can be bought.
     */
    public static BigInteger swapOut(BigInteger rIn, BigInteger rOut, BigInteger dx) {
        if (dx.signum() <= 0 || !ltNote(dx) || !ltNote(rIn.add(dx))) return BigInteger.ZERO;
        BigInteger dy = FEE_NUM.multiply(dx).multiply(rOut).divide(FEE_DEN.multiply(rIn).add(FEE_NUM.multiply(dx)));
        return dy.min(rOut);
    }

    public static BigInteger poolSwapOut(BigInteger rr, BigInteger rt, boolean randIn, BigInteger dx) {
        return randIn ? swapOut(rr, rt, dx) : swapOut(rt, rr, dx);
    }

    /** The fee's share of an amount sold, rounded up so the fee plus the priced part is dx. */
    public static BigInteger swapFee(BigInteger dx) {
        return dx.signum() <= 0 ? BigInteger.ZERO : dx.subtract(dx.multiply(FEE_NUM).divide(FEE_DEN));
    }

    /** How far a trade moves the price it gets, in parts per million, the fee excluded. */
    public static BigInteger priceImpactPpm(BigInteger rIn, BigInteger rOut, BigInteger dx, BigInteger dy) {
        if (dx.signum() <= 0 || rIn.signum() <= 0 || rOut.signum() <= 0) return BigInteger.ZERO;
        BigInteger ideal = FEE_NUM.multiply(dx).multiply(rOut);
        BigInteger got = dy.multiply(FEE_DEN).multiply(rIn);
        return got.compareTo(ideal) >= 0 ? BigInteger.ZERO : ideal.subtract(got).multiply(MILLION).divide(ideal);
    }

    static BigInteger combinePpm(BigInteger a, BigInteger b) {
        return MILLION.subtract(MILLION.subtract(a).multiply(MILLION.subtract(b)).divide(MILLION));
    }

    /** Every asset the pools can swap: RAND, and each pool's token. */
    public static List<Integer> tradeable(List<Pool> pools) {
        List<Integer> out = new ArrayList<>();
        if (pools.isEmpty()) return out;
        out.add(RAND_ASSET);
        for (Pool p : pools) out.add(p.token);
        return out;
    }

    /** One pool for RAND ↔ token, or two (through RAND) for token → token. */
    public static final class Route {
        public final boolean through;
        /** Direct: the pool and which side is sold. */
        public final Pool pool;
        public final boolean randIn;
        /** Through RAND: sell into {@code poolIn}, buy out of {@code poolOut}. */
        public final Pool poolIn;
        public final Pool poolOut;

        private Route(boolean through, Pool pool, boolean randIn, Pool poolIn, Pool poolOut) {
            this.through = through;
            this.pool = pool;
            this.randIn = randIn;
            this.poolIn = poolIn;
            this.poolOut = poolOut;
        }
    }

    private static Pool of(List<Pool> pools, int token) {
        for (Pool p : pools) if (p.token == token) return p;
        return null;
    }

    /** The pools a swap of {@code sell} for {@code buy} runs through, or null when there is no route. */
    public static Route findRoute(List<Pool> pools, int sell, int buy) {
        if (sell == buy) return null;
        if (sell == RAND_ASSET) {
            Pool p = of(pools, buy);
            return p == null ? null : new Route(false, p, true, null, null);
        }
        if (buy == RAND_ASSET) {
            Pool p = of(pools, sell);
            return p == null ? null : new Route(false, p, false, null, null);
        }
        Pool in = of(pools, sell);
        Pool out = of(pools, buy);
        return in != null && out != null ? new Route(true, null, false, in, out) : null;
    }

    /** One pool's part of a swap: what goes in, what comes out, and the pool's reserves after. */
    public static final class Hop {
        public final Pool pool;
        public final boolean randIn;
        public final BigInteger amountIn;
        public final BigInteger amountOut;
        public final BigInteger fee;
        public final BigInteger impactPpm;
        public final BigInteger rrAfter;
        public final BigInteger rtAfter;

        Hop(Pool pool, boolean randIn, BigInteger amountIn, BigInteger amountOut, BigInteger fee, BigInteger impactPpm,
            BigInteger rrAfter, BigInteger rtAfter) {
            this.pool = pool;
            this.randIn = randIn;
            this.amountIn = amountIn;
            this.amountOut = amountOut;
            this.fee = fee;
            this.impactPpm = impactPpm;
            this.rrAfter = rrAfter;
            this.rtAfter = rtAfter;
        }
    }

    /** {@link #buildSwap}'s answer: the quote and the exact request, or a refusal with its code. */
    public static final class Swap {
        public final boolean ok;
        /** {@code no-route}, {@code no-amount}, {@code over-bound} or {@code dust} when not ok. */
        public final String code;
        public final String message;
        public final int sell;
        public final int buy;
        public final BigInteger amountIn;
        public final BigInteger amountOut;
        public final BigInteger fee;
        public final int feeAsset;
        public final BigInteger impactPpm;
        public final List<Hop> hops;
        /** What {@link WalletService#quoteInvoke} and {@link WalletService#invoke} take. */
        public final JSONObject request;

        private Swap(String code, String message) {
            this.ok = false;
            this.code = code;
            this.message = message;
            this.sell = 0;
            this.buy = 0;
            this.amountIn = BigInteger.ZERO;
            this.amountOut = BigInteger.ZERO;
            this.fee = BigInteger.ZERO;
            this.feeAsset = 0;
            this.impactPpm = BigInteger.ZERO;
            this.hops = Collections.emptyList();
            this.request = null;
        }

        private Swap(int sell, int buy, BigInteger amountIn, BigInteger amountOut, BigInteger fee, int feeAsset,
                     BigInteger impactPpm, List<Hop> hops, JSONObject request) {
            this.ok = true;
            this.code = null;
            this.message = null;
            this.sell = sell;
            this.buy = buy;
            this.amountIn = amountIn;
            this.amountOut = amountOut;
            this.fee = fee;
            this.feeAsset = feeAsset;
            this.impactPpm = impactPpm;
            this.hops = Collections.unmodifiableList(hops);
            this.request = request;
        }
    }

    static final String TOO_SMALL = "That amount is too small: it would buy nothing.";
    static final String TOO_LARGE = "That amount is more than the pool can hold.";

    private static Object hop(Pool pool, boolean randIn, BigInteger amountIn) {
        BigInteger rIn = randIn ? pool.rr : pool.rt;
        BigInteger rOut = randIn ? pool.rt : pool.rr;
        if (rIn.add(amountIn).compareTo(NOTE_BOUND) >= 0) return new Swap("over-bound", TOO_LARGE);
        BigInteger out = poolSwapOut(pool.rr, pool.rt, randIn, amountIn);
        if (out.signum() <= 0) return new Swap("dust", TOO_SMALL);
        BigInteger rr = randIn ? pool.rr.add(amountIn) : pool.rr.subtract(out);
        BigInteger rt = randIn ? pool.rt.subtract(out) : pool.rt.add(amountIn);
        return new Hop(pool, randIn, amountIn, out, swapFee(amountIn), priceImpactPpm(rIn, rOut, amountIn, out), rr, rt);
    }

    private static JSONObject cell(String key, String value) throws JSONException {
        return new JSONObject().put("key", key).put("value", value);
    }

    private static JSONObject after(Hop h) throws JSONException {
        return cell(h.pool.key, encodePool(h.rrAfter, h.rtAfter, h.pool.supply, h.pool.lpAsset));
    }

    /** Cells in key order, as the ledger wants reads and writes. */
    private static JSONArray byKey(JSONObject a, JSONObject b) {
        boolean swap = compareKeys(a.optString("key"), b.optString("key")) > 0;
        return new JSONArray().put(swap ? b : a).put(swap ? a : b);
    }

    private static JSONObject inflow(String rand, int asset, String amount, String kind) throws JSONException {
        return new JSONObject().put("rand", rand).put("asset", asset).put("amount", amount).put("kind", kind);
    }

    /** Three random u32 words, so a call's input digest is never a guessable function of public data. */
    public static long[] randomWords() {
        SecureRandom r = new SecureRandom();
        return new long[]{r.nextInt() & 0xffff_ffffL, r.nextInt() & 0xffff_ffffL, r.nextInt() & 0xffff_ffffL};
    }

    public static Swap buildSwap(Route route, BigInteger dx) {
        return buildSwap(route, dx, randomWords(), "");
    }

    /**
     * The quote and the exact transition for selling {@code dx} of the route's sold asset — the
     * request is {@code {program, inputs, reads, writes, inflow, pays, mints, summary}}, every
     * amount a decimal string, as {@code ui/lib/amm.js}'s {@code buildSwap} makes it.
     */
    public static Swap buildSwap(Route route, BigInteger dx, long[] rnd, String title) {
        if (route == null) return new Swap("no-route", "There is no pool for that pair.");
        if (dx == null || dx.signum() <= 0) return new Swap("no-amount", "Enter an amount.");
        if (dx.compareTo(NOTE_BOUND) >= 0) return new Swap("over-bound", TOO_LARGE);
        try {
            JSONArray inputs = new JSONArray().put(METHOD_SWAP).put(rnd[0]).put(rnd[1]).put(rnd[2]);
            JSONObject summary = new JSONObject().put("title", title == null ? "" : title);
            if (!route.through) {
                Object r = hop(route.pool, route.randIn, dx);
                if (r instanceof Swap) return (Swap) r;
                Hop h = (Hop) r;
                int sell = route.randIn ? RAND_ASSET : route.pool.token;
                int buy = route.randIn ? route.pool.token : RAND_ASSET;
                JSONObject request = new JSONObject()
                        .put("program", DURIAN_PROGRAM)
                        .put("inputs", inputs)
                        .put("reads", new JSONArray().put(cell(route.pool.key, route.pool.value)))
                        .put("writes", new JSONArray().put(after(h)))
                        .put("inflow", route.randIn
                                ? inflow(dx.toString(), 0, "0", "none")
                                : inflow("0", route.pool.token, dx.toString(), "deposit"))
                        .put("pays", new JSONArray().put(new JSONObject().put("asset", buy).put("amount", h.amountOut.toString())))
                        .put("mints", new JSONArray())
                        .put("summary", summary);
                List<Hop> hops = new ArrayList<>();
                hops.add(h);
                return new Swap(sell, buy, dx, h.amountOut, h.fee, sell, h.impactPpm, hops, request);
            }
            Object r1 = hop(route.poolIn, false, dx);
            if (r1 instanceof Swap) return (Swap) r1;
            Hop first = (Hop) r1;
            Object r2 = hop(route.poolOut, true, first.amountOut);
            if (r2 instanceof Swap) return (Swap) r2;
            Hop second = (Hop) r2;
            JSONObject request = new JSONObject()
                    .put("program", DURIAN_PROGRAM)
                    .put("inputs", inputs)
                    .put("reads", byKey(cell(route.poolIn.key, route.poolIn.value), cell(route.poolOut.key, route.poolOut.value)))
                    .put("writes", byKey(after(first), after(second)))
                    .put("inflow", inflow("0", route.poolIn.token, dx.toString(), "deposit"))
                    .put("pays", new JSONArray().put(new JSONObject().put("asset", route.poolOut.token).put("amount", second.amountOut.toString())))
                    .put("mints", new JSONArray())
                    .put("summary", summary);
            List<Hop> hops = new ArrayList<>();
            hops.add(first);
            hops.add(second);
            return new Swap(route.poolIn.token, route.poolOut.token, dx, second.amountOut, first.fee, route.poolIn.token,
                    combinePpm(first.impactPpm, second.impactPpm), hops, request);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * What one whole sold asset (10^sellDecimals base units) buys at the pools' current reserves,
     * before the fee and the trade's own price impact, in the bought asset's base units.
     */
    public static BigInteger spotRate(Route route, int sellDecimals) {
        if (route == null) return null;
        BigInteger num;
        BigInteger den;
        if (!route.through) {
            num = route.randIn ? route.pool.rt : route.pool.rr;
            den = route.randIn ? route.pool.rr : route.pool.rt;
        } else {
            num = route.poolIn.rr.multiply(route.poolOut.rt);
            den = route.poolIn.rt.multiply(route.poolOut.rr);
        }
        return BigInteger.TEN.pow(sellDecimals).multiply(num).divide(den);
    }
}
