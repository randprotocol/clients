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

    /** Trial-decrypt a page of {@code shrugg_getCommitments} rows. */
    public static JSONObject scanPage(String spendKey, JSONArray rows) throws CoreException {
        return object("scan_page", p("spend_key", spendKey, "rows", rows));
    }

    /** The deposit note a {@code bridge_attest} action created for this wallet, or null. */
    public static JSONObject rebuiltDeposit(String spendKey, JSONObject action) throws CoreException {
        Object v = call("rebuilt_deposit", p("spend_key", spendKey, "action", action));
        return v instanceof JSONObject ? (JSONObject) v : null;
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
