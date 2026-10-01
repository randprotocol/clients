package org.randprotocol.wallet.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.wallet.Amm;
import org.randprotocol.wallet.wallet.Invoke;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The Swap screen's state rules ({@link SwapForm}): the words, the amounts and when Review opens. */
public class SwapFormTest {
    static final String LIVE_KEY = "0100000000000000020000000000000000000000000000000000000000000000";
    static final String LIVE_VALUE = "007e9420310000005f981f6a04000000338ebab90e0000000300000001000000";

    static List<Amm.Pool> pools() {
        return Arrays.asList(Amm.decodePool(LIVE_KEY, LIVE_VALUE));
    }

    static Map<Integer, SwapForm.Asset> assets(String rand, String dur) throws Exception {
        JSONArray tokens = new JSONArray().put(new JSONObject().put("index", 2).put("symbol", "DUR").put("decimals", 6).put("name", "Durian"));
        Map<Integer, BigInteger> balances = new HashMap<>();
        balances.put(0, new BigInteger(rand));
        balances.put(2, new BigInteger(dur));
        return SwapForm.assets(tokens, balances, s -> s);
    }

    @Test
    public void namesAndDecimalsComeFromTheRegistryAndRandIsAlwaysNine() throws Exception {
        Map<Integer, SwapForm.Asset> a = assets("1000000000", "0");
        assertEquals("RAND", SwapForm.infoOf(a, 0).symbol);
        assertEquals(9, SwapForm.infoOf(a, 0).decimals);
        assertEquals("DUR", SwapForm.infoOf(a, 2).symbol);
        assertEquals(6, SwapForm.infoOf(a, 2).decimals);
        assertEquals("asset 7", SwapForm.infoOf(a, 7).symbol);
        // A symbol the node sends is cleaned before it is shown; an empty one is the index.
        JSONArray hostile = new JSONArray().put(new JSONObject().put("index", 5).put("symbol", "").put("decimals", 9));
        assertEquals("asset 5", SwapForm.assets(hostile, new HashMap<>(), s -> s).get(5).symbol);
    }

    @Test
    public void unitsFormatAndParseAtTheAssetsDecimals() {
        assertEquals("1,234.5", SwapForm.formatUnits(new BigInteger("1234500000000"), 6, 9));
        assertEquals("0.123456", SwapForm.formatUnits(new BigInteger("123456789"), 6, 9));
        assertEquals("12.345678", SwapForm.formatUnits(new BigInteger("12345678"), 9, 6));
        assertEquals("0", SwapForm.formatUnits(BigInteger.ZERO, 6, 9));
        assertEquals(new BigInteger("200000000"), SwapForm.parseUnits("0.2", 9));
        assertEquals(new BigInteger("1500000"), SwapForm.parseUnits("1.5", 6));
        assertEquals(new BigInteger("500000"), SwapForm.parseUnits(".5", 6));
        assertNull("more digits than the asset has", SwapForm.parseUnits("0.0000001", 6));
        assertNull(SwapForm.parseUnits("1.2.3", 9));
        assertNull(SwapForm.parseUnits(".", 9));
        assertNull(SwapForm.parseUnits("abc", 9));
    }

    @Test
    public void aGoodAmountQuotesAndOpensReview() throws Exception {
        SwapForm.State s = SwapForm.evaluate(pools(), assets("1000000000", "0"), 0, 2, "0.2");
        assertNull(s.error);
        assertTrue(s.quote.ok);
        assertTrue(s.canReview);
        assertEquals(SwapForm.formatUnits(s.quote.amountOut, 9, 6), s.out);
        assertEquals("200000000", s.quote.request.getJSONObject("inflow").getString("rand"));
        assertTrue(SwapForm.rateLine(assets("0", "0"), s.quote, s.route).startsWith("1 RAND ≈ "));
        assertTrue(SwapForm.rateLine(assets("0", "0"), s.quote, s.route).endsWith(" DUR"));
        assertNull("a direct swap has no route line", SwapForm.via(assets("0", "0"), s.quote));
    }

    @Test
    public void whatIsWrongWithTheAmountIsSaidUnderIt() throws Exception {
        Map<Integer, SwapForm.Asset> a = assets("100000000", "0");
        SwapForm.State empty = SwapForm.evaluate(pools(), a, 0, 2, "");
        assertNull(empty.error);
        assertNull(empty.quote);
        assertEquals("—", empty.out);
        assertFalse(empty.canReview);
        assertEquals(SwapForm.BAD_AMOUNT, SwapForm.evaluate(pools(), a, 0, 2, "0").error);
        assertEquals(SwapForm.BAD_AMOUNT, SwapForm.evaluate(pools(), a, 0, 2, "x").error);
        SwapForm.State over = SwapForm.evaluate(pools(), a, 0, 2, "0.2");
        assertEquals("You have 0.1 RAND.", over.error);
        assertFalse("still quoted, but not reviewable", over.canReview);
        assertTrue(over.quote.ok);
        SwapForm.State dust = SwapForm.evaluate(pools(), a, 0, 2, "0.000000001");
        assertEquals("That amount is too small: it would buy nothing.", dust.error);
        assertFalse(dust.canReview);
        SwapForm.State noRoute = SwapForm.evaluate(pools(), a, 0, 9, "0.01");
        assertEquals("There is no pool for that pair.", noRoute.error);
    }

    @Test
    public void priceImpactAtFivePercentOrMoreIsShownNegative() {
        assertEquals("< 0.01%", SwapForm.impactText(BigInteger.valueOf(50)));
        assertEquals("1.23%", SwapForm.impactText(BigInteger.valueOf(12_300)));
        assertFalse(SwapForm.impactNegative(BigInteger.valueOf(49_999)));
        assertTrue(SwapForm.impactNegative(BigInteger.valueOf(50_000)));
    }

    @Test
    public void maxLeavesRoomForTheFeeOnlyWhenSellingRand() throws Exception {
        Map<Integer, SwapForm.Asset> a = assets("1000000000", "2500000");
        assertEquals("0.99", SwapForm.maxAmount(SwapForm.infoOf(a, 0)));
        assertEquals("2.5", SwapForm.maxAmount(SwapForm.infoOf(a, 2)));
        assertNull(SwapForm.maxAmount(SwapForm.infoOf(assets("10000000", "0"), 0)));
    }

    @Test
    public void theBoughtAssetIsNeverTheSoldOne() {
        List<Integer> list = Amm.tradeable(pools());
        assertEquals(Integer.valueOf(2), SwapForm.pickBuy(list, 0, null));
        assertEquals(Integer.valueOf(0), SwapForm.pickBuy(list, 2, 2));
        assertEquals(Integer.valueOf(2), SwapForm.pickBuy(list, 0, 2));
        assertEquals("one not tradeable falls back", Integer.valueOf(2), SwapForm.pickBuy(list, 0, 9));
    }

    @Test
    public void onlyAStaleReadReQuotesWithTheNotice() {
        assertTrue(SwapForm.isStale(Invoke.STALE_READ));
        assertFalse(SwapForm.isStale(Invoke.INSUFFICIENT_FUNDS));
        assertFalse(SwapForm.isStale(null));
        assertEquals("The pool moved before your swap reached the chain, so nothing was sent. Here is a new quote.", SwapForm.STALE);
    }
}
