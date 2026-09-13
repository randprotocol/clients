package org.randprotocol.wallet.store;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;

/**
 * A note this wallet owns, exactly as the core hands it back from {@code scan_page}: the leaf
 * index, the 112-byte plaintext (hex, opaque to the app), the commitment and nullifier, and the
 * fields the UI shows. Amounts are decimal strings of units (they exceed a double's precision).
 */
public final class OwnedNote {
    public long index;
    public String note;
    public String cm;
    public String nf;
    public String amount;
    public int asset;
    public long time;
    public String from;
    public long height;
    public boolean spent;
    /** The {@code time} of the bundle that spends this note, while its commit is unconfirmed. */
    public Long pending;

    public static OwnedNote fromJson(JSONObject o) throws JSONException {
        OwnedNote n = new OwnedNote();
        n.index = o.getLong("index");
        n.note = o.getString("note");
        n.cm = o.getString("cm");
        n.nf = o.getString("nf");
        n.amount = o.getString("amount");
        n.asset = o.optInt("asset", 0);
        n.time = o.optLong("time", 0);
        n.from = o.optString("from", "");
        n.height = o.optLong("height", 0);
        n.spent = o.optBoolean("spent", false);
        n.pending = o.isNull("pending") ? null : o.getLong("pending");
        return n;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("index", index);
        o.put("note", note);
        o.put("cm", cm);
        o.put("nf", nf);
        o.put("amount", amount);
        o.put("asset", asset);
        o.put("time", time);
        o.put("from", from);
        o.put("height", height);
        o.put("spent", spent);
        o.put("pending", pending == null ? JSONObject.NULL : pending);
        return o;
    }

    public BigInteger units() {
        try {
            return new BigInteger(amount);
        } catch (NumberFormatException e) {
            return BigInteger.ZERO;
        }
    }

    /** Unspent, not held by a pending submission, and worth something. */
    public boolean isSpendable() {
        return !spent && pending == null && units().signum() > 0;
    }
}
