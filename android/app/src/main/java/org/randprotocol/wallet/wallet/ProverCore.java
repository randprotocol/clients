package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;

/**
 * The four core methods delegated proving uses (documented on {@code wallet_core::dispatch}). An
 * interface so the JVM unit tests, which cannot load the native core, can stand in for it.
 */
public interface ProverCore {
    /** {@code {kem_ek, url, token, own, fingerprint}}; throws on a link the core refuses. */
    JSONObject parseProverLink(String link) throws Exception;

    /** The 16-character fingerprint of a prover's ML-KEM key (hex). */
    String proverFingerprint(String kemEk) throws Exception;

    /**
     * {@code {sealed_hex, pending, expected}}: the transfer {@code prove_transfer} would build, its
     * witness sealed to the prover. {@code params} carries the spend key and the token — never log
     * it; {@code pending} carries neither.
     */
    JSONObject prepareTransfer(JSONObject params) throws Exception;

    /** The ProveResult {@code prove_transfer} would have returned, once the reply checks out. */
    JSONObject finishProof(Object pending, String replyHex) throws Exception;

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
        public JSONObject prepareTransfer(JSONObject params) throws CoreException {
            return Core.object("prepare_transfer", params);
        }

        @Override
        public JSONObject finishProof(Object pending, String replyHex) throws CoreException, JSONException {
            return Core.object("finish_proof", new JSONObject().put("pending", pending).put("reply_hex", replyHex));
        }
    };
}
