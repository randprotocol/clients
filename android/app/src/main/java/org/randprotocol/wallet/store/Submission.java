package org.randprotocol.wallet.store;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * A transfer this wallet submitted: what the user needs afterwards — the hash to look it up,
 * and the payment's per-transaction key so exactly that payment can be disclosed later.
 */
public final class Submission {
    public static final String PENDING = "pending";
    public static final String COMMITTED = "committed";
    public static final String EXPIRED = "expired";

    public String hash;
    public long time;
    public String amount;
    public String fee;
    public String to;
    /** The payment envelope's TxKey (hex); opens that one payment on randscan.org. */
    public String txKey;
    public String status = PENDING;
    public long height;
    public long createdAtMs;

    public static Submission fromJson(JSONObject o) throws JSONException {
        Submission s = new Submission();
        s.hash = o.getString("hash");
        s.time = o.optLong("time", 0);
        s.amount = o.optString("amount", "0");
        s.fee = o.optString("fee", "0");
        s.to = o.optString("to", "");
        s.txKey = o.optString("tx_key", "");
        s.status = o.optString("status", PENDING);
        s.height = o.optLong("height", 0);
        s.createdAtMs = o.optLong("created_at_ms", 0);
        return s;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("hash", hash);
        o.put("time", time);
        o.put("amount", amount);
        o.put("fee", fee);
        o.put("to", to);
        o.put("tx_key", txKey);
        o.put("status", status);
        o.put("height", height);
        o.put("created_at_ms", createdAtMs);
        return o;
    }
}
