package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Scanner;

/**
 * {@link Amm}, the durian.market AMM as the Swap screen reads it — {@code ui/test/amm.test.mjs} on
 * the JVM: the quote matches durian's own crate to the unit (its generated vectors, copied from
 * {@code ui/test/fixtures/amm-vectors.json}), and the transition is exact — the write is the pool
 * after the trade, the pay is the quote, and the program's inequality holds for it.
 */
public class AmmTest {
    /** The live chain-20 cell of the RAND/token-2 pool, as rand_getProgramCells answered (2026-10-01). */
    static final String LIVE_KEY = "0100000000000000020000000000000000000000000000000000000000000000";
    static final String LIVE_VALUE = "007e9420310000005f981f6a04000000338ebab90e0000000300000001000000";

    static JSONObject vectors() throws Exception {
        try (InputStream in = AmmTest.class.getResourceAsStream("/amm-vectors.json")) {
            return new JSONObject(new Scanner(in, StandardCharsets.UTF_8.name()).useDelimiter("\\A").next());
        }
    }

    static BigInteger B(String s) {
        return new BigInteger(s);
    }

    static Amm.Pool live() {
        return Amm.decodePool(LIVE_KEY, LIVE_VALUE);
    }

    static JSONArray cells(String... kv) throws Exception {
        JSONArray a = new JSONArray();
        for (int i = 0; i < kv.length; i += 2) a.put(new JSONObject().put("key", kv[i]).put("value", kv[i + 1]));
        return a;
    }

    @Test
    public void swapOutMatchesDurianCoreForEverySwapVector() throws Exception {
        JSONArray swap = vectors().getJSONArray("swap");
        assertTrue(swap.length() >= 100);
        for (int i = 0; i < swap.length(); i++) {
            JSONObject v = swap.getJSONObject(i);
            assertEquals(v.toString(), v.getString("dy"),
                    Amm.poolSwapOut(B(v.getString("rr")), B(v.getString("rt")), v.getBoolean("randIn"), B(v.getString("dx"))).toString());
        }
    }

    @Test
    public void aTokenToTokenSwapThroughRandMatchesDurianCoreForEveryVector() throws Exception {
        JSONArray through = vectors().getJSONArray("swapThrough");
        assertTrue(through.length() >= 50);
        for (int i = 0; i < through.length(); i++) {
            JSONObject v = through.getJSONObject(i);
            BigInteger mid = Amm.swapOut(B(v.getString("rtA")), B(v.getString("rrA")), B(v.getString("dx")));
            BigInteger dz = mid.signum() > 0 ? Amm.swapOut(B(v.getString("rrB")), B(v.getString("rtB")), mid) : BigInteger.ZERO;
            assertEquals(v.toString(), v.getString("mid"), mid.toString());
            assertEquals(v.toString(), v.getString("dz"), dz.toString());
        }
    }

    @Test
    public void word8IsEightLittleEndianWordsAndKeysOrderWordByWord() {
        assertEquals("01000000" + "0".repeat(56), Amm.wordsToHex(1));
        assertArrayEquals(new long[]{1, 0, 2, 0xffffffffL, 0, 0, 0, 0}, Amm.hexToWords(Amm.wordsToHex(1, 0, 2, 0xffffffffL)));
        assertEquals(LIVE_KEY, Amm.poolKey(2));
        assertEquals(-1, Amm.compareKeys(Amm.poolKey(2), Amm.poolKey(10)));
        assertEquals("numeric, not lexicographic on the hex", 1, Amm.compareKeys(Amm.poolKey(256), Amm.poolKey(2)));
    }

    @Test
    public void theLivePoolCellDecodesAndEncodesBackByteForByte() throws Exception {
        Amm.Pool p = live();
        assertNotNull(p);
        assertEquals(2, p.token);
        assertEquals(3, p.lpAsset);
        assertTrue(p.rr.signum() > 0 && p.rt.signum() > 0 && p.supply.signum() > 0);
        assertEquals(LIVE_VALUE, Amm.encodePool(p.rr, p.rt, p.supply, p.lpAsset));
        // Any other cell — the LP binding the program also keeps, a wrong version — is no pool.
        assertNull(Amm.decodePool("0200000003000000000000000000000000000000000000000000000000000000",
                "0100000000000000020000000000000000000000000000000000000000000000"));
        assertNull(Amm.decodePool(LIVE_KEY, LIVE_VALUE.substring(0, 56) + "02000000"));
        List<Amm.Pool> pools = Amm.poolsOf(cells(LIVE_KEY, LIVE_VALUE, "zz", "zz"));
        assertEquals(1, pools.size());
        assertEquals(2, pools.get(0).token);
        assertEquals(Arrays.asList(0, 2), Amm.tradeable(pools));
    }

    @Test
    public void randToTokenWritesThePoolAfterThePaysTheQuoteAndTheProgramAcceptsIt() throws Exception {
        Amm.Pool pool = live();
        Amm.Route route = Amm.findRoute(Arrays.asList(pool), 0, 2);
        BigInteger dx = BigInteger.valueOf(1_000_000_000L); // 1 RAND
        Amm.Swap s = Amm.buildSwap(route, dx, new long[]{7, 8, 9}, "Swap 1 RAND");
        assertTrue(s.ok);
        JSONObject r = s.request;
        assertEquals(Amm.DURIAN_PROGRAM, r.getString("program"));
        assertEquals("METHOD_SWAP and the three random words", "[3,7,8,9]", r.getJSONArray("inputs").toString());
        assertEquals(1, r.getJSONArray("reads").length());
        assertEquals(LIVE_KEY, r.getJSONArray("reads").getJSONObject(0).getString("key"));
        assertEquals(LIVE_VALUE, r.getJSONArray("reads").getJSONObject(0).getString("value"));
        JSONObject inflow = r.getJSONObject("inflow");
        assertEquals("RAND goes in as the bundle's RAND burn", "1000000000", inflow.getString("rand"));
        assertEquals(0, inflow.getInt("asset"));
        assertEquals("0", inflow.getString("amount"));
        assertEquals("none", inflow.getString("kind"));
        JSONArray pays = r.getJSONArray("pays");
        assertEquals(1, pays.length());
        assertEquals(2, pays.getJSONObject(0).getInt("asset"));
        assertEquals(s.amountOut.toString(), pays.getJSONObject(0).getString("amount"));
        assertEquals(0, r.getJSONArray("mints").length());
        assertEquals("Swap 1 RAND", r.getJSONObject("summary").getString("title"));
        JSONObject w = r.getJSONArray("writes").getJSONObject(0);
        Amm.Pool after = Amm.decodePool(w.getString("key"), w.getString("value"));
        assertEquals(pool.rr.add(dx), after.rr);
        assertEquals(pool.rt.subtract(s.amountOut), after.rt);
        assertEquals(pool.supply, after.supply);
        assertEquals(pool.lpAsset, after.lpAsset);
        // The program's own check: dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut, and one unit more fails it.
        BigInteger lhsK = BigInteger.valueOf(1000).multiply(pool.rr).add(BigInteger.valueOf(997).multiply(dx));
        BigInteger rhs = BigInteger.valueOf(997).multiply(dx).multiply(pool.rt);
        assertTrue(s.amountOut.multiply(lhsK).compareTo(rhs) <= 0);
        assertTrue("the quote is the largest the program accepts", s.amountOut.add(BigInteger.ONE).multiply(lhsK).compareTo(rhs) > 0);
        assertEquals(Amm.swapFee(dx), s.fee);
        assertEquals(0, s.feeAsset);
    }

    @Test
    public void tokenToRandDepositsTheTokenAndPaysRand() throws Exception {
        Amm.Pool pool = live();
        BigInteger dx = BigInteger.valueOf(10_000_000_000L);
        Amm.Swap s = Amm.buildSwap(Amm.findRoute(Arrays.asList(pool), 2, 0), dx, new long[]{1, 2, 3}, "");
        assertTrue(s.ok);
        JSONObject inflow = s.request.getJSONObject("inflow");
        assertEquals("0", inflow.getString("rand"));
        assertEquals(2, inflow.getInt("asset"));
        assertEquals("10000000000", inflow.getString("amount"));
        assertEquals("deposit", inflow.getString("kind"));
        JSONObject pay = s.request.getJSONArray("pays").getJSONObject(0);
        assertEquals(0, pay.getInt("asset"));
        assertEquals(s.amountOut.toString(), pay.getString("amount"));
        JSONObject w = s.request.getJSONArray("writes").getJSONObject(0);
        Amm.Pool after = Amm.decodePool(w.getString("key"), w.getString("value"));
        assertEquals(pool.rt.add(dx), after.rt);
        assertEquals(pool.rr.subtract(s.amountOut), after.rr);
    }

    @Test
    public void tokenToTokenRunsThroughBothPoolsReadingAndWritingInKeyOrder() throws Exception {
        String a = Amm.encodePool(B("9000000000"), B("4000000000"), B("6000000000"), 6);
        String b = Amm.encodePool(B("8000000000"), B("3000000000"), B("5000000000"), 3);
        List<Amm.Pool> pools = Amm.poolsOf(cells(Amm.poolKey(5), a, Amm.poolKey(2), b));
        BigInteger dx = B("100000000");
        Amm.Swap s = Amm.buildSwap(Amm.findRoute(pools, 5, 2), dx, new long[]{1, 1, 1}, "");
        assertTrue(s.ok);
        assertEquals(2, s.hops.size());
        JSONArray reads = s.request.getJSONArray("reads");
        JSONArray writes = s.request.getJSONArray("writes");
        assertEquals("ascending", Amm.poolKey(2), reads.getJSONObject(0).getString("key"));
        assertEquals(Amm.poolKey(5), reads.getJSONObject(1).getString("key"));
        assertEquals(Amm.poolKey(2), writes.getJSONObject(0).getString("key"));
        assertEquals(Amm.poolKey(5), writes.getJSONObject(1).getString("key"));
        JSONObject inflow = s.request.getJSONObject("inflow");
        assertEquals(5, inflow.getInt("asset"));
        assertEquals("100000000", inflow.getString("amount"));
        assertEquals("deposit", inflow.getString("kind"));
        BigInteger mid = Amm.swapOut(B("4000000000"), B("9000000000"), dx);
        assertEquals(Amm.swapOut(B("8000000000"), B("3000000000"), mid), s.amountOut);
        assertEquals(2, s.request.getJSONArray("pays").getJSONObject(0).getInt("asset"));
        assertEquals(s.amountOut.toString(), s.request.getJSONArray("pays").getJSONObject(0).getString("amount"));
    }

    @Test
    public void whatCannotBeSwappedIsRefusedBeforeAnythingIsBuilt() {
        List<Amm.Pool> pools = Arrays.asList(live());
        assertNull(Amm.findRoute(pools, 0, 0));
        assertNull(Amm.findRoute(pools, 0, 9));
        assertEquals("no-route", Amm.buildSwap(null, BigInteger.ONE).code);
        assertEquals("no-amount", Amm.buildSwap(Amm.findRoute(pools, 0, 2), BigInteger.ZERO).code);
        assertEquals("over-bound", Amm.buildSwap(Amm.findRoute(pools, 0, 2), Amm.NOTE_BOUND).code);
        // The pool holds ~11× more RAND than token units, so one base unit of RAND buys no token unit.
        Amm.Swap dust = Amm.buildSwap(Amm.findRoute(pools, 0, 2), BigInteger.ONE);
        assertFalse(dust.ok);
        assertEquals("one unit buys nothing", "dust", dust.code);
        assertNull(dust.request);
    }

    @Test
    public void theSpotRateIsTheReservesRatioInTheBoughtAssetsUnits() {
        Amm.Pool pool = live();
        assertEquals(BigInteger.TEN.pow(9).multiply(pool.rt).divide(pool.rr), Amm.spotRate(Amm.findRoute(Arrays.asList(pool), 0, 2), 9));
        assertNull(Amm.spotRate(null, 9));
    }

    @Test
    public void randomWordsAreThreeU32s() {
        long[] w = Amm.randomWords();
        assertEquals(3, w.length);
        for (long x : w) assertTrue(x >= 0 && x <= 0xffffffffL);
    }
}
