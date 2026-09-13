package org.randprotocol.wallet.util;

import java.math.BigInteger;

/** SHRUGG amounts: 1 SHRUGG = 10^9 units, always carried as strings of units. */
public final class Amounts {
    private Amounts() {}

    public static final int DECIMALS = 9;
    public static final BigInteger UNITS_PER_SHRUGG = BigInteger.TEN.pow(DECIMALS);
    /** The bundle floor: the fee of a plain transfer, 0.001 SHRUGG. */
    public static final String BUNDLE_BASE_FEE = "1000000";

    /** Units → decimal SHRUGG ("1.5", "0.000000001"), trailing zeros trimmed. */
    public static String format(BigInteger units) {
        BigInteger[] qr = units.divideAndRemainder(UNITS_PER_SHRUGG);
        if (qr[1].signum() == 0) return qr[0].toString();
        String frac = String.format("%0" + DECIMALS + "d", qr[1].longValue());
        int end = frac.length();
        while (end > 0 && frac.charAt(end - 1) == '0') end--;
        return qr[0] + "." + frac.substring(0, end);
    }

    public static String format(String units) {
        try {
            return format(new BigInteger(units));
        } catch (NumberFormatException e) {
            return units;
        }
    }

    /** Decimal SHRUGG ("1.5", ".25") → units, or null for anything that is not an amount. */
    public static BigInteger parse(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (s.isEmpty()) return null;
        int dot = s.indexOf('.');
        String whole = dot < 0 ? s : s.substring(0, dot);
        String frac = dot < 0 ? "" : s.substring(dot + 1);
        if (frac.length() > DECIMALS) return null;
        if (whole.isEmpty() && frac.isEmpty()) return null;
        if (!whole.matches("\\d*") || !frac.matches("\\d*")) return null;
        StringBuilder f = new StringBuilder(frac);
        while (f.length() < DECIMALS) f.append('0');
        BigInteger w = whole.isEmpty() ? BigInteger.ZERO : new BigInteger(whole);
        BigInteger fr = frac.isEmpty() ? BigInteger.ZERO : new BigInteger(f.toString());
        return w.multiply(UNITS_PER_SHRUGG).add(fr);
    }

    /** "shrugg1abcdefghij…klmnop" for chips and rows. */
    public static String shortAddress(String address) {
        if (address == null || address.length() <= 20) return address == null ? "" : address;
        return address.substring(0, 12) + "…" + address.substring(address.length() - 6);
    }

    public static String shortHex(String hex) {
        if (hex == null || hex.length() <= 16) return hex == null ? "" : hex;
        return hex.substring(0, 8) + "…" + hex.substring(hex.length() - 6);
    }
}
