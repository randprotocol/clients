package org.randprotocol.wallet.ui;

import org.json.JSONArray;
import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;
import org.randprotocol.wallet.wallet.Amm;
import org.randprotocol.wallet.wallet.Invoke;

import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The Swap screen's rules with no Android in them ({@code ui/screens/swap.js}'s {@code requote},
 * {@code infoOf} and {@code detailsMarkup}): what the form says for the pools, the balances and
 * what was typed, in the shared UI's words — unit tested on the JVM like {@link SendDraft}.
 */
public final class SwapForm {
    private SwapForm() {}

    /** Selling RAND leaves room for the network fee, which is paid in RAND too (Max). */
    public static final BigInteger FEE_ROOM = BigInteger.valueOf(10_000_000L);
    /** At or above this price impact the screen shows it in the negative colour (5%). */
    public static final BigInteger IMPACT_WARN_PPM = BigInteger.valueOf(50_000);

    public static final String STALE = "The pool moved before your swap reached the chain, so nothing was sent. Here is a new quote.";
    public static final String BAD_AMOUNT = "Enter an amount like 1.5.";

    /** {@link #STALE} in the language in force. */
    public static String stale() {
        return L10n.t(R.string.swap_stale, STALE);
    }

    /** A token the registry does not name: "asset N". */
    static String unnamed(int index) {
        return L10n.t(R.string.swap_asset_unnamed, "asset %1$d", index);
    }

    /** One asset as the screen names it: its symbol, its decimals and this wallet's balance of it. */
    public static final class Asset {
        public final int index;
        public final String symbol;
        public final int decimals;
        public final BigInteger balance;

        public Asset(int index, String symbol, int decimals, BigInteger balance) {
            this.index = index;
            this.symbol = symbol;
            this.decimals = decimals;
            this.balance = balance;
        }
    }

    /**
     * index → {@link Asset}, from {@code rand_getTokens}' rows ({@code RpcClient.tokens}) and the
     * balances; RAND is asset 0 with 9 decimals, and a token the registry does not name is
     * "asset N" with 9. Symbols are node text: shown through {@link Memo#display}.
     */
    public static Map<Integer, Asset> assets(JSONArray tokens, Map<Integer, BigInteger> balances, java.util.function.UnaryOperator<String> clean) {
        Map<Integer, Asset> out = new HashMap<>();
        out.put(Amm.RAND_ASSET, new Asset(Amm.RAND_ASSET, "RAND", 9, balances.getOrDefault(Amm.RAND_ASSET, BigInteger.ZERO)));
        if (tokens != null) {
            for (int i = 0; i < tokens.length(); i++) {
                JSONObject t = tokens.optJSONObject(i);
                if (t == null) continue;
                int index = t.optInt("index", -1);
                if (index <= 0) continue;
                String sym = clean.apply(t.optString("symbol", "")).trim();
                out.put(index, new Asset(index, sym.isEmpty() ? unnamed(index) : sym, t.optInt("decimals", 9), balances.getOrDefault(index, BigInteger.ZERO)));
            }
        }
        return out;
    }

    public static Asset infoOf(Map<Integer, Asset> assets, int index) {
        Asset a = assets.get(index);
        if (a != null) return a;
        return index == Amm.RAND_ASSET ? new Asset(0, "RAND", 9, BigInteger.ZERO) : new Asset(index, unnamed(index), 9, BigInteger.ZERO);
    }

    /** {@code units} at {@code decimals}, at most {@code frac} fraction digits (rounded down), trailing zeros trimmed, thousands grouped. */
    public static String formatUnits(BigInteger units, int frac, int decimals) {
        java.math.BigDecimal v = new java.math.BigDecimal(units, decimals).setScale(Math.min(frac, decimals), RoundingMode.DOWN);
        String plain = v.stripTrailingZeros().toPlainString();
        int dot = plain.indexOf('.');
        String whole = dot < 0 ? plain : plain.substring(0, dot);
        String rest = dot < 0 ? "" : plain.substring(dot);
        StringBuilder g = new StringBuilder();
        for (int i = 0; i < whole.length(); i++) {
            if (i > 0 && (whole.length() - i) % 3 == 0) g.append(',');
            g.append(whole.charAt(i));
        }
        return g + rest;
    }

    /** A decimal amount at {@code decimals} → units, or null for anything that is not one (or has more digits than the asset). */
    public static BigInteger parseUnits(String text, int decimals) {
        if (text == null) return null;
        String s = text.trim().replace(",", "");
        if (s.isEmpty() || !s.matches("\\d*\\.?\\d*") || s.equals(".")) return null;
        int dot = s.indexOf('.');
        String frac = dot < 0 ? "" : s.substring(dot + 1);
        if (frac.length() > decimals) return null;
        try {
            return new java.math.BigDecimal(s).movePointRight(decimals).toBigIntegerExact();
        } catch (ArithmeticException | NumberFormatException e) {
            return null;
        }
    }

    /** {@code "< 0.01%"} or two decimals, as the shared UI shows it. */
    public static String impactText(BigInteger ppm) {
        double pct = ppm.doubleValue() / 10_000.0;
        return pct < 0.01 ? "< 0.01%" : String.format(Locale.US, "%.2f%%", pct);
    }

    public static boolean impactNegative(BigInteger ppm) {
        return ppm.compareTo(IMPACT_WARN_PPM) >= 0;
    }

    /** What Max fills in: the balance, less {@link #FEE_ROOM} when selling RAND; null when nothing is left. */
    public static String maxAmount(Asset sell) {
        BigInteger room = sell.index == Amm.RAND_ASSET ? sell.balance.subtract(FEE_ROOM) : sell.balance;
        return room.signum() > 0 ? formatUnits(room, sell.decimals, sell.decimals).replace(",", "") : null;
    }

    /** The asset to buy: {@code buy} while it is tradeable and not the one sold, else the first that is not. */
    public static Integer pickBuy(List<Integer> list, int sell, Integer buy) {
        if (buy != null && list.contains(buy) && buy != sell) return buy;
        for (Integer a : list) if (a != sell) return a;
        return null;
    }

    /** What the form shows for one set of values. */
    public static final class State {
        public final Amm.Route route;
        /** {@link Amm#buildSwap}'s result, or null when no amount is typed. */
        public final Amm.Swap quote;
        /** Under the amount: a bad amount, more than the balance, or the quote's refusal. */
        public final String error;
        /** "You receive": the amount only (the asset is the picker beside it), or "—". */
        public final String out;
        public final boolean canReview;

        State(Amm.Route route, Amm.Swap quote, String error, String out, boolean canReview) {
            this.route = route;
            this.quote = quote;
            this.error = error;
            this.out = out;
            this.canReview = canReview;
        }
    }

    public static State evaluate(List<Amm.Pool> pools, Map<Integer, Asset> assets, int sell, Integer buy, String amount) {
        Amm.Route route = buy == null ? null : Amm.findRoute(pools, sell, buy);
        Asset s = infoOf(assets, sell);
        String typed = amount == null ? "" : amount.trim();
        BigInteger units = typed.isEmpty() ? null : parseUnits(typed, s.decimals);
        String err = null;
        if (!typed.isEmpty() && (units == null || units.signum() <= 0)) err = L10n.t(R.string.swap_bad_amount, BAD_AMOUNT);
        else if (units != null && units.compareTo(s.balance) > 0) err = L10n.t(R.string.swap_over_balance, "You have %1$s %2$s.", formatUnits(s.balance, 6, s.decimals), s.symbol);
        Amm.Swap quote = null;
        if (units != null && units.signum() > 0) {
            quote = Amm.buildSwap(route, units);
            if (!quote.ok && err == null) err = quote.message;
        }
        boolean ok = quote != null && quote.ok;
        String out = ok ? formatUnits(quote.amountOut, 9, infoOf(assets, buy).decimals) : "—";
        return new State(route, quote, err, out, ok && err == null);
    }

    /** "1 RAND ≈ 0.012 DUR": one whole sold asset at the pools' reserves, before the fee and the trade's impact. */
    public static String rateLine(Map<Integer, Asset> assets, Amm.Swap q, Amm.Route route) {
        Asset s = infoOf(assets, q.sell);
        Asset b = infoOf(assets, q.buy);
        BigInteger rate = Amm.spotRate(route, s.decimals);
        return L10n.t(R.string.swap_rate_line, "1 %1$s ≈ %2$s %3$s", s.symbol, formatUnits(rate == null ? BigInteger.ZERO : rate, 6, b.decimals), b.symbol);
    }

    /** {@code amount} of {@code index}, with its symbol. */
    public static String amountOf(Map<Integer, Asset> assets, int index, BigInteger units, int frac) {
        Asset a = infoOf(assets, index);
        return formatUnits(units, frac, a.decimals) + " " + a.symbol;
    }

    /** The route through RAND, or null for a direct swap. */
    public static String via(Map<Integer, Asset> assets, Amm.Swap q) {
        return q.hops.size() == 2 ? L10n.t(R.string.swap_via, "%1$s → RAND → %2$s", infoOf(assets, q.sell).symbol, infoOf(assets, q.buy).symbol) : null;

    }

    /** What the failed step says, and whether it is a moved pool (re-read and quote again). */
    public static boolean isStale(String code) {
        return Invoke.STALE_READ.equals(code);
    }
}
