package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;

/**
 * The core methods delegated proving uses (documented on {@code wallet_core::dispatch}). An
 * interface so the JVM unit tests, which cannot load the native core, can stand in for it.
 */
public interface ProverCore {
    /** {@code {kem_ek, url, token, own, fingerprint}}; throws on a link the core refuses. */
    JSONObject parseProverLink(String link) throws Exception;

    /** The 16-character fingerprint of a prover's ML-KEM key (hex). */
    String proverFingerprint(String kemEk) throws Exception;

    /**
     * {@code chain_guests {hc_bundle?, hc_auth?}} → {@code {hc_bundle, hc_auth,
     * split_authorisation, witness_kind}}: what this build makes of the chain's two guests, before
     * anything is fetched or built — a chain it cannot prove for is refused here, exactly as
     * {@code prove_*}/{@code prepare_*} would refuse it, and {@code witness_kind} says what a
     * paired prover would be sent: {@code "viewing_key"} on a split-authorisation chain (bundle
     * guest v3, every chain since 17), {@code "spend_key"} on an older one.
     */
    JSONObject chainGuests(JSONObject params) throws Exception;

    /**
     * {@code {sealed_hex, pending, expected}}: the transfer {@code prove_transfer} would build, its
     * witness sealed to the prover. On a split-authorisation chain the core makes the AUTH PROOF
     * inside this call, on this device, from the spend key (tier 10: several seconds natively), so
     * the job that goes out carries the viewing key and a salt and never the spend key. {@code
     * params} carries the spend key and the token — never log it; {@code pending} carries neither
     * (its {@code tx_hex} is ~2.8 MB of hex on such a chain: the auth proof is already inside).
     */
    JSONObject prepareTransfer(JSONObject params) throws Exception;

    /** The ProveResult {@code prove_transfer} would have returned, once the reply checks out. */
    JSONObject finishProof(Object pending, String replyHex) throws Exception;

    /**
     * What a paired prover learns from a viewing-key job, in the core's own words ({@code
     * version.prover_history_warning}) so every shell says the same thing; {@link
     * ProverPairing#WARNING} when the core does not say.
     */
    default String historyWarning() {
        return ProverPairing.WARNING;
    }

    /** Base units → display units ({@code format_amount}); the units themselves when the core cannot. */
    default String formatAmount(String units) {
        return units;
    }

    /**
     * The prover this build ships the address of ({@code version.trusted_prover}: the RandProtocol
     * validators' pool), for a screen to offer in one step — or null when the core names none.
     * Asking pairs nothing.
     */
    default TrustedProver trustedProver() {
        return null;
    }

    ProverCore NATIVE = new ProverCore() {
        @Override
        public JSONObject parseProverLink(String link) throws CoreException, JSONException {
            return Core.object("parse_prover_link", new JSONObject().put("link", link.trim()));
        }

        @Override
        public String proverFingerprint(String kemEk) throws CoreException, JSONException {
            return String.valueOf(Core.call("prover_fingerprint", new JSONObject().put("kem_ek", kemEk)));
        }

        @Override
        public JSONObject chainGuests(JSONObject params) throws CoreException {
            return Core.object("chain_guests", params);
        }

        @Override
        public JSONObject prepareTransfer(JSONObject params) throws CoreException {
            return Core.object("prepare_transfer", params);
        }

        @Override
        public JSONObject finishProof(Object pending, String replyHex) throws CoreException, JSONException {
            return Core.object("finish_proof", new JSONObject().put("pending", pending).put("reply_hex", replyHex));
        }

        @Override
        public String historyWarning() {
            try {
                String s = Core.constants().optString("prover_history_warning", "");
                return s.isEmpty() ? ProverPairing.WARNING : s;
            } catch (Exception e) {
                return ProverPairing.WARNING;
            }
        }

        @Override
        public String formatAmount(String units) {
            return Core.formatAmount(units);
        }

        @Override
        public TrustedProver trustedProver() {
            try {
                return TrustedProver.fromJson(Core.constants().optJSONObject("trusted_prover_pool"));
            } catch (Exception e) {
                return null;
            }
        }
    };
}
