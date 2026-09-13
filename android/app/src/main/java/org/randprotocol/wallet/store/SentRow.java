package org.randprotocol.wallet.store;

import org.json.JSONException;
import org.json.JSONObject;

/** A note this wallet created for someone else: history, never spendable. */
public final class SentRow {
    public long index;
    public String toPk;
    public String amount;
    public int asset;
    public long time;
    public long height;

    public static SentRow fromJson(JSONObject o) throws JSONException {
        SentRow s = new SentRow();
        s.index = o.getLong("index");
        s.toPk = o.getString("to_pk");
        s.amount = o.getString("amount");
        s.asset = o.optInt("asset", 0);
        s.time = o.optLong("time", 0);
        s.height = o.optLong("height", 0);
        return s;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("index", index);
        o.put("to_pk", toPk);
        o.put("amount", amount);
        o.put("asset", asset);
        o.put("time", time);
        o.put("height", height);
        return o;
    }
}
