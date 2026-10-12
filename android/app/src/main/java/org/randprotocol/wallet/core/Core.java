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

    // ---- RPL-2 invoke (wallet_core::dispatch: dry_run_invoke, plan_invoke, prove_invoke, prepare_invoke)

    /**
     * {@code {program, program_code, public_hex, private_inputs, reads, writes, inflow, pays,
     * mints}} → {@code {tier, gas, gas_limit, gas_max, keccak_log_height, sha256_log_height,
     * context_words}}. Fast (the emulator, no proof): the code is checked to hash to {@code program},
     * and a transition the program refuses is an error naming why.
     */
    public static JSONObject dryRunInvoke(JSONObject transition) throws CoreException {
        return object("dry_run_invoke", transition);
    }

    /**
     * {@code {notes, burn_r, burn_asset, burn_a, fee}} → {@code {inputs, fee_inputs, need, change,
     * fee_change, fee, proofs}}: the one bundle the invoke rides. Throws when the notes do not cover it.
     */
    public static JSONObject planInvoke(JSONObject params) throws CoreException {
        return object("plan_invoke", params);
    }

    /** The slow one for an invoke: the call proof, the auth proof and the bundle proof, all here. Background thread only. */
    public static JSONObject proveInvoke(JSONObject request) throws CoreException {
        return object("prove_invoke", request);
    }

    /**
     * {@code prove_invoke}'s request plus {@code prover} (and {@code max_proof_bytes}) → {@code
     * {sealed_hex, pending, expected}}: the call proof and the auth proof are made here, only the
     * bundle proof is sealed to the prover. {@code finish_proof} opens the reply.
     */
    public static JSONObject prepareInvoke(JSONObject params) throws CoreException {
        return object("prepare_invoke", params);
    }

    // ---- private multisig signing (wallet-core msauth.rs: msauth_check, msauth_sign, msauth_verify_share,
    // msauth_signer_import, msauth_policy_info). A call's params carry a policy (its msk sees every
    // note of the account) and, for msauth_sign, a seed: never log them.

    /**
     * The proposal checked against the policy and the intended payments ({@code rand1…:AMOUNT}
     * each, passed unchanged): fullnode's summary plus {@code recipients_checked}, {@code expected},
     * {@code chain_id}, {@code genesis}, {@code binding_domain} and {@code lines}. {@code
     * org.randprotocol.wallet.wallet.SignFlow} judges the reply.
     */
    public static JSONObject msauthCheck(String proposal, String policy, java.util.List<String> expectedRecipients) throws CoreException {
        return object("msauth_check", msauthCheckParams(proposal, policy, expectedRecipients));
    }

    /**
     * The share {@code "i:hex"}. The core re-runs every check, the payee check with {@code
     * expectedRecipients} included — pass the very list the check was given. {@code seedHex} is the
     * caller's; it wipes its byte[] after (the String cannot be wiped).
     */
    public static String msauthSign(String proposal, String policy, String seedHex, java.util.List<String> expectedRecipients) throws CoreException {
        Object v = call("msauth_sign", msauthSignParams(proposal, policy, seedHex, expectedRecipients));
        if (v instanceof String) return (String) v;
        throw new CoreException("msauth_sign returned no share");
    }

    /** Throws the core's refusal when {@code share} does not verify over this proposal. */
    public static void msauthVerifyShare(String proposal, String policy, String share) throws CoreException {
        call("msauth_verify_share", msauthVerifyShareParams(proposal, policy, share));
    }

    /** A keygen file or 64 hex → {@code {seed, public_key, address, index}}; {@code policy} null leaves index null. */
    public static JSONObject msauthSignerImport(String input, String policy) throws CoreException {
        return object("msauth_signer_import", msauthSignerImportParams(input, policy));
    }

    /** {@code {fingerprint, threshold, signers, address, policy_hash}}. */
    public static JSONObject msauthPolicyInfo(String policy) throws CoreException {
        return object("msauth_policy_info", msauthPolicyInfoParams(policy));
    }

    static JSONObject msauthCheckParams(String proposal, String policy, java.util.List<String> expectedRecipients) {
        return p("proposal", proposal, "policy", policy, "expected_recipients", new JSONArray(expectedRecipients));
    }

    static JSONObject msauthSignParams(String proposal, String policy, String seedHex, java.util.List<String> expectedRecipients) {
        return p("proposal", proposal, "policy", policy, "seed", seedHex, "expected_recipients", new JSONArray(expectedRecipients));
    }

    static JSONObject msauthVerifyShareParams(String proposal, String policy, String share) {
        return p("proposal", proposal, "policy", policy, "share", share);
    }

    static JSONObject msauthSignerImportParams(String input, String policy) {
        return policy == null ? p("input", input) : p("input", input, "policy", policy);
    }

    static JSONObject msauthPolicyInfoParams(String policy) {
        return p("policy", policy);
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
