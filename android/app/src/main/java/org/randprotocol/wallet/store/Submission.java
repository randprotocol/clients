package org.randprotocol.wallet.store;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A transfer this wallet submitted: what the user needs afterwards — the hash to look it up,
 * and the payment's per-transaction key so exactly that payment can be disclosed later. A swap
 * (an RPL-2 invoke) is one too, of {@code kind} {@link #INVOKE}: its {@code amount} is what it
 * put in, of {@code asset}, and {@code payouts} what the program pays back, found by the next scan.
 */
public final class Submission {
    public static final String PENDING = "pending";
    public static final String COMMITTED = "committed";
    public static final String EXPIRED = "expired";
    public static final String TRANSFER = "transfer";
    public static final String INVOKE = "invoke";

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
    public String kind = TRANSFER;
    /** An invoke's program id; empty for a transfer. */
    public String program = "";
    /** The asset {@code amount} is in: 0 (RAND) for a transfer. */
    public int asset;
    /** An invoke's payouts to this wallet, {@code [{asset, amount}]}; empty for a transfer. */
    public JSONArray payouts = new JSONArray();

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
        s.kind = o.optString("kind", TRANSFER);
        s.program = o.optString("program", "");
        s.asset = o.optInt("asset", 0);
        JSONArray p = o.optJSONArray("payouts");
        s.payouts = p == null ? new JSONArray() : p;
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
        o.put("kind", kind);
        o.put("program", program);
        o.put("asset", asset);
        o.put("payouts", payouts);
        return o;
    }
}
