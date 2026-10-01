package org.randprotocol.wallet.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Typed access to the Rust core. Every method here is a thin wrapper over
 * {@link NativeCore#call}; the parameter and result shapes are documented on
 * {@code wallet_core::dispatch} in core/crates/wallet-core/src/lib.rs.
 *
 * <p>Nothing here does I/O and nothing keeps a spend key: it is passed in per call.
 */
public final class Core {
    private Core() {}

    /** Call {@code method} and unwrap the reply, throwing the core's own message on error. */
    public static Object call(String method, JSONObject params) throws CoreException {
        String reply = NativeCore.call(method, params == null ? "{}" : params.toString());
        try {
            JSONObject r = new JSONObject(reply);
            if (r.optBoolean("ok", false)) {
                return r.opt("value");
            }
            throw new CoreException(r.optString("error", "unknown core error"));
        } catch (JSONException e) {
            throw new CoreException("core reply is not JSON: " + e.getMessage());
        }
    }

    public static JSONObject object(String method, JSONObject params) throws CoreException {
        Object v = call(method, params);
        if (v instanceof JSONObject) return (JSONObject) v;
        throw new CoreException(method + " did not return an object");
    }

    private static JSONObject p(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
        return o;
    }

    /** Chain constants: default chain id, RPC URL, fee floor, windows, core version. */
    public static JSONObject constants() throws CoreException {
        return object("version", null);
    }

    public static JSONObject keygen() throws CoreException {
        return object("keygen", null);
    }

    public static JSONObject walletInfo(String spendKey) throws CoreException {
        return object("wallet_info", p("spend_key", spendKey));
    }

    /** 64 hex characters or the contents of a wallet.key.json. */
    public static JSONObject importKey(String input) throws CoreException {
        return object("import_key", p("input", input));
    }

    public static JSONObject parseAddress(String address) throws CoreException {
        return object("parse_address", p("address", address));
    }

    public static boolean isValidAddress(String address) {
        try {
            return parseAddress(address).optBoolean("valid", false);
        } catch (CoreException e) {
            return false;
        }
    }

    /** {@code XXXX-XXXX-XXXX-XXXX}, sixteen characters the core computes from the address. */
    public static String addressFingerprint(String address) throws CoreException {
        return object("address_fingerprint", p("address", address)).optString("fingerprint", null);
    }

    /**
     * A {@code randpay:} link, parsed: {@code {address, amount, asset, memo, fingerprint}}, the
     * fingerprint recomputed by the core. Throws the core's message on a link it refuses.
     */
    public static JSONObject uriParse(String uri) throws CoreException {
        return object("uri_parse", p("uri", uri.trim()));
    }

    /** The core formats and parses back, so this never returns a link another wallet refuses. */
    public static String uriFormat(String address, String amount, String asset, String memo) throws CoreException {
        JSONObject params = p("address", address);
        try {
            if (amount != null && !amount.isEmpty()) params.put("amount", amount);
            if (asset != null && !asset.isEmpty()) params.put("asset", asset);
            if (memo != null && !memo.isEmpty()) params.put("memo", memo);
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
        return object("uri_format", params).optString("uri", null);
    }

    /** Trial-decrypt a page of {@code rand_getCommitments} rows. */
    public static JSONObject scanPage(String spendKey, JSONArray rows) throws CoreException {
        return object("scan_page", p("spend_key", spendKey, "rows", rows));
    }

    /** The deposit note a {@code bridge_attest} action created for this wallet, or null. */
    public static JSONObject rebuiltDeposit(String spendKey, JSONObject action) throws CoreException {
        Object v = call("rebuilt_deposit", p("spend_key", spendKey, "action", action));
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    /**
     * Every note a block action created for this wallet from its public fields: a bridge deposit (net
     * of the chain's fee, v0.6.8) and — when this wallet is {@code feeRecipient}, the chain's
     * {@code bridge.fees.recipient} — the envelope-less fee notes of deposits and burns.
     */
    public static JSONArray rebuiltNotes(String spendKey, JSONObject action, String feeRecipient) throws CoreException {
        Object v = feeRecipient == null
            ? call("rebuilt_notes", p("spend_key", spendKey, "action", action))
            : call("rebuilt_notes", p("spend_key", spendKey, "action", action, "fee_recipient", feeRecipient));
        return v instanceof JSONArray ? (JSONArray) v : new JSONArray();
    }

    public static JSONObject selectInputs(JSONArray notes, int asset, String needUnits) throws CoreException {
        return object("select_inputs", p("notes", notes, "asset", asset, "need", needUnits));
    }

    /** The slow one: proves a bundle. Call on a background thread only. */
    public static JSONObject proveTransfer(JSONObject request) throws CoreException {
        return object("prove_transfer", request);
    }

    public static String formatAmount(String units) {
        try {
            return String.valueOf(call("format_amount", p("units", units)));
        } catch (CoreException e) {
            return units;
        }
    }

    public static String parseAmount(String text) throws CoreException {
        return String.valueOf(call("parse_amount", p("text", text)));
    }
}
