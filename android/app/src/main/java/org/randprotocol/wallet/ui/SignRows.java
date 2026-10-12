package org.randprotocol.wallet.ui;

import org.json.JSONArray;
import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.util.L10n;
import org.randprotocol.wallet.wallet.SignFlow;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The pure decisions behind the sign screen's "Intended payments" (iOS {@code SignRows},
 * ui/screens/signers.js): an output that needs a payee, a row as the core's {@code addr:AMOUNT}
 * entry, and whether a row may go without its amount.
 */
public final class SignRows {
    private SignRows() {}

    /** One intended payment as the signer is typing it: the address and the amount in RAND text. */
    public static final class Row {
        public String addr;
        public String amount;

        public Row() {
            this("", "");
        }

        public Row(String addr, String amount) {
            this.addr = addr == null ? "" : addr;
            this.amount = amount == null ? "" : amount;
        }
    }

    /**
     * An output the signer must name a payee for: it leaves the account ({@code to_account} is not
     * {@code true}) and moves something. Decided from the output itself, not from the core's own flag.
     */
    public static boolean needsPayee(Object output) {
        if (!(output instanceof JSONObject)) return false;
        JSONObject o = (JSONObject) output;
        return !Boolean.TRUE.equals(o.opt("to_account")) && !SignFlow.isZeroAmount(o.opt("amount"));
    }

    public static boolean isNonRand(JSONObject o) {
        Long a = SignFlow.assetId(o.opt("asset"));
        return a != null && a != 0;
    }

    public static boolean isMatched(JSONObject o) {
        Object m = o.opt("matches");
        return m instanceof String && !SignFlow.jsTrim((String) m).isEmpty();
    }

    /** The paying outputs of a summary; none when the summary has no list of outputs. */
    static List<JSONObject> paying(JSONObject summary) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray a = summary == null ? null : summary.optJSONArray("outputs");
        for (int i = 0; a != null && i < a.length(); i++) {
            Object o = a.opt(i);
            if (needsPayee(o)) out.add((JSONObject) o);
        }
        return out;
    }

    public static int payingTotal(JSONObject summary) {
        return paying(summary).size();
    }

    public static int payingMatched(JSONObject summary) {
        int n = 0;
        for (JSONObject o : paying(summary)) if (isMatched(o)) n++;
        return n;
    }

    /** The payments section shows while the last good summary has something to pay for. */
    public static boolean showsPayments(JSONObject lastSummary) {
        return !paying(lastSummary).isEmpty();
    }

    /** The rows as one string, to tell whether they changed since a check was sent (length-prefixed: no separator forges another list). */
    public static String key(List<Row> rows) {
        StringBuilder sb = new StringBuilder();
        for (Row r : rows) {
            sb.append(r.addr.length()).append(':').append(r.addr).append('|')
                    .append(r.amount.length()).append(':').append(r.amount).append('\n');
        }
        return sb.toString();
    }

    /**
     * One intended payment as the core's {@code addr:AMOUNT}. AMOUNT is RAND display text, checked
     * by {@link Amounts#parse} and passed as typed (trimmed). It may be left out only when {@code
     * amountOptional}. Throws IllegalArgumentException with the sentence for the signer.
     */
    public static String entry(Row row, boolean amountOptional) {
        String a = SignFlow.jsTrim(row.addr);
        String v = SignFlow.jsTrim(row.amount);
        if (a.isEmpty()) throw new IllegalArgumentException(L10n.t(R.string.msauth_row_no_address, "Enter the address of every payment."));
        if (v.isEmpty()) {
            if (amountOptional) return a;
            throw new IllegalArgumentException(L10n.t(R.string.msauth_row_no_amount, "Enter the amount of every payment: it is what stops a split or an inflated payment."));
        }
        BigInteger units = Amounts.parse(v);
        if (units == null || units.signum() <= 0) {
            throw new IllegalArgumentException(L10n.t(R.string.msauth_row_bad_amount, "An amount is a number of RAND, such as 1.5."));
        }
        return a + ":" + v;
    }

    /** Every row as its entry, each with its own {@link #amountOptional}; the first refusal throws. */
    public static List<String> entries(List<Row> rows, JSONObject summary) {
        List<String> out = new ArrayList<>();
        for (Row r : rows) out.add(entry(r, amountOptional(r, summary)));
        return out;
    }

    /**
     * Whether this row may go without an amount: only when the check's {@code expected} shows the
     * row's address owns a paying non-RAND output. A row the core has not fingerprinted yet (or
     * whose address was edited) may be sent address-only when some paying output is non-RAND, so
     * the next check can tell; the rule ({@link SignFlow#judge}) refuses it unless its fingerprint
     * owns such an output.
     */
    public static boolean amountOptional(Row row, JSONObject summary) {
        if (summary == null) return false;
        List<JSONObject> paying = paying(summary);
        boolean anyNonRand = false;
        Set<String> owners = new HashSet<>();
        for (JSONObject o : paying) {
            if (!isNonRand(o)) continue;
            anyNonRand = true;
            Object fp = o.opt("owner_fingerprint");
            if (fp instanceof String && !((String) fp).isEmpty()) owners.add((String) fp);
        }
        String a = SignFlow.jsTrim(row.addr);
        JSONArray expected = summary.optJSONArray("expected");
        if (!a.isEmpty() && expected != null) {
            for (int i = 0; i < expected.length(); i++) {
                Object item = expected.opt(i);
                if (!(item instanceof JSONObject)) continue;
                Object entry = ((JSONObject) item).opt("entry");
                if (!(entry instanceof String)) continue;
                String e = (String) entry;
                int colon = e.indexOf(':');
                String head = SignFlow.jsTrim(colon < 0 ? e : e.substring(0, colon));
                if (!head.equals(a)) continue;
                Object fp = ((JSONObject) item).opt("fingerprint");
                return fp instanceof String && owners.contains(fp);
            }
        }
        return anyNonRand;
    }
}
